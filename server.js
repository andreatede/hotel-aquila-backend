// server.js — Hotel Aquila backend: disponibilità, checkout, webhook Stripe.
//
// REGOLA IMPORTANTE (voluta esplicitamente): per i pagamenti con carta, nessuna riga viene
// scritta nel database quando si crea la sessione Stripe. Tutti i dettagli della prenotazione
// viaggiano dentro ai metadata della sessione stessa. Solo quando Stripe conferma con l'evento
// 'checkout.session.completed' (pagamento davvero riuscito) il webhook crea la prenotazione,
// già con stato 'paid'. Se il pagamento fallisce, viene rifiutato, o l'ospite abbandona il
// checkout, non esiste alcuna traccia nel database — punto.
//
// Per "paga in struttura", il flusso è diverso e più semplice: bypassa Stripe del tutto,
// scrive subito la prenotazione con stato 'da_pagare_struttura'.
//
// Avvio in locale:
//   1. cp .env.example .env  →  compila con le tue chiavi Stripe e DATABASE_URL
//   2. npm install
//   3. npm start
//   4. In un secondo terminale:  stripe listen --forward-to localhost:3000/api/webhook

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const db = require('./db');

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('⚠️  STRIPE_SECRET_KEY non impostata — copia .env.example in .env e compilalo.');
}
if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD non impostata — il pannello di gestione non sarà accessibile finché non la imposti.');
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const JWT_SECRET = process.env.JWT_SECRET || 'cambia-questo-in-produzione-' + (process.env.ADMIN_PASSWORD || 'dev');

const app = express();
// Il frontend ora è servito da QUESTO stesso backend (vedi più sotto) — quindi FRONTEND_URL
// di default usa l'indirizzo pubblico vero, che Render imposta da solo in RENDER_EXTERNAL_URL
// per ogni Web Service (es. "https://hotel-aquila-backend.onrender.com"). Zero configurazione
// manuale necessaria una volta che gira su Render — nessun indirizzo da tenere allineato a mano.
const FRONTEND_URL = process.env.FRONTEND_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

/* ---------------------------------------------------------------------
   Webhook Stripe — DEVE stare prima di express.json(), e ha bisogno del
   corpo grezzo della richiesta (non json già interpretato) per verificare
   la firma. Questo è l'errore più comune quando si integra Stripe+Express.
--------------------------------------------------------------------- */
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Verifica firma webhook fallita:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const m = session.metadata || {};
    if (m.bookingId) {
      const datiPrenotazione = {
        id: m.bookingId, roomId: m.roomId, checkIn: m.checkIn, checkOut: m.checkOut,
        adults: parseInt(m.adults, 10) || 1, children: parseInt(m.children, 10) || 0,
        extras: m.extras || '[]',
        guestName: m.guestName || '', guestEmail: m.guestEmail || '',
        guestPhone: m.guestPhone || '', guestNotes: m.guestNotes || '',
        amountCents: parseInt(m.amountCents, 10) || 0,
        stripeSessionId: session.id,
      };
      try {
        await db.createPaidBooking(datiPrenotazione);
        console.log(`✅ Prenotazione ${m.bookingId} creata come pagata (sessione ${session.id})`);
      } catch (err) {
        if (err.code === '23P01') {
          // Il vincolo del database ha bloccato la scrittura: la camera è stata presa da
          // un'altra prenotazione nello stesso istante. Il pagamento è comunque riuscito
          // e va registrato per una verifica manuale (rimborso o sistemazione alternativa).
          await db.createConflictBooking(datiPrenotazione);
          console.error(`⚠️  CONFLITTO: pagamento ${m.bookingId} riuscito ma camera ${m.roomId} già occupata per ${m.checkIn}→${m.checkOut}. Registrata come 'conflitto_da_risolvere' — richiede intervento manuale.`);
        } else {
          throw err;
        }
      }
    }
  }
  // Nota: non serve più gestire 'checkout.session.expired' — se il pagamento non va a
  // buon fine, semplicemente non è mai stata scritta nessuna riga da ripulire.

  res.json({ received: true });
});

// Tutte le altre rotte usano il normale parsing JSON.
app.use(express.json());
app.use(cors());

/* ---------------------------------------------------------------------
   Prezzo — ricalcolato qui dal database, mai fidandosi del client.
--------------------------------------------------------------------- */
async function calculateAmountCents({ roomId, checkIn, checkOut, adults, children, extraIds }) {
  const room = await db.getRoom(roomId);
  if (!room) throw new Error('Camera non valida');
  const nights = Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
  if (nights <= 0) throw new Error('Date non valide');
  const guests = adults + children;
  if (guests > room.max_guests) throw new Error('Troppi ospiti per questa camera');

  const allExtras = await db.getExtras();
  let extrasCents = 0;
  for (const id of extraIds) {
    const ex = allExtras.find(e => e.id === id);
    if (!ex) continue;
    extrasCents += ex.unit === 'per_person_per_night' ? ex.price_cents * guests * nights : ex.price_cents;
  }
  const cityTaxCents = db.CITY_TAX_CENTS * guests * nights;
  const roomCents = room.price_cents * nights;
  return { room, nights, roomCents, extrasCents, cityTaxCents, totalCents: roomCents + extrasCents + cityTaxCents };
}

/* ---------------------------------------------------------------------
   Rotte
--------------------------------------------------------------------- */
app.get('/api/rooms', async (req, res) => {
  try { res.json(await db.getRooms()); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Errore database' }); }
});

app.get('/api/extras', async (req, res) => {
  try { res.json(await db.getExtras()); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Errore database' }); }
});

app.get('/api/availability', async (req, res) => {
  try {
    const { roomId, checkIn, checkOut } = req.query;
    if (!roomId || !checkIn || !checkOut) return res.status(400).json({ error: 'roomId, checkIn e checkOut sono obbligatori' });
    res.json({ available: await db.isRoomAvailable(roomId, checkIn, checkOut) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore database' }); }
});

app.post('/api/checkout', async (req, res) => {
  try {
    const { roomId, checkIn, checkOut, adults, children, extras = [], guest = {} } = req.body;

    if (!(await db.isRoomAvailable(roomId, checkIn, checkOut))) {
      return res.status(409).json({ error: 'Questa camera non è più disponibile per le date scelte.' });
    }

    const { room, nights, roomCents, extrasCents, cityTaxCents, totalCents } =
      await calculateAmountCents({ roomId, checkIn, checkOut, adults, children, extraIds: extras });

    const bookingId = 'AQ-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const datiComuni = {
      id: bookingId, roomId, checkIn, checkOut, adults, children,
      extras: JSON.stringify(extras),
      guestName: guest.name || '', guestEmail: guest.email || '',
      guestPhone: guest.phone || '', guestNotes: guest.notes || '',
      amountCents: totalCents,
    };

    /* "Paga in struttura": bypassa Stripe interamente. Nessun addebito online — la
       prenotazione è comunque reale e va scritta subito, con lo stato che lo rende
       esplicito, così l'hotel sa che quell'importo va ancora incassato di persona. */
    if (guest.payment === 'hotel') {
      try {
        await db.createPayAtPropertyBooking(datiComuni);
      } catch (err) {
        if (err.code === '23P01') {
          return res.status(409).json({ error: 'Questa camera non è più disponibile per le date scelte.' });
        }
        throw err;
      }
      return res.json({
        payLater: true, bookingId,
        room: { name: room.name }, checkIn, checkOut, nights,
        totalCents, guestName: datiComuni.guestName,
      });
    }

    const lineItems = [{
      price_data: {
        currency: 'eur',
        product_data: { name: `${room.name} · ${nights} ${nights === 1 ? 'notte' : 'notti'}` },
        unit_amount: roomCents,
      },
      quantity: 1,
    }];
    if (extrasCents > 0) {
      lineItems.push({
        price_data: { currency: 'eur', product_data: { name: 'Extra selezionati' }, unit_amount: extrasCents },
        quantity: 1,
      });
    }
    lineItems.push({
      price_data: { currency: 'eur', product_data: { name: 'Tassa di soggiorno' }, unit_amount: cityTaxCents },
      quantity: 1,
    });

    // Nessuna riga nel database qui. Tutti i dettagli della prenotazione viaggiano nei
    // metadata della sessione Stripe — verranno letti dal webhook SOLO se il pagamento
    // va davvero a buon fine. Ogni valore metadata deve essere una stringa breve (limite
    // Stripe: 500 caratteri) — troncamento difensivo su nome/note nel caso siano lunghi.
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      customer_email: guest.email || undefined,
      success_url: `${FRONTEND_URL}/success.html?booking=${bookingId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/?cancelled=1`,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      metadata: {
        bookingId, roomId, checkIn, checkOut,
        adults: String(adults), children: String(children),
        extras: JSON.stringify(extras).slice(0, 480),
        guestName: (guest.name || '').slice(0, 480),
        guestEmail: (guest.email || '').slice(0, 480),
        guestPhone: (guest.phone || '').slice(0, 480),
        guestNotes: (guest.notes || '').slice(0, 480),
        amountCents: String(totalCents),
      },
    });

    res.json({ url: session.url, bookingId });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/bookings/:id', async (req, res) => {
  try {
    const booking = await db.getBooking(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Prenotazione non trovata' });
    res.json(booking);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore database' }); }
});

/* ---------------------------------------------------------------------
   Pannello hotel — login e prenotazioni protette da password.
   Un'unica password condivisa (adatta per un solo hotel/staff); se in
   futuro serviranno account separati per più strutture, qui è il punto
   dove passare a utenti veri con Supabase Auth.
--------------------------------------------------------------------- */
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD non configurata sul server.' });
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Password errata.' });
  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

function richiedeAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Accesso richiesto.' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Sessione scaduta, accedi di nuovo.' });
  }
}

app.get('/api/admin/bookings', richiedeAdmin, async (req, res) => {
  try { res.json(await db.getAllBookings()); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Errore database' }); }
});

app.patch('/api/admin/bookings/:id', richiedeAdmin, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['paid', 'da_pagare_struttura', 'annullata'].includes(status)) {
      return res.status(400).json({ error: 'Stato non valido.' });
    }
    const aggiornata = await db.updateBookingStatus(req.params.id, status);
    if (!aggiornata) return res.status(404).json({ error: 'Prenotazione non trovata' });
    res.json(aggiornata);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore database' }); }
});

// Disponibilità di TUTTE le camere per una coppia di date — usa la stessa identica
// funzione isRoomAvailable() del checkout pubblico, così il pannello non può mai
// mostrare "libera" una camera che il sito considera occupata, o viceversa.
app.get('/api/admin/availability', richiedeAdmin, async (req, res) => {
  try {
    const { checkIn, checkOut } = req.query;
    if (!checkIn || !checkOut) return res.status(400).json({ error: 'checkIn e checkOut sono obbligatori' });
    const rooms = await db.getRooms();
    const risultati = await Promise.all(rooms.map(async r => ({
      ...r,
      available: await db.isRoomAvailable(r.id, checkIn, checkOut),
    })));
    res.json(risultati);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore database' }); }
});

// Creazione di una prenotazione direttamente dallo staff (telefono, di persona, ecc.).
// Nessun passaggio da Stripe — lo staff sceglie se segnarla già pagata o da incassare
// in struttura. La disponibilità viene ricontrollata qui, lato server, un'ultima volta
// prima di scrivere: anche se due membri dello staff provano nello stesso istante,
// solo il primo che arriva davvero al database riesce a creare la prenotazione.
app.post('/api/admin/bookings', richiedeAdmin, async (req, res) => {
  try {
    const { roomId, checkIn, checkOut, adults, children, guestName, guestEmail, guestPhone, guestNotes, status } = req.body || {};

    if (!['paid', 'da_pagare_struttura'].includes(status)) {
      return res.status(400).json({ error: 'Stato pagamento non valido.' });
    }
    const room = await db.getRoom(roomId);
    if (!room) return res.status(400).json({ error: 'Camera non valida.' });

    const nights = Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
    if (!checkIn || !checkOut || nights <= 0) return res.status(400).json({ error: 'Date non valide.' });

    const numAdulti = parseInt(adults, 10) || 1;
    const numBambini = parseInt(children, 10) || 0;
    if (numAdulti + numBambini > room.max_guests) {
      return res.status(400).json({ error: `Troppi ospiti per questa camera (massimo ${room.max_guests}).` });
    }

    // Il controllo rapido lato applicazione — per un messaggio d'errore immediato e
    // chiaro. Chi garantisce DAVVERO che non ci si sovrapponga è il vincolo nel database
    // (sotto), che non può essere aggirato nemmeno da due richieste simultanee.
    if (!(await db.isRoomAvailable(roomId, checkIn, checkOut))) {
      return res.status(409).json({ error: 'Questa camera non è disponibile per le date scelte — qualcun altro l\'ha appena presa, o è già occupata.' });
    }

    const guests = numAdulti + numBambini;
    const roomCents = room.price_cents * nights;
    const cityTaxCents = db.CITY_TAX_CENTS * guests * nights;
    const totalCents = roomCents + cityTaxCents;

    const bookingId = 'AQ-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const dati = {
      id: bookingId, roomId, checkIn, checkOut, adults: numAdulti, children: numBambini,
      extras: '[]',
      guestName: guestName || '', guestEmail: guestEmail || '',
      guestPhone: guestPhone || '', guestNotes: guestNotes || '',
      amountCents: totalCents,
    };

    try {
      if (status === 'paid') await db.createPaidBooking({ ...dati, stripeSessionId: null });
      else await db.createPayAtPropertyBooking(dati);
    } catch (err) {
      if (err.code === '23P01') {
        // Il vincolo del database ha bloccato la scrittura: qualcuno l'ha presa un istante prima.
        return res.status(409).json({ error: 'Questa camera è stata appena presa da un\'altra prenotazione — riprova con altre date o un\'altra camera.' });
      }
      throw err;
    }

    const creata = await db.getBooking(bookingId);
    res.json(creata);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore database' }); }
});

app.get('/api/health', (req, res) => res.json({ ok: true, version: 'no-pending-v1-2026-08-16' }));

/* ---------------------------------------------------------------------
   Sito statico — lo stesso backend serve anche hotel-aquila.html,
   success.html e dashboard.html, se li carichi in questa stessa
   cartella/repository. Un solo indirizzo per tutto: niente più
   FRONTEND_URL puntato altrove da tenere allineato a mano.
--------------------------------------------------------------------- */
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'hotel-aquila.html')));

const PORT = process.env.PORT || 3000;

// Crea/verifica le tabelle su Supabase PRIMA di iniziare ad accettare richieste,
// così non arrivano mai chiamate che trovano tabelle ancora inesistenti.
db.initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Hotel Aquila backend attivo su http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('❌ Impossibile inizializzare il database:', err.message);
    process.exit(1);
  });

module.exports = app;

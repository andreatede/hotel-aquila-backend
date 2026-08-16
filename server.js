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
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Stripe = require('stripe');
const db = require('./db');

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('⚠️  STRIPE_SECRET_KEY non impostata — copia .env.example in .env e compilalo.');
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

const app = express();
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5500';

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
      // Controllo difensivo: se nel frattempo la camera è stata presa da un'altra
      // prenotazione (raro, ma possibile con due checkout paralleli), registriamo
      // comunque la prenotazione — il pagamento è stato preso, non si può "annullare"
      // automaticamente — ma logghiamo un avviso per una verifica manuale.
      const libera = await db.isRoomAvailable(m.roomId, m.checkIn, m.checkOut);
      if (!libera) {
        console.warn(`⚠️  ATTENZIONE: ${m.bookingId} pagata ma la camera ${m.roomId} risultava già occupata per ${m.checkIn}→${m.checkOut}. Verifica manuale necessaria.`);
      }
      await db.createPaidBooking({
        id: m.bookingId, roomId: m.roomId, checkIn: m.checkIn, checkOut: m.checkOut,
        adults: parseInt(m.adults, 10) || 1, children: parseInt(m.children, 10) || 0,
        extras: m.extras || '[]',
        guestName: m.guestName || '', guestEmail: m.guestEmail || '',
        guestPhone: m.guestPhone || '', guestNotes: m.guestNotes || '',
        amountCents: parseInt(m.amountCents, 10) || 0,
        stripeSessionId: session.id,
      });
      console.log(`✅ Prenotazione ${m.bookingId} creata come pagata (sessione ${session.id})`);
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
      await db.createPayAtPropertyBooking(datiComuni);
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

app.get('/api/health', (req, res) => res.json({ ok: true, version: 'no-pending-v1-2026-08-16' }));

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

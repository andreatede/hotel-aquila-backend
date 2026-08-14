// server.js — Hotel Aquila backend: availability, checkout, Stripe webhook.
// Ora parla con Postgres (Supabase) tramite db.js — ogni chiamata al database
// è asincrona (await), perché passa dalla rete e non da un file locale.
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
    const bookingId = session.metadata && session.metadata.bookingId;
    if (bookingId) {
      await db.markBookingPaid(bookingId, session.id);
      console.log(`✅ Prenotazione ${bookingId} segnata come pagata (sessione ${session.id})`);
    }
  }
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

    // Chiediamo prima la sessione a Stripe. Solo se Stripe conferma scriviamo
    // la prenotazione nel database — così un checkout fallito/abbandonato non
    // lascia mai una riga "pending" fantasma che blocca quelle date.
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      customer_email: guest.email || undefined,
      success_url: `${FRONTEND_URL}/success.html?booking=${bookingId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/?cancelled=1`,
      metadata: { bookingId },
    });

    await db.createPendingBooking({
      id: bookingId, roomId, checkIn, checkOut, adults, children,
      extras: JSON.stringify(extras),
      guestName: guest.name || '', guestEmail: guest.email || '',
      guestPhone: guest.phone || '', guestNotes: guest.notes || '',
      amountCents: totalCents,
    });
    await db.markSessionId(bookingId, session.id);

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

app.get('/api/health', (req, res) => res.json({ ok: true }));

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

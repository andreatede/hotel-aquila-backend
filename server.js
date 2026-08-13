// server.js — Hotel Aquila backend: availability, checkout, Stripe webhook.
//
// Run locally:
//   1. cp .env.example .env  →  fill in your real Stripe keys
//   2. npm install
//   3. npm start
//   4. In a second terminal:  stripe listen --forward-to localhost:3000/api/webhook
//      (prints a whsec_... value — put it in .env as STRIPE_WEBHOOK_SECRET)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Stripe = require('stripe');
const db = require('./db');

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('⚠️  STRIPE_SECRET_KEY is not set — copy .env.example to .env and fill it in.');
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

const app = express();
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5500';

/* ---------------------------------------------------------------------
   Stripe webhook — MUST be registered BEFORE express.json(), and needs
   the raw request body (not parsed JSON) to verify the signature.
   This ordering is the #1 thing people get wrong with Stripe + Express.
--------------------------------------------------------------------- */
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const bookingId = session.metadata && session.metadata.bookingId;
    if (bookingId) {
      db.markBookingPaid(bookingId, session.id);
      console.log(`✅ Booking ${bookingId} marked as paid (session ${session.id})`);
    }
  }
  res.json({ received: true });
});

// Every other route uses normal JSON parsing.
app.use(express.json());
app.use(cors());

/* ---------------------------------------------------------------------
   Pricing — recalculated here from the DB, never trusted from the client.
   A request that sends its own "total" is ignored; only room/extra IDs
   and dates coming from the client are used to look up real prices.
--------------------------------------------------------------------- */
function calculateAmountCents({ roomId, checkIn, checkOut, adults, children, extraIds }) {
  const room = db.getRoom(roomId);
  if (!room) throw new Error('Camera non valida');
  const nights = Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
  if (nights <= 0) throw new Error('Date non valide');
  const guests = adults + children;
  if (guests > room.max_guests) throw new Error('Troppi ospiti per questa camera');

  const allExtras = db.getExtras();
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
   Routes
--------------------------------------------------------------------- */
app.get('/api/rooms', (req, res) => {
  res.json(db.getRooms());
});

app.get('/api/extras', (req, res) => {
  res.json(db.getExtras());
});

app.get('/api/availability', (req, res) => {
  const { roomId, checkIn, checkOut } = req.query;
  if (!roomId || !checkIn || !checkOut) return res.status(400).json({ error: 'roomId, checkIn e checkOut sono obbligatori' });
  res.json({ available: db.isRoomAvailable(roomId, checkIn, checkOut) });
});

app.post('/api/checkout', async (req, res) => {
  try {
    const { roomId, checkIn, checkOut, adults, children, extras = [], guest = {} } = req.body;

    if (!db.isRoomAvailable(roomId, checkIn, checkOut)) {
      return res.status(409).json({ error: 'Questa camera non è più disponibile per le date scelte.' });
    }

    const { room, nights, roomCents, extrasCents, cityTaxCents, totalCents } =
      calculateAmountCents({ roomId, checkIn, checkOut, adults, children, extraIds: extras });

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

    // Ask Stripe for a session FIRST. Only once Stripe confirms do we write the
    // booking to our own DB — this way a failed/aborted Stripe call never leaves
    // a "pending" row behind that would wrongly block those dates for other guests.
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      customer_email: guest.email || undefined,
      success_url: `${FRONTEND_URL}/success.html?booking=${bookingId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/?cancelled=1`,
      metadata: { bookingId },
    });

    db.createPendingBooking({
      id: bookingId, roomId, checkIn, checkOut, adults, children,
      extras: JSON.stringify(extras),
      guestName: guest.name || '', guestEmail: guest.email || '',
      guestPhone: guest.phone || '', guestNotes: guest.notes || '',
      amountCents: totalCents,
    });
    db.markSessionId(bookingId, session.id);

    res.json({ url: session.url, bookingId });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/bookings/:id', (req, res) => {
  const booking = db.getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Prenotazione non trovata' });
  res.json(booking);
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Hotel Aquila backend attivo su http://localhost:${PORT}`));

module.exports = app;

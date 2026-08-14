// db.js — Postgres (Supabase) version. Stessa "interfaccia" della versione SQLite
// (stessi nomi di funzione), ma ora tutte le funzioni sono async: usa sempre `await`
// quando le chiami, perché parlano con un database remoto via rete, non con un file locale.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL non impostata — imposta la stringa di connessione Supabase su Render.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase richiede una connessione SSL
});

const CITY_TAX_CENTS = 250; // per persona / notte — deve combaciare col frontend

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      max_guests INTEGER NOT NULL,
      size_sqm INTEGER NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS extras (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      unit TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      check_in TEXT NOT NULL,   -- 'YYYY-MM-DD' come stringa, non tipo DATE — Postgres altrimenti
      check_out TEXT NOT NULL,  -- restituirebbe un oggetto Data invece del testo atteso dal frontend
      adults INTEGER NOT NULL,
      children INTEGER NOT NULL DEFAULT 0,
      extras TEXT NOT NULL DEFAULT '[]',
      guest_name TEXT,
      guest_email TEXT,
      guest_phone TEXT,
      guest_notes TEXT,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      stripe_session_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Semina camere ed extra solo se le tabelle sono vuote (non sovrascrive mai dati esistenti).
  const { rows: roomCountRows } = await pool.query('SELECT COUNT(*)::int AS n FROM rooms');
  if (roomCountRows[0].n === 0) {
    const rooms = [
      ['classic', 'Classic Vista Giardino', 12000, 2, 24],
      ['deluxe', 'Deluxe Vista Mare', 18000, 2, 30],
      ['junior', 'Junior Suite Panoramica', 26000, 3, 42],
      ['aquila', 'Suite Aquila', 42000, 4, 65],
    ];
    for (const r of rooms) {
      await pool.query('INSERT INTO rooms (id,name,price_cents,max_guests,size_sqm) VALUES ($1,$2,$3,$4,$5)', r);
    }
  }
  const { rows: extraCountRows } = await pool.query('SELECT COUNT(*)::int AS n FROM extras');
  if (extraCountRows[0].n === 0) {
    const extras = [
      ['breakfast', 'Colazione Gourmet', 1800, 'per_person_per_night'],
      ['transfer', 'Transfer Privato Aeroporto', 4500, 'per_stay'],
      ['spa', 'Percorso Spa di Coppia', 9000, 'per_stay'],
      ['welcome', 'Bottiglia di Benvenuto', 2500, 'per_stay'],
    ];
    for (const e of extras) {
      await pool.query('INSERT INTO extras (id,name,price_cents,unit) VALUES ($1,$2,$3,$4)', e);
    }
  }
}

async function getRooms() {
  const { rows } = await pool.query('SELECT * FROM rooms ORDER BY price_cents');
  return rows;
}
async function getRoom(id) {
  const { rows } = await pool.query('SELECT * FROM rooms WHERE id = $1', [id]);
  return rows[0] || null;
}
async function getExtras() {
  const { rows } = await pool.query('SELECT * FROM extras');
  return rows;
}

// Due intervalli di date si sovrappongono se check_in1 < check_out2 E check_in2 < check_out1.
// Una prenotazione 'pending' blocca la camera solo per 30 minuti (checkout abbandonato si libera da solo).
async function isRoomAvailable(roomId, checkIn, checkOut, excludeBookingId = null) {
  const { rows } = await pool.query(
    `SELECT id FROM bookings
     WHERE room_id = $1
       AND (status = 'paid' OR (status = 'pending' AND created_at > NOW() - INTERVAL '30 minutes'))
       AND check_in < $2
       AND $3 < check_out
       AND ($4::text IS NULL OR id != $4)`,
    [roomId, checkOut, checkIn, excludeBookingId]
  );
  return rows.length === 0;
}

async function createPendingBooking(b) {
  await pool.query(
    `INSERT INTO bookings (id, room_id, check_in, check_out, adults, children, extras, guest_name, guest_email, guest_phone, guest_notes, amount_cents, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending')`,
    [b.id, b.roomId, b.checkIn, b.checkOut, b.adults, b.children, b.extras, b.guestName, b.guestEmail, b.guestPhone, b.guestNotes, b.amountCents]
  );
}

async function markSessionId(bookingId, stripeSessionId) {
  await pool.query('UPDATE bookings SET stripe_session_id = $1 WHERE id = $2', [stripeSessionId, bookingId]);
}
async function markBookingPaid(bookingId, stripeSessionId) {
  await pool.query(`UPDATE bookings SET status = 'paid', stripe_session_id = $1 WHERE id = $2`, [stripeSessionId, bookingId]);
}
async function getBooking(id) {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [id]);
  return rows[0] || null;
}
async function getBookingBySessionId(sessionId) {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE stripe_session_id = $1', [sessionId]);
  return rows[0] || null;
}

module.exports = {
  pool, CITY_TAX_CENTS, initSchema,
  getRooms, getRoom, getExtras,
  isRoomAvailable, createPendingBooking, markSessionId, markBookingPaid, getBooking, getBookingBySessionId,
};

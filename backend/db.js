// db.js — SQLite database: schema, seed data, and query helpers.
// SQLite is a single file on disk (data.db) — perfect to start with zero setup.
// When traffic grows, swap this file for a Postgres client (e.g. via `pg`) —
// every function below keeps the same signature, so the rest of the app doesn't change.

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    max_guests INTEGER NOT NULL,
    size_sqm INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS extras (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    unit TEXT NOT NULL -- 'per_person_per_night' | 'per_stay'
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    check_in TEXT NOT NULL,        -- 'YYYY-MM-DD'
    check_out TEXT NOT NULL,
    adults INTEGER NOT NULL,
    children INTEGER NOT NULL DEFAULT 0,
    extras TEXT NOT NULL DEFAULT '[]',  -- JSON array of extra ids
    guest_name TEXT,
    guest_email TEXT,
    guest_phone TEXT,
    guest_notes TEXT,
    amount_cents INTEGER NOT NULL, -- calculated server-side, never trusted from the client
    status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | cancelled
    stripe_session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Seed the 4 room types once, matching the demo site — edit prices here, not in the frontend.
const roomCount = db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n;
if (roomCount === 0) {
  const insertRoom = db.prepare('INSERT INTO rooms (id,name,price_cents,max_guests,size_sqm) VALUES (?,?,?,?,?)');
  const tx = db.transaction((rooms) => rooms.forEach(r => insertRoom.run(...r)));
  tx([
    ['classic', 'Classic Vista Giardino', 12000, 2, 24],
    ['deluxe',  'Deluxe Vista Mare',      18000, 2, 30],
    ['junior',  'Junior Suite Panoramica',26000, 3, 42],
    ['aquila',  'Suite Aquila',           42000, 4, 65],
  ]);
}
const extraCount = db.prepare('SELECT COUNT(*) AS n FROM extras').get().n;
if (extraCount === 0) {
  const insertExtra = db.prepare('INSERT INTO extras (id,name,price_cents,unit) VALUES (?,?,?,?)');
  const tx = db.transaction((extras) => extras.forEach(e => insertExtra.run(...e)));
  tx([
    ['breakfast', 'Colazione Gourmet',          1800, 'per_person_per_night'],
    ['transfer',  'Transfer Privato Aeroporto', 4500, 'per_stay'],
    ['spa',       'Percorso Spa di Coppia',     9000, 'per_stay'],
    ['welcome',   'Bottiglia di Benvenuto',     2500, 'per_stay'],
  ]);
}

const CITY_TAX_CENTS = 250; // per person / per night — matches the frontend

function getRooms() {
  return db.prepare('SELECT * FROM rooms').all();
}
function getRoom(id) {
  return db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
}
function getExtras() {
  return db.prepare('SELECT * FROM extras').all();
}

// Two date ranges [a1,a2) and [b1,b2) overlap iff a1 < b2 AND b1 < a2.
// A 'pending' booking only blocks the room for 30 minutes — if someone starts
// checkout and abandons it, those dates free up automatically instead of being
// stuck forever. A 'paid' booking always blocks.
function isRoomAvailable(roomId, checkIn, checkOut, excludeBookingId = null) {
  const rows = db.prepare(`
    SELECT id FROM bookings
    WHERE room_id = ?
      AND (status = 'paid' OR (status = 'pending' AND created_at > datetime('now', '-30 minutes')))
      AND check_in < ?
      AND ? < check_out
      AND (? IS NULL OR id != ?)
  `).all(roomId, checkOut, checkIn, excludeBookingId, excludeBookingId);
  return rows.length === 0;
}

function createPendingBooking(booking) {
  db.prepare(`
    INSERT INTO bookings (id, room_id, check_in, check_out, adults, children, extras, guest_name, guest_email, guest_phone, guest_notes, amount_cents, status)
    VALUES (@id, @roomId, @checkIn, @checkOut, @adults, @children, @extras, @guestName, @guestEmail, @guestPhone, @guestNotes, @amountCents, 'pending')
  `).run(booking);
}

function markSessionId(bookingId, stripeSessionId) {
  db.prepare(`UPDATE bookings SET stripe_session_id = ? WHERE id = ?`).run(stripeSessionId, bookingId);
}

function markBookingPaid(bookingId, stripeSessionId) {
  db.prepare(`UPDATE bookings SET status = 'paid', stripe_session_id = ? WHERE id = ?`).run(stripeSessionId, bookingId);
}

function getBooking(id) {
  return db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
}

function getBookingBySessionId(sessionId) {
  return db.prepare('SELECT * FROM bookings WHERE stripe_session_id = ?').get(sessionId);
}

module.exports = {
  db, CITY_TAX_CENTS,
  getRooms, getRoom, getExtras,
  isRoomAvailable, createPendingBooking, markSessionId, markBookingPaid, getBooking, getBookingBySessionId,
};

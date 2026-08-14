-- ============================================================
-- Hotel Aquila — query pronte all'uso per il database su Supabase
-- Supabase → menu laterale → "SQL Editor" → incolla e premi Run (o Ctrl+Invio).
-- Tutte testate contro dati veri prima di consegnartele.
-- ============================================================

-- Chi arriva oggi
SELECT id, guest_name, room_id, adults, children, guest_phone
FROM bookings
WHERE check_in = to_char(CURRENT_DATE, 'YYYY-MM-DD') AND status = 'paid';

-- Chi parte oggi
SELECT id, guest_name, room_id
FROM bookings
WHERE check_out = to_char(CURRENT_DATE, 'YYYY-MM-DD') AND status = 'paid';

-- Tutte le prenotazioni confermate, in ordine di arrivo
SELECT id, guest_name, room_id, check_in, check_out, amount_cents / 100.0 AS totale_euro
FROM bookings
WHERE status = 'paid'
ORDER BY check_in;

-- Cerca una prenotazione per nome, email o codice
SELECT * FROM bookings
WHERE guest_name LIKE '%Rossi%'
   OR guest_email LIKE '%Rossi%'
   OR id LIKE '%Rossi%';

-- Incasso totale confermato (in euro)
SELECT SUM(amount_cents) / 100.0 AS totale_euro
FROM bookings
WHERE status = 'paid';

-- Incasso per camera, questo mese
SELECT room_id, SUM(amount_cents) / 100.0 AS totale_euro, COUNT(*) AS n_prenotazioni
FROM bookings
WHERE status = 'paid' AND check_in LIKE '2026-08%'
GROUP BY room_id
ORDER BY totale_euro DESC;

-- Prenotazioni "pending" ancora aperte (checkout iniziato, non concluso)
SELECT id, guest_name, room_id, created_at
FROM bookings
WHERE status = 'pending'
ORDER BY created_at DESC;

-- Cambiare il prezzo di una camera (esempio: Suite Aquila a 450€/notte)
UPDATE rooms SET price_cents = 45000 WHERE id = 'aquila';
-- prezzi in centesimi: 450,00 EUR = 45000. Camere: classic, deluxe, junior, aquila

-- Annullare manualmente una prenotazione (es. su richiesta telefonica dell'ospite)
UPDATE bookings SET status = 'cancelled' WHERE id = 'AQ-XXXXXXXX';

-- Rivedere una prenotazione annullata per errore
UPDATE bookings SET status = 'paid' WHERE id = 'AQ-XXXXXXXX';

-- Aggiungere una nuova camera (es. una quinta tipologia)
INSERT INTO rooms (id, name, price_cents, max_guests, size_sqm)
VALUES ('panoramica2', 'Suite Panoramica Nord', 32000, 3, 48);

-- Aggiungere un nuovo extra
INSERT INTO extras (id, name, price_cents, unit)
VALUES ('boat', 'Uscita in barca privata', 12000, 'per_stay');
-- unit deve essere 'per_person_per_night' oppure 'per_stay'

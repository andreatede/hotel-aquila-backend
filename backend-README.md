# Hotel Aquila — Backend

Backend per prenotazioni e pagamenti: database Postgres su Supabase (online, condiviso, sempre acceso), controllo disponibilità che impedisce l'overbooking, e checkout con Stripe.

## Cosa fa davvero

- `GET /api/rooms` e `/api/extras` — camere ed extra, letti dal database
- `GET /api/availability` — controlla se una camera è libera in quelle date
- `POST /api/checkout` — ricalcola il prezzo **lato server** (il prezzo che manda il browser non viene mai usato), crea una sessione di pagamento Stripe, restituisce il link a cui reindirizzare l'ospite
- `POST /api/webhook` — Stripe chiama questo indirizzo quando un pagamento va a buon fine; solo allora la prenotazione viene segnata come "paid"

Le prenotazioni "pending" (checkout iniziato ma non concluso) bloccano la camera solo per 30 minuti, poi si liberano da sole. Se Stripe fallisce, non resta nessuna riga a metà nel database.

## 1. Requisiti

- [Node.js](https://nodejs.org) 18 o superiore
- Un progetto [Supabase](https://supabase.com) (database Postgres online, gratuito per iniziare)
- Un account [Stripe](https://dashboard.stripe.com/register)
- [Stripe CLI](https://stripe.com/docs/stripe-cli) (solo per testare i webhook in locale)

## 2. Configura il database su Supabase

1. Nel tuo progetto Supabase, in alto premi **"Connect"**
2. Scheda **"Direct"** → copia la stringa (tipo `postgresql://postgres.xxxx:[YOUR-PASSWORD]@...`)
3. Sostituisci `[YOUR-PASSWORD]` (parentesi comprese) con la password del progetto

Non serve creare le tabelle a mano: il server le crea da solo al primo avvio (funzione `initSchema()` in `db.js`), e le popola con le 4 camere e i 4 extra di partenza.

## 3. Installazione

```bash
npm install
cp .env.example .env
```

Apri `.env` e inserisci:
- `DATABASE_URL` — la stringa di Supabase del passo 2
- `STRIPE_SECRET_KEY` — da Dashboard Stripe → **Sviluppatori → Chiavi API** (in Test mode, inizia con `sk_test_`)
- `STRIPE_WEBHOOK_SECRET` — la ottieni al passo 5
- `FRONTEND_URL` — dove gira il sito (in locale, es. `http://localhost:5500`)

## 4. Avvia il server

```bash
npm start
```

Se vedi `Hotel Aquila backend attivo su http://localhost:3000`, funziona. Prova subito:

```bash
curl http://localhost:3000/api/rooms
```

Poi vai su Supabase → **Table Editor**: dovresti vedere le tabelle `rooms`, `extras`, `bookings` — le prime due già popolate.

## 5. Collega Stripe (webhook, in locale)

In un secondo terminale, lasciato aperto mentre sviluppi:

```bash
stripe login
stripe listen --forward-to localhost:3000/api/webhook
```

Il comando stampa una riga tipo `whsec_xxxxx` — copiala in `.env` come `STRIPE_WEBHOOK_SECRET` e riavvia `npm start`.

## 6. Testa un pagamento vero (in modalità test)

Apri il sito (`hotel-aquila.html`) con un server statico, es. l'estensione "Live Server" di VS Code, o:

```bash
npx serve . -p 5500
```

Fai una prenotazione completa. Alla conferma verrai portato sulla pagina di pagamento ospitata da Stripe. Usa una carta di test:

- Numero: `4242 4242 4242 4242`
- Scadenza: qualsiasi data futura · CVC: `123` · CAP: qualsiasi

Se tutto funziona: il pagamento va a buon fine, Stripe chiama il tuo webhook, il terminale mostra `✅ Prenotazione AQ-XXXXXXXX segnata come pagata`, e la riga in Supabase → Table Editor → `bookings` passa a `status = paid`.

## 7. Deploy (Render, o simili)

1. Carica questi file su un repository GitHub (non caricare mai `.env`)
2. Su Render: New → Web Service → collega il repository
3. Build Command: `npm install` — Start Command: `npm start`
4. In Environment, aggiungi le stesse variabili di `.env` (incluso `DATABASE_URL`)
5. Quando il servizio è online, aggiorna `FRONTEND_URL` con l'indirizzo vero del sito, e configura su Stripe un webhook "vero" (Dashboard → Sviluppatori → Webhook → Aggiungi endpoint → `https://tuo-backend.onrender.com/api/webhook`, evento `checkout.session.completed`) — il signing secret che ti dà va in `STRIPE_WEBHOOK_SECRET` su Render.

Il database è già su Supabase, quindi non ha il problema che aveva SQLite (perdere i dati ad ogni riavvio) — resta sempre lì, indipendentemente da cosa succede al backend.

## 8. Passare a pagamenti reali

Quando sei pronto ad accettare carte vere: completa l'attivazione dell'account Stripe (dati aziendali, IBAN), passa da **Test** a **Live** nella dashboard, prendi le chiavi `sk_live_...` e aggiornale su Render. Ricrea anche il webhook in modalità Live (le chiavi test e live sono separate).

## Nota sui prezzi delle camere

Sono nel database, tabella `rooms`, colonna `price_cents`, in **centesimi** (es. `18000` = €180). Cambiali da Supabase (Table Editor, o SQL Editor con le query in `queries.sql`), non nel frontend: il frontend chiede i prezzi al server ad ogni caricamento.

## Più hotel sullo stesso sistema

Questa versione gestisce **un solo hotel** (Hotel Aquila). Per offrire questo stesso sistema a più strutture, serve un passaggio ulteriore: aggiungere una tabella `hotels` e una colonna `hotel_id` in `rooms` e `bookings`, così un unico database e un unico backend possono servire tutti i clienti, ciascuno vedendo solo i propri dati tramite login. Non è incluso in questa versione — è il prossimo pezzo da costruire quando si passa dal singolo hotel demo alla piattaforma multi-cliente.

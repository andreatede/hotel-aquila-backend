# Hotel Aquila — Backend

Backend minimo ma reale per prenotazioni e pagamenti: database SQLite, controllo disponibilità che impedisce l'overbooking, e checkout con Stripe. Sostituisce la simulazione che c'era nel solo file HTML.

## Cosa fa davvero

- `GET /api/rooms` e `/api/extras` — camere ed extra, letti dal database (non più hardcoded nel frontend)
- `GET /api/availability` — controlla se una camera è libera in quelle date
- `POST /api/checkout` — ricalcola il prezzo **lato server** (il prezzo che manda il browser non viene mai usato, solo gli ID di camera/extra e le date — così nessuno può manomettere il totale da console del browser), crea una sessione di pagamento Stripe, restituisce il link a cui reindirizzare l'ospite
- `POST /api/webhook` — Stripe chiama questo indirizzo quando un pagamento va a buon fine; solo allora la prenotazione viene segnata come "paid"

Le prenotazioni "pending" (checkout iniziato ma non concluso) bloccano la camera solo per 30 minuti, poi si liberano da sole.

## 1. Requisiti

- [Node.js](https://nodejs.org) 18 o superiore
- Un account Stripe gratuito → [dashboard.stripe.com/register](https://dashboard.stripe.com/register)
- [Stripe CLI](https://stripe.com/docs/stripe-cli) (serve solo per testare in locale) → `brew install stripe/stripe-cli/stripe` su Mac, oppure scaricalo da stripe.com/docs/stripe-cli

## 2. Installazione

```bash
npm install
cp .env.example .env
```

Apri `.env` e inserisci:
- `STRIPE_SECRET_KEY` — da Dashboard Stripe → **Sviluppatori → Chiavi API** → "Chiave segreta" (in modalità Test, inizia con `sk_test_`)
- `STRIPE_WEBHOOK_SECRET` — lo ottieni al passo 4
- `FRONTEND_URL` — dove gira il sito (in locale, es. `http://localhost:5500`)

## 3. Avvia il server

```bash
npm start
```

Se vedi `Hotel Aquila backend attivo su http://localhost:3000`, funziona. Prova subito:

```bash
curl http://localhost:3000/api/rooms
```

## 4. Collega Stripe (webhook, in locale)

In un secondo terminale, lasciato aperto mentre sviluppi:

```bash
stripe login
stripe listen --forward-to localhost:3000/api/webhook
```

Il comando stampa una riga tipo `whsec_xxxxx` — copiala in `.env` come `STRIPE_WEBHOOK_SECRET` e riavvia `npm start`.

## 5. Testa un pagamento vero (in modalità test)

Apri il sito (`hotel-aquila.html`) con un server statico, es. l'estensione "Live Server" di VS Code, o:

```bash
npx serve . -p 5500
```

Fai una prenotazione completa. Alla conferma verrai portato sulla pagina di pagamento ospitata da Stripe. Usa una carta di test:

- Numero: `4242 4242 4242 4242`
- Scadenza: qualsiasi data futura · CVC: `123` · CAP: qualsiasi

Se tutto funziona: il pagamento va a buon fine, Stripe chiama il tuo webhook, il terminale col server mostra `✅ Booking AQ-XXXXXXXX marcato come pagato`, e la prenotazione nel database passa a `paid`.

## 6. Passare a pagamenti reali

Quando sei pronto ad accettare carte vere:
1. Su Stripe, completa l'attivazione dell'account (dati aziendali, IBAN)
2. Passa dalla modalità **Test** a **Live** nella dashboard, prendi le chiavi `sk_live_...`
3. Configura un webhook "vero" (non più `stripe listen`): Dashboard → Sviluppatori → Webhook → Aggiungi endpoint → `https://tuodominio.it/api/webhook`, evento da ascoltare: `checkout.session.completed`. Copia il signing secret mostrato lì dentro `STRIPE_WEBHOOK_SECRET` sul server di produzione.

## 7. Andare online (deploy)

Questo file SQLite (`data.db`) vive sul disco del server — su hosting con filesystem "effimero" (che si resetta a ogni deploy) i dati andrebbero persi. Due strade:
- **Più semplice**: hosting con disco persistente — Render.com (piano con "persistent disk"), Fly.io (volumes), o una VPS qualunque
- **Più robusto**: quando il traffico cresce, passa da SQLite a Postgres gestito (Render, Supabase, Neon hanno tutti un piano gratuito) — le funzioni in `db.js` restano le stesse, cambia solo cosa c'è dentro

Ricordati di impostare le variabili d'ambiente (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `FRONTEND_URL`) sul pannello dell'hosting scelto, non dentro al codice.

## Nota sui prezzi delle camere

Sono in `db.js`, nella funzione di seed (`INSERT INTO rooms...`), in **centesimi** (es. `18000` = €180) — è una convenzione comune per evitare errori di arrotondamento con i decimali. Cambiali lì, non nel frontend: il frontend ora chiede i prezzi al server, non li ha più scritti dentro di sé.

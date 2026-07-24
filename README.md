# Waylin's Barbershop

Booking app for Waylin's Barbershop: React + Vite frontend on Firebase Hosting,
Cloud Functions (europe-west1) for all money logic, Firestore for data, Paystack
for payments, Telegram for owner/barber notifications.

- **Live site:** https://waylins-37532.web.app
- **Firebase project:** `waylins-37532` (the only real project)
- **Roadmap / state of the world:** `PLAN-MASTER.md`

## Local development

1. Install dependencies (repo root and functions):
   ```bash
   npm install
   npm --prefix functions install
   ```
2. Copy the environment template and fill in the Firebase **web app** config
   (Firebase console → Project settings → Your apps → SDK setup and configuration):
   ```bash
   cp .env.example .env
   ```
3. Start the dev server:
   ```bash
   npm run dev
   ```

## Environment variables

All frontend variables are Vite-exposed (`VITE_` prefix) and read in
`services/api.ts`. They are the Firebase web config — identifiers, not secrets,
but kept out of git anyway:

| Variable | What it is |
| --- | --- |
| `VITE_FIREBASE_API_KEY` | Firebase web API key |
| `VITE_FIREBASE_AUTH_DOMAIN` | `waylins-37532.firebaseapp.com` |
| `VITE_FIREBASE_PROJECT_ID` | `waylins-37532` |
| `VITE_FIREBASE_STORAGE_BUCKET` | Firebase storage bucket |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | FCM sender id |
| `VITE_FIREBASE_APP_ID` | Firebase web app id |

Server-side secrets (Paystack secret keys, Telegram bot token/chat id) live in
**Cloud Secret Manager** (`firebase functions:secrets:set`), never in `.env`:
`PAYSTACK_SECRET_KEY`, `PAYSTACK_SECRET_KEY_TEST`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`. Payment routing config (mode, public keys, subaccount,
fees) lives in the Firestore doc `settings/paymentConfig`.

## Deploying

Deploys are manual and **always paired with a commit**:

```bash
npm run build
firebase deploy --only functions,hosting
```

The GitHub Action (`.github/workflows/firebase-deploy.yml`) also deploys
hosting to `waylins-37532` on every push to `main`; it needs the
`FIREBASE_SERVICE_ACCOUNT_WAYLINS_37532` repo secret plus the six `VITE_*`
variables above as repo secrets to produce a configured build.

<!-- CI trigger: verify Action deploys to waylins-37532 -->

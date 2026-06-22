# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Waylin's Barbershop is a single-page booking app: a client-facing booking wizard plus an admin dashboard for managing bookings, services, hours, and blockouts. It is a Vite + React 18 + TypeScript SPA with **no backend of its own** — Firebase Firestore is the database, Paystack handles online payments, and Telegram receives booking alerts. All "server" logic lives client-side in `services/api.ts`.

## Commands

```bash
npm install        # install dependencies (CI uses `npm install`, not `npm ci`)
npm run dev        # start Vite dev server
npm run build      # tsc (typecheck, noEmit) + vite build → dist/
npm run preview    # preview the production build
```

There is **no test runner and no linter configured** — `npm run build` (which runs `tsc`) is the only automated check. Type errors fail the build, so run `npm run build` to validate changes. There is no "run a single test" because there are no tests.

A one-off maintenance script exists: `node scripts/addService.js` writes a service directly into Firestore using the same `VITE_FIREBASE_*` env vars (read via `process.env`).

## Architecture

### Routing (`App.tsx`)
Uses **HashRouter** (URLs are `/#/...`) — required because the app is served as static files from Firebase Hosting with a catch-all rewrite to `index.html`. Top-level routes: `/` (HomePage), `/client/*` (ClientPortal booking wizard), `/admin/*` (AdminPortal), plus static policy pages (`/pricing`, `/refund-policy`, `/cancellation-policy`, `/terms`, `/privacy`).

### Data layer — the `api` singleton (`services/api.ts`)
This is the heart of the app. Everything reads and writes through the exported `api` object. Understand this before touching any feature:

- **Real-time, push-based state.** `api.subscribe(listener)` registers a callback and lazily opens Firestore `onSnapshot` listeners on first call. Snapshots update module-level caches (`bookingsCache`, `configCache`) and then `notifyListeners()` re-renders subscribed components. Components read synchronously from `api.getBookings()` / `api.getConfig()` — these return the cache, they do not fetch.
- **Two Firestore locations:** the `bookings` collection (one doc per booking, doc id = booking `id`) and a single config doc at `settings/storeConfig` (services, weekly hours, blockouts). Config writes use `updateDoc` with the whole rewritten array (read-modify-write against the cache).
- **Graceful degradation:** if `VITE_FIREBASE_API_KEY` is absent, `db` stays `null` and every write throws `"Database not connected"`; reads fall back to `INITIAL_CONFIG` from `constants.ts`. Always guard new write methods with `if (db)`.
- **Side effects on write:** `createBooking` and `updateBooking` (on status/payment changes) send a Telegram message via `sendTelegramNotification`. All user-supplied strings in those messages must go through `escapeHTML` (Telegram uses `parse_mode: 'HTML'`).
- **Availability logic:** `getAvailableSlots` generates 30-min-stepped start times for a given date/duration, subtracting closed days, blockouts, and overlapping non-cancelled bookings using `date-fns` interval overlap. This is the canonical slot logic — reuse it rather than reimplementing.

### Auth
"Admin auth" is a **hardcoded password (`'1234'`) in `api.login`**, with a flag persisted to `localStorage` under `STORAGE_KEYS.ADMIN_SESSION`. There is no real server-side auth. Firestore is effectively open from the client. Do not assume any security boundary here.

### Pages
- `pages/ClientPortal.tsx` (~43KB) — multi-step booking wizard (service → date → slot → payment). Contains all Paystack logic.
- `pages/AdminPortal.tsx` (~37KB) — login gate + dashboard with three tabs (`bookings`, `services`, `settings`) selected by local `activeTab` state, rendered as `<BookingsTab/>`, `<ServicesTab/>`, `<SettingsTab/>`.

### Payments (Paystack)
Implemented entirely in `ClientPortal.tsx` via `react-paystack`'s `PaystackButton`. Key conventions:
- Amounts are in **cents** (`Math.round(amount * 100)`), currency `"ZAR"`. Paystack requires an email, so one is synthesized from the client's phone (`{digits}@example.com`).
- Pricing: `total = basePrice + R50 service fee`; a "deposit" option charges half the total.
- **Revenue split** supports two mutually exclusive modes via env:
  - `VITE_PAYSTACK_SUBACCOUNT` (`ACCT_...`) → uses `subaccount` + `transaction_charge` (the creator's cut, capped at the deposit) + `bearer: "subaccount"`. Preferred.
  - `VITE_PAYSTACK_SPLIT_CODE` (`SPL_...`) → legacy `split_code` mode, only used when no subaccount is set.
- A booking is created **only after** `onSuccess`; cash bookings are created immediately. See `PAYSTACK_IMPLEMENTATION_SUMMARY.md` and `PAYSTACK_LIVE_SETUP.md` for the full flow and troubleshooting.

### Domain types (`types.ts`)
`Booking`, `StoreConfig`, `ServiceItem`, `WorkingHours`, `Blockout`, and the enums `PaymentMethod`, `PaymentStatus`, `BookingStatus`. `weeklyHours` is keyed by JS day index (0 = Sunday). Defaults and `STORAGE_KEYS` live in `constants.ts`.

### Styling
Tailwind is loaded from the **CDN in `index.html`** (no build-time Tailwind config / PostCSS). Custom keyframe animations are defined inline in `index.html`. The palette is iOS-style (`#F2F2F7`, `#1C1C1E`, `#007AFF`, etc.). UI primitives: `components/ui/Button.tsx`, `components/ui/Card.tsx`. Toasts go through `services/notifications.ts` (`notify.success/error/info/warning`); `<Toaster/>` is mounted once in `App.tsx`.

## Environment & configuration

All runtime config comes from `VITE_`-prefixed env vars (typed in `vite-env.d.ts`), read via `import.meta.env`. `.env` is gitignored. Required for full function:
`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`, `VITE_PAYSTACK_PUBLIC_KEY`, and one of `VITE_PAYSTACK_SUBACCOUNT` / `VITE_PAYSTACK_SPLIT_CODE`. Telegram alerts use `VITE_TELEGRAM_BOT_TOKEN` and `VITE_TELEGRAM_CHAT_ID`.

> Note: `README.md` and `metadata.json` are leftovers from the AI Studio template and reference a `GEMINI_API_KEY` / `.env.local` that this app does **not** use. Trust the Firebase/Paystack vars above.

## Deployment

Pushing to `main` triggers `.github/workflows/firebase-deploy.yml`, which builds and deploys `dist/` to Firebase Hosting (`channelId: live`). Firebase secrets are injected at build time — note the env-var names referenced in the workflow when adding new ones. Manual deploy: `firebase deploy --only hosting`. `firebase.json` serves `dist/` with a SPA catch-all rewrite to `index.html`.

The Firebase Hosting `projectId` in the deploy workflow (`waylans-barbershop-app`) differs from the `.firebaserc` default (`waylins-37532`); the GitHub Actions value is the one used for live deploys.

# PLAN-MASTER - Everything Remaining, Sequenced

**Status date:** 2026-07-22
**Live project:** waylins-37532 (the only real project; `waylans-barbershop-app` never existed)
**Repo:** C:\Users\Admin User\CascadeProjects\waylins-app (github.com/Quaviousthe3rd/waylins-app)

---

## What is already done and proven

- Trust boundary: Firestore rules deployed, real Firebase Auth admin login, forgeable localStorage session removed.
- Server owns money: `initTransaction` computes every amount from Firestore config. The browser cannot invent a price.
- Payments verified: `paystackWebhook` checks the HMAC signature, writes the booking with the Admin SDK, writes a cent-exact ledger row. Idempotent on reference.
- Money model (owner-approved 2026-07-27, replaces the old grossed-up split): customer pays **base + flat R50** on every service; owner receives **exactly 10% of base**; barber receives **base + (R50 - Paystack fee - owner cut)**. The R50 is the only thing the fee and the owner cut come out of, and the barber keeps every cent left. Paystack's rate is never hardcoded — the split call uses an estimate (`feePercent`/`feeFlatRand`), settlement records the **actual** fee Paystack reports and the exact barber figure, and the statement shows the drift between the two. A base price where R50 cannot cover fee + owner cut is **refused** at `initTransaction` (see A2 for the current threshold), never silently underpaid.
- Test mode: environment-switched via `settings/paymentConfig.mode`, verified end to end with a test card.
- Telegram: notifications land in the shared group after verified payment.

**Everything below is what remains.**

---

## Accepted risks (decided, not oversights)

- **Phone-number lookup stays open.** Anyone who types a phone number sees that number's bookings. Owner's decision: acceptable. For the record, the practical exposure is that someone iterating through numbers could harvest client names, phone numbers and appointment times, and the app currently ships a Privacy Policy page that implies otherwise. Revisit if the shop ever scales or if a client complains, but not a blocker now.

---

## Phase A - Money correctness (before going live)

### A1. Config validation, fail loud — DONE (2026-07-23, commit 9ccc875)
The trailing-space incident silently armed live mode with no public key, and a checkout attempt in that state would have created a real charge. Fix the class of bug, not the instance:
- `getPaymentMode` and `initTransaction` must reject a config that is not explicitly valid: `mode` must be exactly `"test"` or `"live"`, the matching public key must be present and start with `pk_`, `subaccountCode` must start with `ACCT_`.
- Anything else throws a clear error and refuses to serve checkout. Never silently fall through to live.
- Log and reject unrecognised field names on the config doc (this is what would have caught `"mode "` immediately).

### A2. Fee percentage, owner decides
Under the flat-R50 model the configured rate no longer decides anyone's payout — settlement uses the **actual** fee Paystack reports, so a wrong rate only shows up as drift on the statement (Paystack routed the estimate; the owner settles the difference with the barber). Two things still depend on the configured rate:
- the estimated `transaction_charge` sent to Paystack, so a closer rate means smaller drift;
- the **underpay threshold**: with 2.9% + R1 the highest base price the R50 can carry is **R368.64** (at that price the owner's R36.86 + the R13.14 estimated fee is exactly R50). Above it `initTransaction` refuses the booking with a Telegram alert. The whole current menu (R80–R300) is under it. A worse rate lowers the threshold.
- **Blocked on:** the owner's real contracted live rate, read off the live Paystack dashboard. Do not use the test-mode figure and do not use any model-estimated rate.
- Once known, update `feePercent` and `feeFlatRand` in `settings/paymentConfig`. No deploy needed. `quoteService` returns `maxSafeBase` so the new threshold can be read straight back.

### A3. Split preview tool (the owner may change the split model)
Add an admin-only callable `previewSplit({ feePercent, feeFlat, ownerPercent, flatFee })` that returns the full table for every service in the catalog: base, charge, flat fee, owner cut, estimated fee, barber net. Read-only, changes nothing.
Purpose: the owner can model a different split (different percentage, different buffer, percentage-of-total versus percentage-of-base) and see the exact rand outcome per service before committing. Surface it in the admin portal as a simple table when convenient.

### A4. Go live
Deliberate, in this order:
1. Add `publicKeyLive` (the `pk_live_` key) to `settings/paymentConfig`.
2. Register the **live** webhook URL in Paystack's Live section: `https://europe-west1-waylins-37532.cloudfunctions.net/paystackWebhook`.
3. Flip `mode` to `live`.
4. Verify `getPaymentMode` returns live with a `pk_live_` key.
5. One small real booking on the cheapest service, then reconcile the ledger row against the Paystack dashboard to the cent, including the actual fee and the subaccount split.
6. Confirm the barber's subaccount actually received his share in the live dashboard. This is the one thing test mode cannot prove.

---

## Phase B - Booking integrity (the two that embarrass you with real customers)

### B1. Reschedule double-charge (GO-LIVE BLOCKER)
Higher priority than double-booking because it fires reliably from a single user action, not from a coincidence of timing. Current flow creates a new paid booking first, then cancels the old one, and only `console.warn`s if the cancel fails. Result: customer charged twice, two live bookings, no refund.
- Replace with a `rescheduleBooking` callable: verify ownership, move the booking's date and time, release the old slot claim and take the new one, all in one Firestore transaction, with **no new charge**. Paystack cannot move a charge; the original payment stays valid and only the time changes.
- Remove the "Pay and Reschedule" button and all client-side reschedule payment code.

### B2. Slot double-booking
Two people paying for the same slot simultaneously both succeed today.
- `slotClaims/{date}_{HH:mm}` documents, one per 30-minute grid cell, `{ bookingRef, expiresAt, status: held | confirmed }`.
- Claim inside `initTransaction` in a transaction: if any covered cell is confirmed or unexpired-held, abort before the Paystack popup opens.
- Confirm in `paystackWebhook`: flip cells to confirmed alongside the booking write.
- Availability reads must exclude claimed cells (`slotClaims` is public-read, it holds no personal data).
- Every cancel path must release its cells.
- **The trap:** a 60-minute service on a 30-minute grid must claim BOTH cells, or someone books the second half legitimately. Claim `ceil(duration / 30)` cells.
- **Migration:** backfill claims from all existing future non-cancelled bookings before enabling, or day-one collisions with existing appointments are possible.

---

## Phase C - Visibility

### C1. Full lifecycle notifications
See `PLAN-notifications.md` (already written). Firestore trigger on `bookings/{id}` owns booking lifecycle messages (new, cancelled, rescheduled, deleted, status change), `paystackWebhook` expands to refunds, disputes and payment anomalies. Includes the double-notification trap and the `events` audit collection.

### C2. The barber's statement view
The reason this project started. The ledger data exists and reconciles; the barber cannot see any of it.
- Admin portal tab reading `ledger`, grouped by settlement date, each row one client: name, service, date, time, gross charged, Paystack fee, owner cut, barber net, reference.
- Totals per group so a batched Paystack settlement expands into exactly the transactions inside it.
- Exclude any row with `mode: "test"` from totals.
- Bank deposits stay batched (Paystack settles T+1 in lumps, nothing changes that). This screen is the itemised truth that reconciles against them.

### C3. Honest revenue numbers
The dashboard currently sums the full amount of every Confirmed booking regardless of payment state. Replace with Collected and Outstanding, sourced from `ledger` rather than booking documents. Warn the barber the headline number will drop and why, or "the app lost money" becomes a support call.

---

## Phase D - Resilience (the orphan problem)

A webhook outage longer than 30 minutes currently turns a paid booking into an orphan: the customer paid, the pending intent was garbage-collected, and the booking details are gone. Three layers, all cheap, in order of importance:

1. **Scheduled reconciliation sweep (the real fix).** A function running every 15 minutes that asks Paystack for successful transactions in the last 48 hours and settles any that have no matching ledger row, using the same idempotent logic as the webhook. This makes webhook delivery non-critical: Paystack becomes the source of truth and the system self-heals. It would have silently fixed the R180 orphan without anyone noticing.
2. **Extend the pending TTL** from 30 minutes to 48 hours. Booking intent detail must outlive any plausible outage. Clean up only after settlement or expiry, never on a timer short enough to destroy recoverable data.
3. **Admin manual settle.** A button on the ledger view that takes a reference, verifies it against Paystack, and settles it. The human escape hatch when both automated layers fail.

---

## Phase E - Housekeeping (last, per owner's priority)

Detail lives in `PLAN-build-hygiene.md` and `PLAN-correctness-cleanup.md`. Summary:
- Remove the AI-Studio import map so dev and production run the same library versions.
- Fix or delete the dead GitHub Action (it has failed every run since January and deployed nothing; manual deploys are the real pipeline).
- Tailwind as a real build step instead of the CDN.
- CSP and security headers, report-only first so a wrong policy does not silently kill Paystack.
- README rewrite with the real environment variables, plus a real `.env.example`.
- Delete the stale Downloads copy permanently.
- Error boundary, config deep-merge guard, timezone-safe date parsing, negative-value guards.
- Kill the half-built deposit feature and the dead cash path (owner decided: kill both).
- Restore pinch-zoom, keyboard access on service cards, replace native `confirm`/`alert` with the toast UI.
- Test harness: exact-cent money tests, the 60-minute-on-30-minute-grid slot test, a timezone-mocked availability test, webhook idempotency test. Wire into CI so a red test blocks deploy.

---

## Recommended sequence

1. **A1** config validation (small, prevents a repeat of the silent-live incident)
2. **B1** reschedule double-charge (go-live blocker)
3. **A2** fee rate, once the owner supplies the real live figure
4. **A4** go live, with the small real payment and subaccount verification
5. **C1** full notifications
6. **B2** slot claims
7. **C2** statement view, then **C3** honest revenue
8. **D** resilience sweep
9. **E** housekeeping

**Why this order:** A1 and B1 are the two things that can actively cost money or credibility with real customers, so they come before go-live. B2 matters but requires a genuine timing coincidence, and at a single-barber shop's volume the daily risk is low, so it can follow go-live. Everything after that improves the operation rather than protecting it.

**One rule carried forward from every session so far:** deploy and commit happen together, always. Half of this project's lost time came from code that was deployed but never committed, or committed in a folder that was not the real repo.

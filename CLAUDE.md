# waylins-app

This is the REAL repository for waylins-app (remote: github.com/Quaviousthe3rd/waylins-app). All work happens here.

Do NOT work in `C:\Users\Admin User\Downloads\waylins-app-main (2)\waylins-app-main` — that is a stale copy, even if a session is rooted there.

## Session state (2026-07-27)

- Plan 2 core DONE and verified end to end in test mode: server computes all prices, signature-verified webhook, cent-exact ledger row, booking written server-side, Telegram message landing in the group.
- `settings/paymentConfig` is currently mode "test".
- MONEY MODEL (owner-approved 2026-07-27, superseded the grossed-up split): customer pays base + flat R50; owner gets exactly 10% of base; barber gets base + (R50 - Paystack fee - owner cut). Paystack's rate is NEVER hardcoded — the split call sends an estimate, settlement records the actual reported fee plus the exact barber figure and the drift. `initTransaction` REFUSES any base price where R50 can't cover fee + owner cut (R368.64 at 2.9% + R1). All of it lives in functions/src/money.ts — pure and unit-tested; do not recompute money anywhere else.
- Roadmap is PLAN-MASTER.md. Done since: A1, B1, B2, C1, C2, C3, and Phase D (reconciliation sweep every 15 min, 48h pending TTL, admin manual settle — all three settle via the ONE shared `settleCharge` in functions/src/settlement.ts; never duplicate that logic). Next: A2 fee rate then A4 go-live.
- Fee percent is blocked on the owner's real live Paystack rate.
- ADMIN IDENTITY is the allowlist in `settings/adminConfig.adminEmails` (lowercase emails) — never a hardcoded address. firestore.rules `isAdmin()` reads it with `get()`, `manualSettle` checks it with the Admin SDK, and the client treats a successful read of that admin-only doc AS the admin test. Seed/extend with `node scripts/seedAdminConfig.js`, which must run BEFORE the rules that depend on it (chicken-and-egg: no doc => no admins).
- Accepted risk (owner's decision): phone-number booking lookup stays open, not a bug.
- Standing rule: deploy and commit always happen together.

# waylins-app

This is the REAL repository for waylins-app (remote: github.com/Quaviousthe3rd/waylins-app). All work happens here.

Do NOT work in `C:\Users\Admin User\Downloads\waylins-app-main (2)\waylins-app-main` — that is a stale copy, even if a session is rooted there.

## Session state (2026-08-07)

- **LIVE.** `settings/paymentConfig` is mode "live". Test data was purged on 2026-07-28 (backup: `~/waylins-firestore-backups/firestore-backup-2026-07-28T20-02-18Z.json`).
- FIRST REAL CUSTOMER PAYMENT RECONCILED: ref `WAYLINS-1786048344262-W8ZZ3AM5` (Prince, R300, txn 6432323630), settled by webhook, cent-exact against Paystack's own `fees_split`. The live path is proven end to end — init, split, webhook, ledger, booking, Telegram.
- MONEY MODEL (owner-approved 2026-07-27, superseded the grossed-up split): customer pays base + flat R50; owner gets exactly 10% of base; barber gets base + (R50 - Paystack fee - owner cut). Paystack's rate is NEVER hardcoded — the split call sends an estimate, settlement records the actual reported fee plus the exact figures and the drift. `initTransaction` REFUSES any base price where R50 can't cover fee + owner cut (**R353.84** at 2.9% + R1 + 15% VAT). All of it lives in functions/src/money.ts — pure and unit-tested; do not recompute money anywhere else.
- VAT IS PART OF THE FEE. Paystack charges 15% SA VAT on its own fee — the transaction reports `fees_breakdown.amount` (fee proper) and `fees` (what was actually taken); on the R300 charge that was R9.70 -> R11.16. `feeVatPercent` lives in `settings/paymentConfig` (0.15) and `estimateFeeCents` grosses the fee up by it. Never estimate the fee without VAT: doing so made transaction_charge R1.46 light and the owner silently netted under 10% on every sale.
- WHO ABSORBS FEE DRIFT: the OWNER, always. `transaction_charge` is fixed at initialize time and the split uses bearer "account", so Paystack routes exactly `charged - transaction_charge` to the barber's subaccount regardless of the real fee. On a ledger row `barberNetActual` is what the subaccount banked and `ownerNet` = ownerCut + barberDrift is what the owner kept. The Statement shows `ownerNet` (actual money), not `ownerCut` (the 10% entitlement) — it has to match the barber's bank.
- Roadmap is PLAN-MASTER.md. Done since: A1, A2, A4, B1, B2, C1, C2, C3, and Phase D (reconciliation sweep every 15 min, 48h pending TTL, admin manual settle — all three settle via the ONE shared `settleCharge` in functions/src/settlement.ts; never duplicate that logic).
- A2 is UNBLOCKED and closed: the real live rate is confirmed from transaction 6432323630 as **2.9% + R1, plus 15% VAT** (effective 3.335% + R1.15). Both the VAT fix and the drift-attribution fix are deployed.
- Known data quirk: `settings/storeConfig.weeklyHours[3]` (Wednesday) starts at "00:00" instead of "09:00", so Wednesdays offer midnight slots. Not yet fixed.
- ADMIN IDENTITY is the allowlist in `settings/adminConfig.adminEmails` (lowercase emails) — never a hardcoded address. firestore.rules `isAdmin()` reads it with `get()`, `manualSettle` checks it with the Admin SDK, and the client treats a successful read of that admin-only doc AS the admin test. Seed/extend with `node scripts/seedAdminConfig.js`, which must run BEFORE the rules that depend on it (chicken-and-egg: no doc => no admins).
- Accepted risk (owner's decision): phone-number booking lookup stays open, not a bug.
- Standing rule: deploy and commit always happen together.

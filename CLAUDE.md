# waylins-app

This is the REAL repository for waylins-app (remote: github.com/Quaviousthe3rd/waylins-app). All work happens here.

Do NOT work in `C:\Users\Admin User\Downloads\waylins-app-main (2)\waylins-app-main` — that is a stale copy, even if a session is rooted there.

## Session state (2026-07-22)

- Plan 2 core DONE and verified end to end in test mode: server computes all prices, signature-verified webhook, cent-exact ledger row, booking written server-side, Telegram message landing in the group.
- `settings/paymentConfig` is currently mode "test".
- Roadmap is PLAN-MASTER.md. Next: A1 config validation (fail loud on bad config, never silently default to live), then B1 reschedule double-charge fix.
- Fee percent is blocked on the owner's real live Paystack rate.
- Accepted risk (owner's decision): phone-number booking lookup stays open, not a bug.
- Standing rule: deploy and commit always happen together.

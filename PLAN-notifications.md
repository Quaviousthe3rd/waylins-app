# PLAN-notifications - Full Lifecycle Alerts to the Telegram Group

**Goal:** every meaningful event in the system produces a Telegram message in the bookings group: new paid bookings, cancellations (client or admin), reschedules, refunds, disputes, and payment anomalies. Nothing moves in the account without both the owner and the barber seeing it.

**Depends on:** the deployed Plan 2 work (initTransaction, paystackWebhook, ledger, working Telegram secrets). All of that is live and verified.

---

## The architectural decision (do not skip this)

Notifications currently live inside `paystackWebhook`, which only runs when Paystack confirms a charge. Cancellations and reschedules never reach that webhook, so no amount of extra message templates would ever make them notify.

Split responsibility by event source:

- **Booking lifecycle -> a Firestore trigger** on `bookings/{id}` (`onDocumentWritten`). This catches every create, update and delete regardless of who made it: client app, admin portal, a Cloud Function, or a manual edit in the Firebase console. That universality is the whole point.
- **Payment lifecycle -> `paystackWebhook`** expanded beyond `charge.success` to handle refunds, disputes, and anomalies. These never touch a booking document, so the trigger cannot see them.

**Critical consequence:** once the trigger owns booking notifications, `paystackWebhook` must STOP sending its own "new paid booking" message, or every booking notifies twice. The webhook writes the booking, the trigger notices the write and sends the message. One owner per message type.

---

## Files to touch

- `functions/src/telegram.ts` (NEW) - shared send helper, message formatters, non-fatal error handling
- `functions/src/index.ts` - remove the inline Telegram send from `paystackWebhook`, add the Firestore trigger, expand webhook event handling, add `cancelBooking` callable
- `functions/src/types.ts` or inline - `EventType` union for the audit trail
- `firestore.rules` - `events` collection admin-read only, no client writes
- `pages/ClientPortal.tsx` and `pages/AdminPortal.tsx` - route cancellation through the new callable instead of direct Firestore writes (see step 4)

---

## Implementation order

### 1. Extract the Telegram sender
Move the existing send logic from `paystackWebhook` into `functions/src/telegram.ts`:
- `sendTelegram(text: string, mode: PaymentMode): Promise<void>` - prefixes `[TEST]` when mode is test, uses HTML or MarkdownV2 consistently, never throws (catch, log the error body, return).
- Keep the existing message format for new bookings: emoji header, client, phone, service, date, time, total, payment status, reference. The barber already reads that shape.

### 2. Add the booking lifecycle trigger
`onDocumentWritten("bookings/{bookingId}")` in europe-west1, bound to the Telegram secrets. Compute what actually changed and emit one message per meaningful change:

| Change detected | Message |
|---|---|
| Document created with `paymentStatus: Paid` | New paid booking (full detail + reference) |
| Document created with any other status | New unpaid/pending booking |
| `status` changed to Cancelled | Cancellation (who cancelled, service, date, time, amount, whether a refund is owed) |
| `date` or `timeSlot` changed | Reschedule (old date/time -> new date/time) |
| `paymentStatus` changed (e.g. Paid -> Refunded) | Payment status change |
| Document deleted | Booking deleted (admin action) |
| Anything else | No message. Silence is correct for noise. |

Write a matching row to a new `events/{autoId}` collection for every notification: `{ type, bookingId, reference, actor, before, after, mode, createdAt }`. This is the audit trail behind the messages, and it is what a future admin activity feed reads from.

### 3. Expand the webhook's event handling
`paystackWebhook` currently processes `charge.success` only. Add, each with its own message and ledger update:
- `refund.processed` - refund completed. Update the ledger row to `REFUNDED`, set the booking's `paymentStatus`, message the group with amount and reference.
- `refund.pending` and `refund.failed` - message only, no booking change.
- `charge.dispute.create`, `charge.dispute.remind`, `charge.dispute.resolve` - message the group. Disputes are money at risk and must never be silent.
- Keep responding 200 to unhandled event types without processing them.

Anomaly alerts already specified in Plan 2 (`UNMATCHED_PAYMENT`, `AMOUNT_MISMATCH`, `ORPHANED_PAYMENT`) must also send Telegram messages, clearly marked as needing manual attention.

### 4. Route cancellation through a callable
First verify: under the current `firestore.rules`, `bookings` update and delete are admin-only, so **client-side cancellation may already be broken**. Check whether the client cancel button works at all today and report it before changing anything.

Then add a `cancelBooking` callable: takes `{ bookingId, clientPhone }`, verifies the caller owns that booking (phone match against the booking doc), sets `status: Cancelled` and records `cancelledBy: "client"` plus `cancelledAt`. Admin cancellation sets `cancelledBy: "admin"`. The trigger reads `cancelledBy` to attribute the message correctly.

**Refunds stay manual for now.** Cancelling does not refund automatically. The message should state plainly whether money is still held, so a human decides. Automatic refunds move real money from code and belong in their own plan with their own gates.

### 5. Deploy, verify, commit
Deploy functions and rules together. Commit as `feat: full lifecycle telegram notifications via firestore trigger plus refund and dispute events`.

---

## Edge cases a weaker model would miss

- **Double notification.** The webhook writes the booking, then the trigger fires on that same write. If the webhook still sends its own message, every booking notifies twice. Remove the webhook's booking message when adding the trigger, in the same commit, never as a follow-up.
- **Infinite loops.** The trigger must not write back to `bookings/{id}`. Write only to `events/`. A trigger that updates its own collection re-triggers itself.
- **Trigger retries.** Firestore triggers can fire more than once for a single write. Make the event row idempotent: derive a deterministic document ID from `bookingId + changeType + after.updatedAt`, and skip the send if that event row already exists.
- **Meaningless diffs.** The webhook may touch fields like `transactionId` after creation. Only notify on the specific fields in the table above, never on any-change.
- **Notification storms.** An admin bulk-cancelling ten bookings produces ten messages. Acceptable, but log a warning above a threshold (say 5 events in 60 seconds) so a runaway loop is visible rather than silent.
- **Test mode leakage.** Every message must carry the `[TEST]` prefix when the booking or event has `mode: "test"`. Mixing test and live messages in the same group is how a fake booking gets treated as real. Event rows must also carry `mode` so test data can be excluded from any future statement or revenue view.
- **Deletion payloads.** On delete, `after` is empty. Read the booking detail from `before`, or the message will be blank fields.
- **Telegram failures stay non-fatal.** A failed send must never fail the trigger or the webhook, but it must be logged with the full Telegram error body. That logging is exactly what let us diagnose 401 versus "chat not found" earlier.
- **Old bookings.** Documents created before `mode` stamping have no `mode` field. Treat missing mode as live for display, but never let that assumption reach money logic.
- **Message length and formatting.** Telegram rejects malformed markdown with a 400. If using MarkdownV2, escape client names and service names, since a stray underscore or bracket in a name silently kills the message.

---

## Acceptance criteria

1. A test booking produces exactly ONE Telegram message (not two) with the existing format and the `[TEST]` prefix.
2. Cancelling a booking from the client app produces a cancellation message naming the client, service, date, time, amount, and that it was cancelled by the client.
3. Cancelling from the admin portal produces the same message attributed to admin.
4. Changing a booking's date or time produces a reschedule message showing both old and new values.
5. Editing a booking document directly in the Firebase console produces the appropriate message, proving the trigger catches non-app changes.
6. Issuing a refund from the Paystack test dashboard produces a refund message and flips the ledger row to `REFUNDED`.
7. Replaying the same Paystack event produces no duplicate message and no duplicate event row.
8. An `events` row exists for every message sent, with actor and before/after recorded.
9. Deleting a booking produces a message with the booking's details populated, not blanks.
10. A deliberately broken Telegram token causes bookings and payments to still succeed, with the error visible in the function logs.

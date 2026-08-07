import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { PaymentMode, escapeHTML, sendTelegram } from "./telegram";
import { computeActualSplit } from "./money";

// --- Shared settlement core (Phase D) ---
// ONE function turns a successful Paystack charge into a booking + ledger
// row. The webhook, the 15-minute reconciliation sweep, and the admin
// manual-settle button ALL call settleCharge — there is deliberately no
// second copy of this logic anywhere, so the paths can never diverge.
// Idempotency on the reference (ledger/{reference} created exactly once via
// tx.create) is what makes it safe for the sweep and the webhook to race
// each other over the same charge: exactly one of them books, the other
// sees ALREADY_EXISTS and reports ALREADY_SETTLED.
//
// HARD RULE: no Telegram sends inside Firestore transactions. All alerts
// happen after the writes commit.

export const randFromCents = (c: number): number => c / 100;

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

// Same semantics as date-fns areIntervalsOverlapping (exclusive bounds):
// touching end-to-start is NOT an overlap.
export const overlaps = (
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
) => aStart < bEnd && bStart < aEnd;

// Cells are computed by flooring the start to the 30-min grid and covering
// through ceil(end), so even an off-grid legacy timeSlot maps onto the same
// cells a grid-aligned booking would claim.
export const cellIdsFor = (
  date: string,
  timeSlot: string,
  durationMinutes: number
): string[] => {
  const start = toMinutes(timeSlot);
  const end = start + Math.max(1, durationMinutes);
  const first = Math.floor(start / 30);
  const last = Math.ceil(end / 30); // exclusive
  const ids: string[] = [];
  for (let c = first; c < last; c++) {
    const m = c * 30;
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    ids.push(`${date}_${hh}:${mm}`);
  }
  return ids;
};

// A claim blocks unless it belongs to us (by reference or bookingId) or it
// is a held claim that has already expired (server clock).
export const claimBlocks = (
  snap: FirebaseFirestore.DocumentSnapshot,
  nowMs: number,
  ownRef?: string | null,
  ownBookingId?: string | null
): boolean => {
  if (!snap.exists) return false;
  const c = snap.data() as any;
  if (ownRef && c.bookingRef === ownRef) return false;
  if (ownBookingId && c.bookingId === ownBookingId) return false;
  if (c.status === "confirmed") return true;
  if (c.status === "held") {
    const exp = c.expiresAt?.toMillis?.();
    return typeof exp === "number" && exp > nowMs;
  }
  return false;
};

export type SettleSource = "webhook" | "sweep" | "manual";

export interface SettleResult {
  // Every ledger status settleCharge can produce, plus ALREADY_SETTLED
  // (a row for the reference already existed — nothing was written).
  status:
    | "ALREADY_SETTLED"
    | "PAID_BOOKED"
    | "UNMATCHED_PAYMENT"
    | "MODE_MISMATCH"
    | "AMOUNT_MISMATCH"
    | "ORPHANED_PAYMENT"
    | "SLOT_TAKEN_REFUND"
    | "NO_REFERENCE";
  reference: string;
  bookingId: string | null;
  // True when the pending intent was gone and the booking was rebuilt from
  // Paystack's transaction metadata instead.
  recoveredFromMetadata: boolean;
  amountRand: number;
  clientName: string | null;
}

// Settle one successful Paystack charge. `data` is Paystack's transaction
// data object (webhook event.data, list-transactions item, or verify
// response data — all carry reference, amount, id, fees, metadata).
// Throws on genuine write failure (the webhook maps that to a 500 so
// Paystack retries; the sweep catches per-reference).
export const settleCharge = async (
  data: any,
  eventMode: PaymentMode,
  source: SettleSource,
  rawEvent: any
): Promise<SettleResult> => {
  const db = getFirestore();
  const reference = String(data.reference ?? "");
  const chargedCents = Number(data.amount) || 0;
  const base: SettleResult = {
    status: "NO_REFERENCE",
    reference,
    bookingId: null,
    recoveredFromMetadata: false,
    amountRand: randFromCents(chargedCents),
    clientName: null,
  };
  if (!reference) return base;

  const ledgerRef = db.doc(`ledger/${reference}`);
  const paystackFeeActualRand =
    data.fees != null ? randFromCents(Number(data.fees) || 0) : null;

  // Base ledger fields shared by every outcome. The raw event is stored
  // verbatim for reconciliation. `mode` is stamped on EVERY row: rows with
  // mode "test" must be excluded from all revenue/statement totals.
  // `settledBy` records which path wrote the row — "webhook" is health,
  // anything else means webhook delivery failed for this charge.
  const ledgerBase = {
    reference,
    mode: eventMode,
    transactionId: data.id != null ? String(data.id) : null,
    charged: randFromCents(chargedCents),
    paystackFeeActual: paystackFeeActualRand,
    event: rawEvent,
    settledBy: source,
    createdAt: FieldValue.serverTimestamp(),
  };

  // Idempotency fast-path (the transaction below also enforces this
  // atomically via tx.create).
  if ((await ledgerRef.get()).exists) {
    return { ...base, status: "ALREADY_SETTLED" };
  }

  const pendingSnap = await db.doc(`pendingPayments/${reference}`).get();
  let pending = pendingSnap.exists ? (pendingSnap.data() as any) : null;
  let recovered = false;

  // Pending intent gone (outage outlived even the 48h TTL, or data loss):
  // initTransaction puts the full booking detail into Paystack's metadata,
  // so the charge itself usually carries everything needed to rebuild the
  // booking. Attempt that first; UNMATCHED_PAYMENT is the fallback when
  // metadata is insufficient, never the first resort.
  if (!pending) {
    const md = (data.metadata ?? {}) as any;
    const mdName = String(md.clientName ?? "").trim();
    const mdPhone = String(md.clientPhone ?? "").trim();
    const mdService = String(md.serviceName ?? "").trim();
    const mdDate = String(md.date ?? "");
    const mdTime = String(md.timeSlot ?? "");
    if (
      mdName &&
      mdPhone &&
      mdService &&
      DATE_RE.test(mdDate) &&
      TIME_RE.test(mdTime)
    ) {
      recovered = true;
      pending = {
        // Metadata stamps the mode the intent was created in; trust it for
        // the cross-mode guard below, defaulting to the event's own mode.
        mode: md.mode === "test" || md.mode === "live" ? md.mode : eventMode,
        booking: {
          clientName: mdName,
          clientPhone: mdPhone,
          serviceId: String(md.serviceId ?? ""),
          serviceName: mdService,
          durationMinutes: null, // resolved from the service catalog below
          date: mdDate,
          timeSlot: mdTime,
        },
        amounts: {
          // The charge IS the source of truth here — there is no stored
          // quote left to compare against, so the amount check self-passes.
          amountCents: chargedCents,
          totalRand: randFromCents(chargedCents),
          basePriceRand: typeof md.baseAmount === "number" ? md.baseAmount : null,
          ownerCutRand: typeof md.ownerCut === "number" ? md.ownerCut : null,
          barberNetRand: typeof md.barberNet === "number" ? md.barberNet : null,
          estimatedFeeRand:
            typeof md.estimatedFee === "number" ? md.estimatedFee : null,
        },
      };
    }
  }

  // 4. Money arrived with no matching intent AND no usable metadata:
  //    record it, alert, done.
  if (!pending) {
    console.error(
      `charge.success for unknown reference ${reference} (via ${source}); metadata insufficient for recovery`
    );
    try {
      await ledgerRef.create({ ...ledgerBase, status: "UNMATCHED_PAYMENT" });
    } catch (e: any) {
      if (e?.code === 6 /* ALREADY_EXISTS */) {
        return { ...base, status: "ALREADY_SETTLED" };
      }
      throw e;
    }
    await sendTelegram(
      `⚠️ <b>Unmatched Paystack payment — manual attention needed</b>\nReference: <code>${escapeHTML(reference)}</code>\nAmount: R${randFromCents(chargedCents)}\nNo pending booking found and the transaction metadata was not enough to rebuild one — investigate in the Paystack dashboard.`,
      eventMode
    );
    return { ...base, status: "UNMATCHED_PAYMENT" };
  }

  // 4b. Cross-mode guard: an event may only settle an intent created in
  //     the SAME environment. A test-signed charge (free test cards) must
  //     never confirm a live booking intent — that would be a payment
  //     bypass. Record, alert, never book.
  const intentMode: PaymentMode = pending.mode === "test" ? "test" : "live";
  if (intentMode !== eventMode) {
    console.error(
      `MODE_MISMATCH ${reference}: event is ${eventMode}, intent is ${intentMode}`
    );
    try {
      await ledgerRef.create({
        ...ledgerBase,
        bookingId: null,
        status: "MODE_MISMATCH",
        intentMode,
      });
    } catch (e: any) {
      if (e?.code === 6) return { ...base, status: "ALREADY_SETTLED" };
      throw e;
    }
    await sendTelegram(
      `🚨 <b>Paystack mode mismatch — manual attention needed</b>\nReference: <code>${escapeHTML(reference)}</code>\nEvent env: ${eventMode} — booking intent env: ${intentMode}\nNo booking was created. Investigate immediately.`,
      eventMode
    );
    return { ...base, status: "MODE_MISMATCH" };
  }

  const b = pending.booking ?? {};
  const amounts = pending.amounts ?? {};
  const bookingFields = {
    clientName: String(b.clientName ?? ""),
    serviceName: String(b.serviceName ?? ""),
    date: String(b.date ?? ""),
    timeSlot: String(b.timeSlot ?? ""),
  };
  // --- Exact money, from the ACTUAL fee Paystack reported ---
  // The split Paystack already performed used the ESTIMATED fee, so the exact
  // barber figure (base + R50 - actualFee - ownerCut) can differ by a few
  // cents. Both are stored, plus the drift, so the statement can show it and
  // the owner can settle the difference. A rate change on Paystack's side
  // changes only the drift — nothing here assumes a rate.
  const centsOf = (rand: any): number | null =>
    typeof rand === "number" && Number.isFinite(rand) ? Math.round(rand * 100) : null;
  const ownerCutCents =
    typeof amounts.ownerCutCents === "number"
      ? amounts.ownerCutCents
      : centsOf(amounts.ownerCutRand);
  const barberNetRoutedCents = centsOf(amounts.barberNetRand);
  const actualFeeCents = data.fees != null ? Number(data.fees) || 0 : null;
  const split =
    actualFeeCents !== null && ownerCutCents !== null && barberNetRoutedCents !== null
      ? computeActualSplit(
          chargedCents,
          ownerCutCents,
          actualFeeCents,
          barberNetRoutedCents
        )
      : null;

  const ledgerFull = {
    ...ledgerBase,
    ...bookingFields,
    base: amounts.basePriceRand ?? null,
    ownerCut: ownerCutCents !== null ? randFromCents(ownerCutCents) : null,
    estimatedFee: amounts.estimatedFeeRand ?? null,
    // What Paystack routed to the subaccount (estimate-based).
    barberNet: amounts.barberNetRand ?? null,
    // What Paystack actually banked to the subaccount, and how far the fee
    // estimate missed (the miss is absorbed by ownerNet, not by the barber).
    barberNetActual: split ? randFromCents(split.barberNetActualCents) : null,
    barberDrift: split ? randFromCents(split.barberDriftCents) : null,
    ownerNet: split ? randFromCents(split.ownerNetCents) : null,
    ...(recovered ? { recoveredFromMetadata: true } : {}),
  };
  const result = {
    ...base,
    recoveredFromMetadata: recovered,
    clientName: bookingFields.clientName || null,
  };

  // 5. The charge must match the quoted amount EXACTLY (integer cents).
  //    (In metadata recovery there is no stored quote; amountCents was set
  //    to the charge itself above, so this check self-passes.)
  if (chargedCents !== Number(amounts.amountCents)) {
    console.error(
      `AMOUNT_MISMATCH ${reference}: charged ${chargedCents}, expected ${amounts.amountCents}`
    );
    try {
      await ledgerRef.create({
        ...ledgerFull,
        bookingId: null,
        status: "AMOUNT_MISMATCH",
      });
    } catch (e: any) {
      if (e?.code === 6) return { ...base, status: "ALREADY_SETTLED" };
      throw e;
    }
    await sendTelegram(
      `⚠️ <b>Paystack amount mismatch — manual attention needed</b>\nReference: <code>${escapeHTML(reference)}</code>\nCharged: R${randFromCents(chargedCents)} — expected R${randFromCents(Number(amounts.amountCents) || 0)}\nClient: ${escapeHTML(bookingFields.clientName)}\nNo booking was created. Review and refund/adjust manually.`,
      eventMode
    );
    return { ...result, status: "AMOUNT_MISMATCH" };
  }

  // A recovered intent has no stored duration — resolve it from the service
  // catalog by serviceId, falling back to 60 like everywhere else.
  let durationMinutes = Number(b.durationMinutes) || 0;
  if (!durationMinutes) {
    try {
      const storeSnap = await db.doc("settings/storeConfig").get();
      const svc = (storeSnap.data()?.services ?? []).find(
        (s: any) => s.id === String(b.serviceId ?? "")
      );
      durationMinutes = Number(svc?.durationMinutes) || 60;
    } catch {
      durationMinutes = 60;
    }
  }

  // 6. Happy path — one Firestore transaction:
  //    - re-check the slot (someone may have booked between init & now)
  //    - create the ledger row (tx.create = atomic idempotency)
  //    - write the booking ONLY if the slot is still free
  //    Money is never silently dropped: a lost race becomes a
  //    SLOT_TAKEN_REFUND / ORPHANED_PAYMENT ledger row + alert for a
  //    manual refund. PURE body: no Telegram inside (Firestore retries
  //    transactions on contention).
  const bookingRef = db.collection("bookings").doc();
  const slotStart = toMinutes(String(b.timeSlot ?? "00:00"));
  const slotEnd = slotStart + durationMinutes;

  let slotTaken = false;
  let orphaned = false;
  const cellIds = cellIdsFor(
    String(b.date ?? ""),
    String(b.timeSlot ?? "00:00"),
    durationMinutes
  );
  const cellRefs = cellIds.map((id) => db.doc(`slotClaims/${id}`));
  try {
    await db.runTransaction(async (tx) => {
      slotTaken = false;
      orphaned = false;
      // All reads first (Firestore transaction rule), then writes.
      const cellSnaps = await tx.getAll(...cellRefs);
      const sameDay = await tx.get(
        db.collection("bookings").where("date", "==", b.date)
      );
      const nowMs = Date.now();
      // Our held claim may have expired and been stolen between init and
      // settlement. Missing/expired cells we simply re-claim; a cell that is
      // confirmed or held-unexpired by ANOTHER reference means the slot is
      // gone — money must not vanish: ORPHANED_PAYMENT + manual refund.
      const stolen = cellSnaps.some((s) => claimBlocks(s, nowMs, reference));
      const taken = sameDay.docs.some((d) => {
        const other = d.data();
        if (other.status === "Cancelled") return false;
        const oStart = toMinutes(String(other.timeSlot ?? "00:00"));
        const oEnd = oStart + (Number(other.durationMinutes) || 60);
        return overlaps(slotStart, slotEnd, oStart, oEnd);
      });

      // Whenever we cannot book, drop any cells still held by us so the
      // slot is not wedged for the winner's neighbours.
      const releaseOwnCells = () => {
        cellSnaps.forEach((s, i) => {
          if (s.exists && (s.data() as any).bookingRef === reference) {
            tx.delete(cellRefs[i]);
          }
        });
      };

      if (stolen) {
        orphaned = true;
        releaseOwnCells();
        tx.create(ledgerRef, {
          ...ledgerFull,
          bookingId: null,
          status: "ORPHANED_PAYMENT",
        });
      } else if (taken) {
        slotTaken = true;
        releaseOwnCells();
        tx.create(ledgerRef, {
          ...ledgerFull,
          bookingId: null,
          status: "SLOT_TAKEN_REFUND",
        });
      } else {
        tx.create(ledgerRef, {
          ...ledgerFull,
          bookingId: bookingRef.id,
          status: "PAID_BOOKED",
        });
        tx.set(bookingRef, {
          id: bookingRef.id,
          // Test bookings are stamped so they can be filtered out of any
          // revenue/statement totals alongside their ledger rows.
          mode: eventMode,
          clientName: bookingFields.clientName,
          clientPhone: String(b.clientPhone ?? ""),
          date: bookingFields.date,
          timeSlot: bookingFields.timeSlot,
          serviceId: String(b.serviceId ?? ""),
          serviceName: bookingFields.serviceName,
          durationMinutes,
          amount: amounts.totalRand ?? randFromCents(chargedCents),
          depositAmount: amounts.totalRand ?? randFromCents(chargedCents),
          paymentMethod: "Online (Paystack)",
          paymentStatus: "Paid",
          status: "Confirmed",
          createdAt: new Date().toISOString(),
          paymentReference: reference,
          transactionId: data.id != null ? String(data.id) : "",
          ...(recovered ? { recoveredFromMetadata: true } : {}),
        });
        // Flip the reference's cells to confirmed in the SAME transaction
        // that writes the booking.
        cellRefs.forEach((ref, i) => {
          tx.set(ref, {
            bookingRef: reference,
            bookingId: bookingRef.id,
            status: "confirmed",
            date: String(b.date ?? ""),
            time: cellIds[i].slice(String(b.date ?? "").length + 1),
            expiresAt: null,
            createdAt: FieldValue.serverTimestamp(),
          });
        });
      }
      if (pendingSnap.exists) tx.delete(pendingSnap.ref);
    });
  } catch (e: any) {
    if (e?.code === 6 /* ALREADY_EXISTS: concurrent settler won the race */) {
      return { ...result, status: "ALREADY_SETTLED" };
    }
    throw e; // Genuine write failure — caller decides retry semantics.
  }

  // 7. Telegram AFTER the writes; failure is logged only.
  //    NOTE: the happy path sends NOTHING here — the bookings/{id}
  //    Firestore trigger (onBookingWritten) owns the "new paid booking"
  //    message. SLOT_TAKEN_REFUND / ORPHANED_PAYMENT write no booking doc,
  //    so settlement still owns those alerts.
  const who = `${escapeHTML(bookingFields.clientName)} (${escapeHTML(String(b.clientPhone ?? ""))})`;
  const what = `Service: ${escapeHTML(bookingFields.serviceName)}\n${escapeHTML(bookingFields.date)} at ${escapeHTML(bookingFields.timeSlot)}\nPaid: R${randFromCents(chargedCents)}\nReference: <code>${escapeHTML(reference)}</code>`;
  if (orphaned) {
    await sendTelegram(
      `🔴 <b>Orphaned payment — slot claim was stolen, refund needed</b>\nClient: ${who}\n${what}\nTheir hold expired and someone else claimed the slot before payment landed. No booking was created — refund manually in the Paystack dashboard.`,
      eventMode
    );
    return { ...result, status: "ORPHANED_PAYMENT" };
  }
  if (slotTaken) {
    await sendTelegram(
      `🔴 <b>Paid but slot taken — refund needed</b>\nClient: ${who}\n${what}\nRefund manually in the Paystack dashboard.`,
      eventMode
    );
    return { ...result, status: "SLOT_TAKEN_REFUND" };
  }
  return { ...result, status: "PAID_BOOKED", bookingId: bookingRef.id };
};

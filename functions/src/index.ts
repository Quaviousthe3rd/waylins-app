import { setGlobalOptions } from "firebase-functions/v2";
import { onRequest, onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { createHmac, timingSafeEqual } from "crypto";
import {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  PaymentMode,
  escapeHTML,
  sendTelegram,
  sendThrottledAlert,
} from "./telegram";
import {
  settleCharge,
  randFromCents,
  DATE_RE,
  TIME_RE,
  toMinutes,
  overlaps,
  cellIdsFor,
  claimBlocks,
} from "./settlement";

// All functions run in europe-west1.
setGlobalOptions({ region: "europe-west1" });

initializeApp();
const db = getFirestore();

const PAYSTACK_SECRET_KEY = defineSecret("PAYSTACK_SECRET_KEY");
const PAYSTACK_SECRET_KEY_TEST = defineSecret("PAYSTACK_SECRET_KEY_TEST");

// --- Payment mode ---
// settings/paymentConfig.mode switches the ENTIRE money path between
// Paystack live and test integrations.
const secretKeyFor = (mode: PaymentMode): string =>
  mode === "test" ? PAYSTACK_SECRET_KEY_TEST.value() : PAYSTACK_SECRET_KEY.value();

// --- Payment config validation (fail loud) ---
// A trailing space in a field name ("mode ") once silently armed live mode
// with no public key; a checkout in that state would have created a REAL
// charge. Every money-path function validates the config through here and
// REFUSES to serve checkout on anything not explicitly valid. There is no
// fallback to live, ever.
const KNOWN_PAYMENT_CONFIG_FIELDS = new Set([
  "mode",
  "publicKeyTest",
  "publicKeyLive",
  "subaccountCode",
  "feePercent",
  "feeFlatRand",
  "roundToRand",
  "barberBufferRand",
]);

interface ValidPaymentConfig {
  mode: PaymentMode;
  publicKey: string;
  subaccountCode: string;
}

// Fatal config problem: log, alert the Telegram group (so a broken config is
// visible in minutes, not sessions), and refuse to serve checkout.
const paymentConfigError = async (detail: string): Promise<HttpsError> => {
  console.error(`PAYMENT_CONFIG_INVALID: ${detail}`);
  // Throttled: every page load re-triggers this, so identical alerts go out
  // at most once per hour.
  await sendThrottledAlert(
    "cfg-invalid",
    `🚨 <b>Payment config invalid — checkout disabled</b>\n${escapeHTML(detail)}\nFix settings/paymentConfig. Online payment is refused until this is corrected.`
  );
  return new HttpsError(
    "failed-precondition",
    `Payment configuration invalid: ${detail}`
  );
};

const validatePaymentConfig = async (payCfg: any): Promise<ValidPaymentConfig> => {
  if (!payCfg || typeof payCfg !== "object") {
    throw await paymentConfigError(
      "settings/paymentConfig is missing or empty"
    );
  }
  // Unknown field names (this is exactly what "mode " was): loud warning +
  // Telegram alert, but NOT fatal — a harmless extra field must never kill
  // payments. Only the three required checks below are fatal.
  const unknown = Object.keys(payCfg).filter(
    (k) => !KNOWN_PAYMENT_CONFIG_FIELDS.has(k)
  );
  if (unknown.length > 0) {
    const list = unknown.map((k) => JSON.stringify(k)).join(", ");
    console.warn(`PAYMENT_CONFIG_UNKNOWN_FIELDS: ${list}`);
    await sendThrottledAlert(
      "cfg-unknown",
      `⚠️ <b>Unexpected field(s) on settings/paymentConfig</b>\n${escapeHTML(list)}\nPayments still work, but check for typos (a trailing space in a field name once silently broke checkout).`
    );
  }
  const mode = payCfg.mode;
  if (mode !== "test" && mode !== "live") {
    throw await paymentConfigError(
      `mode is ${JSON.stringify(mode)} — must be exactly "test" or "live"`
    );
  }
  const keyField = mode === "test" ? "publicKeyTest" : "publicKeyLive";
  const publicKey = payCfg[keyField];
  if (typeof publicKey !== "string" || !publicKey.startsWith("pk_")) {
    throw await paymentConfigError(
      `${keyField} is missing or does not start with "pk_"`
    );
  }
  const subaccountCode = payCfg.subaccountCode;
  if (typeof subaccountCode !== "string" || !subaccountCode.startsWith("ACCT_")) {
    throw await paymentConfigError(
      `subaccountCode is missing or does not start with "ACCT_"`
    );
  }
  return { mode, publicKey, subaccountCode };
};

// Healthcheck: verifies the deploy pipeline end-to-end before any money logic.
export const ping = onRequest(
  { secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, PAYSTACK_SECRET_KEY, PAYSTACK_SECRET_KEY_TEST] },
  (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  }
);

// Money model lives in money.ts (pure, unit-tested) — see that file for the
// full split documentation.
import { computeQuote, readFeeConfig } from "./money";

// --- Slot claims (B2: atomic double-booking prevention) ---
// slotClaims/{date}_{HH:mm}: one doc per 30-minute grid cell. A booking that
// spans several cells claims ALL of them. Claims are created "held" (expire
// after 15 min) inside initTransaction's Firestore transaction BEFORE the
// Paystack popup opens, and flipped to "confirmed" in the same transaction
// that writes the booking. Expired held claims are treated as free inside
// the claim transaction itself — no scheduler. All claim logic is PURE (no
// Telegram or other side effects inside transaction bodies): Firestore
// retries transactions on contention.
const HOLD_MS = 15 * 60 * 1000;

const makeReference = (): string => {
  const rand = Array.from({ length: 8 }, () =>
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".charAt(Math.floor(Math.random() * 32))
  ).join("");
  return `WAYLINS-${Date.now()}-${rand}`;
};

export const initTransaction = onCall(
  {
    secrets: [
      PAYSTACK_SECRET_KEY,
      PAYSTACK_SECRET_KEY_TEST,
      TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID,
    ],
  },
  async (request) => {
    const { serviceId, date, timeSlot, clientName, clientPhone } =
      request.data ?? {};

    // 1. Validate inputs.
    if (typeof serviceId !== "string" || !serviceId.trim()) {
      throw new HttpsError("invalid-argument", "serviceId is required.");
    }
    if (typeof date !== "string" || !DATE_RE.test(date)) {
      throw new HttpsError("invalid-argument", "date must be yyyy-MM-dd.");
    }
    if (typeof timeSlot !== "string" || !TIME_RE.test(timeSlot)) {
      throw new HttpsError("invalid-argument", "timeSlot must be HH:mm.");
    }
    if (typeof clientName !== "string" || !clientName.trim()) {
      throw new HttpsError("invalid-argument", "clientName is required.");
    }
    if (typeof clientPhone !== "string" || !clientPhone.trim()) {
      throw new HttpsError("invalid-argument", "clientPhone is required.");
    }

    // 2. Resolve the service server-side — never trust a client-sent price.
    const storeSnap = await db.doc("settings/storeConfig").get();
    if (!storeSnap.exists) {
      throw new HttpsError("failed-precondition", "Store is not configured.");
    }
    const store = storeSnap.data() as any;
    const service = (store.services ?? []).find((s: any) => s.id === serviceId);
    if (!service) {
      throw new HttpsError("not-found", "Unknown service. Please refresh and try again.");
    }
    const durationMinutes = Number(service.durationMinutes) || 60;
    const basePriceRand = Number(service.price);
    if (!Number.isFinite(basePriceRand) || basePriceRand <= 0) {
      throw new HttpsError("failed-precondition", "Service has an invalid price.");
    }

    // 2b. Lazy cleanup: delete pendingPayments older than 48 HOURS.
    //     Booking intent detail must outlive any plausible webhook outage —
    //     a 30-minute TTL once garbage-collected a paid booking's details
    //     before its webhook arrived (the orphan incident). 48h matches the
    //     reconciliation sweep's lookback window, so an intent always
    //     survives long enough for the sweep to settle it. Slot claims keep
    //     their separate 15-minute hold — that is a different concern.
    //     Best-effort: a cleanup failure must never block a paying customer.
    try {
      const cutoff = Timestamp.fromMillis(Date.now() - 48 * 60 * 60 * 1000);
      const stale = await db
        .collection("pendingPayments")
        .where("createdAt", "<", cutoff)
        .limit(100)
        .get();
      if (!stale.empty) {
        const batch = db.batch();
        stale.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        console.log(`Cleaned up ${stale.size} expired pendingPayments.`);
      }
    } catch (e) {
      console.error("pendingPayments cleanup failed (non-fatal)", e);
    }

    // 2c. Lazy cleanup of slotClaims, same pattern, best-effort:
    //     - expired held claims (only held claims carry expiresAt, so this
    //       single-field query never touches confirmed claims)
    //     - claims for past dates (confirmed or not — the day is over)
    try {
      const now = Timestamp.now();
      // "Past" = strictly before yesterday (UTC minus 24h), so timezone skew
      // can never delete a claim for a day that is still in progress locally.
      const pastCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const [expired, past] = await Promise.all([
        db.collection("slotClaims").where("expiresAt", "<", now).limit(100).get(),
        db.collection("slotClaims").where("date", "<", pastCutoff).limit(100).get(),
      ]);
      const doomed = [...expired.docs, ...past.docs];
      if (doomed.length > 0) {
        const batch = db.batch();
        const seen = new Set<string>();
        doomed.forEach((d) => {
          if (!seen.has(d.ref.path)) { seen.add(d.ref.path); batch.delete(d.ref); }
        });
        await batch.commit();
        console.log(`Cleaned up ${seen.size} stale slotClaims.`);
      }
    } catch (e) {
      console.error("slotClaims cleanup failed (non-fatal)", e);
    }

    // 3. Recheck the slot against non-cancelled bookings and blockouts
    //    (same overlap logic as the client's getAvailableSlots).
    const slotStart = toMinutes(timeSlot);
    const slotEnd = slotStart + durationMinutes;

    const bookingsSnap = await db
      .collection("bookings")
      .where("date", "==", date)
      .get();
    const taken = bookingsSnap.docs.some((d) => {
      const b = d.data();
      if (b.status === "Cancelled") return false;
      const bStart = toMinutes(String(b.timeSlot ?? "00:00"));
      const bEnd = bStart + (Number(b.durationMinutes) || 60);
      return overlaps(slotStart, slotEnd, bStart, bEnd);
    });
    if (taken) {
      throw new HttpsError(
        "already-exists",
        "That time slot has just been taken. Please pick another slot."
      );
    }
    const blocked = (store.blockouts ?? []).some((b: any) => {
      if (b.date !== date) return false;
      return overlaps(slotStart, slotEnd, toMinutes(b.startTime), toMinutes(b.endTime));
    });
    if (blocked) {
      throw new HttpsError(
        "already-exists",
        "That time is no longer available. Please pick another slot."
      );
    }

    // 4. Payment routing config (server-only doc; clients can't read it).
    //    Strictly validated — an invalid config refuses checkout entirely
    //    rather than ever falling through to live.
    const paySnap = await db.doc("settings/paymentConfig").get();
    const { mode, subaccountCode } = await validatePaymentConfig(paySnap.data());

    // 5. Amounts.
    const quote = computeQuote(Math.round(basePriceRand * 100), readFeeConfig(paySnap.data()));
    if (quote.barberNetCents < quote.baseCents) {
      // Should be impossible by construction; refuse rather than short the barber.
      throw new HttpsError("internal", "Pricing configuration error.");
    }

    // 6. ATOMICALLY claim every 30-min cell the service covers, BEFORE the
    //    Paystack popup opens. One transaction: read all cells, abort with a
    //    clean "slot taken" if any is confirmed or held-and-unexpired,
    //    otherwise create them all as held (15-min expiry). Expired held
    //    claims are treated as free right here — no scheduler. Pure: no side
    //    effects in the body (Firestore retries on contention).
    const reference = makeReference();
    const cellIds = cellIdsFor(date, timeSlot, durationMinutes);
    const cellRefs = cellIds.map((id) => db.doc(`slotClaims/${id}`));
    await db.runTransaction(async (tx) => {
      const snaps = await tx.getAll(...cellRefs);
      const nowMs = Date.now(); // server clock, never a client's
      if (snaps.some((s) => claimBlocks(s, nowMs))) {
        throw new HttpsError(
          "already-exists",
          "That time slot has just been taken. Please pick another slot."
        );
      }
      const expiresAt = Timestamp.fromMillis(nowMs + HOLD_MS);
      cellRefs.forEach((ref, i) => {
        tx.set(ref, {
          bookingRef: reference,
          bookingId: null,
          status: "held",
          date,
          time: cellIds[i].slice(date.length + 1),
          expiresAt,
          createdAt: FieldValue.serverTimestamp(),
        });
      });
    });
    // Best-effort release if anything below fails: without this the cells
    // stay dead for 15 minutes on a Paystack outage.
    const releaseHeldCells = async () => {
      try {
        const batch = db.batch();
        const snaps = await db.getAll(...cellRefs);
        snaps.forEach((s) => {
          if (s.exists && (s.data() as any).bookingRef === reference) {
            batch.delete(s.ref);
          }
        });
        await batch.commit();
      } catch (e) {
        console.error(`could not release held cells for ${reference} (they expire in 15 min)`, e);
      }
    };

    // 7. Record the intent before contacting Paystack.
    await db.doc(`pendingPayments/${reference}`).set({
      reference,
      mode,
      status: "initialized",
      booking: {
        clientName: clientName.trim(),
        clientPhone: clientPhone.trim(),
        serviceId,
        serviceName: service.name,
        durationMinutes,
        date,
        timeSlot,
      },
      amounts: {
        currency: "ZAR",
        basePriceRand,
        ownerCutRand: randFromCents(quote.ownerCutCents),
        serviceFeeRand: randFromCents(quote.serviceFeeCents),
        totalRand: randFromCents(quote.chargeCents),
        barberNetRand: randFromCents(quote.barberNetCents),
        estimatedFeeRand: randFromCents(quote.estimatedFeeCents),
        amountCents: quote.chargeCents,
        transactionChargeCents: quote.transactionChargeCents,
      },
      createdAt: FieldValue.serverTimestamp(),
    });

    // 8. Initialize the Paystack transaction. NOTE: subaccount split with a
    //    flat transaction_charge; SPL_ split codes are deliberately not used.
    //    In test mode the split params are omitted (no real subaccount) and
    //    the test secret key is used; everything else is identical.
    const resp = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKeyFor(mode)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: quote.chargeCents,
        currency: "ZAR",
        email: "bookings@waylins-37532.web.app",
        reference,
        ...(mode === "live"
          ? {
              subaccount: subaccountCode,
              transaction_charge: quote.transactionChargeCents,
              bearer: "account",
            }
          : {}),
        metadata: {
          mode,
          reference,
          clientName: clientName.trim(),
          clientPhone: clientPhone.trim(),
          serviceId,
          serviceName: service.name,
          date,
          timeSlot,
          baseAmount: basePriceRand,
          serviceFee: randFromCents(quote.serviceFeeCents),
          ownerCut: randFromCents(quote.ownerCutCents),
          barberNet: randFromCents(quote.barberNetCents),
        },
      }),
    });
    const body: any = await resp.json().catch(() => null);
    if (!resp.ok || !body?.status || !body?.data?.authorization_url) {
      console.error("Paystack initialize failed", resp.status, body?.message);
      await db
        .doc(`pendingPayments/${reference}`)
        .set({ status: "init_failed", paystackError: body?.message ?? `HTTP ${resp.status}` }, { merge: true });
      await releaseHeldCells();
      throw new HttpsError("internal", "Could not start the payment. Please try again.");
    }

    await db
      .doc(`pendingPayments/${reference}`)
      .set({ status: "awaiting_payment", accessCode: body.data.access_code ?? null }, { merge: true });

    return {
      reference,
      access_code: body.data.access_code ?? null,
      authorization_url: body.data.authorization_url,
    };
  }
);

// Public quote: what a booking will cost and how it splits, computed with the
// same code path as initTransaction. Never exposes the subaccount code.
export const quoteService = onCall(
  { secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID] },
  async (request) => {
  const { serviceId } = request.data ?? {};
  if (typeof serviceId !== "string" || !serviceId.trim()) {
    throw new HttpsError("invalid-argument", "serviceId is required.");
  }
  const storeSnap = await db.doc("settings/storeConfig").get();
  const service = (storeSnap.data()?.services ?? []).find(
    (s: any) => s.id === serviceId
  );
  if (!service) {
    throw new HttpsError("not-found", "Unknown service.");
  }
  const paySnap = await db.doc("settings/paymentConfig").get();
  // Fail loud on a broken config before quoting a price for it.
  await validatePaymentConfig(paySnap.data());
  const quote = computeQuote(
    Math.round(Number(service.price) * 100),
    readFeeConfig(paySnap.data())
  );
  return {
    base: randFromCents(quote.baseCents),
    serviceFee: randFromCents(quote.serviceFeeCents),
    total: randFromCents(quote.chargeCents),
    barberNet: randFromCents(quote.barberNetCents),
    ownerCut: randFromCents(quote.ownerCutCents),
  };
  }
);

// Public, non-sensitive payment environment for the client UI: which mode
// is active and which Paystack PUBLIC key to mount checkout with. Public
// keys live in settings/paymentConfig as publicKeyLive / publicKeyTest.
// Never returns secrets or the subaccount code.
export const getPaymentMode = onCall(
  { secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID] },
  async () => {
    const payCfg = (await db.doc("settings/paymentConfig").get()).data();
    const { mode, publicKey } = await validatePaymentConfig(payCfg);
    return { mode, publicKey };
  }
);

// --- Booking lifecycle callables (no money movement) ---
// Ownership is proven by clientPhone matching the booking's stored phone —
// the same (accepted-risk) trust level as the phone-number booking lookup.
// Neither callable touches Paystack or payment fields, and neither sends
// Telegram: the C1 Firestore trigger will own booking lifecycle messages.

const requireOwnedBooking = (
  snap: FirebaseFirestore.DocumentSnapshot,
  clientPhone: unknown
): any => {
  if (typeof clientPhone !== "string" || !clientPhone.trim()) {
    throw new HttpsError("invalid-argument", "clientPhone is required.");
  }
  if (!snap.exists) {
    throw new HttpsError("not-found", "Booking not found.");
  }
  const booking = snap.data() as any;
  if (String(booking.clientPhone ?? "") !== clientPhone.trim()) {
    throw new HttpsError(
      "permission-denied",
      "This booking belongs to a different phone number."
    );
  }
  return booking;
};

// Reschedule = move the EXISTING booking to a new date/time. The original
// payment stays valid; NO new charge, NO new booking doc, ZERO Paystack
// calls. Payment fields (paymentStatus, paymentReference, transactionId,
// amount) are never touched.
export const rescheduleBooking = onCall(async (request) => {
  const { bookingId, clientPhone, newDate, newTimeSlot } = request.data ?? {};
  if (typeof bookingId !== "string" || !bookingId.trim()) {
    throw new HttpsError("invalid-argument", "bookingId is required.");
  }
  if (typeof newDate !== "string" || !DATE_RE.test(newDate)) {
    throw new HttpsError("invalid-argument", "newDate must be yyyy-MM-dd.");
  }
  if (typeof newTimeSlot !== "string" || !TIME_RE.test(newTimeSlot)) {
    throw new HttpsError("invalid-argument", "newTimeSlot must be HH:mm.");
  }

  const bookingRef = db.doc(`bookings/${bookingId}`);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(bookingRef);
    const booking = requireOwnedBooking(snap, clientPhone);
    if (booking.status === "Cancelled") {
      throw new HttpsError(
        "failed-precondition",
        "This booking has been cancelled and cannot be rescheduled."
      );
    }

    // The new slot must be free — same overlap logic as getAvailableSlots,
    // EXCLUDING this booking's own current slot, with the || 60 duration
    // fallback for legacy docs.
    const durationMinutes = Number(booking.durationMinutes) || 60;
    const slotStart = toMinutes(newTimeSlot);
    const slotEnd = slotStart + durationMinutes;

    const sameDay = await tx.get(
      db.collection("bookings").where("date", "==", newDate)
    );
    const taken = sameDay.docs.some((d) => {
      if (d.id === bookingId) return false;
      const other = d.data();
      if (other.status === "Cancelled") return false;
      const oStart = toMinutes(String(other.timeSlot ?? "00:00"));
      const oEnd = oStart + (Number(other.durationMinutes) || 60);
      return overlaps(slotStart, slotEnd, oStart, oEnd);
    });
    if (taken) {
      throw new HttpsError(
        "already-exists",
        "That time slot has just been taken. Please pick another slot."
      );
    }

    const storeSnap = await tx.get(db.doc("settings/storeConfig"));
    const blocked = (storeSnap.data()?.blockouts ?? []).some((b: any) => {
      if (b.date !== newDate) return false;
      return overlaps(slotStart, slotEnd, toMinutes(b.startTime), toMinutes(b.endTime));
    });
    if (blocked) {
      throw new HttpsError(
        "already-exists",
        "That time is no longer available. Please pick another slot."
      );
    }

    // Slot claims: release old cells, take new ones, in THIS transaction.
    // The check excludes this booking's own claims (by bookingId or payment
    // reference) — otherwise a same-day move to an overlapping time would
    // deadlock against itself. All reads happen before any write.
    const ownRef = String(booking.paymentReference ?? "") || null;
    const oldCellIds = cellIdsFor(
      String(booking.date ?? ""),
      String(booking.timeSlot ?? "00:00"),
      durationMinutes
    );
    const newCellIds = cellIdsFor(newDate, newTimeSlot, durationMinutes);
    const oldCellRefs = oldCellIds.map((id) => db.doc(`slotClaims/${id}`));
    const newCellRefs = newCellIds.map((id) => db.doc(`slotClaims/${id}`));
    const [oldSnaps, newSnaps] = await Promise.all([
      tx.getAll(...oldCellRefs),
      tx.getAll(...newCellRefs),
    ]);
    const nowMs = Date.now();
    if (newSnaps.some((s) => claimBlocks(s, nowMs, ownRef, bookingId))) {
      throw new HttpsError(
        "already-exists",
        "That time slot has just been taken. Please pick another slot."
      );
    }
    const newIdSet = new Set(newCellIds);
    oldSnaps.forEach((s, i) => {
      if (newIdSet.has(oldCellIds[i])) return; // overwritten below
      if (!s.exists) return;
      const c = s.data() as any;
      if (c.bookingId === bookingId || (ownRef && c.bookingRef === ownRef)) {
        tx.delete(oldCellRefs[i]);
      }
    });
    newCellRefs.forEach((ref, i) => {
      tx.set(ref, {
        bookingRef: ownRef,
        bookingId,
        status: "confirmed",
        date: newDate,
        time: newCellIds[i].slice(newDate.length + 1),
        expiresAt: null,
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    tx.update(bookingRef, {
      date: newDate,
      timeSlot: newTimeSlot,
      rescheduledFrom: {
        date: String(booking.date ?? ""),
        timeSlot: String(booking.timeSlot ?? ""),
        at: FieldValue.serverTimestamp(),
      },
    });
  });

  return { ok: true, bookingId, date: newDate, timeSlot: newTimeSlot };
});

// Client-side cancel. No refund — refunds stay manual and human-decided.
export const cancelBooking = onCall(async (request) => {
  const { bookingId, clientPhone } = request.data ?? {};
  if (typeof bookingId !== "string" || !bookingId.trim()) {
    throw new HttpsError("invalid-argument", "bookingId is required.");
  }

  const bookingRef = db.doc(`bookings/${bookingId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(bookingRef);
    const booking = requireOwnedBooking(snap, clientPhone);
    if (booking.status === "Cancelled") {
      return; // Already cancelled — idempotent success.
    }
    // Release this booking's slot claim cells (reads before writes).
    const ownRef = String(booking.paymentReference ?? "") || null;
    const cellIds = cellIdsFor(
      String(booking.date ?? ""),
      String(booking.timeSlot ?? "00:00"),
      Number(booking.durationMinutes) || 60
    );
    const cellSnaps = await tx.getAll(
      ...cellIds.map((id) => db.doc(`slotClaims/${id}`))
    );
    tx.update(bookingRef, {
      status: "Cancelled",
      cancelledBy: "client",
      cancelledAt: FieldValue.serverTimestamp(),
    });
    cellSnaps.forEach((s) => {
      if (!s.exists) return;
      const c = s.data() as any;
      if (c.bookingId === bookingId || (ownRef && c.bookingRef === ownRef)) {
        tx.delete(s.ref);
      }
    });
  });

  return { ok: true, bookingId };
});

// --- Booking lifecycle trigger ---
// The ONE owner of ALL booking lifecycle messages: created, cancelled,
// rescheduled, payment status changed, deleted. Fires on every write to
// bookings/{id} regardless of author (webhook, callable, admin portal, or a
// manual Firebase-console edit — that universality is the point).
//
// HARD RULE: this trigger NEVER writes to bookings/ (it would re-trigger
// itself forever). It writes only events/ rows — the audit trail behind the
// messages. Event rows use a deterministic ID (bookingId + changeType +
// commit time) so a retried trigger run skips the send instead of
// duplicating it.

interface BookingChange {
  type: string;
  actor: string;
  text: string;
}

export const onBookingWritten = onDocumentWritten(
  {
    document: "bookings/{bookingId}",
    secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID],
  },
  async (event) => {
    const bookingId = event.params.bookingId;
    const before = event.data?.before?.exists
      ? (event.data.before.data() as any)
      : null;
    const after = event.data?.after?.exists
      ? (event.data.after.data() as any)
      : null;
    if (!before && !after) return;

    // Slot-claim upkeep for writes that do NOT go through a server callable
    // (admin cancel / delete / date edit are direct Firestore writes from the
    // portal). Idempotent, so re-running over callable-managed changes is
    // harmless. Deletes/creates only slotClaims — never bookings/ — and sends
    // no Telegram (C1 owns lifecycle messages). Best-effort: claim upkeep
    // must never block the notification path.
    try {
      const releaseFor = async (bk: any) => {
        const ownRef = String(bk.paymentReference ?? "") || null;
        const ids = cellIdsFor(
          String(bk.date ?? ""),
          String(bk.timeSlot ?? "00:00"),
          Number(bk.durationMinutes) || 60
        );
        const snaps = await db.getAll(...ids.map((id) => db.doc(`slotClaims/${id}`)));
        const batch = db.batch();
        let any = false;
        snaps.forEach((s) => {
          if (!s.exists) return;
          const c = s.data() as any;
          if (c.bookingId === bookingId || (ownRef && c.bookingRef === ownRef)) {
            batch.delete(s.ref);
            any = true;
          }
        });
        if (any) await batch.commit();
      };
      const confirmFor = async (bk: any) => {
        const ids = cellIdsFor(
          String(bk.date ?? ""),
          String(bk.timeSlot ?? "00:00"),
          Number(bk.durationMinutes) || 60
        );
        const batch = db.batch();
        ids.forEach((id) => {
          batch.set(db.doc(`slotClaims/${id}`), {
            bookingRef: String(bk.paymentReference ?? "") || null,
            bookingId,
            status: "confirmed",
            date: String(bk.date ?? ""),
            time: id.slice(String(bk.date ?? "").length + 1),
            expiresAt: null,
            createdAt: FieldValue.serverTimestamp(),
          });
        });
        await batch.commit();
      };

      const wasCancelled = String(before?.status ?? "") === "Cancelled";
      const isCancelled = String(after?.status ?? "") === "Cancelled";
      const moved =
        before && after &&
        (String(before.date ?? "") !== String(after.date ?? "") ||
          String(before.timeSlot ?? "") !== String(after.timeSlot ?? ""));

      if (!before && after && !isCancelled) {
        // Created. The webhook already confirmed its cells in-transaction
        // (idempotent overwrite); this also covers admin-created bookings.
        await confirmFor(after);
      } else if (before && !after) {
        await releaseFor(before); // deleted
      } else if (before && after && !wasCancelled && isCancelled) {
        await releaseFor(before); // cancelled
      } else if (before && after && wasCancelled && !isCancelled) {
        await confirmFor(after); // un-cancelled by admin: re-claim
      } else if (moved && !isCancelled) {
        await releaseFor(before); // admin date/time edit: move the claims
        await confirmFor(after);
      }
    } catch (e) {
      console.error(`slot claim upkeep failed for booking ${bookingId} (non-fatal)`, e);
    }

    // Missing mode (pre-stamping docs) displays as live; this never feeds
    // money logic.
    const mode: PaymentMode = (after ?? before)?.mode === "test" ? "test" : "live";
    // On delete, `after` is empty — details come from `before`.
    const b = after ?? before;
    const who = `${escapeHTML(String(b.clientName ?? ""))} (${escapeHTML(String(b.clientPhone ?? ""))})`;
    const what = `Service: ${escapeHTML(String(b.serviceName ?? ""))}\nWhen: ${escapeHTML(String(b.date ?? ""))} at ${escapeHTML(String(b.timeSlot ?? ""))}`;
    const ref = String(b.paymentReference ?? "");
    const refLine = ref ? `\nRef: <code>${escapeHTML(ref)}</code>` : "";
    const moneyHeld =
      String(b.paymentStatus ?? "") === "Paid"
        ? `\n💰 R${b.amount ?? "?"} was paid online and is STILL HELD — refund is a manual decision.`
        : `\nPayment status: ${escapeHTML(String(b.paymentStatus ?? "unknown"))} — no money held.`;

    // Only the specific changes below notify. Anything else (transactionId
    // touch-ups, etc.) is silence, and silence is correct for noise.
    const changes: BookingChange[] = [];

    if (!before && after) {
      const paid = String(after.paymentStatus ?? "") === "Paid";
      changes.push({
        type: "created",
        actor: paid ? "server" : "admin",
        text: paid
          ? `✅ <b>New paid booking</b>\nClient: ${who}\n${what}\nAmount: R${after.amount ?? "?"}\nPayment: ${escapeHTML(String(after.paymentStatus ?? ""))}${refLine}`
          : `🆕 <b>New booking (not paid online)</b>\nClient: ${who}\n${what}\nPayment: ${escapeHTML(String(after.paymentStatus ?? "unknown"))}`,
      });
    } else if (before && !after) {
      changes.push({
        type: "deleted",
        actor: "admin",
        text: `🗑️ <b>Booking deleted</b> (admin action)\nClient: ${who}\n${what}\nAmount: R${before.amount ?? "?"}${moneyHeld}${refLine}`,
      });
    } else if (before && after) {
      if (
        String(before.status ?? "") !== "Cancelled" &&
        String(after.status ?? "") === "Cancelled"
      ) {
        const by = after.cancelledBy === "client" ? "client" : after.cancelledBy === "admin" ? "admin" : "unknown";
        changes.push({
          type: "cancelled",
          actor: by,
          text: `❌ <b>Booking cancelled by ${by}</b>\nClient: ${who}\n${what}\nAmount: R${after.amount ?? "?"}${moneyHeld}${refLine}`,
        });
      }
      if (
        String(before.date ?? "") !== String(after.date ?? "") ||
        String(before.timeSlot ?? "") !== String(after.timeSlot ?? "")
      ) {
        // The reschedule callable stamps rescheduledFrom; a bare date edit
        // (admin portal / console) does not.
        const by = after.rescheduledFrom && !before.rescheduledFrom
          ? "client"
          : after.rescheduledFrom &&
              JSON.stringify(after.rescheduledFrom) !== JSON.stringify(before.rescheduledFrom)
            ? "client"
            : "admin";
        changes.push({
          type: "rescheduled",
          actor: by,
          text: `🔄 <b>Booking rescheduled by ${by}</b>\nClient: ${who}\nService: ${escapeHTML(String(b.serviceName ?? ""))}\nFrom: ${escapeHTML(String(before.date ?? ""))} at ${escapeHTML(String(before.timeSlot ?? ""))}\nTo: ${escapeHTML(String(after.date ?? ""))} at ${escapeHTML(String(after.timeSlot ?? ""))}\nOriginal payment stays valid — no new charge.${refLine}`,
        });
      }
      if (
        String(before.paymentStatus ?? "") !== String(after.paymentStatus ?? "")
      ) {
        changes.push({
          type: "payment_status_changed",
          actor: "unknown",
          text: `💰 <b>Payment status changed</b>\nClient: ${who}\n${what}\n${escapeHTML(String(before.paymentStatus ?? "?"))} → <b>${escapeHTML(String(after.paymentStatus ?? "?"))}</b>\nAmount: R${after.amount ?? "?"}${refLine}`,
        });
      }
    }

    if (changes.length === 0) return;

    // Storm visibility: >5 events in 60s is worth a loud log line (a bulk
    // admin action is fine; a runaway loop must not be silent).
    try {
      const recent = await db
        .collection("events")
        .where("createdAt", ">", Timestamp.fromMillis(Date.now() - 60_000))
        .count()
        .get();
      if (recent.data().count >= 5) {
        console.warn(
          `NOTIFICATION_STORM: ${recent.data().count} booking events in the last 60s`
        );
      }
    } catch (e) {
      console.warn("event storm check failed (non-fatal)", e);
    }

    // event.time is the commit timestamp — stable across trigger retries,
    // which is what makes the doc ID deterministic.
    const stamp = String(event.time ?? "unknown").replace(/[^0-9A-Za-z]/g, "-");
    for (const c of changes) {
      const evRef = db.doc(`events/${bookingId}_${c.type}_${stamp}`);
      try {
        await evRef.create({
          type: c.type,
          bookingId,
          reference: ref || null,
          actor: c.actor,
          before,
          after,
          mode,
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (e: any) {
        if (e?.code === 6 /* ALREADY_EXISTS: retried trigger run */) {
          console.log(`event ${evRef.id} already recorded; skipping send`);
          continue;
        }
        // Audit-row failure must not silence the human notification.
        console.error("event row write failed; sending message anyway", e);
      }
      await sendTelegram(c.text, mode);
    }
  }
);

// --- Paystack refund events ---
// refund.processed flips the ledger row to REFUNDED and the booking's
// paymentStatus to Refunded (the bookings trigger then reports that status
// change). refund.pending / refund.failed message only. A refund for a
// reference we have no ledger row for is recorded as ORPHANED_PAYMENT and
// flagged for manual attention.
const handleRefundEvent = async (
  eventType: string,
  d: any,
  eventMode: PaymentMode
): Promise<void> => {
  const reference = String(
    d.transaction_reference ?? d.transaction?.reference ?? ""
  );
  const amountRand = randFromCents(Number(d.amount) || 0);
  const refLine = `Reference: <code>${escapeHTML(reference || "unknown")}</code>\nAmount: R${amountRand}`;

  if (eventType === "refund.pending") {
    await sendTelegram(`⏳ <b>Refund pending</b>\n${refLine}`, eventMode);
    return;
  }
  if (eventType === "refund.failed") {
    await sendTelegram(
      `❌ <b>Refund FAILED — manual attention needed</b>\n${refLine}\nRetry or resolve in the Paystack dashboard.`,
      eventMode
    );
    return;
  }
  if (eventType !== "refund.processed") {
    return; // e.g. refund.processing — ack silently.
  }

  if (!reference) {
    await sendTelegram(
      `⚠️ <b>Refund processed with no reference — manual attention needed</b>\nAmount: R${amountRand}\nInvestigate in the Paystack dashboard.`,
      eventMode
    );
    return;
  }

  const ledgerRef = db.doc(`ledger/${reference}`);
  const ledgerSnap = await ledgerRef.get();

  if (!ledgerSnap.exists) {
    // Money moved on a transaction we have no record of.
    try {
      await ledgerRef.create({
        reference,
        mode: eventMode,
        status: "ORPHANED_PAYMENT",
        refundedAmount: amountRand,
        event: { event: eventType, data: d },
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e: any) {
      if (e?.code !== 6) throw e;
    }
    await sendTelegram(
      `⚠️ <b>Orphaned refund — manual attention needed</b>\n${refLine}\nNo ledger row exists for this reference. Investigate in the Paystack dashboard.`,
      eventMode
    );
    return;
  }

  if (ledgerSnap.data()?.status === "REFUNDED") {
    return; // Replayed event: no duplicate message, no duplicate write.
  }

  await ledgerRef.set(
    {
      status: "REFUNDED",
      refundedAmount: amountRand,
      refundedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  const bookingId = ledgerSnap.data()?.bookingId;
  if (bookingId) {
    try {
      await db.doc(`bookings/${bookingId}`).update({ paymentStatus: "Refunded" });
    } catch (e) {
      console.error(`could not set paymentStatus Refunded on ${bookingId}`, e);
    }
  }

  await sendTelegram(
    `💸 <b>Refund processed</b>\n${refLine}\nLedger updated to REFUNDED${bookingId ? "; booking payment status set to Refunded" : " (no linked booking)"}.`,
    eventMode
  );
};

// --- Paystack webhook ---
// The single source of truth for paid bookings. Paystack POSTs events here;
// we verify the HMAC-SHA512 signature over the RAW body (never re-serialized
// JSON), act only on charge.success, and are idempotent on the transaction
// reference: ledger/{reference} is created exactly once via tx.create(),
// which throws ALREADY_EXISTS on Paystack's retries.
export const paystackWebhook = onRequest(
  {
    secrets: [
      PAYSTACK_SECRET_KEY,
      PAYSTACK_SECRET_KEY_TEST,
      TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID,
    ],
  },
  async (req, res) => {
    // 1. Signature check — 401 and write nothing on any failure.
    //    Live and test integrations sign with different secret keys; which
    //    key verifies tells us which environment the event came from
    //    (eventMode). Same algorithm, same timing-safe comparison for both.
    const signature = req.headers["x-paystack-signature"];
    const rawBody: Buffer | undefined = (req as any).rawBody;
    if (typeof signature !== "string" || !signature || !rawBody) {
      res.status(401).send("unauthorized");
      return;
    }
    const sigBuf = Buffer.from(signature, "utf8");
    const verifiesWith = (key: string): boolean => {
      const expBuf = Buffer.from(
        createHmac("sha512", key).update(rawBody).digest("hex"),
        "utf8"
      );
      return sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
    };
    const eventMode: PaymentMode | null = verifiesWith(PAYSTACK_SECRET_KEY.value())
      ? "live"
      : verifiesWith(PAYSTACK_SECRET_KEY_TEST.value())
        ? "test"
        : null;
    if (!eventMode) {
      res.status(401).send("unauthorized");
      return;
    }
    let event: any;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      // Signed but unparseable — acknowledge so Paystack stops retrying.
      res.status(200).send("ignored");
      return;
    }

    // 2. Route by event type. charge.success books; refunds and disputes
    //    message the group (money at risk must never be silent); everything
    //    else is acked fast without processing.
    const eventType: string = String(event?.event ?? "");

    if (eventType.startsWith("refund.") ) {
      await handleRefundEvent(eventType, event.data ?? {}, eventMode);
      res.status(200).send("ok");
      return;
    }
    if (eventType.startsWith("charge.dispute.")) {
      const d = event.data ?? {};
      const disputeRef = String(d.transaction?.reference ?? d.transaction_reference ?? "unknown");
      const disputeAmount = randFromCents(Number(d.amount ?? d.transaction?.amount) || 0);
      const stage =
        eventType === "charge.dispute.create" ? "🚨 <b>New dispute opened</b>"
        : eventType === "charge.dispute.remind" ? "⏰ <b>Dispute reminder — response due</b>"
        : "⚖️ <b>Dispute resolved</b>";
      await sendTelegram(
        `${stage}\nReference: <code>${escapeHTML(disputeRef)}</code>\nAmount: R${disputeAmount}\nStatus: ${escapeHTML(String(d.status ?? "unknown"))}\n⚠️ Money at risk — handle in the Paystack dashboard.`,
        eventMode
      );
      res.status(200).send("ok");
      return;
    }
    if (eventType !== "charge.success") {
      res.status(200).send("ok");
      return;
    }

    const data = event.data ?? {};
    const reference: string = String(data.reference ?? "");
    if (!reference) {
      res.status(200).send("ok");
      return;
    }

    // 3–7. Settle via the SHARED settlement core (settlement.ts) — the same
    //      function the reconciliation sweep and admin manual settle call,
    //      so the paths can never diverge. Idempotent on the reference.
    try {
      await settleCharge(data, eventMode, "webhook", event);
    } catch (e) {
      // Genuine write failure: 500 so Paystack retries later.
      console.error(`webhook settlement failed for ${reference}`, e);
      res.status(500).send("error");
      return;
    }
    res.status(200).send("ok");
  }
);

// --- D1: Scheduled reconciliation sweep ---
// Every 15 minutes: ask Paystack for successful transactions in the last
// 48 hours (current mode's key) and settle any that have no ledger row,
// via the SAME settleCharge the webhook uses. This makes webhook delivery
// non-critical: Paystack is the source of truth and the system self-heals.
// A healthy system sweeps up nothing — anything settled here means webhook
// delivery is failing, so every sweep settlement alerts Telegram.
//
// Cost: 96 invocations/day of a mostly-idle function + one Cloud Scheduler
// job (first 3 are free) — effectively R0 at this volume.
export const reconcileSweep = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "Africa/Johannesburg",
    secrets: [
      PAYSTACK_SECRET_KEY,
      PAYSTACK_SECRET_KEY_TEST,
      TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID,
    ],
  },
  async () => {
    // Respect the current mode; an invalid config alerts (throttled, the
    // sweep re-fires every 15 min) and skips — never guesses live.
    const payCfg = (await db.doc("settings/paymentConfig").get()).data();
    const mode: PaymentMode | null =
      payCfg?.mode === "test" ? "test" : payCfg?.mode === "live" ? "live" : null;
    if (!mode) {
      console.error("reconcileSweep: paymentConfig mode invalid; skipping");
      await sendThrottledAlert(
        "sweep-cfg",
        `🚨 <b>Reconciliation sweep cannot run</b>\nsettings/paymentConfig mode is invalid — the orphan-payment safety net is OFF until this is fixed.`
      );
      return;
    }

    // Successful transactions in the last 48h, paginated (100/page).
    const from = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const txns: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const resp = await fetch(
        `https://api.paystack.co/transaction?status=success&perPage=100&page=${page}&from=${encodeURIComponent(from)}`,
        { headers: { Authorization: `Bearer ${secretKeyFor(mode)}` } }
      );
      const body: any = await resp.json().catch(() => null);
      if (!resp.ok || !body?.status) {
        console.error("reconcileSweep: Paystack list failed", resp.status, body?.message);
        await sendThrottledAlert(
          "sweep-api",
          `⚠️ <b>Reconciliation sweep could not reach Paystack</b>\n${escapeHTML(String(body?.message ?? `HTTP ${resp.status}`))}\nThe sweep will retry in 15 minutes.`,
          mode
        );
        return;
      }
      const list: any[] = body.data ?? [];
      txns.push(...list);
      if (list.length < 100) break;
    }

    let settled = 0;
    for (const t of txns) {
      const reference = String(t.reference ?? "");
      if (!reference) continue;
      // Skip anything already settled (by the webhook or a previous sweep).
      if ((await db.doc(`ledger/${reference}`).get()).exists) continue;
      try {
        const result = await settleCharge(t, mode, "sweep", {
          event: "charge.success",
          data: t,
          via: "reconcileSweep",
        });
        if (result.status === "ALREADY_SETTLED") continue; // webhook won the race — fine
        settled++;
        // Anomaly outcomes already alerted inside settleCharge; this alert
        // is about the SWEEP having had to act at all — webhook delivery is
        // failing and someone needs to know.
        await sendTelegram(
          `🧹 <b>Reconciliation sweep settled a payment the webhook missed</b>\nReference: <code>${escapeHTML(reference)}</code>\nOutcome: ${escapeHTML(result.status)}${result.clientName ? `\nClient: ${escapeHTML(result.clientName)}` : ""}\nAmount: R${result.amountRand}${result.recoveredFromMetadata ? "\nBooking rebuilt from Paystack metadata (pending intent was gone)." : ""}\n⚠️ A healthy system sweeps up nothing — check webhook delivery in the Paystack dashboard.`,
          mode
        );
      } catch (e) {
        console.error(`reconcileSweep: settle failed for ${reference}`, e);
        await sendThrottledAlert(
          "sweep-settle-fail",
          `⚠️ <b>Reconciliation sweep failed to settle</b>\nReference: <code>${escapeHTML(reference)}</code>\nIt will retry in 15 minutes; if this repeats, investigate the logs.`,
          mode
        );
      }
    }
    console.log(
      `reconcileSweep(${mode}): ${txns.length} successful txns in window, ${settled} settled by sweep`
    );
  }
);

// --- D3: Admin manual settle ---
// The human escape hatch when both the webhook and the sweep fail. Two
// phases so the admin confirms rather than fires blind:
//   confirm:false → verify the reference against Paystack and return what
//                   was found (amount, client, mode, ledger state). WRITES
//                   NOTHING.
//   confirm:true  → settle via the SAME shared settleCharge as the webhook
//                   and the sweep. Idempotent on the reference.
// Admin-only: requires Firebase Auth (only admins can sign in).
export const manualSettle = onCall(
  {
    secrets: [
      PAYSTACK_SECRET_KEY,
      PAYSTACK_SECRET_KEY_TEST,
      TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID,
    ],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Admin sign-in required.");
    }
    const { reference, confirm } = request.data ?? {};
    if (typeof reference !== "string" || !/^[\w-]{4,100}$/.test(reference.trim())) {
      throw new HttpsError("invalid-argument", "A valid reference is required.");
    }
    const ref = reference.trim();

    // Verify against Paystack: current mode's environment first, then the
    // other, so a test reference is still findable while mode is live (and
    // vice versa). Whichever environment finds it is the settle mode.
    const payCfg = (await db.doc("settings/paymentConfig").get()).data();
    const cfgMode: PaymentMode = payCfg?.mode === "test" ? "test" : "live";
    const tryModes: PaymentMode[] = cfgMode === "test" ? ["test", "live"] : ["live", "test"];
    let found: any = null;
    let foundMode: PaymentMode | null = null;
    for (const m of tryModes) {
      const resp = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`,
        { headers: { Authorization: `Bearer ${secretKeyFor(m)}` } }
      );
      const body: any = await resp.json().catch(() => null);
      if (resp.ok && body?.status && body?.data) {
        found = body.data;
        foundMode = m;
        break;
      }
    }
    if (!found || !foundMode) {
      throw new HttpsError(
        "not-found",
        "Paystack has no transaction for that reference (checked both live and test)."
      );
    }

    const ledgerExists = (await db.doc(`ledger/${ref}`).get()).exists;
    const pendingExists = (await db.doc(`pendingPayments/${ref}`).get()).exists;
    const md = found.metadata ?? {};
    const preview = {
      reference: ref,
      env: foundMode,
      paystackStatus: String(found.status ?? "unknown"),
      amountRand: randFromCents(Number(found.amount) || 0),
      paidAt: found.paid_at ?? null,
      channel: found.channel ?? null,
      clientName: md.clientName ?? null,
      clientPhone: md.clientPhone ?? null,
      serviceName: md.serviceName ?? null,
      date: md.date ?? null,
      timeSlot: md.timeSlot ?? null,
      ledgerExists,
      pendingExists,
    };

    if (!confirm) return { preview };

    if (preview.paystackStatus !== "success") {
      throw new HttpsError(
        "failed-precondition",
        `Transaction status is "${preview.paystackStatus}" — only successful charges can be settled.`
      );
    }
    const result = await settleCharge(found, foundMode, "manual", {
      event: "charge.success",
      data: found,
      via: "manualSettle",
      by: request.auth.uid,
    });
    if (result.status !== "ALREADY_SETTLED") {
      await sendTelegram(
        `🛠️ <b>Admin manually settled a payment</b>\nReference: <code>${escapeHTML(ref)}</code>\nOutcome: ${escapeHTML(result.status)}\nAmount: R${result.amountRand}${result.recoveredFromMetadata ? "\nBooking rebuilt from Paystack metadata." : ""}`,
        foundMode
      );
    }
    return { preview, result };
  }
);

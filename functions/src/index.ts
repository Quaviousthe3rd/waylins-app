import { setGlobalOptions } from "firebase-functions/v2";
import { onRequest, onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
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

// --- Money model (all authoritative, server-side) ---
// Prices are stored in RAND in Firestore; Paystack amounts are integer CENTS.
//
// ownerCut          = exactly 10% of servicePrice; the owner receives ONLY
//                     this — all rounding surplus flows to the barber.
// charge (total)    = (servicePrice + barberBuffer + ownerCut + feeFlat)
//                     / (1 - feePercent), rounded UP to the next roundTo.
// transaction_charge = ownerCut + estimatedPaystackFee (cents),
//                     bearer: "account", so the main account nominally takes
//                     ownerCut + fee, pays Paystack's actual fee out of it,
//                     and nets exactly ownerCut.
// barberNet         = charge - transaction_charge (subaccount receives this;
//                     always >= servicePrice + barberBuffer).
//
// Fee params come from settings/paymentConfig with these defaults:
const DEFAULT_FEE_PERCENT = 0.029; // Paystack 2.9%
const DEFAULT_FEE_FLAT_RAND = 1; // + R1 per transaction
const DEFAULT_ROUND_TO_RAND = 5; // charge rounded up to next R5
const DEFAULT_BARBER_BUFFER_RAND = 5;

interface FeeConfig {
  feePercent: number;
  feeFlatCents: number;
  roundToCents: number;
  barberBufferCents: number;
}

const readFeeConfig = (payCfg: any): FeeConfig => ({
  feePercent: Number(payCfg?.feePercent) || DEFAULT_FEE_PERCENT,
  feeFlatCents: Math.round((Number(payCfg?.feeFlatRand) || DEFAULT_FEE_FLAT_RAND) * 100),
  roundToCents: Math.round((Number(payCfg?.roundToRand) || DEFAULT_ROUND_TO_RAND) * 100),
  barberBufferCents: Math.round(
    (Number(payCfg?.barberBufferRand) || DEFAULT_BARBER_BUFFER_RAND) * 100
  ),
});

interface Quote {
  baseCents: number;
  ownerCutCents: number;
  chargeCents: number;
  estimatedFeeCents: number;
  transactionChargeCents: number;
  barberNetCents: number;
  serviceFeeCents: number;
}

const computeQuote = (baseCents: number, cfg: FeeConfig): Quote => {
  const ownerCutCents = Math.round(baseCents * 0.1);
  const preFeeCents =
    baseCents + cfg.barberBufferCents + ownerCutCents + cfg.feeFlatCents;
  const grossedUp = preFeeCents / (1 - cfg.feePercent);
  const chargeCents = Math.ceil(grossedUp / cfg.roundToCents) * cfg.roundToCents;
  // Paystack's actual fee formula, estimated with the configured params.
  const estimatedFeeCents =
    Math.round(chargeCents * cfg.feePercent) + cfg.feeFlatCents;
  const transactionChargeCents = ownerCutCents + estimatedFeeCents;
  const barberNetCents = chargeCents - transactionChargeCents;
  return {
    baseCents,
    ownerCutCents,
    chargeCents,
    estimatedFeeCents,
    transactionChargeCents,
    barberNetCents,
    serviceFeeCents: chargeCents - baseCents,
  };
};

const randFromCents = (c: number): number => c / 100;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

// Same semantics as date-fns areIntervalsOverlapping (exclusive bounds):
// touching end-to-start is NOT an overlap.
const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
  aStart < bEnd && bStart < aEnd;

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

    // 2b. Lazy cleanup: delete pendingPayments older than 30 minutes.
    //     Runs on every init, so no scheduler is needed. Abandoned intents
    //     never blocked slots anyway (only bookings do), but this keeps the
    //     collection from growing without bound. Best-effort: a cleanup
    //     failure must never block a paying customer.
    try {
      const cutoff = Timestamp.fromMillis(Date.now() - 30 * 60 * 1000);
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

    // 6. Record the intent before contacting Paystack.
    const reference = makeReference();
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

    // 7. Initialize the Paystack transaction. NOTE: subaccount split with a
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
    tx.update(bookingRef, {
      status: "Cancelled",
      cancelledBy: "client",
      cancelledAt: FieldValue.serverTimestamp(),
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

    const ledgerRef = db.doc(`ledger/${reference}`);
    const chargedCents = Number(data.amount) || 0;
    const paystackFeeActualRand =
      data.fees != null ? randFromCents(Number(data.fees) || 0) : null;

    // Base ledger fields shared by every outcome. The raw event is stored
    // verbatim for reconciliation. `mode` is stamped on EVERY row: rows with
    // mode "test" must be excluded from all revenue/statement totals.
    const ledgerBase = {
      reference,
      mode: eventMode,
      transactionId: data.id != null ? String(data.id) : null,
      charged: randFromCents(chargedCents),
      paystackFeeActual: paystackFeeActualRand,
      event,
      createdAt: FieldValue.serverTimestamp(),
    };

    // 3. Idempotency fast-path (the transaction below also enforces this
    //    atomically via tx.create()).
    if ((await ledgerRef.get()).exists) {
      res.status(200).send("ok");
      return;
    }

    const pendingSnap = await db.doc(`pendingPayments/${reference}`).get();

    // 4. Money arrived with no matching intent: record it, alert, ack.
    if (!pendingSnap.exists) {
      console.error(`charge.success for unknown reference ${reference}`);
      try {
        await ledgerRef.create({ ...ledgerBase, status: "UNMATCHED_PAYMENT" });
      } catch (e: any) {
        if (e?.code === 6 /* ALREADY_EXISTS */) { res.status(200).send("ok"); return; }
        throw e;
      }
      await sendTelegram(
        `⚠️ <b>Unmatched Paystack payment — manual attention needed</b>\nReference: <code>${escapeHTML(reference)}</code>\nAmount: R${randFromCents(chargedCents)}\nNo pending booking found — investigate in the Paystack dashboard.`,
        eventMode
      );
      res.status(200).send("ok");
      return;
    }

    const pending = pendingSnap.data() as any;

    // 4b. Cross-mode guard: an event may only settle an intent created in
    //     the SAME environment. A test-signed charge (free test cards) must
    //     never confirm a live booking intent — that would be a payment
    //     bypass. Record, alert, ack; never book.
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
        if (e?.code === 6) { res.status(200).send("ok"); return; }
        throw e;
      }
      await sendTelegram(
        `🚨 <b>Paystack mode mismatch — manual attention needed</b>\nReference: <code>${escapeHTML(reference)}</code>\nEvent env: ${eventMode} — booking intent env: ${intentMode}\nNo booking was created. Investigate immediately.`,
        eventMode
      );
      res.status(200).send("ok");
      return;
    }

    const b = pending.booking ?? {};
    const amounts = pending.amounts ?? {};
    const bookingFields = {
      clientName: String(b.clientName ?? ""),
      serviceName: String(b.serviceName ?? ""),
      date: String(b.date ?? ""),
      timeSlot: String(b.timeSlot ?? ""),
    };
    const ledgerFull = {
      ...ledgerBase,
      ...bookingFields,
      estimatedFee: amounts.estimatedFeeRand ?? null,
      barberNet: amounts.barberNetRand ?? null,
    };

    // 5. The charge must match the quoted amount EXACTLY (integer cents).
    if (chargedCents !== Number(amounts.amountCents)) {
      console.error(
        `AMOUNT_MISMATCH ${reference}: charged ${chargedCents}, expected ${amounts.amountCents}`
      );
      try {
        await ledgerRef.create({ ...ledgerFull, bookingId: null, status: "AMOUNT_MISMATCH" });
      } catch (e: any) {
        if (e?.code === 6) { res.status(200).send("ok"); return; }
        throw e;
      }
      await sendTelegram(
        `⚠️ <b>Paystack amount mismatch — manual attention needed</b>\nReference: <code>${escapeHTML(reference)}</code>\nCharged: R${randFromCents(chargedCents)} — expected R${randFromCents(Number(amounts.amountCents) || 0)}\nClient: ${escapeHTML(bookingFields.clientName)}\nNo booking was created. Review and refund/adjust manually.`,
        eventMode
      );
      res.status(200).send("ok");
      return;
    }

    // 6. Happy path — one Firestore transaction:
    //    - re-check the slot (someone may have booked between init & webhook)
    //    - create the ledger row (tx.create = atomic idempotency)
    //    - write the booking ONLY if the slot is still free
    //    Money is never silently dropped: a lost race becomes a
    //    SLOT_TAKEN_REFUND ledger row + Telegram alert for a manual refund.
    const bookingRef = db.collection("bookings").doc();
    const durationMinutes = Number(b.durationMinutes) || 60;
    const slotStart = toMinutes(String(b.timeSlot ?? "00:00"));
    const slotEnd = slotStart + durationMinutes;

    let slotTaken = false;
    try {
      await db.runTransaction(async (tx) => {
        const sameDay = await tx.get(
          db.collection("bookings").where("date", "==", b.date)
        );
        const taken = sameDay.docs.some((d) => {
          const other = d.data();
          if (other.status === "Cancelled") return false;
          const oStart = toMinutes(String(other.timeSlot ?? "00:00"));
          const oEnd = oStart + (Number(other.durationMinutes) || 60);
          return overlaps(slotStart, slotEnd, oStart, oEnd);
        });

        if (taken) {
          slotTaken = true;
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
          });
        }
        tx.delete(pendingSnap.ref);
      });
    } catch (e: any) {
      if (e?.code === 6 /* ALREADY_EXISTS: concurrent retry won the race */) {
        res.status(200).send("ok");
        return;
      }
      // Genuine write failure: 500 so Paystack retries later.
      console.error(`webhook transaction failed for ${reference}`, e);
      res.status(500).send("error");
      return;
    }

    // 7. Telegram AFTER the writes; failure is logged only.
    //    NOTE: the happy path sends NOTHING here — the bookings/{id}
    //    Firestore trigger (onBookingWritten) owns the "new paid booking"
    //    message now. Sending here too would notify every booking twice.
    //    SLOT_TAKEN_REFUND writes no booking doc, so the webhook still owns
    //    that alert.
    if (slotTaken) {
      await sendTelegram(
        `🔴 <b>Paid but slot taken — refund needed</b>\nClient: ${escapeHTML(bookingFields.clientName)} (${escapeHTML(String(b.clientPhone ?? ""))})\nService: ${escapeHTML(bookingFields.serviceName)}\n${escapeHTML(bookingFields.date)} at ${escapeHTML(bookingFields.timeSlot)}\nPaid: R${randFromCents(chargedCents)}\nReference: <code>${escapeHTML(reference)}</code>\nRefund manually in the Paystack dashboard.`,
        eventMode
      );
    }
    res.status(200).send("ok");
  }
);

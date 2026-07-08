import { setGlobalOptions } from "firebase-functions/v2";
import { onRequest, onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

// All functions run in europe-west1.
setGlobalOptions({ region: "europe-west1" });

initializeApp();
const db = getFirestore();

const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = defineSecret("TELEGRAM_CHAT_ID");
const PAYSTACK_SECRET_KEY = defineSecret("PAYSTACK_SECRET_KEY");

// Healthcheck: verifies the deploy pipeline end-to-end before any money logic.
export const ping = onRequest(
  { secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, PAYSTACK_SECRET_KEY] },
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
  { secrets: [PAYSTACK_SECRET_KEY] },
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
    const paySnap = await db.doc("settings/paymentConfig").get();
    const subaccountCode: string | undefined = paySnap.data()?.subaccountCode;
    if (!subaccountCode || !subaccountCode.startsWith("ACCT_")) {
      throw new HttpsError(
        "failed-precondition",
        "Online payment is not configured. Please choose pay in person."
      );
    }

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
    const resp = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY.value()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: quote.chargeCents,
        currency: "ZAR",
        email: "bookings@waylins-37532.web.app",
        reference,
        subaccount: subaccountCode,
        transaction_charge: quote.transactionChargeCents,
        bearer: "account",
        metadata: {
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

    return { reference, authorization_url: body.data.authorization_url };
  }
);

// Public quote: what a booking will cost and how it splits, computed with the
// same code path as initTransaction. Never exposes the subaccount code.
export const quoteService = onCall(async (request) => {
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
});

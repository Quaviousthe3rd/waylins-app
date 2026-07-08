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
// total charged  = servicePrice + R50 service fee
// barber (subaccount) receives servicePrice + R15
// owner (main account) flat take = R35 = 3500 cents (transaction_charge),
// and Paystack's processing fee comes out of the owner side (bearer: account).
const SERVICE_FEE_RAND = 50;
const OWNER_GROSS_RAND = 35;
const OWNER_GROSS_CENTS = OWNER_GROSS_RAND * 100;

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
    const totalRand = basePriceRand + SERVICE_FEE_RAND;
    const amountCents = Math.round(totalRand * 100);
    const barberRand = basePriceRand + 15;

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
        serviceFeeRand: SERVICE_FEE_RAND,
        totalRand,
        amountCents,
        barberRand,
        ownerGrossRand: OWNER_GROSS_RAND,
        transactionChargeCents: OWNER_GROSS_CENTS,
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
        amount: amountCents,
        currency: "ZAR",
        email: "bookings@waylins-37532.web.app",
        reference,
        subaccount: subaccountCode,
        transaction_charge: OWNER_GROSS_CENTS,
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
          serviceFee: SERVICE_FEE_RAND,
          ownerGross: OWNER_GROSS_RAND,
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

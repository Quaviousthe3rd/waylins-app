import { setGlobalOptions } from "firebase-functions/v2";
import { onRequest, onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { createHmac, timingSafeEqual } from "crypto";

// All functions run in europe-west1.
setGlobalOptions({ region: "europe-west1" });

initializeApp();
const db = getFirestore();

const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = defineSecret("TELEGRAM_CHAT_ID");
const PAYSTACK_SECRET_KEY = defineSecret("PAYSTACK_SECRET_KEY");
const PAYSTACK_SECRET_KEY_TEST = defineSecret("PAYSTACK_SECRET_KEY_TEST");

// --- Payment mode ---
// settings/paymentConfig.mode switches the ENTIRE money path between
// Paystack live and test integrations. Anything other than the literal
// string "test" (including a missing field) means LIVE — the live path is
// the default and is never altered by test-mode logic.
type PaymentMode = "test" | "live";
const paymentModeOf = (payCfg: any): PaymentMode =>
  payCfg?.mode === "test" ? "test" : "live";
const secretKeyFor = (mode: PaymentMode): string =>
  mode === "test" ? PAYSTACK_SECRET_KEY_TEST.value() : PAYSTACK_SECRET_KEY.value();

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
  { secrets: [PAYSTACK_SECRET_KEY, PAYSTACK_SECRET_KEY_TEST] },
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
    const paySnap = await db.doc("settings/paymentConfig").get();
    const mode = paymentModeOf(paySnap.data());
    // Test mode has no real subaccount: skip the split entirely. In live
    // mode the subaccount is mandatory — unchanged.
    const subaccountCode: string | undefined = paySnap.data()?.subaccountCode;
    if (mode === "live" && (!subaccountCode || !subaccountCode.startsWith("ACCT_"))) {
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

// Public, non-sensitive payment environment for the client UI: which mode
// is active and which Paystack PUBLIC key to mount checkout with. Public
// keys live in settings/paymentConfig as publicKeyLive / publicKeyTest.
// Never returns secrets or the subaccount code.
export const getPaymentMode = onCall(async () => {
  const payCfg = (await db.doc("settings/paymentConfig").get()).data();
  const mode = paymentModeOf(payCfg);
  const raw = mode === "test" ? payCfg?.publicKeyTest : payCfg?.publicKeyLive;
  const publicKey =
    typeof raw === "string" && raw.trim().startsWith("pk_") ? raw.trim() : null;
  return { mode, publicKey };
});

// --- Telegram (server-side, NEW bot) ---
// Sent only AFTER Firestore writes commit; a Telegram failure is logged and
// never fails the webhook response.
const sendTelegram = async (text: string): Promise<void> => {
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN.value()}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID.value(),
          text,
          parse_mode: "HTML",
        }),
      }
    );
    if (!resp.ok) {
      console.error("Telegram API error", resp.status, await resp.text().catch(() => ""));
    }
  } catch (e) {
    console.error("Telegram send failed (non-fatal)", e);
  }
};

const escapeHTML = (s: string): string =>
  String(s ?? "").replace(/[&<>]/g, (m) =>
    m === "&" ? "&amp;" : m === "<" ? "&lt;" : "&gt;"
  );

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
    // Test events are visibly tagged everywhere they surface.
    const tag = eventMode === "test" ? "[TEST] " : "";

    let event: any;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      // Signed but unparseable — acknowledge so Paystack stops retrying.
      res.status(200).send("ignored");
      return;
    }

    // 2. Only charge.success does work; everything else is acked fast.
    if (event?.event !== "charge.success") {
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
        `${tag}⚠️ <b>Unmatched Paystack payment</b>\nReference: <code>${escapeHTML(reference)}</code>\nAmount: R${randFromCents(chargedCents)}\nNo pending booking found — investigate in the Paystack dashboard.`
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
        `${tag}🚨 <b>Paystack mode mismatch</b>\nReference: <code>${escapeHTML(reference)}</code>\nEvent env: ${eventMode} — booking intent env: ${intentMode}\nNo booking was created. Investigate immediately.`
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
        `${tag}⚠️ <b>Paystack amount mismatch</b>\nReference: <code>${escapeHTML(reference)}</code>\nCharged: R${randFromCents(chargedCents)} — expected R${randFromCents(Number(amounts.amountCents) || 0)}\nClient: ${escapeHTML(bookingFields.clientName)}\nNo booking was created. Review and refund/adjust manually.`
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
    if (slotTaken) {
      await sendTelegram(
        `${tag}🔴 <b>Paid but slot taken — refund needed</b>\nClient: ${escapeHTML(bookingFields.clientName)} (${escapeHTML(String(b.clientPhone ?? ""))})\nService: ${escapeHTML(bookingFields.serviceName)}\n${escapeHTML(bookingFields.date)} at ${escapeHTML(bookingFields.timeSlot)}\nPaid: R${randFromCents(chargedCents)}\nReference: <code>${escapeHTML(reference)}</code>\nRefund manually in the Paystack dashboard.`
      );
    } else {
      await sendTelegram(
        `${tag}✅ <b>New paid booking</b>\nClient: ${escapeHTML(bookingFields.clientName)} (${escapeHTML(String(b.clientPhone ?? ""))})\nService: ${escapeHTML(bookingFields.serviceName)}\nWhen: ${escapeHTML(bookingFields.date)} at ${escapeHTML(bookingFields.timeSlot)}\nAmount: R${randFromCents(chargedCents)}\nRef: <code>${escapeHTML(reference)}</code>`
      );
    }
    res.status(200).send("ok");
  }
);

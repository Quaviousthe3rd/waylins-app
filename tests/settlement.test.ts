import { describe, it, expect, beforeEach, vi } from 'vitest';

// Telegram is fully mocked — no network, and settlement must not depend on it.
vi.mock('../functions/src/telegram', () => ({
  TELEGRAM_BOT_TOKEN: {},
  TELEGRAM_CHAT_ID: {},
  escapeHTML: (s: string) => String(s ?? ''),
  sendTelegram: vi.fn(async () => {}),
  sendThrottledAlert: vi.fn(async () => {}),
}));

// firebase-admin/firestore is aliased to tests/mocks/firestore.ts in
// vitest.config.ts — an in-memory store whose tx.create throws code 6 on an
// existing path, exactly like the real one.
import { __reset, __store } from './mocks/firestore';
import { settleCharge } from '../functions/src/settlement';

const REF = 'WAYLINS-TEST-IDEMPOTENT';

const seedPendingIntent = () => {
  __store.set(`pendingPayments/${REF}`, {
    reference: REF,
    mode: 'test',
    status: 'awaiting_payment',
    booking: {
      clientName: 'Idem Potent',
      clientPhone: '0810000000',
      serviceId: '1',
      serviceName: 'Regular Cut',
      durationMinutes: 60,
      date: '2026-07-27',
      timeSlot: '10:00',
    },
    // Flat-R50 model: R200 cut -> R250 charged, owner cut R20, estimated fee
    // R8.25, so Paystack routes R221.75 to the barber.
    amounts: {
      currency: 'ZAR',
      amountCents: 25000,
      totalRand: 250,
      basePriceRand: 200,
      ownerCutRand: 20,
      ownerCutCents: 2000,
      barberNetRand: 221.75,
      estimatedFeeRand: 8.25,
    },
  });
};

const chargeData = {
  reference: REF,
  amount: 25000,
  id: 4242,
  fees: 796, // ACTUAL fee Paystack reported — less than the R8.25 estimate
  metadata: {},
};

const rawEvent = { event: 'charge.success', data: chargeData };

const countDocs = (prefix: string) =>
  [...__store.keys()].filter(k => k.startsWith(prefix + '/')).length;

describe('settlement idempotency', () => {
  beforeEach(() => {
    __reset();
    seedPendingIntent();
  });

  it('first settle books: one ledger row, one booking, pending deleted', async () => {
    const result = await settleCharge(chargeData, 'test', 'webhook', rawEvent);
    expect(result.status).toBe('PAID_BOOKED');
    expect(countDocs('ledger')).toBe(1);
    expect(countDocs('bookings')).toBe(1);
    expect(countDocs('pendingPayments')).toBe(0);

    const ledger = __store.get(`ledger/${REF}`)!;
    expect(ledger.status).toBe('PAID_BOOKED');
    expect(ledger.charged).toBe(250);
  });

  it('records the ACTUAL Paystack fee and the exact barber figure, with drift', () => {
    return settleCharge(chargeData, 'test', 'webhook', rawEvent).then(() => {
      const l = __store.get(`ledger/${REF}`)!;
      expect(l.base).toBe(200);
      expect(l.ownerCut).toBe(20);
      expect(l.paystackFeeActual).toBe(7.96); // actual, not the R8.25 estimate
      expect(l.estimatedFee).toBe(8.25);
      expect(l.barberNet).toBe(221.75); // what the split routed
      // transaction_charge is fixed at init, so the subaccount banks exactly
      // the routed figure regardless of the real fee.
      expect(l.barberNetActual).toBe(221.75);
      // Model says the barber was owed 250 - 7.96 - 20 = 222.04, so the
      // estimate over-charged the barber's side by 29c.
      expect(l.barberDrift).toBe(0.29);
      // ...and that 29c sat with the OWNER, who therefore nets above its 10%.
      expect(l.ownerNet).toBe(20.29);
      // Exact decomposition of the charge.
      expect(
        Math.round((l.barberNetActual + l.ownerNet + l.paystackFeeActual) * 100)
      ).toBe(25000);
    });
  });

  it('settling the SAME reference twice produces exactly one ledger row and one booking', async () => {
    const first = await settleCharge(chargeData, 'test', 'webhook', rawEvent);
    const second = await settleCharge(chargeData, 'test', 'sweep', rawEvent);

    expect(first.status).toBe('PAID_BOOKED');
    expect(second.status).toBe('ALREADY_SETTLED');
    expect(countDocs('ledger')).toBe(1);
    expect(countDocs('bookings')).toBe(1);
  });

  it('a pre-existing ledger row (concurrent settler won) yields ALREADY_SETTLED and writes nothing', async () => {
    __store.set(`ledger/${REF}`, { reference: REF, status: 'PAID_BOOKED' });
    const result = await settleCharge(chargeData, 'test', 'manual', rawEvent);
    expect(result.status).toBe('ALREADY_SETTLED');
    expect(countDocs('ledger')).toBe(1);
    expect(countDocs('bookings')).toBe(0);
  });

  it('amount mismatch never books, but is still idempotent on the reference', async () => {
    const bad = { ...chargeData, amount: 100 };
    const first = await settleCharge(bad, 'test', 'webhook', rawEvent);
    expect(first.status).toBe('AMOUNT_MISMATCH');
    expect(countDocs('bookings')).toBe(0);
    expect(countDocs('ledger')).toBe(1);

    const second = await settleCharge(bad, 'test', 'webhook', rawEvent);
    expect(second.status).toBe('ALREADY_SETTLED');
    expect(countDocs('ledger')).toBe(1);
  });
});

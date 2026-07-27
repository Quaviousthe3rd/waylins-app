import { describe, it, expect } from 'vitest';
import {
  computeQuote,
  computeActualSplit,
  readFeeConfig,
  maxSafeBaseCents,
  FLAT_SERVICE_FEE_CENTS,
} from '../functions/src/money';

// Exact-cent assertions for the APPROVED flat-R50 model, against the default
// fee estimate (2.9% + R1). These numbers are the contract: if any of them
// change, real money moves differently.
//
//   customer pays = base + R50
//   owner gets    = exactly 10% of base
//   barber gets   = base + (R50 - Paystack fee - owner cut)
const cfg = readFeeConfig(undefined);

describe('flat R50 model (estimate: 2.9% + R1)', () => {
  const cases = [
    // charge = base + 5000; estFee = round(charge*0.029) + 100;
    // ownerCut = 10% of base; barberNet = charge - ownerCut - estFee.
    // R100: charge 15000, estFee round(435)+100 = 535, ownerCut 1000
    { rand: 100, base: 10000, charge: 15000, ownerCut: 1000, estFee: 535, barberNet: 13465 },
    // R200: charge 25000, estFee round(725)+100 = 825, ownerCut 2000
    { rand: 200, base: 20000, charge: 25000, ownerCut: 2000, estFee: 825, barberNet: 22175 },
    // R300: charge 35000, estFee round(1015)+100 = 1115, ownerCut 3000
    { rand: 300, base: 30000, charge: 35000, ownerCut: 3000, estFee: 1115, barberNet: 30885 },
  ];

  for (const c of cases) {
    it(`R${c.rand}: exact cents`, () => {
      const q = computeQuote(c.base, cfg);
      expect(q.chargeCents).toBe(c.charge);
      expect(q.ownerCutCents).toBe(c.ownerCut);
      expect(q.estimatedFeeCents).toBe(c.estFee);
      expect(q.barberNetCents).toBe(c.barberNet);
      expect(q.serviceFeeCents).toBe(FLAT_SERVICE_FEE_CENTS);
      expect(q.underpaysBarber).toBe(false);
    });

    it(`R${c.rand}: customer pays base + exactly R50`, () => {
      const q = computeQuote(c.base, cfg);
      expect(q.chargeCents - q.baseCents).toBe(5000);
    });

    it(`R${c.rand}: owner cut is exactly 10% of base`, () => {
      const q = computeQuote(c.base, cfg);
      expect(q.ownerCutCents).toBe(Math.round(c.base * 0.1));
    });

    it(`R${c.rand}: barber keeps the full base plus what is left of the R50`, () => {
      const q = computeQuote(c.base, cfg);
      expect(q.barberNetCents).toBe(
        c.base + (FLAT_SERVICE_FEE_CENTS - q.estimatedFeeCents - q.ownerCutCents)
      );
      expect(q.barberNetCents).toBeGreaterThan(c.base);
    });

    it(`R${c.rand}: components sum exactly to the charge`, () => {
      const q = computeQuote(c.base, cfg);
      expect(q.estimatedFeeCents + q.ownerCutCents + q.barberNetCents).toBe(q.chargeCents);
      expect(q.transactionChargeCents).toBe(q.ownerCutCents + q.estimatedFeeCents);
    });
  }

  it('every amount is an integer cent value', () => {
    for (const base of [10000, 15000, 20000, 25000, 30000]) {
      const q = computeQuote(base, cfg);
      for (const [k, v] of Object.entries(q)) {
        if (typeof v === 'number') expect(Number.isInteger(v), k).toBe(true);
      }
    }
  });

  it('the R50 is identical on every service', () => {
    const fees = [8000, 10000, 20000, 30000, 36000].map(
      b => computeQuote(b, cfg).serviceFeeCents
    );
    expect(new Set(fees)).toEqual(new Set([5000]));
  });
});

// The ACTUAL Paystack fee decides the barber's exact payout. Nothing is
// hardcoded: these cases feed in arbitrary reported fees, including ones no
// current rate would produce, and the identities must still hold.
describe('settlement split from the ACTUAL Paystack fee', () => {
  it('barber gets base + (R50 - actual fee - owner cut); owner gets exactly its cut', () => {
    const q = computeQuote(20000, cfg); // charge 25000, ownerCut 2000, est 825
    for (const actualFee of [500, 825, 900, 1234, 2000]) {
      const s = computeActualSplit(
        q.chargeCents,
        q.ownerCutCents,
        actualFee,
        q.barberNetCents
      );
      expect(s.barberNetActualCents).toBe(
        q.baseCents + (FLAT_SERVICE_FEE_CENTS - actualFee - q.ownerCutCents)
      );
      expect(s.ownerNetCents).toBe(q.ownerCutCents);
      // Nothing is created or lost.
      expect(s.barberNetActualCents + s.ownerNetCents + actualFee).toBe(q.chargeCents);
    }
  });

  it('drift is the estimate error, signed toward whoever is owed', () => {
    const q = computeQuote(20000, cfg); // estimated fee 825
    // Paystack charged LESS than estimated -> barber is owed the difference.
    expect(
      computeActualSplit(q.chargeCents, q.ownerCutCents, 800, q.barberNetCents)
        .barberDriftCents
    ).toBe(25);
    // Exactly as estimated -> no drift.
    expect(
      computeActualSplit(q.chargeCents, q.ownerCutCents, 825, q.barberNetCents)
        .barberDriftCents
    ).toBe(0);
    // Paystack charged MORE (e.g. a rate rise) -> barber was over-paid.
    expect(
      computeActualSplit(q.chargeCents, q.ownerCutCents, 900, q.barberNetCents)
        .barberDriftCents
    ).toBe(-75);
  });

  it('survives a Paystack rate change with no code change', () => {
    // A hypothetical 3.5% + R2 world: the split still balances to the cent.
    const q = computeQuote(20000, cfg);
    const actualFee = Math.round(q.chargeCents * 0.035) + 200;
    const s = computeActualSplit(q.chargeCents, q.ownerCutCents, actualFee, q.barberNetCents);
    expect(s.ownerNetCents).toBe(q.ownerCutCents);
    expect(s.barberNetActualCents + s.ownerNetCents + actualFee).toBe(q.chargeCents);
  });
});

// The guard: a cut priced so high that R50 cannot cover fee + owner cut must
// be refused, never silently settled by underpaying the barber.
describe('underpay guard', () => {
  const threshold = maxSafeBaseCents(cfg);

  it('the threshold is the last base price whose barber net is not below base', () => {
    const at = computeQuote(threshold, cfg);
    expect(at.underpaysBarber).toBe(false);
    expect(at.barberNetCents).toBeGreaterThanOrEqual(threshold);
    // R368.64 under the default 2.9% + R1 estimate: there the owner's R36.86
    // plus the R13.14 estimated fee is exactly R50, leaving the barber the
    // base and not a cent more.
    expect(threshold).toBe(36864);
    expect(at.ownerCutCents + at.estimatedFeeCents).toBe(FLAT_SERVICE_FEE_CENTS);
    expect(at.barberNetCents).toBe(threshold);
  });

  it('refuses one cent above the threshold', () => {
    expect(computeQuote(threshold + 1, cfg).underpaysBarber).toBe(true);
  });

  it('fires just above the threshold', () => {
    const over = computeQuote(threshold + 100, cfg); // +R1
    expect(over.underpaysBarber).toBe(true);
    expect(over.barberNetCents).toBeLessThan(over.baseCents);
    expect(over.ownerCutCents + over.estimatedFeeCents).toBeGreaterThan(
      FLAT_SERVICE_FEE_CENTS
    );
  });

  it('every real menu price is comfortably under the threshold', () => {
    for (const base of [8000, 10000, 15000, 20000, 25000, 30000, 35000]) {
      expect(computeQuote(base, cfg).underpaysBarber).toBe(false);
    }
  });

  it('a worse Paystack rate lowers the threshold', () => {
    const pricey = readFeeConfig({ feePercent: 0.045, feeFlatRand: 3 });
    expect(maxSafeBaseCents(pricey)).toBeLessThan(threshold);
    expect(computeQuote(maxSafeBaseCents(pricey) + 100, pricey).underpaysBarber).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import {
  computeQuote,
  computeActualSplit,
  readFeeConfig,
  maxSafeBaseCents,
  estimateFeeCents,
  estimateFeeExVatCents,
  FLAT_SERVICE_FEE_CENTS,
} from '../functions/src/money';

// Exact-cent assertions for the APPROVED flat-R50 model, against the default
// fee estimate (2.9% + R1, plus 15% SA VAT on that fee). These numbers are
// the contract: if any of them change, real money moves differently.
//
//   customer pays = base + R50
//   owner gets    = exactly 10% of base
//   barber gets   = base + (R50 - Paystack fee incl. VAT - owner cut)
const cfg = readFeeConfig(undefined);

describe('flat R50 model (estimate: 2.9% + R1, +15% VAT)', () => {
  const cases = [
    // charge = base + 5000; feeExVat = round(charge*0.029) + 100;
    // estFee = round(feeExVat * 1.15); ownerCut = 10% of base;
    // barberNet = charge - ownerCut - estFee.
    // R100: charge 15000, exVat 535, estFee round(615.25) = 615, ownerCut 1000
    { rand: 100, base: 10000, charge: 15000, ownerCut: 1000, exVat: 535, estFee: 615, barberNet: 13385 },
    // R200: charge 25000, exVat 825, estFee round(948.75) = 949, ownerCut 2000
    { rand: 200, base: 20000, charge: 25000, ownerCut: 2000, exVat: 825, estFee: 949, barberNet: 22051 },
    // R300: charge 35000, exVat 1115, estFee round(1282.25) = 1282, ownerCut 3000
    { rand: 300, base: 30000, charge: 35000, ownerCut: 3000, exVat: 1115, estFee: 1282, barberNet: 30718 },
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
    const fees = [8000, 10000, 20000, 30000, 35000].map(
      b => computeQuote(b, cfg).serviceFeeCents
    );
    expect(new Set(fees)).toEqual(new Set([5000]));
  });
});

// VAT is charged on the Paystack fee itself. Omitting it made every
// transaction_charge short, so the owner silently netted under 10%.
describe('VAT on the Paystack fee', () => {
  it('estimate = fee ex-VAT grossed up by feeVatPercent', () => {
    for (const c of [15000, 25000, 30000, 35000]) {
      expect(estimateFeeCents(c, cfg)).toBe(
        Math.round(estimateFeeExVatCents(c, cfg) * 1.15)
      );
      expect(estimateFeeCents(c, cfg)).toBeGreaterThan(estimateFeeExVatCents(c, cfg));
    }
  });

  it('reproduces the real R300 live charge to the cent', () => {
    // Live txn 6432323630: charge R300 -> fees_breakdown R9.70, fees R11.16.
    expect(estimateFeeExVatCents(30000, cfg)).toBe(970);
    expect(estimateFeeCents(30000, cfg)).toBe(1116);
  });

  it('feeVatPercent is configurable and a configured zero is honoured', () => {
    const noVat = readFeeConfig({ feeVatPercent: 0 });
    expect(noVat.feeVatPercent).toBe(0);
    expect(estimateFeeCents(30000, noVat)).toBe(970);
    const vat20 = readFeeConfig({ feeVatPercent: 0.2 });
    expect(estimateFeeCents(30000, vat20)).toBe(1164);
  });

  it('defaults to 15% when paymentConfig says nothing', () => {
    expect(readFeeConfig(undefined).feeVatPercent).toBe(0.15);
    expect(readFeeConfig({}).feeVatPercent).toBe(0.15);
  });
});

// The ACTUAL Paystack fee decides the barber's exact payout. Nothing is
// hardcoded: these cases feed in arbitrary reported fees, including ones no
// current rate would produce, and the identities must still hold.
describe('settlement split from the ACTUAL Paystack fee', () => {
  it('barber banks exactly what was routed; the owner absorbs the fee drift', () => {
    const q = computeQuote(20000, cfg); // charge 25000, ownerCut 2000, est 949
    for (const actualFee of [500, 949, 1000, 1234, 2000]) {
      const s = computeActualSplit(
        q.chargeCents,
        q.ownerCutCents,
        actualFee,
        q.barberNetCents
      );
      // transaction_charge is fixed at init, so the subaccount is untouched
      // by whatever Paystack's real fee turned out to be.
      expect(s.barberNetActualCents).toBe(q.barberNetCents);
      // The owner keeps its cut plus/minus the estimate error.
      expect(s.ownerNetCents).toBe(q.ownerCutCents + s.barberDriftCents);
      // Nothing is created or lost.
      expect(s.barberNetActualCents + s.ownerNetCents + actualFee).toBe(q.chargeCents);
    }
  });

  it('the owner nets exactly its cut only when the estimate was exact', () => {
    const q = computeQuote(20000, cfg);
    expect(
      computeActualSplit(q.chargeCents, q.ownerCutCents, q.estimatedFeeCents, q.barberNetCents)
        .ownerNetCents
    ).toBe(q.ownerCutCents);
    // Fee came in higher than estimated -> owner keeps less than 10%.
    expect(
      computeActualSplit(q.chargeCents, q.ownerCutCents, q.estimatedFeeCents + 50, q.barberNetCents)
        .ownerNetCents
    ).toBe(q.ownerCutCents - 50);
  });

  it('drift is the estimate error, signed toward whoever is owed', () => {
    const q = computeQuote(20000, cfg); // estimated fee 949
    // Paystack charged LESS than estimated -> barber is owed the difference.
    expect(
      computeActualSplit(q.chargeCents, q.ownerCutCents, 924, q.barberNetCents)
        .barberDriftCents
    ).toBe(25);
    // Exactly as estimated -> no drift.
    expect(
      computeActualSplit(q.chargeCents, q.ownerCutCents, 949, q.barberNetCents)
        .barberDriftCents
    ).toBe(0);
    // Paystack charged MORE (e.g. a rate rise) -> barber was over-paid.
    expect(
      computeActualSplit(q.chargeCents, q.ownerCutCents, 1024, q.barberNetCents)
        .barberDriftCents
    ).toBe(-75);
    // Drift is identically estimatedFee - actualFee.
    for (const actualFee of [500, 949, 1500]) {
      expect(
        computeActualSplit(q.chargeCents, q.ownerCutCents, actualFee, q.barberNetCents)
          .barberDriftCents
      ).toBe(q.estimatedFeeCents - actualFee);
    }
  });

  it('survives a Paystack rate change with no code change', () => {
    // A hypothetical 3.5% + R2 world: the split still balances to the cent.
    const q = computeQuote(20000, cfg);
    const actualFee = Math.round(q.chargeCents * 0.035) + 200;
    const s = computeActualSplit(q.chargeCents, q.ownerCutCents, actualFee, q.barberNetCents);
    expect(s.barberNetActualCents).toBe(q.barberNetCents);
    expect(s.barberNetActualCents + s.ownerNetCents + actualFee).toBe(q.chargeCents);
  });

  // THE REGRESSION CASE. Live txn 6432323630 (ref WAYLINS-1786048344262-W8ZZ3AM5),
  // base R250 -> charge R300. Paystack's own fees_split reported
  // subaccount 26530, integration 2354, paystack 1116. Before this fix the
  // ledger recorded barber R263.84 / owner R25.00 — balanced, but attributed
  // R1.46 to the wrong party.
  it('reconciles the real R300 live charge against Paystack fees_split', () => {
    const chargedCents = 30000;
    const ownerCutCents = 2500; // 10% of the R250 base
    const actualFeeCents = 1116; // fees, VAT included
    const barberNetRoutedCents = 26530; // charged - transaction_charge (3470)

    const s = computeActualSplit(
      chargedCents,
      ownerCutCents,
      actualFeeCents,
      barberNetRoutedCents
    );
    expect(s.barberNetActualCents).toBe(26530); // R265.30 to the subaccount
    expect(s.ownerNetCents).toBe(2354); // R23.54 to the owner, not R25.00
    expect(s.barberDriftCents).toBe(-146); // owner absorbed R1.46
    // Sums to the charge to the cent.
    expect(s.barberNetActualCents + s.ownerNetCents + actualFeeCents).toBe(chargedCents);
  });

  it('with VAT in the estimate the same charge drifts by nothing', () => {
    // Re-quoting that booking today: the estimate now equals the real fee, so
    // transaction_charge is right and the owner keeps its full 10%.
    const q = computeQuote(25000, cfg); // base R250 -> charge R300
    expect(q.chargeCents).toBe(30000);
    expect(q.estimatedFeeCents).toBe(1116); // matches the real fee exactly
    expect(q.transactionChargeCents).toBe(3616); // ownerCut 2500 + fee 1116
    expect(q.barberNetCents).toBe(26384);

    const s = computeActualSplit(q.chargeCents, q.ownerCutCents, 1116, q.barberNetCents);
    expect(s.barberDriftCents).toBe(0);
    expect(s.ownerNetCents).toBe(2500); // the full 10%, no silent shortfall
    expect(s.barberNetActualCents).toBe(26384);
    expect(s.barberNetActualCents + s.ownerNetCents + 1116).toBe(30000);
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
    // R353.84 under the default 2.9% + R1 + 15% VAT estimate: there the
    // owner's R35.38 plus the R14.62 estimated fee is exactly R50, leaving
    // the barber the base and not a cent more. (Was R368.64 before VAT was
    // accounted for — that ceiling was optimistic by R14.80 and would have
    // let a service through that quietly shorted the barber.)
    expect(threshold).toBe(35384);
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

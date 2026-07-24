import { describe, it, expect } from 'vitest';
import { computeQuote, readFeeConfig } from '../functions/src/money';

// Exact-cent assertions against the DEFAULT fee config (2.9% + R1, round up
// to R5, R5 barber buffer). These numbers are the contract: if any of them
// change, real money moves differently.
const cfg = readFeeConfig(undefined);

describe('money math (default config: 2.9% + R1, round R5, buffer R5)', () => {
  const cases = [
    // [base, expected charge, expected ownerCut, expected estFee, expected barberNet]
    { rand: 150, base: 15000, charge: 18000, ownerCut: 1500, estFee: 622, barberNet: 15878 },
    { rand: 200, base: 20000, charge: 23500, ownerCut: 2000, estFee: 782, barberNet: 20718 },
    { rand: 300, base: 30000, charge: 35000, ownerCut: 3000, estFee: 1115, barberNet: 30885 },
  ];

  for (const c of cases) {
    it(`R${c.rand}: exact cents`, () => {
      const q = computeQuote(c.base, cfg);
      expect(q.chargeCents).toBe(c.charge);
      expect(q.ownerCutCents).toBe(c.ownerCut);
      expect(q.estimatedFeeCents).toBe(c.estFee);
      expect(q.barberNetCents).toBe(c.barberNet);
      expect(q.serviceFeeCents).toBe(c.charge - c.base);
    });

    it(`R${c.rand}: owner cut is exactly 10% of base`, () => {
      const q = computeQuote(c.base, cfg);
      expect(q.ownerCutCents).toBe(Math.round(c.base * 0.1));
    });

    it(`R${c.rand}: barber net >= base + buffer`, () => {
      const q = computeQuote(c.base, cfg);
      expect(q.barberNetCents).toBeGreaterThanOrEqual(c.base + cfg.barberBufferCents);
    });

    it(`R${c.rand}: components sum exactly to the charge`, () => {
      const q = computeQuote(c.base, cfg);
      expect(q.estimatedFeeCents + q.ownerCutCents + q.barberNetCents).toBe(q.chargeCents);
      expect(q.transactionChargeCents).toBe(q.ownerCutCents + q.estimatedFeeCents);
    });
  }

  it('every amount is an integer cent value', () => {
    for (const base of [15000, 20000, 30000, 10000, 25000]) {
      const q = computeQuote(base, cfg);
      for (const v of Object.values(q)) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });
});

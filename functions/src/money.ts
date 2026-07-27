// --- Money model (all authoritative, server-side) ---
// Pure arithmetic, no Firebase imports — extracted so the exact-cent
// behaviour is unit-testable. Prices are stored in RAND in Firestore;
// Paystack amounts are integer CENTS.
//
// THE APPROVED MODEL (flat R50):
//   charge (what the customer pays) = base + R50, on EVERY service.
//   ownerCut  = exactly 10% of base — the owner receives ONLY this.
//   barberNet = base + (R50 - Paystack fee - ownerCut), i.e. the barber keeps
//               the full base plus whatever of the R50 survives the Paystack
//               fee and the owner's 10%.
//
// The R50 has to cover BOTH the Paystack fee and the owner's 10% — those are
// the only two deductions in the model, and everything left over is the
// barber's. (charge - fee - ownerCut = barberNet, exactly, no remainder.)
// If the fee plus the owner cut ever exceeds R50 the barber would net less
// than the base price: that is the underpay case, and initTransaction REFUSES
// the booking rather than silently shorting the barber. See
// maxSafeBaseCents() for the base price where that starts.
//
// ESTIMATED vs ACTUAL fee. Paystack's split is fixed at initialize time via
// transaction_charge, before the real fee is known, so we must send an
// ESTIMATE (feePercent/feeFlat from settings/paymentConfig). At settlement the
// charge reports its ACTUAL fee, and the exact barber figure is recomputed
// from that. Both numbers are stored on the ledger row so the statement can
// show the drift — Paystack routed the estimate, so any difference between
// estimate and actual lands on the OWNER's side and is settled off-platform.
// Nothing here hardcodes a Paystack rate: a rate change only moves the drift.
export const DEFAULT_FEE_PERCENT = 0.029; // Paystack 2.9% (estimate only)
export const DEFAULT_FEE_FLAT_RAND = 1; // + R1 per transaction (estimate only)

// The flat customer-facing fee. Deliberately a constant, not config: the
// owner approved "R50 on every service" and it must not drift by accident.
export const FLAT_SERVICE_FEE_CENTS = 5000;

// The owner's share of the base price.
export const OWNER_SHARE = 0.1;

export interface FeeConfig {
  feePercent: number;
  feeFlatCents: number;
}

export const readFeeConfig = (payCfg: any): FeeConfig => ({
  feePercent: Number(payCfg?.feePercent) || DEFAULT_FEE_PERCENT,
  feeFlatCents: Math.round((Number(payCfg?.feeFlatRand) || DEFAULT_FEE_FLAT_RAND) * 100),
});

// Paystack's own fee formula, applied to whatever rate is configured.
export const estimateFeeCents = (chargeCents: number, cfg: FeeConfig): number =>
  Math.round(chargeCents * cfg.feePercent) + cfg.feeFlatCents;

export const ownerCutFor = (baseCents: number): number =>
  Math.round(baseCents * OWNER_SHARE);

export interface Quote {
  baseCents: number;
  ownerCutCents: number;
  chargeCents: number;
  serviceFeeCents: number; // always FLAT_SERVICE_FEE_CENTS
  estimatedFeeCents: number;
  transactionChargeCents: number;
  // What Paystack will actually route to the barber's subaccount (fixed at
  // initialize time, so it is based on the ESTIMATED fee).
  barberNetCents: number;
  // True when the R50 cannot cover the estimated fee + owner cut, so the
  // barber would net less than the base price. Callers MUST refuse.
  underpaysBarber: boolean;
}

export const computeQuote = (baseCents: number, cfg: FeeConfig): Quote => {
  const ownerCutCents = ownerCutFor(baseCents);
  const chargeCents = baseCents + FLAT_SERVICE_FEE_CENTS;
  const estimatedFeeCents = estimateFeeCents(chargeCents, cfg);
  const transactionChargeCents = ownerCutCents + estimatedFeeCents;
  const barberNetCents = chargeCents - transactionChargeCents;
  return {
    baseCents,
    ownerCutCents,
    chargeCents,
    serviceFeeCents: FLAT_SERVICE_FEE_CENTS,
    estimatedFeeCents,
    transactionChargeCents,
    barberNetCents,
    underpaysBarber: barberNetCents < baseCents,
  };
};

// The highest base price the flat R50 can still carry under the given fee
// assumptions. Above this, estimated fee + owner cut > R50 and the booking is
// refused. Derived closed-form, then walked down over the cent rounding so the
// answer is exact for the configured rate rather than an approximation.
export const maxSafeBaseCents = (cfg: FeeConfig): number => {
  const closed =
    (FLAT_SERVICE_FEE_CENTS -
      cfg.feeFlatCents -
      FLAT_SERVICE_FEE_CENTS * cfg.feePercent) /
    (OWNER_SHARE + cfg.feePercent);
  let b = Math.floor(closed) + 10; // start above the boundary, walk down
  while (b > 0 && computeQuote(b, cfg).underpaysBarber) b--;
  return b;
};

// --- Settlement-time exact split ---
// Called once Paystack reports the ACTUAL fee for the charge. This is the
// authoritative barber figure; `barberNetRouted` (from the quote) is merely
// what the split already moved.
export interface ActualSplit {
  actualFeeCents: number;
  // base + (R50 - actualFee - ownerCut): what the barber is owed, exactly.
  barberNetActualCents: number;
  // charged - barberNetActual - actualFee, which is exactly ownerCut.
  ownerNetCents: number;
  // barberNetActual - what Paystack routed. Positive = the estimate was too
  // high and the owner owes the barber this much; negative = the owner
  // over-paid the barber and keeps less than 10%.
  barberDriftCents: number;
}

export const computeActualSplit = (
  chargedCents: number,
  ownerCutCents: number,
  actualFeeCents: number,
  barberNetRoutedCents: number
): ActualSplit => {
  const barberNetActualCents = chargedCents - actualFeeCents - ownerCutCents;
  return {
    actualFeeCents,
    barberNetActualCents,
    ownerNetCents: chargedCents - barberNetActualCents - actualFeeCents,
    barberDriftCents: barberNetActualCents - barberNetRoutedCents,
  };
};

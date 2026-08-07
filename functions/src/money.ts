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
// ESTIMATE (feePercent/feeFlat/feeVatPercent from settings/paymentConfig). At
// settlement the charge reports its ACTUAL fee, and the exact split is
// recomputed from that. Both numbers are stored on the ledger row so the
// statement can show the drift — Paystack routed the estimate, so any
// difference between estimate and actual lands on the OWNER's side and is
// settled off-platform. Nothing here hardcodes a Paystack rate: a rate change
// only moves the drift.
//
// VAT. Paystack charges South African VAT on its own fee, and the transaction
// reports the two separately: `fees_breakdown.amount` is the fee proper and
// `fees` is what was actually taken. The first live charge (R300) showed
// R9.70 -> R11.16, exactly 15% on top. Omitting VAT made every
// transaction_charge R1.46 light, so the owner silently netted under 10% on
// every sale. The estimate therefore applies feeVatPercent to the fee.
export const DEFAULT_FEE_PERCENT = 0.029; // Paystack 2.9% (estimate only)
export const DEFAULT_FEE_FLAT_RAND = 1; // + R1 per transaction (estimate only)
// SA VAT on the Paystack fee itself. Configurable because the VAT rate is a
// legislative number that can change, and a non-SA integration would be 0.
export const DEFAULT_FEE_VAT_PERCENT = 0.15;

// The flat customer-facing fee. Deliberately a constant, not config: the
// owner approved "R50 on every service" and it must not drift by accident.
export const FLAT_SERVICE_FEE_CENTS = 5000;

// The owner's share of the base price.
export const OWNER_SHARE = 0.1;

export interface FeeConfig {
  feePercent: number;
  feeFlatCents: number;
  feeVatPercent: number;
}

// A configured ZERO is a legitimate value (no VAT outside SA), so it must not
// fall through to the default the way `||` would. Only missing/unparseable
// values take the default.
const numOr = (raw: any, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

export const readFeeConfig = (payCfg: any): FeeConfig => ({
  feePercent: numOr(payCfg?.feePercent, DEFAULT_FEE_PERCENT),
  feeFlatCents: Math.round(numOr(payCfg?.feeFlatRand, DEFAULT_FEE_FLAT_RAND) * 100),
  feeVatPercent: numOr(payCfg?.feeVatPercent, DEFAULT_FEE_VAT_PERCENT),
});

// Paystack's fee BEFORE VAT — this is the figure the transaction reports as
// `fees_breakdown.amount`.
export const estimateFeeExVatCents = (chargeCents: number, cfg: FeeConfig): number =>
  Math.round(chargeCents * cfg.feePercent) + cfg.feeFlatCents;

// What Paystack actually deducts: the fee plus VAT on it. Matches the
// transaction's `fees` field. Rounded once, at the end, so the estimate lands
// on the same cent Paystack does (R9.70 * 1.15 = 1115.5 -> 1116).
export const estimateFeeCents = (chargeCents: number, cfg: FeeConfig): number =>
  Math.round(estimateFeeExVatCents(chargeCents, cfg) * (1 + cfg.feeVatPercent));

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
  // VAT multiplies the whole fee, so it raises BOTH the per-charge percentage
  // and the flat component — the ceiling is materially lower than the ex-VAT
  // algebra suggests (R368.64 -> R353.84 at 2.9% + R1 + 15%).
  const vatMult = 1 + cfg.feeVatPercent;
  const effPercent = cfg.feePercent * vatMult;
  const closed =
    (FLAT_SERVICE_FEE_CENTS -
      cfg.feeFlatCents * vatMult -
      FLAT_SERVICE_FEE_CENTS * effPercent) /
    (OWNER_SHARE + effPercent);
  let b = Math.floor(closed) + 10; // start above the boundary, walk down
  while (b > 0 && computeQuote(b, cfg).underpaysBarber) b--;
  return b;
};

// --- Settlement-time exact split ---
// Called once Paystack reports the ACTUAL fee for the charge.
//
// WHO ABSORBS THE ESTIMATE ERROR. transaction_charge is fixed at initialize
// time and cannot be revised afterwards, and the split is sent with
// bearer "account". So Paystack ALWAYS routes exactly
// `charged - transaction_charge` to the barber's subaccount, and takes its
// real fee off the account (owner) side. The barber therefore banks the
// estimate; every cent of fee drift lands on the OWNER.
//
// This function used to back-solve ownerNet to exactly ownerCut, which
// implied the barber absorbed the drift. It balanced to the charge, so it
// looked right, but it put the difference on the wrong side of the ledger:
// the first live charge recorded owner R25.00 / barber R263.84 when Paystack
// had actually paid barber R265.30 / owner R23.54.
export interface ActualSplit {
  actualFeeCents: number;
  // What Paystack ACTUALLY routed to the subaccount = charged minus the
  // transaction_charge fixed at initialize time. Money already banked, not an
  // entitlement.
  barberNetActualCents: number;
  // charged - barberNetActual - actualFee: what is genuinely left for the
  // owner. Equals ownerCut only when the fee estimate was exact; otherwise it
  // is ownerCut + barberDrift.
  ownerNetCents: number;
  // What the model says the barber was owed, minus what Paystack routed.
  // Positive = the estimate was too high and the owner owes the barber this
  // much; negative = the owner over-paid the barber and keeps less than 10%.
  // Identically estimatedFee - actualFee.
  barberDriftCents: number;
}

export const computeActualSplit = (
  chargedCents: number,
  ownerCutCents: number,
  actualFeeCents: number,
  barberNetRoutedCents: number
): ActualSplit => {
  // What the flat-R50 model says the barber should have got, had the fee been
  // known up front. Used only to measure the drift — it is NOT what was paid.
  const barberEntitlementCents = chargedCents - actualFeeCents - ownerCutCents;
  return {
    actualFeeCents,
    barberNetActualCents: barberNetRoutedCents,
    ownerNetCents: chargedCents - barberNetRoutedCents - actualFeeCents,
    barberDriftCents: barberEntitlementCents - barberNetRoutedCents,
  };
};

// --- Money model (all authoritative, server-side) ---
// Pure arithmetic, no Firebase imports — extracted so the exact-cent
// behaviour is unit-testable. Prices are stored in RAND in Firestore;
// Paystack amounts are integer CENTS.
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
export const DEFAULT_FEE_PERCENT = 0.029; // Paystack 2.9%
export const DEFAULT_FEE_FLAT_RAND = 1; // + R1 per transaction
export const DEFAULT_ROUND_TO_RAND = 5; // charge rounded up to next R5
export const DEFAULT_BARBER_BUFFER_RAND = 5;

export interface FeeConfig {
  feePercent: number;
  feeFlatCents: number;
  roundToCents: number;
  barberBufferCents: number;
}

export const readFeeConfig = (payCfg: any): FeeConfig => ({
  feePercent: Number(payCfg?.feePercent) || DEFAULT_FEE_PERCENT,
  feeFlatCents: Math.round((Number(payCfg?.feeFlatRand) || DEFAULT_FEE_FLAT_RAND) * 100),
  roundToCents: Math.round((Number(payCfg?.roundToRand) || DEFAULT_ROUND_TO_RAND) * 100),
  barberBufferCents: Math.round(
    (Number(payCfg?.barberBufferRand) || DEFAULT_BARBER_BUFFER_RAND) * 100
  ),
});

export interface Quote {
  baseCents: number;
  ownerCutCents: number;
  chargeCents: number;
  estimatedFeeCents: number;
  transactionChargeCents: number;
  barberNetCents: number;
  serviceFeeCents: number;
}

export const computeQuote = (baseCents: number, cfg: FeeConfig): Quote => {
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

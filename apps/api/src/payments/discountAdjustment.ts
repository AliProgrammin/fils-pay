import { applyRateFils, subtractFils, type Fils } from "@filspay/money";

/**
 * Net fee for one capture event after the merchant's negotiated discount.
 * Same rule and rounding as settlement's ComputeSettlementFee
 * (apps/settlement/internal/settlement/discounted_fee.go): take the
 * discount off the amount first, then apply the MDR. capture.ts posts
 * (MDR fee - this) as the discount legs, so the ledger fee always equals
 * the fee the payout deducts. Integer fils, half-to-even, no floats.
 */
export function netCaptureFeeFils(amountFils: Fils, mdrBps: number, discountBps: number): Fils {
  const discountedAmount = subtractFils(amountFils, applyRateFils(amountFils, discountBps));
  return applyRateFils(discountedAmount, mdrBps);
}

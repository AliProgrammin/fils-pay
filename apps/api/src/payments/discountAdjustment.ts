import { applyRateFils, subtractFils, type Fils } from "@filspay/money";
import { BadRequestError } from "../lib/errors.js";


/**
 * Parses a promotional discount amount (BD string from the merchant
 * pricing dashboard) into fils for the ledger adjustment.
 */
export function parsePromotionalDiscountFils(raw: string): number {
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new BadRequestError("invalid_discount", `could not parse discount amount "${raw}"`);
  }
  return Math.round(parsed * 100);
}

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

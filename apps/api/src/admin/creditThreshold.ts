import { compareFils, toFils, type Fils } from "@filspay/money";
import { netCaptureFeeFils } from "../payments/discountAdjustment.js";

/** The two figures that make up a manual credit: what the operator asked to
 *  credit, and the MDR the platform hands back alongside it. */
export interface CreditAmounts {
  baseAmountFils: Fils;
  feeReversalFils: Fils;
}

/** Credits at or below this need one operator; above it, two. 50.000 BD. */
export const CREDIT_APPROVAL_THRESHOLD_FILS: Fils = toFils(50_000);

/** Maker-checker: does this credit need a second approver? */
export function creditRequiresSecondApprover(draft: CreditAmounts): boolean {
  return compareFils(draft.baseAmountFils, CREDIT_APPROVAL_THRESHOLD_FILS) > 0;
}

/** Computes the MDR reversal for a manual credit: the fee capture charged on
 *  this amount, after the merchant's negotiated discount (same rule and
 *  rounding as capture and settlement). */
export function calculateCreditFeeReversal(baseAmountFils: Fils, mdrBps: number, discountBps = 0): Fils {
  return netCaptureFeeFils(baseAmountFils, mdrBps, discountBps);
}

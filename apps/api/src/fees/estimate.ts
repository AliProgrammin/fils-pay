import { applyRateFils, subtractFils, toFils } from "@filspay/money";

/**
 * Estimated net fee for a single capture, in integer fils: the MDR fee as
 * capture.ts charges it (applyRateFils, half-to-even), less the negotiated
 * discount as payments/discountAdjustment.ts credits it back. No floats.
 */
export function estimateFeeFils(amountFils: number, mdrBps: number, discountBps: number): number {
  const fee = applyRateFils(toFils(amountFils), mdrBps);
  return Number(subtractFils(fee, applyRateFils(fee, discountBps)));
}

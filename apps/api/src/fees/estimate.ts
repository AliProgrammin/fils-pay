import { toFils } from "@filspay/money";
import { netCaptureFeeFils } from "../payments/discountAdjustment.js";

/**
 * Estimated net fee for a single capture, in integer fils: the same net fee
 * capture.ts posts and settlement deducts (netCaptureFeeFils). No floats.
 */
export function estimateFeeFils(amountFils: number, mdrBps: number, discountBps: number): number {
  return Number(netCaptureFeeFils(toFils(amountFils), mdrBps, discountBps));
}

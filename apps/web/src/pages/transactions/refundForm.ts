import { checkAmount } from "../../inputRules.js";

/** Statuses the API accepts a refund for (payments/refundValidation.ts). */
const REFUNDABLE_STATUSES = new Set(["captured", "partially_captured", "partially_refunded"]);

export function refundableFils(txn: { status: string; capturedFils: number; refundedFils: number }): number {
  if (!REFUNDABLE_STATUSES.has(txn.status)) return 0;
  return Math.max(0, txn.capturedFils - txn.refundedFils);
}

export type ParsedRefundAmount = { ok: true; amountFils: number } | { ok: false; message: string };

/**
 * The merchant types BD ("4.750"), never raw fils. parseBhdToFils parses the
 * text exactly (no float), and rejects more than 3 decimals.
 */
export function parseRefundAmount(text: string, maxFils: number): ParsedRefundAmount {
  const checked = checkAmount(text, { maxFils, example: "4.750" });
  return checked.ok ? { ok: true, amountFils: checked.fils } : { ok: false, message: checked.message };
}

/**
 * One Idempotency-Key per refund the merchant means to make. A retry of the
 * SAME submit (same transaction, amount and reason — for example after a
 * network error) reuses the key, so the server answers with the first result
 * and never refunds twice. A changed amount or reason is a different refund
 * and gets a new key. Call `reset()` after a success.
 */
export class RefundKeyKeeper {
  private current: { fingerprint: string; key: string } | null = null;

  constructor(private readonly newKey: () => string = () => crypto.randomUUID()) {}

  keyFor(transactionId: string, amountFils: number, reason: string): string {
    const fingerprint = `${transactionId}|${amountFils}|${reason}`;
    if (!this.current || this.current.fingerprint !== fingerprint) {
      this.current = { fingerprint, key: this.newKey() };
    }
    return this.current.key;
  }

  reset(): void {
    this.current = null;
  }
}

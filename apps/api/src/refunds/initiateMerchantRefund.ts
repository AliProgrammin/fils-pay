import type { Pool } from "pg";
import type { Fils } from "@filspay/money";
import type { AcquirerSimulator } from "../acquirer/types.js";
import type { MerchantAuthContext, MerchantWriterActor } from "../auth/requireMerchantAuth.js";
import { processRefund, type ProcessRefundResult } from "../payments/processRefund.js";
import { ForbiddenError, NotFoundError } from "../lib/errors.js";

/**
 * `POST /v1/merchants/:merchantId/refunds` business logic.
 *
 * Merchant-scoped path, refund target in the body — the same registration
 * shape `routes/paymentLinks.ts` and `routes/webhooks.ts` use under the
 * `/v1/merchants` prefix.
 */

/**
 * The path-scope check the route performs before this module's work begins —
 * the same shape `routes/paymentLinks.ts`'s `assertOwnMerchant` has, lifted
 * out so it is testable without a live route.
 */
export function assertRefundRequestScope(auth: MerchantAuthContext, merchantIdParam: string): void {
  if (auth.merchantId !== merchantIdParam) {
    throw new ForbiddenError("forbidden");
  }
}

export interface InitiateMerchantRefundInput {
  /** From the path, already scope-checked against the session above. */
  merchantId: string;
  /** From the body. */
  transactionId: string;
  amountFils?: Fils;
  idempotencyKey: string;
  actor: MerchantWriterActor;
  reason?: string;
}

/**
 * Refunds are off per merchant until support turns them on
 * (`merchants.refunds_enabled`, migration 0052): NULL means "not enabled
 * yet", false means "on hold" (a chargeback review, a compliance hold).
 * Only an explicit true lets a refund through, so nothing refunds by
 * accident.
 */
async function assertRefundsEnabled(pool: Pool, merchantId: string): Promise<void> {
  const result = await pool.query<{ refunds_enabled: boolean | null }>(
    `SELECT refunds_enabled FROM merchants WHERE id = $1`,
    [merchantId],
  );
  if (result.rows[0]?.refunds_enabled !== true) {
    throw new ForbiddenError("refunds_not_enabled");
  }
}

export async function initiateMerchantRefund(
  pool: Pool,
  acquirer: AcquirerSimulator,
  input: InitiateMerchantRefundInput,
): Promise<ProcessRefundResult> {
  await assertRefundsEnabled(pool, input.merchantId);

  // Scoped by the authenticated merchant (input.merchantId comes from the
  // auth context, never the body): another merchant's id is not found.
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM transactions WHERE id = $1 AND merchant_id = $2`,
    [input.transactionId, input.merchantId],
  );
  const txn = result.rows[0];
  if (!txn) {
    throw new NotFoundError("transaction_not_found");
  }

  return processRefund(pool, acquirer, {
    transactionId: txn.id,
    merchantId: input.merchantId,
    amountFils: input.amountFils,
    idempotencyKey: input.idempotencyKey,
    actor: input.actor,
    reason: input.reason,
  });
}

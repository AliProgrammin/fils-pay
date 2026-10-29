import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ZERO_FILS, addFils, calculateRefundFee, compareFils, subtractFils, toFils, type Fils } from "@filspay/money";
import { enqueueEvent } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { claimIdempotencyKey, completeIdempotencyKey, failIdempotencyKey, hashRequest } from "./idempotency.js";
import { recordTransactionEvent } from "../transactions/events.js";
import { nextStatusAfterRefund } from "./refundState.js";
import { validateRefundRequest } from "./refundValidation.js";
import { ConflictError, UnprocessableEntityError } from "../lib/errors.js";

const ENDPOINT = "refunds.create";
const REASON_UNSPECIFIED = "unspecified";

export interface ProcessRefundInput {
  transactionId: string;
  merchantId: string;
  amountFils?: Fils;
  idempotencyKey: string;
  actor: { type: "merchant_session" | "merchant_api_key"; id: string };
  reason?: string;
}

export interface ProcessRefundResult {
  statusCode: number;
  body: unknown;
}

interface RefundTransactionRow {
  id: string;
  merchant_id: string;
  status: string;
  amount_fils: string | number;
  captured_fils: string | number;
  refunded_fils: string | number;
  acquirer_reference: string;
}

/** Refund business logic: lock, validate, call the acquirer, journal the reversal. One DB transaction. */
export async function processRefund(
  pool: Pool,
  acquirer: AcquirerSimulator,
  input: ProcessRefundInput,
): Promise<ProcessRefundResult> {
  // Migration 0070: every refund row carries a reason, and its default is
  // 'unspecified'. Supply that default here; never pass NULL to the column.
  const reason = input.reason?.trim() || REASON_UNSPECIFIED;
  const requestHash = hashRequest({
    transactionId: input.transactionId,
    amountFils: input.amountFils ?? null,
    reason,
  });

  // One database transaction from claim to journal, like capture.ts: the
  // row lock is taken before validation and held across the acquirer call,
  // so a second refund on the same transaction waits here and is then
  // validated against the refunded total the first one wrote.
  return withTransaction(pool, async (client) => {
    const claim = await claimIdempotencyKey(client, {
      merchantId: input.merchantId,
      endpoint: ENDPOINT,
      key: input.idempotencyKey,
      requestHash,
    });

    if (claim.outcome === "conflict_hash_mismatch") {
      throw new UnprocessableEntityError("idempotency_key_reused");
    }
    if (claim.outcome === "conflict_in_progress") {
      throw new ConflictError("request_in_progress");
    }
    if (claim.outcome === "replay") {
      return { statusCode: claim.row.responseStatusCode ?? 200, body: claim.row.responseBody };
    }

    const txnResult = await client.query<RefundTransactionRow>(
      `SELECT id, merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference
         FROM transactions
        WHERE id = $1 AND merchant_id = $2
        FOR UPDATE`,
      // Scoped by the authenticated merchant: another merchant's
      // transaction is simply not found (404, never 403).
      [input.transactionId, input.merchantId],
    );
    const txn = txnResult.rows[0];
    if (!txn) {
      const body = { error: "transaction_not_found" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 404, body });
      return { statusCode: 404, body };
    }

    const amountAuthorized = toFils(Number(txn.amount_fils));
    const capturedFils = toFils(Number(txn.captured_fils));
    const refundedFils = toFils(Number(txn.refunded_fils));

    // What may still go back is what was captured less what was already
    // refunded. The authorized amount is never refundable: uncaptured
    // authorization was never taken from the cardholder.
    const refundableFils = subtractFils(capturedFils, refundedFils);

    const validation = validateRefundRequest(
      {
        id: txn.id,
        merchantId: txn.merchant_id,
        status: txn.status,
        capturedFils,
        refundableFils,
      },
      input.amountFils,
    );

    if (!validation.ok) {
      const statusCode = validation.code === "transaction_not_refundable" ? 409 : 422;
      await completeIdempotencyKey(client, claim.row.id, { statusCode, body: validation });
      return { statusCode, body: validation };
    }

    // The NET fee this transaction was charged, read from the ledger (never
    // recomputed from today's mdr_bps): capture fee credits less the
    // negotiated-discount debits on platform_fee_revenue. Earlier refund
    // reversals are left out here and counted separately below.
    const feeResult = await client.query<{ fee_fils: string; reversed_fils: string }>(
      `SELECT
         (SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
            FROM ledger_entries
           WHERE transaction_id = $1
             AND account_id = 'platform_fee_revenue'
             AND description NOT LIKE 'refund:%')::text AS fee_fils,
         (SELECT COALESCE(SUM(fee_reversed_fils), 0)
            FROM refunds
           WHERE transaction_id = $1 AND status = 'succeeded')::text AS reversed_fils`,
      [txn.id],
    );
    const feeRow = feeResult.rows[0];
    if (!feeRow) {
      throw new Error("processRefund: fee aggregate returned no row");
    }

    const prepared = {
      claimId: claim.row.id,
      transactionId: txn.id,
      merchantId: txn.merchant_id,
      amountAuthorized,
      capturedFils,
      refundedFils,
      feeChargedFils: toFils(Number(feeRow.fee_fils)),
      feeReversedBeforeFils: toFils(Number(feeRow.reversed_fils)),
      requestedAmount: validation.amountFils,
    };

    // Acquirer call, with the row lock above still held.
    const acquirerResult = await acquirer.refund({
      acquirerReference: txn.acquirer_reference,
      amountFils: prepared.requestedAmount,
      idempotencyKey: `${claim.row.id}:${claim.row.attemptCount}`,
    });

    if (acquirerResult.outcome === "declined") {
      const body = { error: "refund_declined" };
      await completeIdempotencyKey(client, prepared.claimId, { statusCode: 402, body });
      return { statusCode: 402, body };
    }
    if (acquirerResult.outcome === "error") {
      const body = { error: "acquirer_unavailable" };
      await failIdempotencyKey(client, prepared.claimId, { statusCode: 502, body });
      return { statusCode: 502, body };
    }

    const newRefundedTotal = addFils(prepared.refundedFils, prepared.requestedAmount);
    const newStatus = nextStatusAfterRefund({
      amountFils: prepared.amountAuthorized,
      capturedFils: prepared.capturedFils,
      refundedTotalFils: newRefundedTotal,
    });
    // Cumulative: all refunds of this capture together reverse exactly the
    // net fee charged, to the fil (see calculateRefundFee).
    const feeReversedFils = calculateRefundFee({
      capturedFils: prepared.capturedFils,
      feeChargedFils: prepared.feeChargedFils,
      refundedBeforeFils: prepared.refundedFils,
      feeReversedBeforeFils: prepared.feeReversedBeforeFils,
      refundAmountFils: prepared.requestedAmount,
    });

    const refundResult = await client.query<{ id: string; occurred_at: Date }>(
      `INSERT INTO refunds
         (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
          acquirer_reference, reason, created_by_type, created_by_id)
       VALUES ($1, $2, $3, $4, 'succeeded', $5, $6, $7, $8)
       RETURNING id, occurred_at`,
      [
        prepared.transactionId,
        prepared.merchantId,
        prepared.requestedAmount,
        feeReversedFils,
        acquirerResult.acquirerReference,
        reason,
        input.actor.type,
        input.actor.id,
      ],
    );
    const refund = refundResult.rows[0];
    if (!refund) {
      throw new Error("processRefund: insert into refunds returned no row");
    }

    await client.query(`UPDATE transactions SET refunded_fils = $2, status = $3 WHERE id = $1`, [
      prepared.transactionId,
      newRefundedTotal,
      newStatus,
    ]);

    // Double-entry reversal, mirroring capture's legs with the directions
    // swapped. ledger_entries has CHECK (amount_fils > 0), so a reversal
    // flips direction and never the sign.
    const entryGroupId = randomUUID();
    await client.query(
      `INSERT INTO ledger_entries
         (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES
         ($1, $2, $3, 'merchant_payable',     'debit',  $4, now(), 'refund: gross'),
         ($1, $2, $3, 'card_scheme_clearing', 'credit', $4, now(), 'refund: gross')`,
      [entryGroupId, prepared.merchantId, prepared.transactionId, prepared.requestedAmount],
    );
    if (compareFils(feeReversedFils, ZERO_FILS) > 0) {
      await client.query(
        `INSERT INTO ledger_entries
           (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
         VALUES
           ($1, $2, $3, 'platform_fee_revenue', 'debit',  $4, now(), 'refund: MDR fee reversal'),
           ($1, $2, $3, 'merchant_payable',     'credit', $4, now(), 'refund: MDR fee reversal')`,
        [entryGroupId, prepared.merchantId, prepared.transactionId, feeReversedFils],
      );
    }

    // The timeline records what this refund did to the captured amount, so
    // it stays readable regardless of what the status column ends up
    // saying: everything captured has now gone back, or only part of it has.
    const eventType = compareFils(newRefundedTotal, prepared.capturedFils) >= 0 ? "refunded" : "refund_partial";

    await recordTransactionEvent(client, {
      transactionId: prepared.transactionId,
      eventType,
      amountFils: toFils(-prepared.requestedAmount, { allowNegative: true }),
      actor: input.actor,
      metadata: {
        refundId: refund.id,
        feeReversedFils,
        acquirerReference: acquirerResult.acquirerReference,
      },
    });

    await enqueueEvent(client, {
      eventType: "refund.succeeded",
      aggregateType: "transaction",
      aggregateId: prepared.transactionId,
      payload: {
        merchantId: prepared.merchantId,
        refundId: refund.id,
        amountFils: prepared.requestedAmount,
        feeReversedFils,
        refundedTotalFils: newRefundedTotal,
        newStatus,
      },
    });

    const body = {
      id: refund.id,
      transactionId: prepared.transactionId,
      merchantId: prepared.merchantId,
      amountFils: prepared.requestedAmount,
      feeReversedFils,
      status: "succeeded",
      transactionStatus: newStatus,
      refundedTotalFils: newRefundedTotal,
      acquirerReference: acquirerResult.acquirerReference,
      occurredAt: refund.occurred_at.toISOString(),
    };
    await completeIdempotencyKey(client, prepared.claimId, {
      statusCode: 200,
      body,
      resourceId: refund.id,
    });
    return { statusCode: 200, body };
  });
}

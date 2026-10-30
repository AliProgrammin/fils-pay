import type { Pool } from "pg";
import { voidTransaction } from "../payments/void.js";
import { finalizePaidLink, releaseReservation } from "./pay.js";

/**
 * L5: recovery sweep for payment links cut off past the bind step (api
 * crash, kill -9, restart). pay.ts binds the authorization to the link
 * (pending_transaction_id) before it captures, and from then on the
 * reservation timeout no longer frees the link. If the process dies there,
 * nothing else would ever move the link on. This sweep does:
 *
 *  1. bound transaction fully captured -> mark the link paid, with the same
 *     conditional UPDATE as the live finalize step (finalizePaidLink). No
 *     age check: the live request would write exactly the same row, and it
 *     treats "already paid by this transaction" as success.
 *  2. bound transaction still authorized and the reservation older than the
 *     grace period -> void it through voidTransaction (holds, events,
 *     outbox/webhook) and release the link.
 *  3. bound transaction already voided (crash between 1-2's void and its
 *     release) -> release the link.
 *
 * A live request is never overtaken: the grace period is far longer than a
 * payment, voidTransaction takes the transaction row lock (a running
 * capture holds it, and after it commits the void answers 409 and the
 * next pass finalizes instead), and the release only matches while the
 * reservation (reserved_at) is unchanged.
 *
 * A crash between claim and bind (no bound transaction) needs no sweep:
 * the claim rule re-opens the link after the reservation timeout.
 */

const BATCH_LIMIT = 500;

interface StuckLinkRow {
  id: string;
  merchant_id: string;
  reservation: string;
  txn_id: string;
  txn_status: string;
  fully_captured: boolean;
}

export interface RecoveryPassResult {
  finalized: number;
  released: number;
}

export async function runPaymentLinkRecoveryPass(
  pool: Pool,
  config: { graceSeconds: number },
): Promise<RecoveryPassResult> {
  const stuck = await pool.query<StuckLinkRow>(
    `SELECT pl.id, pl.merchant_id, pl.reserved_at::text AS reservation,
            t.id AS txn_id, t.status AS txn_status,
            (t.captured_fils > 0 AND t.captured_fils = t.amount_fils) AS fully_captured
       FROM payment_links pl
       JOIN transactions t ON t.id = pl.pending_transaction_id
      WHERE pl.status = 'reserved'
        AND (
             (t.captured_fils > 0 AND t.captured_fils = t.amount_fils)
             OR (t.status IN ('authorized', 'voided')
                 AND pl.reserved_at < now() - ($1 || ' seconds')::interval)
            )
      ORDER BY pl.reserved_at
      LIMIT $2`,
    [config.graceSeconds, BATCH_LIMIT],
  );

  const result: RecoveryPassResult = { finalized: 0, released: 0 };
  for (const row of stuck.rows) {
    try {
      if (row.fully_captured) {
        if (await finalizePaidLink(pool, row.id, row.txn_id)) result.finalized += 1;
        continue;
      }
      if (row.txn_status === "authorized") {
        const voided = await voidTransaction(pool, {
          transactionId: row.txn_id,
          merchantId: row.merchant_id,
          actor: { type: "system", id: row.id },
        });
        // 409: a capture won the row lock first; the next pass finalizes.
        if (voided.statusCode !== 200) continue;
      }
      if (await releaseReservation(pool, row.id, row.reservation)) result.released += 1;
    } catch (err: unknown) {
      // One bad row must not stop the others; the next pass retries it.
      console.error(`[paymentLinks/recovery] link ${row.id} failed`, err);
    }
  }
  if (result.finalized > 0 || result.released > 0) {
    console.log(`[paymentLinks/recovery] finalized=${result.finalized} released=${result.released}`);
  }
  return result;
}

export interface PaymentLinkRecoveryHandle {
  stop(): Promise<void>;
}

/** Runs one pass now (startup) and then every intervalMs. Never overlaps passes. */
export function startPaymentLinkRecovery(
  pool: Pool,
  config: { paymentLinkRecoveryGraceSeconds: number; paymentLinkRecoveryIntervalMs: number },
): PaymentLinkRecoveryHandle {
  let current: Promise<void> | null = null;
  let stopped = false;

  const triggerPass = (): void => {
    if (current || stopped) return;
    current = runPaymentLinkRecoveryPass(pool, { graceSeconds: config.paymentLinkRecoveryGraceSeconds })
      .then(() => undefined)
      .catch((err: unknown) => {
        console.error("[paymentLinks/recovery] pass failed", err);
      })
      .finally(() => {
        current = null;
      });
  };

  triggerPass();
  const interval = setInterval(triggerPass, config.paymentLinkRecoveryIntervalMs);

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(interval);
      await current;
    },
  };
}

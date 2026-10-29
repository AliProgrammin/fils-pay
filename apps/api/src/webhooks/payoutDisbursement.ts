import type { Pool } from "pg";

/**
 * Operational record of a payout-rail instruction for a settlement batch.
 * Idempotent: one row per batch (unique index, migration 0079). The
 * dispatcher calls this once per endpoint and again on replays.
 */
export async function recordPayoutDisbursementEffect(
  pool: Pool,
  settlementBatchId: string,
  amountFils: number,
): Promise<void> {
  if (amountFils <= 0) {
    // Void batches (zero or negative net) carry no payout instruction.
    return;
  }

  await pool.query(
    `INSERT INTO settlement_payout_disbursements (settlement_batch_id, amount_fils, disbursement_reference)
     VALUES ($1, $2, 'disb_' || gen_random_uuid())
     ON CONFLICT (settlement_batch_id) DO NOTHING`,
    [settlementBatchId, amountFils],
  );
}

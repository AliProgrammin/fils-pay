/**
 * A settlement batch is paid out once. The disbursement record must be one
 * row per batch, no matter how many endpoints, replays or retries call it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { recordPayoutDisbursementEffect } from "./payoutDisbursement.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("payoutDisbursement.fix.test.ts requires DATABASE_URL");

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
test.after(async () => {
  await pool.end();
});

test("recordPayoutDisbursementEffect called twice (two endpoints / a replay) keeps one disbursement per batch", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Disbursement Fix Merchant ${randomUUID()}`],
  );
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches
        (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at, paid_at)
     VALUES ($1, current_date, 'paid', 5000, 0, 5000, now(), now())
     RETURNING id`,
    [merchant.rows[0]!.id],
  );
  const batchId = batch.rows[0]!.id;

  await Promise.all([
    recordPayoutDisbursementEffect(pool, batchId, 5_000),
    recordPayoutDisbursementEffect(pool, batchId, 5_000),
  ]);
  await recordPayoutDisbursementEffect(pool, batchId, 5_000);

  const rows = await pool.query(`SELECT 1 FROM settlement_payout_disbursements WHERE settlement_batch_id = $1`, [
    batchId,
  ]);
  assert.equal(rows.rows.length, 1);
});

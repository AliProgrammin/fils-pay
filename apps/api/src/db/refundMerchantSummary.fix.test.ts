/**
 * E6: refund_merchant_summary must join refunds to their own transaction
 * and count each transaction's captured amount once. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("refundMerchantSummary.fix.test.ts requires DATABASE_URL");
}
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
after(async () => {
  await pool.end();
});

test("two partial refunds of one 10.000 BD capture count 10.000 BD captured once", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
     VALUES ($1, 250, 'active', false) RETURNING id`,
    [`refund-summary-${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'captured', 10000, 10000, $2) RETURNING id`,
    [merchantId, `acq_${randomUUID()}`],
  );
  const transactionId = t.rows[0]!.id;
  for (const amount of [3000, 2000]) {
    await pool.query(
      `INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
                            acquirer_reference, created_by_type, created_by_id)
       VALUES ($1, $2, $3, 0, 'succeeded', $4, 'merchant_session', $5)`,
      [transactionId, merchantId, amount, `ref_${randomUUID()}`, randomUUID()],
    );
  }

  await pool.query(`REFRESH MATERIALIZED VIEW refund_merchant_summary`);
  const rows = await pool.query<{ refund_count: string; total_refunded_fils: string; original_captured_fils: string }>(
    `SELECT refund_count::text, total_refunded_fils::text, original_captured_fils::text
       FROM refund_merchant_summary WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(rows.rows.length, 1, "the merchant's refunds must appear in the summary");
  assert.deepEqual(rows.rows[0], {
    refund_count: "2",
    total_refunded_fils: "5000",
    original_captured_fils: "10000",
  });
});

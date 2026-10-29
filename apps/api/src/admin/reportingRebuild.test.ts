/**
 * The admin "rebuild analytics" path repopulates merchant_daily_volume from
 * transaction_events. It must rebuild the refund columns too (FP-300), or a
 * rebuild silently erases every refund from the report.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { refreshAnalyticsRollups } from "./reportingRebuild.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("reportingRebuild.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
test.after(async () => {
  await pool.end();
});

test("refreshAnalyticsRollups rebuilds refund_count and refund_gross_fils from refund events", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`rebuild-refunds ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const txn = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference, occurred_at)
     VALUES ($1, 'refunded', 10000, 10000, 10000, $2, '2026-02-10T09:00:00Z') RETURNING id`,
    [merchantId, `acq-${randomUUID()}`],
  );
  const txnId = txn.rows[0]!.id;
  // 22:00 UTC on 10 Feb is 01:00 on 11 Feb in Bahrain.
  await pool.query(
    `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at) VALUES
       ($1, 'captured',       10000, 'system', '2026-02-10T09:00:00Z'),
       ($1, 'refund_partial', -4000, 'system', '2026-02-10T22:00:00Z'),
       ($1, 'refunded',       -6000, 'system', '2026-02-10T22:30:00Z')`,
    [txnId],
  );

  await withTransaction(pool, (client) => refreshAnalyticsRollups(client));

  const rows = await pool.query<{ d: string; captured_count: number; refund_count: number; refund_gross_fils: string }>(
    `SELECT volume_date::text AS d, captured_count, refund_count, refund_gross_fils
       FROM merchant_daily_volume WHERE merchant_id = $1 ORDER BY volume_date`,
    [merchantId],
  );
  assert.deepEqual(
    rows.rows.map((r) => [r.d, r.captured_count, r.refund_count, Number(r.refund_gross_fils)]),
    [
      ["2026-02-10", 1, 0, 0],
      ["2026-02-11", 0, 2, 10_000],
    ],
  );
});

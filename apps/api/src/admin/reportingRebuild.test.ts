/**
 * The admin "rebuild analytics" path must not double count (U5). It used to
 * refill merchant_daily_volume from transaction_events but leave the
 * reporting cursor where it was, so the worker then applied every pending
 * outbox event on top of rows that already held it. The rollups have one
 * writer: the reporting consumer. The rebuild now empties them and moves the
 * consumer's cursor back to the start, in one transaction, so the consumer
 * replays the whole outbox exactly once.
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

test("refreshAnalyticsRollups empties both rollups and resets the reporting cursor in the same transaction", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`rebuild-cursor ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  await pool.query(
    `INSERT INTO merchant_daily_volume (merchant_id, volume_date, captured_count, captured_gross_fils, last_updated_at)
     VALUES ($1, '2026-02-10', 3, 30000, now())`,
    [merchantId],
  );
  // A worker that is part-way through the outbox: these events are already
  // in the rollup, so leaving the cursor here and refilling from source
  // counts the pending events twice.
  await pool.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_txid, last_processed_id, updated_at)
     VALUES ('reporting', '12345', 678, now())
     ON CONFLICT (consumer_name) DO UPDATE SET last_processed_txid = '12345', last_processed_id = 678`,
  );
  const before = await pool.query<{ v: number; t: number }>(
    `SELECT (SELECT count(*)::int FROM merchant_daily_volume) AS v,
            (SELECT count(*)::int FROM merchant_payout_trends) AS t`,
  );

  const summary = await withTransaction(pool, (client) => refreshAnalyticsRollups(client));

  assert.deepEqual(summary, { volumeRows: before.rows[0]!.v, trendRows: before.rows[0]!.t });
  const after = await pool.query<{ v: number; t: number }>(
    `SELECT (SELECT count(*)::int FROM merchant_daily_volume) AS v,
            (SELECT count(*)::int FROM merchant_payout_trends) AS t`,
  );
  assert.deepEqual(after.rows[0], { v: 0, t: 0 }, "only the consumer may fill the rollups");
  const cursor = await pool.query<{ txid: string; id: string }>(
    `SELECT last_processed_txid::text AS txid, last_processed_id::text AS id
       FROM reporting_outbox_cursor WHERE consumer_name = 'reporting'`,
  );
  assert.deepEqual(cursor.rows[0], { txid: "0", id: "0" }, "the consumer must replay from the start");
});

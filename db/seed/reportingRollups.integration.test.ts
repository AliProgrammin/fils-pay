/**
 * The merchant Overview (apps/reporting's read model) must agree with the
 * seeded transactions and settlement batches, bucketed by the Asia/Bahrain
 * day the money moved — never the day the seed (or the consumer) ran.
 *
 * Runs generate() itself, then replays the outbox through the real reporting
 * consumer. Requires DATABASE_URL pointing at a migrated Postgres that may be
 * re-seeded.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { generate } from "./generate.js";
import { runConsumerPass } from "../../apps/reporting/src/consumer/runConsumerPass.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("reportingRollups.integration.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

before(async () => {
  await generate(pool);
  for (;;) {
    const { processedCount } = await runConsumerPass(pool, { consumerBatchLimit: 1000 });
    if (processedCount === 0) break;
  }
});

after(async () => {
  await pool.end();
});

test("Alpha Retail's August captured volume is its 31 Aug batch gross plus its not-yet-batched August captures", async () => {
  // The multi-capture fee fixture (alpha-retail-multi-evt-*, 26 Aug, 650 BD)
  // is captured but deliberately not in any batch yet.
  const { rows } = await pool.query<{ rollup: string; batch: string; unbatched: string }>(`
    SELECT (SELECT COALESCE(sum(v.captured_gross_fils), 0) FROM merchant_daily_volume v
             WHERE v.merchant_id = m.id AND v.volume_date >= '2026-08-01' AND v.volume_date < '2026-09-01') AS rollup,
           (SELECT gross_fils FROM settlement_batches sb
             WHERE sb.merchant_id = m.id AND sb.batch_date = '2026-08-31') AS batch,
           (SELECT COALESCE(sum(te.amount_fils), 0) FROM transaction_events te JOIN transactions t ON t.id = te.transaction_id
             WHERE t.merchant_id = m.id AND te.event_type IN ('captured', 'partially_captured')
               AND te.settlement_batch_id IS NULL
               AND te.occurred_at >= '2026-08-01T00:00:00+03:00' AND te.occurred_at < '2026-09-01T00:00:00+03:00') AS unbatched
      FROM merchants m WHERE m.display_name = 'Alpha Retail Co'`);
  assert.equal(Number(rows[0]?.batch), 7_326_913);
  assert.equal(Number(rows[0]?.unbatched), 650_000);
  assert.equal(Number(rows[0]?.rollup), 7_326_913 + 650_000);
});

test("every merchant's daily captured volume and count equal its capture ledger legs per Bahrain day", async () => {
  // Ground truth: one capture = one card_scheme_clearing debit (the gross leg).
  const { rows } = await pool.query<{ merchant_id: string; day: string; expected: string; actual: string }>(`
    WITH truth AS (
      SELECT merchant_id, (occurred_at AT TIME ZONE 'Asia/Bahrain')::date AS day,
             count(*) AS n, sum(amount_fils) AS gross
        FROM ledger_entries
       WHERE account_id = 'card_scheme_clearing' AND direction = 'debit' AND description LIKE 'capture%'
       GROUP BY 1, 2),
    rollup AS (
      SELECT merchant_id, volume_date AS day, captured_count AS n, captured_gross_fils AS gross
        FROM merchant_daily_volume WHERE captured_count > 0)
    SELECT COALESCE(t.merchant_id, r.merchant_id) AS merchant_id, COALESCE(t.day, r.day)::text AS day,
           COALESCE(t.n, 0) || '/' || COALESCE(t.gross, 0) AS expected,
           COALESCE(r.n, 0) || '/' || COALESCE(r.gross, 0) AS actual
      FROM truth t FULL JOIN rollup r ON r.merchant_id = t.merchant_id AND r.day = t.day
     WHERE t.n IS DISTINCT FROM r.n OR t.gross IS DISTINCT FROM r.gross`);
  assert.equal(rows.length, 0, `${rows.length} merchant-day(s) differ (count/gross), e.g. ${JSON.stringify(rows[0])}`);
});

test("every merchant's daily voided count equals its voided events per Bahrain day", async () => {
  const { rows } = await pool.query<{ merchant_id: string; day: string }>(`
    WITH truth AS (
      SELECT t.merchant_id, (te.occurred_at AT TIME ZONE 'Asia/Bahrain')::date AS day, count(*) AS n
        FROM transaction_events te JOIN transactions t ON t.id = te.transaction_id
       WHERE te.event_type = 'voided' GROUP BY 1, 2),
    rollup AS (SELECT merchant_id, volume_date AS day, voided_count AS n FROM merchant_daily_volume WHERE voided_count > 0)
    SELECT COALESCE(t.merchant_id, r.merchant_id) AS merchant_id, COALESCE(t.day, r.day)::text AS day
      FROM truth t FULL JOIN rollup r ON r.merchant_id = t.merchant_id AND r.day = t.day
     WHERE t.n IS DISTINCT FROM r.n`);
  assert.equal(rows.length, 0, `${rows.length} merchant-day(s) have a wrong voided count, e.g. ${JSON.stringify(rows[0])}`);
});

test("every closed settlement batch appears once in payout trends with its own totals", async () => {
  const { rows } = await pool.query<{ id: string }>(`
    SELECT sb.id FROM settlement_batches sb
      LEFT JOIN merchant_payout_trends p ON p.settlement_batch_id = sb.id
     WHERE sb.status <> 'open'
       AND (p.settlement_batch_id IS NULL OR p.batch_date <> sb.batch_date OR p.gross_fils <> sb.gross_fils
            OR p.fee_fils <> sb.fee_fils OR p.net_payout_fils <> sb.net_payout_fils)`);
  assert.equal(rows.length, 0, `${rows.length} closed batch(es) missing or wrong in payout trends`);
});

test("nothing seeded is reported as captured on the day the seed ran", async () => {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM merchant_daily_volume WHERE volume_date > '2026-09-01'`,
  );
  assert.equal(Number(rows[0]?.count), 0);
});

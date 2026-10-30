/**
 * V1 (docs/bugs/venue-hint.md): every seeded capture must be charged the
 * fee-schedule rate in force at its own occurred_at, the same rule
 * capture.ts, settlement/query.ts and the Go EffectiveMdrBpsAt use.
 * Otherwise settlement charges a different fee than the ledger holds and
 * the merchant is paid out more (or less) than the ledger owes.
 *
 * Runs generate() itself. Requires DATABASE_URL pointing at a migrated
 * Postgres that may be re-seeded.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { applyRateFils, toFils } from "@filspay/money";
import { generate } from "./generate.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("feeAtEventTime.integration.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

// Same rule as apps/api/src/fees/feeSchedule.ts getEffectiveMdrBps.
const RATE_AT = (at: string) => `
  COALESCE(
    (SELECT fs.mdr_bps FROM fee_schedules fs
      WHERE fs.merchant_id = m.id AND fs.effective_from <= ${at}
      ORDER BY fs.effective_from DESC, fs.created_at DESC LIMIT 1),
    m.mdr_bps)`;

before(async () => {
  await generate(pool);
});

after(async () => {
  await pool.end();
});

test("every seeded capture ledger group's fee is the rate in force at its occurred_at", async () => {
  // Merchants with a negotiated discount (the marketplace) post a
  // discounted fee; they have no fee_schedules rows and are out of scope.
  const { rows } = await pool.query<{ gross: string; fee: string; rate: number; description: string; occurred_at: Date }>(`
    SELECT g.gross, g.fee, ${RATE_AT("g.occurred_at")} AS rate, g.description, g.occurred_at
      FROM (SELECT entry_group_id, merchant_id, min(description) AS description, min(occurred_at) AS occurred_at,
                   sum(amount_fils) FILTER (WHERE account_id = 'card_scheme_clearing' AND direction = 'debit') AS gross,
                   COALESCE(sum(amount_fils) FILTER (WHERE account_id = 'platform_fee_revenue' AND direction = 'credit'), 0) AS fee
              FROM ledger_entries
             WHERE description LIKE 'capture %'
             GROUP BY entry_group_id, merchant_id) g
      JOIN merchants m ON m.id = g.merchant_id
     WHERE m.negotiated_discount_bps = 0`);
  assert.ok(rows.length > 1000, `expected the seeded capture groups, got ${rows.length}`);
  const wrong = rows.filter((r) => Number(r.fee) !== applyRateFils(toFils(Number(r.gross)), r.rate));
  assert.equal(
    wrong.length,
    0,
    `${wrong.length} capture group(s) charged the wrong rate, e.g. ${wrong[0]?.description} at ` +
      `${wrong[0]?.occurred_at.toISOString()}: fee ${wrong[0]?.fee} on ${wrong[0]?.gross}, rate in force ${wrong[0]?.rate} bps`,
  );
});

test("every seeded capture event's metadata.feeFils is the rate in force at its occurred_at", async () => {
  const { rows } = await pool.query<{ amount: string; fee: number; rate: number; occurred_at: Date }>(`
    SELECT te.amount_fils AS amount, (te.metadata->>'feeFils')::int AS fee, ${RATE_AT("te.occurred_at")} AS rate, te.occurred_at
      FROM transaction_events te
      JOIN transactions t ON t.id = te.transaction_id
      JOIN merchants m ON m.id = t.merchant_id
     WHERE te.metadata ? 'feeFils' AND m.negotiated_discount_bps = 0`);
  assert.ok(rows.length > 0, "expected seeded capture events with a feeFils");
  const wrong = rows.filter((r) => r.fee !== applyRateFils(toFils(Number(r.amount)), r.rate));
  assert.equal(wrong.length, 0, `${wrong.length} capture event(s) carry the wrong feeFils`);
});

test("the alpha-retail 2026-08-26 instalment captures post the 225 bps fee settlement will charge", async () => {
  const { rows } = await pool.query<{ gross: string; fee: string }>(`
    SELECT sum(le.amount_fils) FILTER (WHERE le.account_id = 'card_scheme_clearing' AND le.direction = 'debit') AS gross,
           sum(le.amount_fils) FILTER (WHERE le.account_id = 'platform_fee_revenue' AND le.direction = 'credit') AS fee
      FROM ledger_entries le JOIN transactions t ON t.id = le.transaction_id
     WHERE t.reference LIKE 'alpha-retail-multi-evt-%'`);
  assert.equal(Number(rows[0]?.gross), 650_000);
  // Settlement (Go run-batch) charged 14,625 for this day; the seed posted 16,250.
  assert.equal(Number(rows[0]?.fee), 14_625);
});

test("every pre-baked closed batch's fee_fils equals the ledger fee of the captures it settles", async () => {
  const { rows } = await pool.query<{ batch_date: string; fee_fils: string; ledger_fee: string }>(`
    SELECT sb.batch_date::text, sb.fee_fils,
           (SELECT COALESCE(sum(le.amount_fils), 0) FROM ledger_entries le
             WHERE le.account_id = 'platform_fee_revenue' AND le.direction = 'credit'
               AND le.transaction_id IN (SELECT transaction_id FROM scheme_export_lines WHERE settlement_batch_id = sb.id)) AS ledger_fee
      FROM settlement_batches sb
     WHERE sb.status = 'closed'
       AND EXISTS (SELECT 1 FROM scheme_export_lines WHERE settlement_batch_id = sb.id)`);
  assert.ok(rows.length > 0, "expected pre-baked closed batches");
  const wrong = rows.filter((r) => Number(r.fee_fils) !== Number(r.ledger_fee));
  assert.equal(wrong.length, 0, `${wrong.length} batch(es) disagree, e.g. ${JSON.stringify(wrong[0])}`);
});

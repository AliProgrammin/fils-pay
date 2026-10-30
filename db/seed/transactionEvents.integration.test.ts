/**
 * Every seeded transaction has the event timeline the live API would have
 * written for it (authorize.ts, capture.ts, void.ts), so the dashboard's
 * "Event timeline" is never empty for seeded payments. The March
 * reconciliation fixture is the one exception: no settlement batch covers
 * it, so it carries no events (see generate.ts).
 *
 * Runs generate() itself. Requires DATABASE_URL pointing at a migrated
 * Postgres that may be re-seeded.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { generate } from "./generate.js";
import { listTransactionEvents } from "../../apps/api/src/transactions/events.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("transactionEvents.integration.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

before(async () => {
  await generate(pool);
});

after(async () => {
  await pool.end();
});

test("seeded captured transaction alpha-retail-txn-0031 has authorized and captured events", async () => {
  const { rows } = await pool.query<{ id: string; amount_fils: string; occurred_at: Date }>(
    `SELECT id, amount_fils, occurred_at FROM transactions WHERE reference = 'alpha-retail-txn-0031' AND status = 'captured'`,
  );
  const txn = rows[0];
  assert.ok(txn, "expected seeded captured transaction alpha-retail-txn-0031");

  const events = await listTransactionEvents(pool, txn.id);
  assert.deepEqual(
    events.map((e) => [e.eventType, e.amountFils, e.actorType, e.actorId]),
    [
      ["authorized", null, "system", null],
      ["captured", Number(txn.amount_fils), "system", null],
    ],
  );
  for (const event of events) {
    assert.equal(event.occurredAt, txn.occurred_at.toISOString());
  }
  assert.equal(typeof events[1]?.metadata.feeFils, "number");
  assert.equal(typeof events[1]?.metadata.acquirerReference, "string");
});

test("every seeded transaction's timeline matches its status, captured amount and ledger", async () => {
  const { rows } = await pool.query<{ reference: string; status: string; problem: string }>(`
    SELECT t.reference, t.status,
           CASE
             WHEN e.authorized <> 1 THEN 'authorized events = ' || e.authorized
             WHEN e.voided <> CASE WHEN t.status = 'voided' THEN 1 ELSE 0 END THEN 'voided events = ' || e.voided
             WHEN e.captured_sum <> t.captured_fils THEN 'capture events sum ' || e.captured_sum || ' <> captured_fils ' || t.captured_fils
             WHEN e.captured_sum <> l.gross THEN 'capture events sum ' || e.captured_sum || ' <> ledger gross ' || l.gross
             WHEN e.fee_sum <> l.fee THEN 'feeFils sum ' || e.fee_sum || ' <> ledger fee ' || l.fee
             WHEN t.status = 'captured' AND e.last_capture_type <> 'captured' THEN 'last capture event is ' || e.last_capture_type
             WHEN t.status = 'partially_captured' AND e.last_capture_type <> 'partially_captured' THEN 'last capture event is ' || e.last_capture_type
           END AS problem
      FROM transactions t
      CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE event_type = 'authorized') AS authorized,
               count(*) FILTER (WHERE event_type = 'voided') AS voided,
               COALESCE(sum(amount_fils) FILTER (WHERE event_type IN ('captured', 'partially_captured')), 0) AS captured_sum,
               COALESCE(sum((metadata->>'feeFils')::bigint), 0) AS fee_sum,
               (array_agg(event_type ORDER BY occurred_at DESC, id DESC)
                  FILTER (WHERE event_type IN ('captured', 'partially_captured')))[1] AS last_capture_type
          FROM transaction_events WHERE transaction_id = t.id) e
      CROSS JOIN LATERAL (
        SELECT COALESCE(sum(amount_fils) FILTER (WHERE account_id = 'card_scheme_clearing' AND direction = 'debit'), 0) AS gross,
               COALESCE(sum(amount_fils) FILTER (WHERE account_id = 'platform_fee_revenue' AND direction = 'credit'), 0) AS fee
          FROM ledger_entries WHERE transaction_id = t.id) l
     WHERE t.reference NOT LIKE '%-mar-%'`);
  assert.ok(rows.length > 1000, `expected the seeded transactions, got ${rows.length}`);
  const wrong = rows.filter((r) => r.problem !== null);
  assert.equal(wrong.length, 0, `${wrong.length} transaction(s) have a wrong timeline, e.g. ${JSON.stringify(wrong[0])}`);
});

test("seeded capture events already in a pre-baked batch carry that batch, so settlement never re-settles them", async () => {
  // Each pre-baked closed batch's gross is exactly the capture events it claims.
  const batches = await pool.query<{ batch_date: string; gross_fils: string; event_sum: string }>(`
    SELECT sb.batch_date::text, sb.gross_fils,
           (SELECT COALESCE(sum(te.amount_fils), 0) FROM transaction_events te WHERE te.settlement_batch_id = sb.id) AS event_sum
      FROM settlement_batches sb
     WHERE sb.status = 'closed' AND EXISTS (SELECT 1 FROM scheme_export_lines WHERE settlement_batch_id = sb.id)`);
  assert.ok(batches.rows.length > 0, "expected pre-baked closed batches");
  const wrongBatches = batches.rows.filter((r) => Number(r.gross_fils) !== Number(r.event_sum));
  assert.equal(wrongBatches.length, 0, `batch gross <> its events, e.g. ${JSON.stringify(wrongBatches[0])}`);

  // A capture is unbatched only when no batch settled it (no scheme export line).
  const { rows } = await pool.query<{ count: string }>(`
    SELECT count(*) FROM transaction_events te
     WHERE te.event_type IN ('captured', 'partially_captured') AND te.settlement_batch_id IS NULL
       AND EXISTS (SELECT 1 FROM scheme_export_lines sel WHERE sel.transaction_id = te.transaction_id)`);
  assert.equal(Number(rows[0]?.count), 0);
});

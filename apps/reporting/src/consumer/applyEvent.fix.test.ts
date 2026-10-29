/**
 * D10: settlement.batch_closed's rollup parity check must WARN when the
 * rollup has no row yet for a day that had real captures (consumer lag) —
 * not crash. A crash rolls back the whole pass and stops reporting forever.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { applyEvent } from "./applyEvent.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("applyEvent.fix.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
test.after(async () => {
  await pool.end();
});

test("batch_closed with captures that day but no rollup row yet: warns, writes the payout trend, does not throw", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`applyEvent Fix ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
     VALUES ($1, '2026-01-07', 'closed', 4750, 119, 4631, now()) RETURNING id`,
    [merchantId],
  );
  const batchId = batch.rows[0]!.id;
  const txn = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
     VALUES ($1, 'captured', 4750, 4750, $2, '2026-01-07T10:00:00Z') RETURNING id`,
    [merchantId, `acq_${randomUUID()}`],
  );
  await pool.query(
    `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
     VALUES ($1, 'captured', 4750, 'system', '2026-01-07T10:00:00Z')`,
    [txn.rows[0]!.id],
  );

  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    await withTransaction(pool, (client) =>
      applyEvent(client, {
        id: 1,
        event_type: "settlement.batch_closed",
        aggregate_id: batchId,
        created_at: new Date("2026-01-07T21:00:00Z"),
        payload: { merchantId, batchId, batchDate: "2026-01-07", grossFils: 4_750, feeFils: 119, netPayoutFils: 4_631 },
      }),
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1, "the lagging rollup is reported");
  const trend = await pool.query(`SELECT 1 FROM merchant_payout_trends WHERE settlement_batch_id = $1`, [batchId]);
  assert.equal(trend.rows.length, 1);
});

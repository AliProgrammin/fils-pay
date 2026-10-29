/**
 * FP-201: an acquirer callback redelivered with the same callback_id must be
 * recorded once. Requires DATABASE_URL (migrated Postgres).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { applyAcquirerCallback, withCallbackRetry, type AcquirerCallbackInput } from "./callbacks.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("callbacks.fix.test.ts requires DATABASE_URL");

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
test.after(async () => {
  await pool.end();
});

async function createTransaction(): Promise<string> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`FP-201 Merchant ${randomUUID()}`],
  );
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'captured', 50000, 50000, $2) RETURNING id`,
    [m.rows[0]!.id, `acqref_${randomUUID()}`],
  );
  return t.rows[0]!.id;
}

async function noteCount(callbackId: string): Promise<number> {
  const r = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM acquirer_callback_notes WHERE callback_id = $1`,
    [callbackId],
  );
  return Number(r.rows[0]!.count);
}

test("FP-201: a redelivered callback (same callback_id) is recorded once", async () => {
  const transactionId = await createTransaction();
  const callback: AcquirerCallbackInput = {
    callbackId: `acqcb_${randomUUID()}`,
    type: "fraud_review.completed",
    transactionId,
    occurredAt: "2026-09-16T10:00:00.000Z",
    outcome: "confirmed_fraud",
    note: "Card testing pattern.",
  };

  await withCallbackRetry(() => applyAcquirerCallback(pool, callback));
  await withCallbackRetry(() => applyAcquirerCallback(pool, callback));
  await Promise.all([applyAcquirerCallback(pool, callback), applyAcquirerCallback(pool, callback)]);

  assert.equal(await noteCount(callback.callbackId), 1);
});

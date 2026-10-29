/**
 * D5: outbox ids come from a sequence and are taken at INSERT time, but rows
 * become visible at COMMIT time. A transaction that took a lower id and
 * commits after a higher id was consumed must still be applied.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { runConsumerPass } from "./runConsumerPass.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("commitOrder.fix.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
test.after(async () => {
  await pool.end();
});

const config = { consumerBatchLimit: 500 };

async function merchant(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Commit Order Fix ${randomUUID()}`],
  );
  return r.rows[0]!.id;
}

const captured = (merchantId: string) => ({
  eventType: "transaction.captured" as const,
  aggregateType: "transaction" as const,
  aggregateId: randomUUID(),
  payload: { merchantId, amountCapturedFils: 500, feeFils: 8, newStatus: "captured", capturedTotalFils: 500 },
});

async function capturedCount(merchantId: string): Promise<number> {
  const r = await pool.query<{ captured_count: number }>(
    `SELECT captured_count FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  return r.rows[0]?.captured_count ?? 0;
}

test("an event with a lower id that commits later is not skipped", async () => {
  const slowMerchant = await merchant();
  const fastMerchant = await merchant();

  const slow = await pool.connect();
  try {
    await slow.query("BEGIN");
    const slowEvent = await enqueueEvent(slow, captured(slowMerchant)); // takes the lower id, not committed
    const fastEvent = await enqueueEvent(pool, captured(fastMerchant)); // higher id, committed now
    assert.ok(fastEvent.id > slowEvent.id);

    await runConsumerPass(pool, config);
    await slow.query("COMMIT");
  } finally {
    slow.release();
  }

  while ((await runConsumerPass(pool, config)).processedCount > 0) {
    /* drain */
  }

  assert.equal(await capturedCount(fastMerchant), 1);
  assert.equal(await capturedCount(slowMerchant), 1, "the late-committing lower-id event was skipped");
});

/**
 * D6: the live worker and `reporting catch-up` run passes at the same time
 * (RUNBOOK says this is safe). Two concurrent passes must never apply the
 * same event twice, and the cursor must never move backwards.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import { advanceCursor, readCursor } from "./cursor.js";
import { CONSUMER_NAME, runConsumerPass } from "./runConsumerPass.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("cursor.fix.test.ts requires DATABASE_URL");
const poolA = new Pool({ connectionString: databaseUrl, max: 2 });
const poolB = new Pool({ connectionString: databaseUrl, max: 2 });
test.after(async () => {
  await poolA.end();
  await poolB.end();
});

test("two concurrent consumer passes apply each event exactly once", async () => {
  // Drain anything already pending so both passes see the same small range.
  while ((await runConsumerPass(poolA, { consumerBatchLimit: 500 })).processedCount > 0) {
    /* drain */
  }
  const merchant = await poolA.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Cursor Fix ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const rounds = 20;
  for (let round = 0; round < rounds; round++) {
    await enqueueEvent(poolA, {
      eventType: "transaction.captured",
      aggregateType: "transaction",
      aggregateId: randomUUID(),
      payload: { merchantId, amountCapturedFils: 1_000, feeFils: 15, newStatus: "captured", capturedTotalFils: 1_000 },
    });
    await Promise.all([
      runConsumerPass(poolA, { consumerBatchLimit: 500 }),
      runConsumerPass(poolB, { consumerBatchLimit: 500 }),
    ]);
  }

  const volume = await poolA.query<{ captured_count: number }>(
    `SELECT captured_count FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(volume.rows[0]!.captured_count, rounds, "each event applied exactly once");
});

test("advanceCursor never moves the watermark backwards", async () => {
  await withTransaction(poolA, async (client) => {
    const before = await readCursor(client, CONSUMER_NAME);
    await advanceCursor(client, CONSUMER_NAME, { ...before, lastProcessedId: before.lastProcessedId - 1n });
    await advanceCursor(client, CONSUMER_NAME, { lastProcessedTxid: "0", lastProcessedId: before.lastProcessedId + 1000n });
    const after = await readCursor(client, CONSUMER_NAME);
    assert.deepEqual(after, before);
    throw new Error("rollback");
  }).catch((err: Error) => {
    if (err.message !== "rollback") throw err;
  });
});

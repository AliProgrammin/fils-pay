/**
 * The admin "current rate" must be the rate billing charges now:
 * effective_from <= now, newest effective_from, ties by newest created_at
 * (same rule as feeSchedule.ts and the Go settlement service).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { getCurrentFeeScheduleForDisplay } from "./currentFeeScheduleDisplay.js";
import { getEffectiveMdrBps } from "./feeSchedule.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("currentFeeScheduleDisplay.fix.test.ts requires DATABASE_URL");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

async function insertMerchant(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Fee Display Fix ${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

async function insertSchedule(merchantId: string, mdrBps: number, effectiveFrom: string, createdAt: string) {
  await pool.query(
    `INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from, created_at) VALUES ($1, $2, $3, $4)`,
    [merchantId, mdrBps, effectiveFrom, createdAt],
  );
}

async function billedRate(merchantId: string): Promise<number> {
  const client = await pool.connect();
  try {
    return await getEffectiveMdrBps(client, merchantId, new Date(), 250);
  } finally {
    client.release();
  }
}

test("a backdated correction does not replace the rate billing uses (245 vs 225 bps)", async () => {
  const merchantId = await insertMerchant();
  await insertSchedule(merchantId, 225, "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z");
  await insertSchedule(merchantId, 245, "2026-03-01T00:00:00Z", "2026-08-15T00:00:00Z");

  const current = await getCurrentFeeScheduleForDisplay(pool, merchantId);
  assert.equal(current?.mdrBps, 225);
  assert.equal(current?.mdrBps, await billedRate(merchantId));
});

test("a future-dated schedule is not shown as current", async () => {
  const merchantId = await insertMerchant();
  await insertSchedule(merchantId, 200, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  await insertSchedule(merchantId, 150, "2099-01-01T00:00:00Z", "2026-02-01T00:00:00Z");

  const current = await getCurrentFeeScheduleForDisplay(pool, merchantId);
  assert.equal(current?.mdrBps, 200);
  assert.equal(current?.mdrBps, await billedRate(merchantId));
});

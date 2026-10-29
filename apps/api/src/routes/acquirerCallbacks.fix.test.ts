/**
 * FP-240 (inbound) route tests: default config must reject unsigned
 * callbacks and verify the raw request body. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("acquirerCallbacks.fix.test.ts requires DATABASE_URL");

const SECRET = "acqsec_fix_route_secret";
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  ACQUIRER_CALLBACK_SIGNING_SECRET: SECRET,
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

async function createTransaction(): Promise<string> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`FP-240 Merchant ${randomUUID()}`],
  );
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'captured', 50000, 50000, $2) RETURNING id`,
    [m.rows[0]!.id, `acqref_${randomUUID()}`],
  );
  return t.rows[0]!.id;
}

/** Pretty-printed, as an acquirer could send it. JSON.stringify(parsed) differs from it. */
function rawBody(transactionId: string, callbackId: string): string {
  return JSON.stringify(
    {
      callbackId,
      type: "fraud_review.completed",
      transactionId,
      occurredAt: "2026-09-16T10:00:00.000Z",
      outcome: "confirmed_fraud",
      note: "Card testing pattern.",
    },
    null,
    2,
  );
}

function sign(raw: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${createHmac("sha256", SECRET).update(`${timestamp}.${raw}`).digest("hex")}`;
}

test("FP-240: default config rejects a callback without a signature header (401)", async () => {
  const callbackId = `acqcb_${randomUUID()}`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/acquirer/callbacks",
    headers: { "content-type": "application/json" },
    payload: rawBody(await createTransaction(), callbackId),
  });
  assert.equal(res.statusCode, 401);
  const rows = await pool.query(`SELECT 1 FROM acquirer_callback_notes WHERE callback_id = $1`, [callbackId]);
  assert.equal(rows.rowCount, 0);
});

test("FP-240: a callback signed over its exact raw body is accepted", async () => {
  const raw = rawBody(await createTransaction(), `acqcb_${randomUUID()}`);
  const res = await app.inject({
    method: "POST",
    url: "/v1/acquirer/callbacks",
    headers: { "content-type": "application/json", "acquirer-callback-signature": sign(raw) },
    payload: raw,
  });
  assert.equal(res.statusCode, 200);
});

test("FP-240: a replayed callback with an old timestamp is rejected (401)", async () => {
  const raw = rawBody(await createTransaction(), `acqcb_${randomUUID()}`);
  const res = await app.inject({
    method: "POST",
    url: "/v1/acquirer/callbacks",
    headers: { "content-type": "application/json", "acquirer-callback-signature": sign(raw, 1_757_930_000) },
    payload: raw,
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().message, "timestamp_out_of_tolerance");
});

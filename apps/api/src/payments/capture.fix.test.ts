/**
 * B7: the capture idempotency hash must include the transaction id. Reusing
 * an Idempotency-Key on a different transaction must not replay the first
 * transaction's response. Requires DATABASE_URL (migrated Postgres).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("capture.fix.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);
after(async () => {
  await app.close();
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function merchantWithKey() {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Capture Fix ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "capture" });
  return { merchantId, auth: { authorization: `Bearer ${issued.rawKey}` } };
}

async function authorize(auth: Record<string, string>): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...auth, "idempotency-key": randomUUID() },
    payload: { amountFils: 5_000, card: CARD },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id;
}

function capture(auth: Record<string, string>, txnId: string, key: string) {
  return app.inject({
    method: "POST",
    url: `/v1/transactions/${txnId}/capture`,
    headers: { ...auth, "idempotency-key": key },
    payload: { amountFils: 5_000 },
  });
}

test("B7: the same Idempotency-Key on a different transaction does not replay the first capture", async () => {
  const { auth } = await merchantWithKey();
  const txnA = await authorize(auth);
  const txnB = await authorize(auth);
  const key = randomUUID();

  const first = await capture(auth, txnA, key);
  assert.equal(first.statusCode, 200, first.body);

  const second = await capture(auth, txnB, key);
  assert.equal(second.statusCode, 422, second.body);
  assert.equal(second.json().error, "idempotency_key_reused");

  // Transaction B was not reported as captured, and is still capturable.
  const row = await pool.query<{ status: string }>(`SELECT status FROM transactions WHERE id = $1`, [txnB]);
  assert.equal(row.rows[0]!.status, "authorized");

  // A true retry (same key, same transaction) still replays.
  const replay = await capture(auth, txnA, key);
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), first.json());
});

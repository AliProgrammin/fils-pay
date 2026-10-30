/**
 * V2 (docs/bugs/venue-hint.md): capture must pick the fee rate at the same
 * instant its event and ledger rows are stamped with (the DB's now()), not
 * at the API server's clock. Settlement charges the rate in force at the
 * event's stored occurred_at; with clock skew near a rate change the two
 * used to disagree. Requires DATABASE_URL (migrated Postgres).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, mock, test } from "node:test";
import { Pool } from "pg";
import { applyRateFils, toFils } from "@filspay/money";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { getVolumeTierBonusBps } from "../fees/platformVolumeTier.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("captureClockSkew.fix.test.ts requires DATABASE_URL");

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
  mock.timers.reset();
  await app.close();
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const AMOUNT = 100_000;

async function merchantWithKey() {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Clock Skew ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "skew" });
  return { merchantId, auth: { authorization: `Bearer ${issued.rawKey}` } };
}

async function authorizeAndCapture(auth: Record<string, string>, skewMs: number): Promise<string> {
  const a = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...auth, "idempotency-key": randomUUID() },
    payload: { amountFils: AMOUNT, card: CARD },
  });
  assert.equal(a.statusCode, 201, a.body);
  const txnId = a.json().id as string;

  // The API server's clock runs `skewMs` ahead of the database's.
  mock.timers.enable({ apis: ["Date"], now: Date.now() + skewMs });
  try {
    const c = await app.inject({
      method: "POST",
      url: `/v1/transactions/${txnId}/capture`,
      headers: { ...auth, "idempotency-key": randomUUID() },
      payload: { amountFils: AMOUNT },
    });
    assert.equal(c.statusCode, 200, c.body);
  } finally {
    mock.timers.reset();
  }
  return txnId;
}

/** The fee settlement will charge: the rate in force at the event's stored occurred_at. */
async function feesFor(txnId: string, merchantId: string) {
  const { rows } = await pool.query<{ event_fee: number; ledger_fee: string; rate: number }>(
    `SELECT (te.metadata->>'feeFils')::int AS event_fee,
            (SELECT sum(amount_fils) FROM ledger_entries
              WHERE transaction_id = te.transaction_id AND account_id = 'platform_fee_revenue' AND direction = 'credit') AS ledger_fee,
            COALESCE((SELECT mdr_bps FROM fee_schedules f
                       WHERE f.merchant_id = $2 AND f.effective_from <= te.occurred_at
                       ORDER BY effective_from DESC, created_at DESC LIMIT 1), 250) AS rate
       FROM transaction_events te
      WHERE te.transaction_id = $1 AND te.event_type = 'captured'`,
    [txnId, merchantId],
  );
  const row = rows[0]!;
  const client = await pool.connect();
  let bonus: number;
  try {
    bonus = await getVolumeTierBonusBps(client);
  } finally {
    client.release();
  }
  const expected = applyRateFils(toFils(AMOUNT), Math.max(0, row.rate - bonus));
  return { eventFee: row.event_fee, ledgerFee: Number(row.ledger_fee), expected };
}

test("V2: API clock 32 min ahead, new rate starts in 10 min by DB time: capture charges the rate at occurred_at", async () => {
  const { merchantId, auth } = await merchantWithKey();
  await pool.query(
    `INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from) VALUES ($1, 150, now() + interval '10 minutes')`,
    [merchantId],
  );
  const txnId = await authorizeAndCapture(auth, 32 * 60_000);
  const { eventFee, ledgerFee, expected } = await feesFor(txnId, merchantId);
  assert.equal(eventFee, expected, `capture billed ${eventFee}, settlement charges ${expected}`);
  assert.equal(ledgerFee, expected);
});

test("V2: API clock 32 min behind, new rate started 10 min ago by DB time: capture charges the rate at occurred_at", async () => {
  const { merchantId, auth } = await merchantWithKey();
  await pool.query(
    `INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from) VALUES ($1, 150, now() - interval '10 minutes')`,
    [merchantId],
  );
  const txnId = await authorizeAndCapture(auth, -32 * 60_000);
  const { eventFee, ledgerFee, expected } = await feesFor(txnId, merchantId);
  assert.equal(eventFee, expected, `capture billed ${eventFee}, settlement charges ${expected}`);
  assert.equal(ledgerFee, expected);
});

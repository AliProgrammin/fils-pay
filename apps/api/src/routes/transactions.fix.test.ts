/**
 * Regression tests for docs/bugs/hunt-2.md (transactions surface).
 * Requires DATABASE_URL (a real, migrated Postgres).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { sha256Hex, randomToken } from "../lib/crypto.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("transactions.fix.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

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

test.after(async () => {
  await app.close();
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function createMerchant() {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Hunt2 ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "hunt2" });
  return { merchantId, bearer: { authorization: `Bearer ${issued.rawKey}` } };
}

async function sessionCookie(merchantId: string, role: "owner" | "finance" | "support") {
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, $3, 'unused') RETURNING id`,
    [merchantId, `${role}-${randomUUID()}@example.test`, role],
  );
  const raw = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at)
     VALUES ($1, $2, true, now() + interval '1 hour')`,
    [u.rows[0]!.id, sha256Hex(raw)],
  );
  return { [config.cookieName]: raw };
}

async function authorize(bearer: Record<string, string>, amountFils: number) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...bearer, "idempotency-key": randomUUID() },
    payload: { amountFils, card: CARD },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string };
}

// H2: the support role is read-only; it must not move money.
test("H2: a support session cannot capture or void (403); owner and finance sessions and API keys can", async () => {
  const m = await createMerchant();
  const support = await sessionCookie(m.merchantId, "support");

  const t1 = await authorize(m.bearer, 1_000);
  const cap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${t1.id}/capture`,
    cookies: support,
    headers: { "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(cap.statusCode, 403, cap.body);
  assert.equal(cap.json().error, "forbidden");

  const voidRes = await app.inject({ method: "POST", url: `/v1/transactions/${t1.id}/void`, cookies: support });
  assert.equal(voidRes.statusCode, 403, voidRes.body);

  const still = await pool.query(`SELECT status FROM transactions WHERE id = $1`, [t1.id]);
  assert.equal(still.rows[0].status, "authorized");

  // Allowed actors still work.
  const finance = await sessionCookie(m.merchantId, "finance");
  const finCap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${t1.id}/capture`,
    cookies: finance,
    headers: { "idempotency-key": randomUUID() },
    payload: { amountFils: 400 },
  });
  assert.equal(finCap.statusCode, 200, finCap.body);

  const t2 = await authorize(m.bearer, 1_000);
  const owner = await sessionCookie(m.merchantId, "owner");
  const ownerVoid = await app.inject({ method: "POST", url: `/v1/transactions/${t2.id}/void`, cookies: owner });
  assert.equal(ownerVoid.statusCode, 200, ownerVoid.body);

  const t3 = await authorize(m.bearer, 1_000);
  const keyCap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${t3.id}/capture`,
    headers: { ...m.bearer, "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(keyCap.statusCode, 200, keyCap.body);
});

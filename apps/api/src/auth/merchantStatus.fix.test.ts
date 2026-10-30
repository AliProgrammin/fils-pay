/**
 * W3: a suspended or closed merchant must not act through an API key or an
 * existing session (login already checks merchants.status). Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("merchantStatus.fix.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

async function merchantWithKeyAndSession() {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Status Fix ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `status-${randomUUID()}@example.test`],
  );
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "status" });
  const sessionToken = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at)
     VALUES ($1, $2, true, now() + interval '1 hour')`,
    [u.rows[0]!.id, sha256Hex(sessionToken)],
  );
  return { merchantId, rawKey, sessionToken };
}

for (const status of ["suspended", "closed"] as const) {
  test(`a ${status} merchant's API key and session are refused (401)`, async () => {
    const { merchantId, rawKey, sessionToken } = await merchantWithKeyAndSession();
    const byKey = () =>
      app.inject({ method: "GET", url: "/v1/transactions", headers: { authorization: `Bearer ${rawKey}` } });
    const bySession = () =>
      app.inject({ method: "GET", url: "/v1/transactions", cookies: { [config.cookieName]: sessionToken } });

    assert.equal((await byKey()).statusCode, 200, "active merchant: API key works");
    assert.equal((await bySession()).statusCode, 200, "active merchant: session works");

    await pool.query(`UPDATE merchants SET status = $2 WHERE id = $1`, [merchantId, status]);
    assert.equal((await byKey()).statusCode, 401);
    assert.equal((await bySession()).statusCode, 401);

    const capture = await app.inject({
      method: "POST",
      url: `/v1/transactions/${randomUUID()}/capture`,
      headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
      payload: { amountFils: 1000 },
    });
    assert.equal(capture.statusCode, 401);
  });
}

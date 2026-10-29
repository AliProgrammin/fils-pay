/**
 * Regression tests for merchant login bugs (wave A). Real Postgres, real
 * routes via app.inject. Requires DATABASE_URL (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../auth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("auth.fix.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  OTP_DEV_EXPOSE: "true",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const PASSWORD = "correct horse battery staple";

async function createMerchantWithUser(email: string): Promise<{ merchantId: string; userId: string }> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Auth Fix ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role)
     VALUES ($1, $2, $3, 'owner') RETURNING id`,
    [merchantId, email, await hashPassword(PASSWORD, config)],
  );
  return { merchantId, userId: user.rows[0]!.id };
}

async function login(merchantId: string, email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { merchantId, email, password: PASSWORD },
  });
  assert.equal(res.statusCode, 200, res.body);
  const cookie = res.cookies.find((c) => c.name === config.cookieName);
  assert.ok(cookie, "login must set the session cookie");
  return { cookie: cookie.value, devOtpCode: res.json().devOtpCode as string };
}

test("login to merchant A binds the session to A's user when the same email exists under merchant B", async () => {
  const email = `shared-${randomUUID()}@auth-fix.test`;
  // B is created first, so an email-only lookup finds B's row.
  const b = await createMerchantWithUser(email);
  const a = await createMerchantWithUser(email);

  const { cookie, devOtpCode } = await login(a.merchantId, email);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    cookies: { [config.cookieName]: cookie },
    payload: { code: devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal(verify.json().merchantId, a.merchantId, "session must belong to the merchant that logged in");
  assert.notEqual(verify.json().merchantId, b.merchantId);
});

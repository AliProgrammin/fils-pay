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
import { sha256Hex } from "../lib/crypto.js";

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

/** A 6-digit code that is not the real one. */
function wrongCode(real: string): string {
  return real === "000000" ? "111111" : "000000";
}

test("parallel wrong OTP guesses cannot exceed max_attempts", async () => {
  const email = `race-${randomUUID()}@auth-fix.test`;
  const m = await createMerchantWithUser(email);
  const { cookie, devOtpCode } = await login(m.merchantId, email);

  const responses = await Promise.all(
    Array.from({ length: 25 }, () =>
      app.inject({
        method: "POST",
        url: "/v1/auth/otp/verify",
        cookies: { [config.cookieName]: cookie },
        payload: { code: wrongCode(devOtpCode) },
      }),
    ),
  );
  const guessesChecked = responses.filter((r) => r.statusCode === 401 && r.json().error === "invalid_code").length;
  assert.ok(
    guessesChecked <= config.otpMaxAttempts,
    `${guessesChecked} guesses were checked; the limit is ${config.otpMaxAttempts}`,
  );

  const row = await pool.query<{ attempt_count: number }>(
    `SELECT c.attempt_count FROM otp_challenges c JOIN sessions s ON s.otp_challenge_id = c.id WHERE s.token_hash = $1`,
    [sha256Hex(cookie)],
  );
  assert.ok(row.rows[0]!.attempt_count <= config.otpMaxAttempts);
});

test("OTP resend carries the used attempt count over to the new challenge", async () => {
  const email = `resend-${randomUUID()}@auth-fix.test`;
  const m = await createMerchantWithUser(email);
  const { cookie, devOtpCode } = await login(m.merchantId, email);

  for (let i = 0; i < 3; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      cookies: { [config.cookieName]: cookie },
      payload: { code: wrongCode(devOtpCode) },
    });
    assert.equal(res.statusCode, 401, res.body);
  }

  // Step past the 30s resend throttle.
  await pool.query(
    `UPDATE otp_challenges SET created_at = now() - interval '1 minute'
      WHERE id = (SELECT otp_challenge_id FROM sessions WHERE token_hash = $1)`,
    [sha256Hex(cookie)],
  );
  const resend = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/resend",
    cookies: { [config.cookieName]: cookie },
  });
  assert.equal(resend.statusCode, 200, resend.body);

  const row = await pool.query<{ attempt_count: number }>(
    `SELECT c.attempt_count FROM otp_challenges c JOIN sessions s ON s.otp_challenge_id = c.id WHERE s.token_hash = $1`,
    [sha256Hex(cookie)],
  );
  assert.equal(row.rows[0]!.attempt_count, 3, "resend must not reset the guess budget");
});

test("parallel wrong admin OTP guesses cannot exceed max_attempts", async () => {
  const email = `admin-race-${randomUUID()}@auth-fix.test`;
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, $3, 'support')`,
    [email, await hashPassword(PASSWORD, config), `Race ${randomUUID().slice(0, 8)}`],
  );
  const loginRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: { email, password: PASSWORD },
  });
  assert.equal(loginRes.statusCode, 200, loginRes.body);
  const cookie = loginRes.cookies.find((c) => c.name === config.adminCookieName)!.value;
  const devOtpCode = loginRes.json().devOtpCode as string;

  const responses = await Promise.all(
    Array.from({ length: 25 }, () =>
      app.inject({
        method: "POST",
        url: "/v1/admin/auth/otp/verify",
        cookies: { [config.adminCookieName]: cookie },
        payload: { code: wrongCode(devOtpCode) },
      }),
    ),
  );
  const guessesChecked = responses.filter((r) => r.statusCode === 401 && r.json().error === "invalid_code").length;
  assert.ok(
    guessesChecked <= config.otpMaxAttempts,
    `${guessesChecked} guesses were checked; the limit is ${config.otpMaxAttempts}`,
  );
});

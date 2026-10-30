/**
 * Merchant login with an optional merchantId. Without merchantId the API
 * finds the user by email + password. Real Postgres, real routes via
 * app.inject. Requires DATABASE_URL (run `npm run migrate` first).
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
  throw new Error("auth.optionalMerchantId.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

async function createMerchantWithUser(
  email: string,
  opts: { password?: string; status?: string } = {},
): Promise<{ merchantId: string; userId: string }> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Optional MID ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  if (opts.status) {
    await pool.query(`UPDATE merchants SET status = $2 WHERE id = $1`, [merchantId, opts.status]);
  }
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role)
     VALUES ($1, $2, $3, 'owner') RETURNING id`,
    [merchantId, email, await hashPassword(opts.password ?? PASSWORD, config)],
  );
  return { merchantId, userId: user.rows[0]!.id };
}

function postLogin(payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/v1/auth/login", payload });
}

async function verifyOtpFor(res: Awaited<ReturnType<typeof postLogin>>) {
  const cookie = res.cookies.find((c) => c.name === config.cookieName);
  assert.ok(cookie, "login must set the session cookie");
  return app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    cookies: { [config.cookieName]: cookie.value },
    payload: { code: res.json().devOtpCode as string },
  });
}

test("login without merchantId works for a user in exactly one shop", async () => {
  const email = `single-${randomUUID()}@optional-mid.test`;
  const m = await createMerchantWithUser(email);

  const res = await postLogin({ email, password: PASSWORD });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().otpRequired, true);
  assert.ok(res.json().otpExpiresAt);

  const verify = await verifyOtpFor(res);
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal(verify.json().merchantId, m.merchantId);
});

test("wrong password without merchantId gives the same error as wrong password with merchantId", async () => {
  const email = `wrongpw-${randomUUID()}@optional-mid.test`;
  const m = await createMerchantWithUser(email);

  const withId = await postLogin({ merchantId: m.merchantId, email, password: "wrong password" });
  const withoutId = await postLogin({ email, password: "wrong password" });
  assert.equal(withId.statusCode, 401);
  assert.equal(withoutId.statusCode, withId.statusCode);
  assert.deepEqual(withoutId.json(), withId.json());
  assert.equal(withoutId.cookies.length, 0, "a failed login must not set a cookie");
});

test("unknown email without merchantId gives the same error as a wrong password", async () => {
  const email = `wrongpw2-${randomUUID()}@optional-mid.test`;
  const m = await createMerchantWithUser(email);
  const wrongPassword = await postLogin({ merchantId: m.merchantId, email, password: "wrong password" });

  const unknown = await postLogin({ email: `nobody-${randomUUID()}@optional-mid.test`, password: PASSWORD });
  assert.equal(unknown.statusCode, wrongPassword.statusCode);
  assert.deepEqual(unknown.json(), wrongPassword.json());
});

test("an email in two shops with the right password and no merchantId gives 409 merchant_id_required", async () => {
  const email = `two-shops-${randomUUID()}@optional-mid.test`;
  await createMerchantWithUser(email);
  await createMerchantWithUser(email);

  const res = await postLogin({ email, password: PASSWORD });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, "merchant_id_required");
  assert.equal(res.cookies.length, 0, "no pending session is created");
});

test("an email in two shops with the wrong password and no merchantId gives invalid_credentials, not 409", async () => {
  const email = `two-shops-wrong-${randomUUID()}@optional-mid.test`;
  await createMerchantWithUser(email);
  await createMerchantWithUser(email);

  const res = await postLogin({ email, password: "wrong password" });
  assert.equal(res.statusCode, 401, res.body);
  assert.equal(res.json().error, "invalid_credentials");
});

test("an email in two shops where the password matches only one logs in to that one", async () => {
  const email = `two-shops-one-pw-${randomUUID()}@optional-mid.test`;
  await createMerchantWithUser(email, { password: "a different password" });
  const target = await createMerchantWithUser(email);

  const res = await postLogin({ email, password: PASSWORD });
  assert.equal(res.statusCode, 200, res.body);
  const verify = await verifyOtpFor(res);
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal(verify.json().merchantId, target.merchantId);
});

test("without merchantId, a user of a non-active merchant cannot log in (same rule as with merchantId)", async () => {
  const email = `suspended-${randomUUID()}@optional-mid.test`;
  const m = await createMerchantWithUser(email, { status: "suspended" });

  const withId = await postLogin({ merchantId: m.merchantId, email, password: PASSWORD });
  const withoutId = await postLogin({ email, password: PASSWORD });
  assert.equal(withId.statusCode, 401, withId.body);
  assert.equal(withoutId.statusCode, 401, withoutId.body);
  assert.deepEqual(withoutId.json(), withId.json());
});

test("an active shop plus a suspended shop with the same email logs in to the active one without merchantId", async () => {
  const email = `active-plus-suspended-${randomUUID()}@optional-mid.test`;
  await createMerchantWithUser(email, { status: "suspended" });
  const active = await createMerchantWithUser(email);

  const res = await postLogin({ email, password: PASSWORD });
  assert.equal(res.statusCode, 200, res.body);
  const verify = await verifyOtpFor(res);
  assert.equal(verify.json().merchantId, active.merchantId);
});

test("with merchantId, login still picks that shop when the email is in two shops", async () => {
  const email = `with-id-${randomUUID()}@optional-mid.test`;
  await createMerchantWithUser(email);
  const a = await createMerchantWithUser(email);

  const res = await postLogin({ merchantId: a.merchantId, email, password: PASSWORD });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(Object.keys(res.json()).sort(), ["devOtpCode", "otpExpiresAt", "otpRequired"]);
  const verify = await verifyOtpFor(res);
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal(verify.json().merchantId, a.merchantId);
});

test("missing email or password is still 400 invalid_request, with or without merchantId", async () => {
  for (const payload of [
    { email: "x@optional-mid.test" },
    { password: PASSWORD },
    { merchantId: randomUUID(), email: "x@optional-mid.test" },
    {},
  ]) {
    const res = await postLogin(payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(res.json().error, "invalid_request");
  }
});

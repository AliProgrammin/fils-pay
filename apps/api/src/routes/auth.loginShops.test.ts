/**
 * POST /v1/auth/login keeps the handed-over contract: merchantId, email and
 * password are all required. POST /v1/auth/login/shops is the new, separate
 * lookup the dashboard uses for "email + password only" sign-in: it checks
 * the password like login does and lists the active shops it opens, with no
 * OTP and no session. Real Postgres, real routes via app.inject. Requires
 * DATABASE_URL (run `npm run migrate` first).
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
  throw new Error("auth.loginShops.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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
    [`Login Shops ${randomUUID()}`],
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

function postShops(payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/v1/auth/login/shops", payload });
}

async function displayName(merchantId: string): Promise<string> {
  const row = await pool.query<{ display_name: string }>(`SELECT display_name FROM merchants WHERE id = $1`, [
    merchantId,
  ]);
  return row.rows[0]!.display_name;
}

const byId = (x: { merchantId: string }, y: { merchantId: string }) => x.merchantId.localeCompare(y.merchantId);

/** No OTP challenge and no session may exist for these users. */
async function assertNoOtpOrSession(userIds: string[]): Promise<void> {
  const otp = await pool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM otp_challenges WHERE merchant_user_id = ANY($1)`,
    [userIds],
  );
  const sessions = await pool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM sessions WHERE merchant_user_id = ANY($1)`,
    [userIds],
  );
  assert.equal(otp.rows[0]!.c, 0, "no OTP challenge is issued");
  assert.equal(sessions.rows[0]!.c, 0, "no session is created");
}

// ---------------------------------------------------------------- /login (handed-over contract)

test("login without merchantId is 400 invalid_request, as in the handed-over code", async () => {
  const email = `no-mid-${randomUUID()}@login-shops.test`;
  const m = await createMerchantWithUser(email);

  for (const payload of [
    { email, password: PASSWORD },
    { merchantId: "", email, password: PASSWORD },
    { merchantId: null, email, password: PASSWORD },
    { merchantId: m.merchantId, email },
    { merchantId: m.merchantId, password: PASSWORD },
    {},
  ]) {
    const res = await postLogin(payload);
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)}: ${res.body}`);
    assert.deepEqual(res.json(), {
      error: "invalid_request",
      message: "merchantId, email and password are required",
    });
    assert.equal(res.cookies.length, 0, "a refused login must not set a cookie");
  }
  await assertNoOtpOrSession([m.userId]);
});

test("login with merchantId still starts the OTP step with the handed-over body", async () => {
  const email = `with-mid-${randomUUID()}@login-shops.test`;
  const m = await createMerchantWithUser(email);

  const res = await postLogin({ merchantId: m.merchantId, email, password: PASSWORD });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(Object.keys(res.json()).sort(), ["devOtpCode", "otpExpiresAt", "otpRequired"]);
  assert.ok(res.cookies.find((c) => c.name === config.cookieName), "login sets the pending session cookie");
});

// ---------------------------------------------------------------- /login/shops

test("shops: the right password for a user in one shop lists that shop", async () => {
  const email = `one-shop-${randomUUID()}@login-shops.test`;
  const m = await createMerchantWithUser(email);

  const res = await postShops({ email, password: PASSWORD });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { shops: [{ merchantId: m.merchantId, displayName: await displayName(m.merchantId) }] });
  assert.equal(res.cookies.length, 0, "no cookie is set");
  await assertNoOtpOrSession([m.userId]);
});

test("shops: the right password for a user in two shops lists both", async () => {
  const email = `two-shops-${randomUUID()}@login-shops.test`;
  const a = await createMerchantWithUser(email);
  const b = await createMerchantWithUser(email);

  const res = await postShops({ email, password: PASSWORD });
  assert.equal(res.statusCode, 200, res.body);
  const expected = [
    { merchantId: a.merchantId, displayName: await displayName(a.merchantId) },
    { merchantId: b.merchantId, displayName: await displayName(b.merchantId) },
  ];
  assert.deepEqual([...res.json().shops].sort(byId), expected.sort(byId));
  assert.equal(res.cookies.length, 0);
  await assertNoOtpOrSession([a.userId, b.userId]);
});

test("shops: a wrong password gives the same 401 as login, and lists nothing", async () => {
  const email = `wrong-pw-${randomUUID()}@login-shops.test`;
  const m = await createMerchantWithUser(email);
  await createMerchantWithUser(email);

  const login = await postLogin({ merchantId: m.merchantId, email, password: "wrong password" });
  const shops = await postShops({ email, password: "wrong password" });
  assert.equal(login.statusCode, 401);
  assert.equal(shops.statusCode, 401, shops.body);
  assert.deepEqual(shops.json(), login.json());
  assert.equal(shops.cookies.length, 0);
});

test("shops: an unknown email gives the same answer as a wrong password", async () => {
  const email = `known-${randomUUID()}@login-shops.test`;
  await createMerchantWithUser(email);
  const wrongPassword = await postShops({ email, password: "wrong password" });

  const unknown = await postShops({ email: `nobody-${randomUUID()}@login-shops.test`, password: PASSWORD });
  assert.equal(unknown.statusCode, 401, unknown.body);
  assert.deepEqual(unknown.json(), wrongPassword.json());
  assert.equal(unknown.json().error, "invalid_credentials");
});

test("shops: an inactive shop is left out, and a user only in inactive shops gets 401", async () => {
  const email = `inactive-${randomUUID()}@login-shops.test`;
  await createMerchantWithUser(email, { status: "suspended" });
  const active = await createMerchantWithUser(email);

  const res = await postShops({ email, password: PASSWORD });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().shops, [
    { merchantId: active.merchantId, displayName: await displayName(active.merchantId) },
  ]);

  const onlyInactive = `only-inactive-${randomUUID()}@login-shops.test`;
  await createMerchantWithUser(onlyInactive, { status: "suspended" });
  const none = await postShops({ email: onlyInactive, password: PASSWORD });
  assert.equal(none.statusCode, 401, none.body);
  assert.equal(none.json().error, "invalid_credentials");
});

test("shops: only the shops whose user has this password are listed", async () => {
  const email = `mixed-pw-${randomUUID()}@login-shops.test`;
  await createMerchantWithUser(email, { password: "a different password" });
  const target = await createMerchantWithUser(email);

  const res = await postShops({ email, password: PASSWORD });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().shops.map((s: { merchantId: string }) => s.merchantId), [target.merchantId]);
});

test("shops: a missing email or password is 400 invalid_request", async () => {
  for (const payload of [{ email: "x@login-shops.test" }, { password: PASSWORD }, { email: "", password: "" }, {}]) {
    const res = await postShops(payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.deepEqual(res.json(), { error: "invalid_request", message: "email and password are required" });
  }
});

test("shops, then login with the listed merchantId, signs in to that shop", async () => {
  const email = `shops-then-login-${randomUUID()}@login-shops.test`;
  await createMerchantWithUser(email);
  const b = await createMerchantWithUser(email);

  const shops = await postShops({ email, password: PASSWORD });
  assert.equal(shops.statusCode, 200, shops.body);
  assert.ok(shops.json().shops.some((s: { merchantId: string }) => s.merchantId === b.merchantId));

  const login = await postLogin({ merchantId: b.merchantId, email, password: PASSWORD });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = login.cookies.find((c) => c.name === config.cookieName)!;
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    cookies: { [config.cookieName]: cookie.value },
    payload: { code: login.json().devOtpCode as string },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal(verify.json().merchantId, b.merchantId);
});

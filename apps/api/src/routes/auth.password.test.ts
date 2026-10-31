/**
 * POST /v1/auth/password: a signed-in shop user changes their own password.
 * Checks the current password, applies the new-password rules, stores a new
 * argon2 hash, ends the user's OTHER sessions and keeps the current one.
 * Real Postgres, real routes via app.inject. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../auth/passwords.js";
import { startImpersonation } from "../admin/impersonation.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("auth.password.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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
const NEW_PASSWORD = "a much longer new passphrase";

async function createUser(): Promise<{ merchantId: string; userId: string; email: string }> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Password ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const email = `pw-${randomUUID()}@password.test`;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role)
     VALUES ($1, $2, $3, 'support') RETURNING id`,
    [merchantId, email, await hashPassword(PASSWORD, config)],
  );
  return { merchantId, userId: user.rows[0]!.id, email };
}

function login(merchantId: string, email: string, password: string) {
  return app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password } });
}

/** Password + OTP; returns the authenticated session cookie map. */
async function signIn(merchantId: string, email: string, password = PASSWORD): Promise<Record<string, string>> {
  const res = await login(merchantId, email, password);
  assert.equal(res.statusCode, 200, res.body);
  const cookie = res.cookies.find((c) => c.name === config.cookieName)!;
  const cookies = { [config.cookieName]: cookie.value };
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    cookies,
    payload: { code: res.json().devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return cookies;
}

function changePassword(cookies: Record<string, string>, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/v1/auth/password", cookies, payload });
}

function me(cookies: Record<string, string>) {
  return app.inject({ method: "GET", url: "/v1/auth/me", cookies });
}

test("change password: 204, the new password works, the old one stops working", async () => {
  const u = await createUser();
  const cookies = await signIn(u.merchantId, u.email);
  const before = await pool.query<{ password_hash: string }>(
    `SELECT password_hash FROM merchant_users WHERE id = $1`,
    [u.userId],
  );

  const res = await changePassword(cookies, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
  assert.equal(res.statusCode, 204, res.body);

  const after = await pool.query<{ password_hash: string }>(
    `SELECT password_hash FROM merchant_users WHERE id = $1`,
    [u.userId],
  );
  assert.notEqual(after.rows[0]!.password_hash, before.rows[0]!.password_hash);
  assert.match(after.rows[0]!.password_hash, /^\$argon2id\$/, "stored with the existing argon2id helper");
  assert.ok(!after.rows[0]!.password_hash.includes(NEW_PASSWORD), "never stored in plain text");

  assert.equal((await login(u.merchantId, u.email, PASSWORD)).statusCode, 401, "old password refused");
  assert.equal((await login(u.merchantId, u.email, NEW_PASSWORD)).statusCode, 200, "new password accepted");
});

test("change password ends the user's other sessions and keeps the current one", async () => {
  const u = await createUser();
  const current = await signIn(u.merchantId, u.email);
  const other = await signIn(u.merchantId, u.email);
  // A pending (pre-OTP) session started with the old password must die too.
  const pending = await login(u.merchantId, u.email, PASSWORD);
  const pendingCookies = { [config.cookieName]: pending.cookies.find((c) => c.name === config.cookieName)!.value };

  const res = await changePassword(current, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
  assert.equal(res.statusCode, 204, res.body);

  assert.equal((await me(current)).statusCode, 200, "the current session stays signed in");
  assert.equal((await me(other)).statusCode, 401, "the other session is ended");
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    cookies: pendingCookies,
    payload: { code: pending.json().devOtpCode },
  });
  assert.equal(verify.statusCode, 401, "a pending sign-in started before the change cannot finish");
});

test("wrong current password: 400 invalid_current_password, nothing changes", async () => {
  const u = await createUser();
  const cookies = await signIn(u.merchantId, u.email);
  const other = await signIn(u.merchantId, u.email);

  const res = await changePassword(cookies, { currentPassword: "not the password", newPassword: NEW_PASSWORD });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "invalid_current_password");

  assert.equal((await login(u.merchantId, u.email, PASSWORD)).statusCode, 200, "old password still works");
  assert.equal((await me(other)).statusCode, 200, "no session was ended");
});

test("new password rules: too short, too long and unchanged are refused with 400", async () => {
  const u = await createUser();
  const cookies = await signIn(u.merchantId, u.email);

  const short = await changePassword(cookies, { currentPassword: PASSWORD, newPassword: "short-11ch!" });
  assert.equal(short.statusCode, 400, short.body);
  assert.equal(short.json().error, "weak_password");

  const long = await changePassword(cookies, { currentPassword: PASSWORD, newPassword: "x".repeat(129) });
  assert.equal(long.statusCode, 400, long.body);
  assert.equal(long.json().error, "weak_password");

  const same = await changePassword(cookies, { currentPassword: PASSWORD, newPassword: PASSWORD });
  assert.equal(same.statusCode, 400, same.body);
  assert.equal(same.json().error, "password_unchanged");

  // Exactly 12 characters is the minimum and is accepted.
  const ok = await changePassword(cookies, { currentPassword: PASSWORD, newPassword: "exactly-12ch" });
  assert.equal(ok.statusCode, 204, ok.body);
});

test("missing or non-string fields: 400 invalid_request", async () => {
  const u = await createUser();
  const cookies = await signIn(u.merchantId, u.email);
  for (const payload of [{}, { currentPassword: PASSWORD }, { newPassword: NEW_PASSWORD }, { currentPassword: 1, newPassword: 2 }]) {
    const res = await changePassword(cookies, payload);
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)}: ${res.body}`);
    assert.equal(res.json().error, "invalid_request");
  }
});

test("change password writes one merchant audit row", async () => {
  const u = await createUser();
  const cookies = await signIn(u.merchantId, u.email);
  const res = await changePassword(cookies, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
  assert.equal(res.statusCode, 204, res.body);
  const rows = await pool.query<{ action: string; actor_merchant_user_id: string; target_merchant_user_id: string }>(
    `SELECT action, actor_merchant_user_id, target_merchant_user_id FROM merchant_audit_log WHERE merchant_id = $1`,
    [u.merchantId],
  );
  assert.deepEqual(rows.rows, [
    { action: "password_change", actor_merchant_user_id: u.userId, target_merchant_user_id: u.userId },
  ]);
});

test("no session: 401; an admin 'view as merchant' grant: 403", async () => {
  const anon = await changePassword({}, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
  assert.equal(anon.statusCode, 401, anon.body);

  const u = await createUser();
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, 'unused', $2, 'super_admin') RETURNING id`,
    [`pw-${randomUUID()}@admin.test`, `PW ${randomUUID().slice(0, 8)}`],
  );
  const grant = await startImpersonation(pool, { adminUserId: admin.rows[0]!.id, merchantId: u.merchantId, ttlMinutes: 15 });
  const res = await changePassword(
    { [config.impersonationCookieName]: grant.rawToken },
    { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
  );
  assert.equal(res.statusCode, 403, res.body);
});

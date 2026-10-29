/**
 * New merchants start with refunds_enabled NULL (= off, migration 0052), and
 * nothing in the product could turn refunds on: only raw SQL. Finance and
 * super_admin can now switch it, with an audit row. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../adminAuth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("adminRefundsEnabled.fix.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const PASSWORD = "admin-test-password-9000!";

async function signedInAdmin(role: "support" | "finance"): Promise<{ cookie: string; adminUserId: string }> {
  const email = `refunds-${randomUUID()}@admin.test`;
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, await hashPassword(PASSWORD, config), `Refunds ${randomUUID().slice(0, 8)}`, role],
  );
  const login = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = login.cookies.find((c) => c.name === config.adminCookieName)!.value;
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    cookies: { [config.adminCookieName]: cookie },
    payload: { code: login.json().devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return { cookie, adminUserId: admin.rows[0]!.id };
}

async function newMerchant(): Promise<string> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Refunds Toggle ${randomUUID()}`],
  );
  return m.rows[0]!.id;
}

function setRefunds(cookie: string, merchantId: string, enabled: unknown) {
  return app.inject({
    method: "PUT",
    url: `/v1/admin/merchants/${merchantId}/refunds-enabled`,
    cookies: { [config.adminCookieName]: cookie },
    payload: { enabled },
  });
}

test("finance can turn refunds on and off, and each change is audited", async () => {
  const { cookie, adminUserId } = await signedInAdmin("finance");
  const merchantId = await newMerchant();

  const on = await setRefunds(cookie, merchantId, true);
  assert.equal(on.statusCode, 200, on.body);
  assert.deepEqual(on.json(), { merchantId, refundsEnabled: true });
  const row = await pool.query(`SELECT refunds_enabled FROM merchants WHERE id = $1`, [merchantId]);
  assert.equal(row.rows[0].refunds_enabled, true);

  const off = await setRefunds(cookie, merchantId, false);
  assert.equal(off.statusCode, 200, off.body);

  const audit = await pool.query(
    `SELECT metadata FROM admin_audit_log
      WHERE admin_user_id = $1 AND action = 'merchant_refunds_enabled' AND target_id = $2
      ORDER BY created_at`,
    [adminUserId, merchantId],
  );
  assert.deepEqual(audit.rows.map((r) => r.metadata.enabled), [true, false]);
});

test("support cannot change the refunds switch", async () => {
  const { cookie } = await signedInAdmin("support");
  const res = await setRefunds(cookie, await newMerchant(), true);
  assert.equal(res.statusCode, 403);
});

test("the switch needs a real boolean and an existing merchant", async () => {
  const { cookie } = await signedInAdmin("finance");
  assert.equal((await setRefunds(cookie, await newMerchant(), "yes")).statusCode, 400);
  assert.equal((await setRefunds(cookie, randomUUID(), true)).statusCode, 404);
});

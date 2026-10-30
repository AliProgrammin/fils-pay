/**
 * "Recompute transaction statuses" tidies statuses. It must never take a test
 * merchant out of test mode: settlement only skips merchants with
 * test_mode = true. Real Postgres. Requires DATABASE_URL.
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
  throw new Error("adminMerchantsRecompute.fix.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

async function signedInFinanceAdmin(): Promise<string> {
  const email = `recompute-${randomUUID()}@admin.test`;
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, $3, 'finance')`,
    [email, await hashPassword(PASSWORD, config), `Recompute ${randomUUID().slice(0, 8)}`],
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
  return cookie;
}

async function testMerchantWith(statuses: Array<"captured" | "authorized">): Promise<string> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, test_mode) VALUES ($1, 250, true) RETURNING id`,
    [`Recompute Test ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  for (const status of statuses) {
    await pool.query(
      `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
       VALUES ($1, $2, 5000, $3, $4)`,
      [merchantId, status, status === "captured" ? 5000 : 0, `acq_${randomUUID()}`],
    );
  }
  return merchantId;
}

async function recompute(cookie: string, merchantId: string) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/transactions/recompute-statuses`,
    cookies: { [config.adminCookieName]: cookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { openAuthorizations: number; flagsUpdated: string[] };
}

async function testMode(merchantId: string): Promise<boolean> {
  const row = await pool.query<{ test_mode: boolean }>(`SELECT test_mode FROM merchants WHERE id = $1`, [merchantId]);
  return row.rows[0]!.test_mode;
}

test("recompute keeps test_mode and counts an open authorization", async () => {
  const cookie = await signedInFinanceAdmin();
  const merchantId = await testMerchantWith(["captured", "authorized"]);

  const result = await recompute(cookie, merchantId);
  assert.equal(result.openAuthorizations, 1, "the authorized transaction is an open authorization");
  assert.deepEqual(result.flagsUpdated, []);
  assert.equal(await testMode(merchantId), true, "a test merchant must stay out of real settlement");
});

test("recompute keeps test_mode for a test merchant with nothing open", async () => {
  const cookie = await signedInFinanceAdmin();
  const merchantId = await testMerchantWith(["captured"]);

  await recompute(cookie, merchantId);
  assert.equal(await testMode(merchantId), true, "a test merchant must stay out of real settlement");
});

test("recompute never changes a chargeback transaction", async () => {
  const cookie = await signedInFinanceAdmin();
  const merchantId = await testMerchantWith([]);
  const txn = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'chargeback', 5000, 5000, $2) RETURNING id`,
    [merchantId, `acq_${randomUUID()}`],
  );

  await recompute(cookie, merchantId);
  const row = await pool.query<{ status: string }>(`SELECT status FROM transactions WHERE id = $1`, [txn.rows[0]!.id]);
  assert.equal(row.rows[0]!.status, "chargeback", "a chargeback must stay a chargeback (and so stay unrefundable)");
});

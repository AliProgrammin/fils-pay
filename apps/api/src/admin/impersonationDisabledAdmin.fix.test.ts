/**
 * A13: disabling an admin must kill their live impersonation grants, the
 * same way it kills their admin sessions. lookupImpersonationGrant relied on
 * an "admin-disable trigger" that does not exist in db/migrations.
 * Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { lookupImpersonationGrant, startImpersonation } from "./impersonation.js";
import { lookupAdminSession } from "../adminAuth/sessions.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("impersonationDisabledAdmin.fix.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

async function adminWithGrant() {
  const suffix = randomUUID();
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'unused', $2, 'support') RETURNING id`,
    [`dis-${suffix}@admin.test`, `Dis ${suffix.slice(0, 8)}`],
  );
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Disabled Admin ${suffix}`],
  );
  const adminUserId = admin.rows[0]!.id;
  const grant = await startImpersonation(pool, { adminUserId, merchantId: merchant.rows[0]!.id, ttlMinutes: 15 });
  return { adminUserId, rawToken: grant.rawToken };
}

test("A13: a disabled admin's impersonation grant stops working", async () => {
  const { adminUserId, rawToken } = await adminWithGrant();
  const cookies = { [config.impersonationCookieName]: rawToken };

  const before = await app.inject({ method: "GET", url: "/v1/transactions", cookies });
  assert.equal(before.statusCode, 200, before.body);

  await pool.query(`UPDATE admin_users SET status = 'disabled' WHERE id = $1`, [adminUserId]);

  assert.equal(await lookupImpersonationGrant(pool, rawToken), null);
  const after = await app.inject({ method: "GET", url: "/v1/transactions", cookies });
  assert.equal(after.statusCode, 401, after.body);
});

test("A13: a disabled admin's admin session also stops working (regression guard)", async () => {
  const { adminUserId } = await adminWithGrant();
  const rawToken = randomToken(32);
  await pool.query(
    `INSERT INTO admin_sessions (admin_user_id, token_hash, authenticated, authenticated_at, expires_at)
     VALUES ($1, $2, true, now(), now() + interval '1 hour')`,
    [adminUserId, sha256Hex(rawToken)],
  );
  assert.notEqual(await lookupAdminSession(pool, rawToken), null);
  await pool.query(`UPDATE admin_users SET status = 'disabled' WHERE id = $1`, [adminUserId]);
  assert.equal(await lookupAdminSession(pool, rawToken), null);
});

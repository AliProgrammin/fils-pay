/**
 * "View as merchant" must be read-only (HANDOVER, ARCHITECTURE). Mapping the
 * grant to the `support` role is not enough: capture, void and saved filters
 * only check requireMerchantAuth, so an impersonating admin could still write.
 * Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { startImpersonation } from "../admin/impersonation.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("impersonationReadOnly.fix.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

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

async function impersonationCookie(adminRole: "support" | "finance" | "super_admin") {
  const suffix = randomUUID();
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'unused', $2, $3) RETURNING id`,
    [`ro-${suffix}@admin.test`, `RO ${suffix.slice(0, 8)}`, adminRole],
  );
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`RO Fix ${suffix}`],
  );
  const grant = await startImpersonation(pool, {
    adminUserId: admin.rows[0]!.id,
    merchantId: merchant.rows[0]!.id,
    ttlMinutes: 15,
  });
  return { [config.impersonationCookieName]: grant.rawToken };
}

for (const adminRole of ["support", "finance", "super_admin"] as const) {
  test(`a ${adminRole} impersonation grant cannot call write routes`, async () => {
    const cookies = await impersonationCookie(adminRole);
    const txnId = randomUUID();
    for (const url of [`/v1/transactions/${txnId}/capture`, `/v1/transactions/${txnId}/void`]) {
      const res = await app.inject({
        method: "POST",
        url,
        cookies,
        headers: { "idempotency-key": randomUUID() },
        payload: { amountFils: 1000 },
      });
      assert.equal(res.statusCode, 403, `${url} should be 403 for impersonation, got ${res.statusCode}`);
    }
    const filter = await app.inject({
      method: "POST",
      url: "/v1/reporting/saved-filters",
      cookies,
      payload: { name: "x", filter: {} },
    });
    assert.equal(filter.statusCode, 403);
  });
}

test("an impersonation grant can still read", async () => {
  const cookies = await impersonationCookie("finance");
  const res = await app.inject({ method: "GET", url: "/v1/transactions", cookies });
  assert.equal(res.statusCode, 200);
});

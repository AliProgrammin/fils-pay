/**
 * "View as merchant" is read-only for every admin role: a grant always maps
 * to the merchant-plane role `support` (HANDOVER, ARCH). Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { lookupImpersonationGrant, startImpersonation } from "./impersonation.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("impersonation.fix.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 4 });

test.after(async () => {
  await pool.end();
});

for (const adminRole of ["support", "finance", "super_admin"] as const) {
  test(`a ${adminRole} impersonation grant resolves to the read-only merchant role 'support'`, async () => {
    const suffix = randomUUID();
    const admin = await pool.query<{ id: string }>(
      `INSERT INTO admin_users (email, password_hash, display_name, role)
       VALUES ($1, 'unused', $2, $3) RETURNING id`,
      [`imp-${suffix}@admin.test`, `Imp ${suffix.slice(0, 8)}`, adminRole],
    );
    const merchant = await pool.query<{ id: string }>(
      `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
      [`Imp Fix ${suffix}`],
    );

    const grant = await startImpersonation(pool, {
      adminUserId: admin.rows[0]!.id,
      merchantId: merchant.rows[0]!.id,
      ttlMinutes: 15,
    });
    const found = await lookupImpersonationGrant(pool, grant.rawToken);
    assert.ok(found);
    assert.equal(found.merchantRole, "support");
  });
}

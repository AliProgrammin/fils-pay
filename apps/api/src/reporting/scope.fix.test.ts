/**
 * A merchant may report on itself and on its OWN split children only —
 * never on another parent's child.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { resolveReportMerchantId } from "./scope.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("scope.fix.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
test.after(async () => {
  await pool.end();
});

async function merchant(label: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Scope Fix ${label} ${randomUUID()}`],
  );
  return r.rows[0]!.id;
}

test("a caller cannot scope a report to another parent's split child", async () => {
  const attacker = await merchant("attacker");
  const victimParent = await merchant("victim-parent");
  const victimChild = await merchant("victim-child");
  const ownChild = await merchant("own-child");
  await pool.query(
    `INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps)
     VALUES ($1, $2, 10000), ($3, $4, 10000)`,
    [victimParent, victimChild, attacker, ownChild],
  );

  assert.equal(await resolveReportMerchantId(pool, attacker, victimChild), attacker);
  assert.equal(await resolveReportMerchantId(pool, attacker, ownChild), ownChild);
  assert.equal(await resolveReportMerchantId(pool, attacker), attacker);
});

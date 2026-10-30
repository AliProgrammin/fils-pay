/**
 * H9 (docs/bugs/hunt-2.md): releasing a hold (capture, void, refund) must
 * use an index, not scan every hold ever made. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("holdsIndex.fix.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
test.after(() => pool.end());

test("H9: the hold-release UPDATE is planned as an index scan on the active-holds index", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Rule out the 'table is tiny' seq-scan choice: only the index can make it cheap.
    await client.query("SET LOCAL enable_seqscan = off");
    const plan = await client.query<{ "QUERY PLAN": string }>(
      `EXPLAIN UPDATE holds SET status = 'released'
        WHERE transaction_id = '00000000-0000-0000-0000-000000000000' AND status = 'active'`,
    );
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    assert.match(text, /idx_holds_active_transaction/, text);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

/**
 * E4: ledger_entries is append-only. A balanced UPDATE, a whole-group
 * DELETE and a TRUNCATE must all be rejected. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool, type PoolClient } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("ledgerAppendOnly.fix.test.ts requires DATABASE_URL");
}
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
after(async () => {
  await pool.end();
});

async function postGroup(): Promise<string> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
     VALUES ($1, 250, 'active', false) RETURNING id`,
    [`ledger-append-only-${randomUUID()}`],
  );
  const groupId = randomUUID();
  await pool.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at)
     VALUES ($1, $2, 'platform_cash', 'debit', 1000, now()),
            ($1, $2, 'merchant_payable', 'credit', 1000, now())`,
    [groupId, m.rows[0]!.id],
  );
  return groupId;
}

/** Runs `sql` in a transaction that is always rolled back; returns the error, if any. */
async function tryInTx(sql: string, values: unknown[] = []): Promise<unknown> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql, values);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    return undefined;
  } catch (err) {
    return err;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

test("a balanced UPDATE of both legs is rejected", async () => {
  const groupId = await postGroup();
  const err = await tryInTx(`UPDATE ledger_entries SET amount_fils = 5 WHERE entry_group_id = $1`, [groupId]);
  assert.match(String(err), /append-only/);
});

test("deleting a whole group is rejected", async () => {
  const groupId = await postGroup();
  const err = await tryInTx(`DELETE FROM ledger_entries WHERE entry_group_id = $1`, [groupId]);
  assert.match(String(err), /append-only/);
});

test("TRUNCATE is rejected", async () => {
  await postGroup();
  const err = await tryInTx(`TRUNCATE ledger_entries`);
  assert.match(String(err), /append-only/);
});

test("inserting a new balanced group still works", async () => {
  await assert.doesNotReject(postGroup());
});

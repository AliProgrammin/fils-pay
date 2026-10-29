/**
 * E3: expired holds are marked 'expired', never deleted. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client } from "pg";
import * as expire from "./expire_holds.js";

test("expireHolds flips only active, past-due holds to 'expired' and deletes nothing", async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const m = await client.query<{ id: string }>(
      `INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
       VALUES ($1, 250, 'active', false) RETURNING id`,
      [`holds-fix-${randomUUID()}`],
    );
    const merchantId = m.rows[0]!.id;
    const ins = await client.query<{ id: string }>(
      `INSERT INTO holds (merchant_id, amount_fils, status, expires_at) VALUES
         ($1, 1000, 'active',   now() - interval '1 hour'),
         ($1, 2000, 'active',   now() + interval '1 hour'),
         ($1, 3000, 'released', now() - interval '1 hour')
       RETURNING id`,
      [merchantId],
    );
    const [pastDue, live, released] = ins.rows.map((r) => r.id);

    const run = expire.expireHolds;
    assert.ok((await run(client)) >= 1);
    await run(client); // a second night changes nothing for these rows

    const rows = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM holds WHERE merchant_id = $1`,
      [merchantId],
    );
    const status = new Map(rows.rows.map((r) => [r.id, r.status]));
    assert.equal(rows.rows.length, 3, "no hold may be deleted");
    assert.equal(status.get(pastDue!), "expired");
    assert.equal(status.get(live!), "active");
    assert.equal(status.get(released!), "released");
  } finally {
    await client.end();
  }
});

/**
 * E2: the March sweep must use the Bahrain month, post legs per ADR-0002,
 * and be safe to re-run. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client } from "pg";
import * as recon from "./reconcile_march.js";

test("monthBounds(2026, 3) is the Bahrain month, UTC+3", () => {
  const { start, end } = recon.monthBounds(2026, 3);
  assert.equal(start.toISOString(), "2026-02-28T21:00:00.000Z");
  assert.equal(end.toISOString(), "2026-03-31T21:00:00.000Z");
});

test("running the residue posting twice posts one balanced ADR-0002 group", async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const m = await client.query<{ id: string }>(
      `INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
       VALUES ($1, 250, 'active', false) RETURNING id`,
      [`recon-fix-${randomUUID()}`],
    );
    const merchantId = m.rows[0]!.id;
    const merchant = { merchantId, lineCount: 2, residueFils: 14 };
    assert.equal(await recon.postResidueCorrection(client, merchant, 2026, 3, new Date()), true);
    assert.equal(await recon.postResidueCorrection(client, merchant, 2026, 3, new Date()), false);

    const legs = await client.query<{ account_id: string; direction: string; amount_fils: string; groups: string }>(
      `SELECT account_id, direction, amount_fils::text,
              (SELECT COUNT(DISTINCT entry_group_id) FROM ledger_entries WHERE merchant_id = $1)::text AS groups
         FROM ledger_entries WHERE merchant_id = $1 ORDER BY account_id`,
      [merchantId],
    );
    assert.equal(legs.rows[0]?.groups, "1", "a re-run must not post a second group");
    assert.deepEqual(
      legs.rows.map((r) => [r.account_id, r.direction, Number(r.amount_fils)]),
      [
        ["card_scheme_clearing", "credit", 14],
        ["scheme_rounding_residue", "debit", 14],
      ],
    );
  } finally {
    await client.end();
  }
});

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

// W2: since C9, CloseBatch posts the residue per line at close. The sweep
// must see a month that already has close-time residue and not post again.
test("a month with close-time residue rows is detected; an empty month is not", async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const m = await client.query<{ id: string }>(
      `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
      [`recon-c9-${randomUUID()}`],
    );
    const merchantId = m.rows[0]!.id;
    const txn = await client.query<{ id: string }>(
      `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, occurred_at, acquirer_reference)
       VALUES ($1, 'captured', 4755, 4755, '2031-07-10T09:00:00Z', $2) RETURNING id`,
      [merchantId, `recon-c9-${randomUUID()}`],
    );
    const batch = await client.query<{ id: string }>(
      `INSERT INTO settlement_batches (merchant_id, batch_date, status) VALUES ($1, '2031-07-10', 'closed') RETURNING id`,
      [merchantId],
    );
    await client.query(
      `INSERT INTO ledger_entries (entry_group_id, merchant_id, transaction_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES ($1, $2, $3, $4, 'card_scheme_clearing', 'credit', 5, '2031-07-11T00:00:00Z', 'scheme rounding residue'),
              ($1, $2, $3, $4, 'scheme_rounding_residue', 'debit', 5, '2031-07-11T00:00:00Z', 'scheme rounding residue')`,
      [randomUUID(), merchantId, txn.rows[0]!.id, batch.rows[0]!.id],
    );

    assert.equal(await recon.periodHasCloseTimeResidue(client, 2031, 7), true);
    assert.equal(await recon.periodHasCloseTimeResidue(client, 2031, 9), false);
  } finally {
    await client.end();
  }
});

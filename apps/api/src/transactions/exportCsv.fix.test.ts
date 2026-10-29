/**
 * B6: the transactions CSV export must stream page by page (keyset on
 * occurred_at, id) without skipping rows that share a timestamp, and bad
 * from/to must be a 400. Requires DATABASE_URL (migrated Postgres).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { streamTransactionsExportCsv } from "./exportCsv.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("exportCsv.fix.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);
after(async () => {
  await app.close();
  await pool.end();
});

async function merchantWithKey() {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Export Fix ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "export" });
  return { merchantId, rawKey: issued.rawKey };
}

/** 1500 rows (more than one 1000-row page), all with the SAME occurred_at. */
async function insertTiedRows(merchantId: string, count = 1500): Promise<void> {
  await pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
     SELECT $1, 'authorized', 1000, 0, 'acq_' || gen_random_uuid(), '2026-04-01T10:00:00Z'
       FROM generate_series(1, $2)`,
    [merchantId, count],
  );
}

function dataIds(csv: string): string[] {
  return csv
    .split("\n")
    .slice(1)
    .filter((l) => l.length > 0)
    .map((l) => l.split(",")[0]!);
}

test("B6: streaming export returns every row once when many rows share one occurred_at", async () => {
  const { merchantId } = await merchantWithKey();
  await insertTiedRows(merchantId);

  let csv = "";
  for await (const chunk of streamTransactionsExportCsv(pool, { merchantId })) csv += chunk;

  const ids = dataIds(csv);
  assert.equal(ids.length, 1500);
  assert.equal(new Set(ids).size, 1500);
});

test("B6: GET /v1/transactions/export returns all rows across pages", async () => {
  const { merchantId, rawKey } = await merchantWithKey();
  await insertTiedRows(merchantId);

  const res = await app.inject({
    method: "GET",
    url: "/v1/transactions/export",
    headers: { authorization: `Bearer ${rawKey}` },
  });

  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers["content-type"]), /^text\/csv/);
  const ids = dataIds(res.body);
  assert.equal(ids.length, 1500);
  assert.equal(new Set(ids).size, 1500);
});

test("B6: an invalid from/to is a 400, not a 500", async () => {
  const { rawKey } = await merchantWithKey();
  for (const qs of ["from=not-a-date", "to=2026-13-45"]) {
    const res = await app.inject({
      method: "GET",
      url: `/v1/transactions/export?${qs}`,
      headers: { authorization: `Bearer ${rawKey}` },
    });
    assert.equal(res.statusCode, 400, `${qs}: ${res.body}`);
    assert.equal(res.json().error, "invalid_request");
  }
});

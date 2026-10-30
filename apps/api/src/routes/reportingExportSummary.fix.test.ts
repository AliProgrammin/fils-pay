/**
 * GET /v1/reporting/export-summary had no auth hook: it read
 * request.merchantAuth!.merchantId and crashed with a 500. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("reportingExportSummary.fix.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

test("export-summary without credentials answers 401, not 500", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/reporting/export-summary" });
  assert.equal(res.statusCode, 401);
});

// D17: the summary reported gross only; refunds from the 0084 rollup columns were dropped.
test("export-summary reports the refunded total next to gross", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Export Summary ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "summary" });
  await pool.query(
    `INSERT INTO merchant_daily_volume (merchant_id, volume_date, captured_count, captured_gross_fils, refund_count, refund_gross_fils)
     VALUES ($1, '2026-06-01', 2, 10000, 1, 1500), ($1, '2026-06-02', 1, 4000, 1, 500)`,
    [merchantId],
  );

  const res = await app.inject({
    method: "GET",
    url: "/v1/reporting/export-summary",
    headers: { authorization: `Bearer ${rawKey}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { totalDays: 2, grossFils: 14000, refundedFils: 2000 });
});

// W5: a merchantId in the filter that is not a UUID is bad input (400), not a 500.
test("GET /v1/reporting/transactions with a non-UUID filter merchantId answers 400 invalid_request", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Report Scope ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "scope" });
  for (const bad of ["not-a-uuid", 42]) {
    const res = await app.inject({
      method: "GET",
      url: `/v1/reporting/transactions?filter=${encodeURIComponent(JSON.stringify({ merchantId: bad }))}`,
      headers: { authorization: `Bearer ${rawKey}` },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error, "invalid_request");
  }
});

// W8: bad dates and odd filter values are bad input (400), not a 500.
test("bad reporting filter values and bad reconciliation dates answer 400", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Report Bad Input ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "bad-input" });
  const headers = { authorization: `Bearer ${rawKey}` };

  for (const filter of ['{"from":"x","__proto__":{"a":1}}', '{"to":"2026-13-45"}', '{"status":{"a":1}}', "null"]) {
    const res = await app.inject({
      method: "GET",
      url: `/v1/reporting/transactions?filter=${encodeURIComponent(filter)}`,
      headers,
    });
    assert.equal(res.statusCode, 400, `${filter}: ${res.body}`);
  }
  const ok = await app.inject({
    method: "GET",
    url: `/v1/reporting/transactions?filter=${encodeURIComponent('{"from":"2026-01-01","to":"2026-02-01T00:00:00Z"}')}`,
    headers,
  });
  assert.equal(ok.statusCode, 200, ok.body);

  for (const path of ["reconciliation", "summary"]) {
    const res = await app.inject({ method: "GET", url: `/v1/settlement/${path}?from=2026-13-45&to=xyz`, headers });
    assert.equal(res.statusCode, 400, `${path}: ${res.body}`);
    assert.equal(res.json().error, "invalid_request");
  }
  const okRecon = await app.inject({
    method: "GET",
    url: "/v1/settlement/reconciliation?from=2026-01-01&to=2026-01-31",
    headers,
  });
  assert.equal(okRecon.statusCode, 200, okRecon.body);
});

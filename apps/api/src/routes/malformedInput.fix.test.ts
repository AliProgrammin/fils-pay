/**
 * Malformed query values, path ids and PATCH keys are client mistakes:
 * 400 invalid_request (or 404 for a path id that cannot name a row), never
 * 500. Valid input keeps working. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { sha256Hex, randomToken } from "../lib/crypto.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("malformedInput.fix.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

async function ownerSession() {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Malformed ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `malformed-${randomUUID()}@example.test`],
  );
  const raw = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at)
     VALUES ($1, $2, true, now() + interval '1 hour')`,
    [u.rows[0]!.id, sha256Hex(raw)],
  );
  return { merchantId, cookies: { [config.cookieName]: raw } };
}

const badCursor = Buffer.from("not-a-time|not-a-uuid", "utf8").toString("base64url");

async function get(cookies: Record<string, string>, url: string) {
  return app.inject({ method: "GET", url, cookies });
}

test("webhook delivery list: bad limit or cursor is 400, valid query is 200", async () => {
  const { merchantId, cookies } = await ownerSession();
  const created = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/webhook-endpoints`,
    cookies,
    payload: { url: "https://example.com/hook" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const base = `/v1/merchants/${merchantId}/webhook-endpoints/${created.json().id}/deliveries`;

  for (const q of ["limit=abc", `cursor=${badCursor}`]) {
    const res = await get(cookies, `${base}?${q}`);
    assert.equal(res.statusCode, 400, `${q}: ${res.body}`);
    assert.equal(res.json().error, "invalid_request");
  }
  const ok = await get(cookies, `${base}?limit=10`);
  assert.equal(ok.statusCode, 200, ok.body);
});

test("settlement batch list: bad limit, from or cursor is 400; bad batch id is 404", async () => {
  const { cookies } = await ownerSession();
  for (const q of ["limit=abc", "from=garbage", "to=garbage", `cursor=${badCursor}`]) {
    const res = await get(cookies, `/v1/settlement/batches?${q}`);
    assert.equal(res.statusCode, 400, `${q}: ${res.body}`);
    assert.equal(res.json().error, "invalid_request");
  }
  for (const url of ["/v1/settlement/batches/not-a-uuid", "/v1/settlement/batches/not-a-uuid/transactions"]) {
    const res = await get(cookies, url);
    assert.equal(res.statusCode, 404, `${url}: ${res.body}`);
    assert.equal(res.json().error, "settlement_batch_not_found");
  }
  const ok = await get(cookies, `/v1/settlement/batches?limit=5&from=2026-01-01&to=2026-12-31`);
  assert.equal(ok.statusCode, 200, ok.body);
});

test("business-profile PATCH: an unknown key is 400 invalid_request", async () => {
  const { merchantId, cookies } = await ownerSession();
  const res = await app.inject({
    method: "PATCH",
    url: `/v1/merchants/${merchantId}/business-profile`,
    cookies,
    payload: { notAField: "x" },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "invalid_request");
});

test("KYC document file/thumbnail: a non-UUID document id is 404", async () => {
  const { merchantId, cookies } = await ownerSession();
  for (const [kind, code] of [["file", "kyc_document_not_found"], ["thumbnail", "kyc_thumbnail_not_found"]]) {
    const res = await get(cookies, `/v1/merchants/${merchantId}/kyc/documents/not-a-uuid/${kind}`);
    assert.equal(res.statusCode, 404, `${kind}: ${res.body}`);
    assert.equal(res.json().error, code);
  }
});

test("settlement batch list: a real nextCursor still pages", async () => {
  const { merchantId, cookies } = await ownerSession();
  await pool.query(
    `INSERT INTO settlement_batches (merchant_id, batch_date) VALUES ($1, '2026-03-01'), ($1, '2026-03-02')`,
    [merchantId],
  );
  const first = await get(cookies, "/v1/settlement/batches?limit=1");
  assert.equal(first.statusCode, 200, first.body);
  const page1 = first.json() as { batches: Array<{ id: string }>; nextCursor: string | null };
  assert.ok(page1.nextCursor);
  const second = await get(cookies, `/v1/settlement/batches?limit=1&cursor=${page1.nextCursor}`);
  assert.equal(second.statusCode, 200, second.body);
  const page2 = second.json() as { batches: Array<{ id: string }> };
  assert.equal(page2.batches.length, 1);
  assert.notEqual(page2.batches[0]!.id, page1.batches[0]!.id);
});

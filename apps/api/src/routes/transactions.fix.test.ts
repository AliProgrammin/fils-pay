/**
 * Regression tests for docs/bugs/hunt-2.md (transactions surface).
 * Requires DATABASE_URL (a real, migrated Postgres).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { sha256Hex, randomToken } from "../lib/crypto.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("transactions.fix.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function createMerchant() {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Hunt2 ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "hunt2" });
  return { merchantId, bearer: { authorization: `Bearer ${issued.rawKey}` } };
}

async function sessionCookie(merchantId: string, role: "owner" | "finance" | "support") {
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, $3, 'unused') RETURNING id`,
    [merchantId, `${role}-${randomUUID()}@example.test`, role],
  );
  const raw = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at)
     VALUES ($1, $2, true, now() + interval '1 hour')`,
    [u.rows[0]!.id, sha256Hex(raw)],
  );
  return { [config.cookieName]: raw };
}

async function authorize(bearer: Record<string, string>, amountFils: number) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...bearer, "idempotency-key": randomUUID() },
    payload: { amountFils, card: CARD },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string };
}

// H2: the support role is read-only; it must not move money.
test("H2: a support session cannot capture or void (403); owner and finance sessions and API keys can", async () => {
  const m = await createMerchant();
  const support = await sessionCookie(m.merchantId, "support");

  const t1 = await authorize(m.bearer, 1_000);
  const cap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${t1.id}/capture`,
    cookies: support,
    headers: { "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(cap.statusCode, 403, cap.body);
  assert.equal(cap.json().error, "forbidden");

  const voidRes = await app.inject({ method: "POST", url: `/v1/transactions/${t1.id}/void`, cookies: support });
  assert.equal(voidRes.statusCode, 403, voidRes.body);

  const still = await pool.query(`SELECT status FROM transactions WHERE id = $1`, [t1.id]);
  assert.equal(still.rows[0].status, "authorized");

  // Allowed actors still work.
  const finance = await sessionCookie(m.merchantId, "finance");
  const finCap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${t1.id}/capture`,
    cookies: finance,
    headers: { "idempotency-key": randomUUID() },
    payload: { amountFils: 400 },
  });
  assert.equal(finCap.statusCode, 200, finCap.body);

  const t2 = await authorize(m.bearer, 1_000);
  const owner = await sessionCookie(m.merchantId, "owner");
  const ownerVoid = await app.inject({ method: "POST", url: `/v1/transactions/${t2.id}/void`, cookies: owner });
  assert.equal(ownerVoid.statusCode, 200, ownerVoid.body);

  const t3 = await authorize(m.bearer, 1_000);
  const keyCap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${t3.id}/capture`,
    headers: { ...m.bearer, "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(keyCap.statusCode, 200, keyCap.body);
});

// H3: bad client input must be a 400, never a 500.
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

test("H3: transactions list rejects a bad from/to/limit/cursor with 400", async () => {
  const m = await createMerchant();
  const bad = [
    "from=garbage",
    "to=garbage",
    "limit=abc",
    `cursor=${b64("x|y")}`,
    `cursor=${b64(`2026-13-40 00:00:00+00|${randomUUID()}`)}`,
    `cursor=${b64("2026-10-30 10:00:00.123456+00|not-a-uuid")}`,
    "cursor=nonsense",
  ];
  for (const qs of bad) {
    const res = await app.inject({ method: "GET", url: `/v1/transactions?${qs}`, headers: m.bearer });
    assert.equal(res.statusCode, 400, `${qs}: ${res.body}`);
    assert.equal(res.json().error, "invalid_request", qs);
  }
});

test("H3: transactions list still pages with a real cursor and clamps numeric limits", async () => {
  const m = await createMerchant();
  for (let i = 0; i < 3; i++) await authorize(m.bearer, 100 + i);
  const p1 = await app.inject({ method: "GET", url: "/v1/transactions?limit=2", headers: m.bearer });
  assert.equal(p1.statusCode, 200, p1.body);
  assert.equal(p1.json().transactions.length, 2);
  const p2 = await app.inject({
    method: "GET",
    url: `/v1/transactions?limit=2&cursor=${p1.json().nextCursor}`,
    headers: m.bearer,
  });
  assert.equal(p2.statusCode, 200, p2.body);
  assert.equal(p2.json().transactions.length, 1);
  const zero = await app.inject({ method: "GET", url: "/v1/transactions?limit=0", headers: m.bearer });
  assert.equal(zero.statusCode, 200, zero.body);
  assert.equal(zero.json().transactions.length, 1);
  const ranged = await app.inject({
    method: "GET",
    url: `/v1/transactions?from=2020-01-01T00:00:00Z&to=${new Date(Date.now() + 60_000).toISOString()}`,
    headers: m.bearer,
  });
  assert.equal(ranged.statusCode, 200, ranged.body);
  assert.equal(ranged.json().transactions.length, 3);
});

test("H3: a non-UUID transaction id is a 400 on every /:id route", async () => {
  const m = await createMerchant();
  for (const [method, url] of [
    ["GET", "/v1/transactions/abc"],
    ["GET", "/v1/transactions/abc/events"],
    ["POST", "/v1/transactions/abc/capture"],
    ["POST", "/v1/transactions/abc/void"],
  ] as const) {
    const res = await app.inject({
      method,
      url,
      headers: { ...m.bearer, "idempotency-key": randomUUID() },
      ...(method === "POST" ? { payload: {} } : {}),
    });
    assert.equal(res.statusCode, 400, `${method} ${url}: ${res.body}`);
    assert.equal(res.json().error, "invalid_request");
  }
});

test("H3: authorize and capture reject a non-integer, string, zero or negative amountFils with 400", async () => {
  const m = await createMerchant();
  for (const amountFils of [1.5, "100", 0, -5]) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/transactions",
      headers: { ...m.bearer, "idempotency-key": randomUUID() },
      payload: { amountFils, card: CARD },
    });
    assert.equal(res.statusCode, 400, `authorize ${amountFils}: ${res.body}`);
    assert.equal(res.json().error, "invalid_amount");
  }

  const txn = await authorize(m.bearer, 1_000);
  for (const amountFils of [1.5, "100", 0, -5]) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/transactions/${txn.id}/capture`,
      headers: { ...m.bearer, "idempotency-key": randomUUID() },
      payload: { amountFils },
    });
    assert.equal(res.statusCode, 400, `capture ${amountFils}: ${res.body}`);
    assert.equal(res.json().error, "invalid_amount");
  }
});

test("H3: payment-link list rejects a bad limit/cursor with 400 and still pages with a real cursor", async () => {
  const m = await createMerchant();
  const base = `/v1/merchants/${m.merchantId}/payment-links`;
  for (const qs of ["limit=abc", `cursor=${b64("x|y")}`, "cursor=nonsense"]) {
    const res = await app.inject({ method: "GET", url: `${base}?${qs}`, headers: m.bearer });
    assert.equal(res.statusCode, 400, `${qs}: ${res.body}`);
    assert.equal(res.json().error, "invalid_request", qs);
  }

  for (let i = 0; i < 3; i++) {
    const c = await app.inject({
      method: "POST",
      url: base,
      headers: { ...m.bearer, "idempotency-key": randomUUID() },
      payload: { amountFils: 500 + i, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    assert.equal(c.statusCode, 201, c.body);
  }
  const p1 = await app.inject({ method: "GET", url: `${base}?limit=2`, headers: m.bearer });
  assert.equal(p1.statusCode, 200, p1.body);
  assert.equal(p1.json().paymentLinks.length, 2);
  const p2 = await app.inject({ method: "GET", url: `${base}?limit=2&cursor=${p1.json().nextCursor}`, headers: m.bearer });
  assert.equal(p2.statusCode, 200, p2.body);
  assert.equal(p2.json().paymentLinks.length, 1);
});

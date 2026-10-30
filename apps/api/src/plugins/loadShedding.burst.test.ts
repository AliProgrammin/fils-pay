/**
 * A sudden burst against a tiny pool must be refused with a fast 503
 * server_busy + Retry-After, never a 500 after a multi-second wait. Real
 * Postgres, real routes, the pool and timeouts from config defaults.
 * Requires DATABASE_URL (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { hashPassword } from "../auth/passwords.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("loadShedding.burst.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  OTP_DEV_EXPOSE: "true",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  PG_POOL_MAX: "2",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "100",
  ACQUIRER_LATENCY_MAX_MS: "101",
});
const pool = createPool(config);
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const PASSWORD = "correct horse battery staple";
const BURST = 400;
/** Longer than the old 5 s connection timeout: queued requests cannot simply wait it out. */
const HOLD_MS = 6_000;
/** Every refusal must come before this. */
const MAX_LATENCY_MS = 2_000;

test("a burst of 400 requests at a 2-connection pool gets only 2xx or a fast 503 server_busy, never a 500", async (t) => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Burst ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const email = `burst-${randomUUID()}@load-shed.test`;
  await pool.query(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role) VALUES ($1, $2, $3, 'owner')`,
    [merchantId, email, await hashPassword(PASSWORD, config)],
  );
  const login = () =>
    app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password: PASSWORD } });

  // Every connection is busy (as with slow acquirer calls) when the burst lands.
  const held = await Promise.all(Array.from({ length: config.pgPoolMax }, () => pool.connect()));
  const releaseAt = sleep(HOLD_MS).then(() => held.forEach((c) => c.release()));

  const start = Date.now();
  const results = await Promise.all(
    Array.from({ length: BURST }, () => login().then((res) => ({ res, ms: Date.now() - start }))),
  );
  await releaseAt;

  const byStatus = new Map<number, number>();
  for (const { res } of results) byStatus.set(res.statusCode, (byStatus.get(res.statusCode) ?? 0) + 1);
  for (const { res, ms } of results) {
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    assert.ok(ok || res.statusCode === 503, `unexpected ${res.statusCode} ${res.body}; all: ${[...byStatus]}`);
    if (res.statusCode === 503) {
      assert.equal(res.headers["retry-after"], "1");
      assert.equal(res.json().error, "server_busy");
      assert.ok(ms < MAX_LATENCY_MS, `a 503 took ${ms} ms`);
    }
  }
  assert.ok((byStatus.get(503) ?? 0) > 0, "the burst must be shed");
  // Only the requests the shedder lets queue for a connection may wait for
  // the connection timeout; the rest are refused at once.
  const slow = results.filter((r) => r.ms > 500).length;
  t.diagnostic(`statuses ${JSON.stringify([...byStatus])}, slower than 500 ms: ${slow}`);
  assert.ok(slow <= config.loadShedMaxPoolWaiting + config.pgPoolMax, `${slow} requests waited more than 500 ms`);

  // The API recovers once the connections are free.
  const after = await login();
  assert.equal(after.statusCode, 200, after.body);
  // Health is never shed.
  assert.equal((await app.inject("/healthz")).statusCode, 200);
});

test("a payment that has started finishes even when the pool is full past the connection timeout", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Burst pay ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@load-shed.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "burst" });
  const created = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/payment-links`,
    headers: { authorization: `Bearer ${rawKey}` },
    payload: { amountFils: 1_250, reference: "burst", expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(created.statusCode, 201, created.body);
  const link = created.json() as { id: string; token: string };

  // One connection is busy for longer than the connection timeout.
  const hog = await pool.connect();
  const hogFree = sleep(3 * config.pgPoolConnectionTimeoutMs).then(() => hog.release());

  const pay = app.inject({
    method: "POST",
    url: `/v1/payment-links/${link.token}/pay`,
    headers: { "idempotency-key": randomUUID() },
    payload: { card: { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" } },
  });
  // Once the payment has the other connection, another request queues for
  // it and, if it gets it, keeps it past the connection timeout.
  while (pool.idleCount > 0 || pool.totalCount < config.pgPoolMax) await sleep(1);
  const waiter = pool.connect().then(
    async (c) => {
      await sleep(3 * config.pgPoolConnectionTimeoutMs);
      c.release();
    },
    () => undefined,
  );

  const res = await pay;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, "paid");
  await Promise.all([hogFree, waiter]);
  const row = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [link.id]);
  assert.equal(row.rows[0]!.status, "paid");
});

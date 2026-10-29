/**
 * Wave B payment-link fixes (FP-187 expiry, 2026-05-14 double charge,
 * cross-merchant cancel). Requires DATABASE_URL (migrated Postgres).
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
if (!databaseUrl) throw new Error("paymentLinks.fix.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  PAYMENT_LINK_RESERVATION_TIMEOUT_SECONDS: "60",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

const APPROVED_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function merchantWithKey(label: string) {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Fix Merchant ${label} ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label });
  return { merchantId, rawKey: issued.rawKey };
}

async function createLink(rawKey: string, merchantId: string) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/payment-links`,
    headers: { authorization: `Bearer ${rawKey}` },
    payload: { amountFils: 4_750, reference: "order-1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; token: string };
}

test("FP-187: an expired link cannot be paid by sending an old submittedAt", async () => {
  const { merchantId, rawKey } = await merchantWithKey("expiry");
  const link = await createLink(rawKey, merchantId);
  await pool.query(`UPDATE payment_links SET expires_at = now() - interval '1 day' WHERE id = $1`, [link.id]);

  const res = await app.inject({
    method: "POST",
    url: `/v1/payment-links/${link.token}/pay`,
    headers: { "idempotency-key": randomUUID() },
    payload: { card: APPROVED_CARD, submittedAt: "2000-01-01T00:00:00.000Z" },
  });

  assert.equal(res.statusCode, 410, res.body);
  assert.equal(res.json().error, "payment_link_expired");
  const row = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [link.id]);
  assert.equal(row.rows[0]!.status, "active");
});

/**
 * C12: the platform-wide volume-tier discount has no written finance
 * sign-off (docs/HANDOVER.md: "I said no until finance signs off in
 * writing"). A capture after platform volume passes the old 2,000,000.000 BD
 * threshold must be charged the merchant's full rate. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("platformVolumeTier.fix.test.ts requires DATABASE_URL");

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
after(async () => {
  await pool.query(`UPDATE platform_stats SET total_processed_fils = 0 WHERE id = 1`);
  await app.close();
  await pool.end();
});

test("C12: a capture after the volume threshold is charged the full MDR (no unapproved tier discount)", async () => {
  await pool.query(`UPDATE platform_stats SET total_processed_fils = 2100000000 WHERE id = 1`);

  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Tier Fix ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "tier" });
  const auth = { authorization: `Bearer ${issued.rawKey}` };

  const auth1 = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...auth, "idempotency-key": randomUUID() },
    payload: { amountFils: 10_000, card: { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" } },
  });
  assert.equal(auth1.statusCode, 201, auth1.body);
  const cap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${auth1.json().id}/capture`,
    headers: { ...auth, "idempotency-key": randomUUID() },
    payload: { amountFils: 10_000 },
  });
  assert.equal(cap.statusCode, 200, cap.body);

  const fee = await pool.query<{ amount_fils: string }>(
    `SELECT amount_fils FROM ledger_entries
      WHERE merchant_id = $1 AND account_id = 'platform_fee_revenue' AND direction = 'credit'`,
    [merchantId],
  );
  // 250 bps of 10,000 fils = 250 fils. With the unapproved 15 bps bonus it was 235.
  assert.equal(Number(fee.rows[0]!.amount_fils), 250);
});

/**
 * A payment cut off after its authorization was bound to the link (api crash
 * or restart mid-pay) completes when the same payer retries with the same
 * Idempotency-Key, and is charged once. Requires DATABASE_URL (migrated Postgres).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { payPaymentLink } from "../paymentLinks/pay.js";
import type { AcquirerSimulator } from "../acquirer/types.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("paymentLinks.resume.test.ts requires DATABASE_URL");

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
const payConfig = { paymentLinkReservationTimeoutSeconds: 60 };

async function linkForNewMerchant(): Promise<{ merchantId: string; linkId: string; token: string }> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Resume Merchant ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "resume" });
  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/payment-links`,
    headers: { authorization: `Bearer ${rawKey}` },
    payload: { amountFils: 4_750, reference: "resume", expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(res.statusCode, 201, res.body);
  const link = res.json() as { id: string; token: string };
  return { merchantId, linkId: link.id, token: link.token };
}

/** The app's acquirer, except that capture dies (like the process dying mid-call). */
function captureCrashes(): AcquirerSimulator {
  const inner = app.acquirer;
  return {
    authorize: (req) => inner.authorize(req),
    capture: async () => {
      throw new Error("simulated crash during capture");
    },
    refund: (req) => inner.refund(req),
  };
}

async function stopAfterBind(token: string, idempotencyKey: string): Promise<void> {
  await assert.rejects(payPaymentLink(pool, captureCrashes(), payConfig, { token, card: CARD, idempotencyKey }));
}

async function capturedCount(merchantId: string): Promise<number> {
  const r = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM transactions WHERE merchant_id = $1 AND captured_fils > 0`,
    [merchantId],
  );
  return Number(r.rows[0]!.c);
}

test("a same-key retry after a crash past the bind completes the payment, charged once", async () => {
  const { merchantId, linkId, token } = await linkForNewMerchant();
  const key = randomUUID();
  await stopAfterBind(token, key);

  const stuck = await pool.query<{ status: string; pending_transaction_id: string | null }>(
    `SELECT status, pending_transaction_id FROM payment_links WHERE id = $1`,
    [linkId],
  );
  assert.equal(stuck.rows[0]!.status, "reserved");
  assert.ok(stuck.rows[0]!.pending_transaction_id);

  const retry = await payPaymentLink(pool, app.acquirer, payConfig, { token, card: CARD, idempotencyKey: key });
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
  const body = retry.body as { status: string; transactionId: string; amountFils: number };
  assert.equal(body.status, "paid");
  assert.equal(body.amountFils, 4_750);
  assert.equal(body.transactionId, stuck.rows[0]!.pending_transaction_id);

  const again = await payPaymentLink(pool, app.acquirer, payConfig, { token, card: CARD, idempotencyKey: key });
  assert.equal(again.statusCode, 409);
  assert.equal(await capturedCount(merchantId), 1);
  const link = await pool.query<{ status: string; transaction_id: string }>(
    `SELECT status, transaction_id FROM payment_links WHERE id = $1`,
    [linkId],
  );
  assert.equal(link.rows[0]!.status, "paid");
  assert.equal(link.rows[0]!.transaction_id, body.transactionId);
});

test("another payer (different key) cannot take over a payment cut off past the bind", async () => {
  const { merchantId, linkId, token } = await linkForNewMerchant();
  await stopAfterBind(token, randomUUID());

  const other = await payPaymentLink(pool, app.acquirer, payConfig, { token, card: CARD, idempotencyKey: randomUUID() });
  assert.equal(other.statusCode, 409, JSON.stringify(other.body));
  assert.equal((other.body as { error: string }).error, "payment_link_processing");
  assert.equal(await capturedCount(merchantId), 0);
  const link = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [linkId]);
  assert.equal(link.rows[0]!.status, "reserved");
});

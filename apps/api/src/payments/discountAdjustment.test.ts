/**
 * H4: the negotiated discount is posted by captureTransaction itself, in the
 * capture's own DB transaction, so every capture path (merchant route,
 * payment link) gets it exactly once, and the ledger net fee equals the fee
 * settlement deducts from the payout (ComputeSettlementFee in
 * apps/settlement/internal/settlement/discounted_fee.go).
 * Requires DATABASE_URL (a real, migrated Postgres).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { createAcquirerSimulator } from "../acquirer/simulator.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { payPaymentLink } from "../paymentLinks/pay.js";
import { authorizeTransaction } from "./authorize.js";
import { captureTransaction } from "./capture.js";
import { netCaptureFeeFils } from "./discountAdjustment.js";
import { processRefund } from "./processRefund.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("discountAdjustment.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const acquirer = createAcquirerSimulator(config);
after(async () => {
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const DISCOUNT_DESC = "capture: negotiated discount adjustment";

async function discountedMerchant(mdrBps: number, discountBps: number) {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps) VALUES ($1, $2, $3) RETURNING id`,
    [`H4 Discount ${randomUUID()}`, mdrBps, discountBps],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "h4" });
  const k = await pool.query<{ id: string }>(`SELECT id FROM api_keys WHERE merchant_id = $1`, [merchantId]);
  return { merchantId, apiKeyId: k.rows[0]!.id };
}

/** Pays a fresh payment link through the real checkout code; returns the transaction id. */
async function payLink(merchantId: string, apiKeyId: string, amountFils: number): Promise<string> {
  const token = `h4-${randomUUID()}`;
  await pool.query(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, $3, now() + interval '1 day', 'merchant_api_key', $4)`,
    [merchantId, token, amountFils, apiKeyId],
  );
  const res = await payPaymentLink(pool, acquirer, config, { token, card: CARD, idempotencyKey: randomUUID() });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const row = await pool.query<{ transaction_id: string }>(`SELECT transaction_id FROM payment_links WHERE token = $1`, [
    token,
  ]);
  return row.rows[0]!.transaction_id;
}

async function legs(transactionId: string, description: string) {
  const r = await pool.query<{ account_id: string; direction: string; amount_fils: string }>(
    `SELECT account_id, direction, amount_fils FROM ledger_entries
      WHERE transaction_id = $1 AND description = $2 ORDER BY account_id`,
    [transactionId, description],
  );
  return r.rows.map((x) => ({ ...x, amount_fils: Number(x.amount_fils) }));
}

async function merchantPayableFor(transactionId: string): Promise<number> {
  const r = await pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS net
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'merchant_payable'`,
    [transactionId],
  );
  return Number(r.rows[0]!.net);
}

// The same rows as TestComputeSettlementFee in discounted_fee_test.go, plus
// the seed Alpha Retail case (275 bps MDR, 75 bps discount, 100.000 BD).
// The payout deducts exactly ComputeSettlementFee, so the ledger must too.
test("H4: the capture-time net fee equals settlement's ComputeSettlementFee", () => {
  const goTable: Array<[amount: number, mdr: number, disc: number, goFee: number]> = [
    [602, 275, 1250, 14],
    [100_000, 275, 1250, 2406],
    [4750, 250, 2000, 95],
    [50_000, 320, 10_000, 0],
    [0, 275, 1250, 0],
    [100_000, 275, 75, 2729],
  ];
  for (const [amount, mdr, disc, goFee] of goTable) {
    assert.equal(netCaptureFeeFils(toFils(amount), mdr, disc), goFee, `${amount} @ ${mdr}/${disc}`);
  }
});

test("H4: a payment-link capture posts the discount legs; payable = gross - net fee, so the payout zeroes it", async () => {
  const { merchantId, apiKeyId } = await discountedMerchant(275, 75);
  const txnId = await payLink(merchantId, apiKeyId, 100_000);

  // MDR 2,750; net fee 2,729 (ComputeSettlementFee); discount 21.
  assert.deepEqual(await legs(txnId, DISCOUNT_DESC), [
    { account_id: "merchant_payable", direction: "credit", amount_fils: 21 },
    { account_id: "platform_fee_revenue", direction: "debit", amount_fils: 21 },
  ]);
  const payable = await merchantPayableFor(txnId);
  assert.equal(payable, 100_000 - 2_729);
  // Settlement pays gross - ComputeSettlementFee for this event: nothing left over.
  assert.equal(payable - (100_000 - netCaptureFeeFils(toFils(100_000), 275, 75)), 0);
});

test("H4: a rounding case where fee-then-discount and discount-then-fee differ follows settlement", async () => {
  // 602 fils @ 275 bps / 1250 bps: settlement charges 14 (Go test table).
  // MDR fee is 17, so the discount legs must be 3, not round(17 * 12.5%) = 2.
  const { merchantId, apiKeyId } = await discountedMerchant(275, 1250);
  const txnId = await payLink(merchantId, apiKeyId, 602);

  assert.equal((await legs(txnId, DISCOUNT_DESC))[0]!.amount_fils, 3);
  assert.equal(await merchantPayableFor(txnId), 602 - 14);
});

test("H4: a replayed capture (same idempotency key) does not post the discount twice", async () => {
  const { merchantId } = await discountedMerchant(275, 75);
  const auth = await authorizeTransaction(pool, acquirer, {
    merchantId,
    amountFils: toFils(100_000),
    card: CARD,
    idempotencyKey: randomUUID(),
    actor: { type: "system" },
  });
  assert.equal(auth.statusCode, 201, JSON.stringify(auth.body));
  const transactionId = (auth.body as { id: string }).id;
  const key = randomUUID();
  const input = { transactionId, merchantId, idempotencyKey: key, actor: { type: "system" as const, id: merchantId } };

  const first = await captureTransaction(pool, acquirer, input);
  const replay = await captureTransaction(pool, acquirer, input);
  assert.equal(first.statusCode, 200);
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.body, first.body);

  assert.equal((await legs(transactionId, DISCOUNT_DESC)).length, 2);
  assert.equal(await merchantPayableFor(transactionId), 100_000 - 2_729);
});

test("H4: a full refund of a discounted link payment reverses exactly the net fee", async () => {
  const { merchantId, apiKeyId } = await discountedMerchant(275, 75);
  const txnId = await payLink(merchantId, apiKeyId, 100_000);

  const result = await processRefund(pool, acquirer, {
    transactionId: txnId,
    merchantId,
    idempotencyKey: randomUUID(),
    actor: { type: "merchant_api_key", id: apiKeyId },
  });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.equal((result.body as { feeReversedFils: number }).feeReversedFils, 2_729);
  assert.equal(await merchantPayableFor(txnId), 0);
});

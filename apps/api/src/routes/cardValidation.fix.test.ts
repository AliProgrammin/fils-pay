/**
 * The one card check the API adds to the original contract: an expired card
 * is declined by the bank (402 card_declined, declineReason card_expired),
 * on POST /v1/transactions and on the public payment-link pay route. Every
 * other card shape the original API accepted (a number failing Luhn, any
 * CVV, any expiry shape) is still accepted unchanged. Requires DATABASE_URL
 * (migrated Postgres).
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
if (!databaseUrl) throw new Error("cardValidation.fix.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
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

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

/** Year and month (1-12) on the Asia/Bahrain calendar, shifted by `deltaMonths`. */
function bahrainMonth(deltaMonths: number): { expiryMonth: number; expiryYear: number } {
  const now = new Date(Date.now() + 3 * 3_600_000);
  const index = now.getUTCFullYear() * 12 + now.getUTCMonth() + deltaMonths;
  return { expiryYear: Math.floor(index / 12), expiryMonth: (index % 12) + 1 };
}

async function merchantWithKey() {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Card Check Merchant ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "card-check" });
  return { merchantId, rawKey: issued.rawKey };
}

const merchant = merchantWithKey();

async function authorize(card: Record<string, unknown>) {
  const { rawKey } = await merchant;
  return app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils: 5_000, card },
  });
}

test("authorize: valid test cards keep their documented behaviour", async () => {
  assert.equal((await authorize(VALID_CARD)).statusCode, 201);
  assert.equal((await authorize({ ...VALID_CARD, pan: "4242 4242 4242 4242" })).statusCode, 201);
  assert.equal((await authorize({ ...VALID_CARD, cvv: "1234" })).statusCode, 201);
  assert.equal((await authorize({ ...VALID_CARD, ...bahrainMonth(0) })).statusCode, 201, "expires end of this month");

  const doNotHonor = await authorize({ ...VALID_CARD, pan: "4000000000000002" });
  assert.equal(doNotHonor.statusCode, 402);
  assert.equal(doNotHonor.json().declineReason, "do_not_honor");
  const noFunds = await authorize({ ...VALID_CARD, pan: "4000000000000119" });
  assert.equal(noFunds.statusCode, 402);
  assert.equal(noFunds.json().declineReason, "insufficient_funds");
  const error = await authorize({ ...VALID_CARD, pan: "4000000000000069" });
  assert.equal(error.statusCode, 502);
  assert.equal(error.json().error, "acquirer_unavailable");
});

test("authorize: a card that expired before the current month is declined as card_expired", async () => {
  const res = await authorize({ ...VALID_CARD, ...bahrainMonth(-1) });
  assert.equal(res.statusCode, 402, res.body);
  assert.equal(res.json().error, "card_declined");
  assert.equal(res.json().declineReason, "card_expired");
  assert.equal(typeof res.json().acquirerReference, "string");

  const old = await authorize({ ...VALID_CARD, expiryMonth: 12, expiryYear: 2020 });
  assert.equal(old.statusCode, 402, old.body);
  assert.equal(old.json().declineReason, "card_expired");
});

test("authorize: a 2-digit expiry year means 20YY", async () => {
  const future = await authorize({ ...VALID_CARD, expiryMonth: 12, expiryYear: 99 });
  assert.equal(future.statusCode, 201, future.body);
  const past = await authorize({ ...VALID_CARD, expiryMonth: 12, expiryYear: 20 });
  assert.equal(past.statusCode, 402, past.body);
  assert.equal(past.json().declineReason, "card_expired");
});

test("authorize: magic test cards keep their outcome even when expired", async () => {
  const expired = { expiryMonth: 12, expiryYear: 2020 };
  const doNotHonor = await authorize({ ...VALID_CARD, ...expired, pan: "4000000000000002" });
  assert.equal(doNotHonor.json().declineReason, "do_not_honor");
  const error = await authorize({ ...VALID_CARD, ...expired, pan: "4000000000000069" });
  assert.equal(error.statusCode, 502);
});

test("authorize: card shapes the original API accepted are still approved", async () => {
  const cards: Record<string, unknown>[] = [
    { ...VALID_CARD, pan: "4000000000000000" }, // fails Luhn
    { ...VALID_CARD, pan: "4242424242424241" }, // fails Luhn
    { ...VALID_CARD, pan: "42" },
    { ...VALID_CARD, pan: "4242abcd42424242" },
    { ...VALID_CARD, cvv: "1" },
    { ...VALID_CARD, cvv: "12345" },
    { ...VALID_CARD, cvv: undefined },
    { ...VALID_CARD, expiryMonth: 0 },
    { ...VALID_CARD, expiryMonth: 13 },
    { ...VALID_CARD, expiryMonth: "12" },
    { ...VALID_CARD, expiryYear: undefined },
    { pan: "4242424242424242" },
  ];
  for (const card of cards) {
    const res = await authorize(card);
    assert.equal(res.statusCode, 201, `${JSON.stringify(card)}: ${res.body}`);
    assert.equal(res.json().status, "authorized");
  }
});

test("authorize: a non-string pan is still invalid_request (H10)", async () => {
  const res = await authorize({ ...VALID_CARD, pan: 4242424242424242 });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "invalid_request");
});

async function createLink() {
  const { merchantId, rawKey } = await merchant;
  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/payment-links`,
    headers: { authorization: `Bearer ${rawKey}` },
    payload: { amountFils: 4_750, reference: "card-check", expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; token: string };
}

function pay(token: string, card: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/v1/payment-links/${token}/pay`,
    headers: { "idempotency-key": randomUUID() },
    payload: { card },
  });
}

test("payment-link pay: an expired card fails cleanly and the link stays payable", async () => {
  const link = await createLink();

  const expired = await pay(link.token, { ...VALID_CARD, ...bahrainMonth(-1) });
  assert.equal(expired.statusCode, 402, expired.body);
  assert.equal(expired.json().stage, "authorize");
  assert.equal(expired.json().error, "card_declined");
  assert.equal(expired.json().declineReason, "card_expired");

  const row = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [link.id]);
  assert.equal(row.rows[0]!.status, "active");

  const ok = await pay(link.token, VALID_CARD);
  assert.equal(ok.statusCode, 200, ok.body);
});

test("payment-link pay: a Luhn-failing number with a future expiry is approved, as originally", async () => {
  const link = await createLink();
  const res = await pay(link.token, { ...VALID_CARD, pan: "4000000000000000", cvv: "1" });
  assert.equal(res.statusCode, 200, res.body);
});

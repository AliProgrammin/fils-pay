/**
 * Card checks a real acquirer makes: an expired card is declined by the bank
 * (402 card_declined, declineReason card_expired); a card number that fails
 * the Luhn check or a CVV that is not 3-4 digits is malformed input
 * (400 invalid_request), on POST /v1/transactions and on the public
 * payment-link pay route. Requires DATABASE_URL (migrated Postgres).
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

test("authorize: a CVV that is not 3-4 digits is rejected as invalid_request", async () => {
  for (const cvv of ["12", "12345", "12a", "", undefined]) {
    const res = await authorize({ ...VALID_CARD, cvv });
    assert.equal(res.statusCode, 400, `cvv ${String(cvv)}: ${res.body}`);
    assert.equal(res.json().error, "invalid_request");
  }
});

test("authorize: a card number failing the Luhn check is rejected as invalid_request", async () => {
  for (const pan of ["4242424242424241", "4000000000000001", "1234567812345678", "4242abcd42424242", "42"]) {
    const res = await authorize({ ...VALID_CARD, pan });
    assert.equal(res.statusCode, 400, `pan ${pan}: ${res.body}`);
    assert.equal(res.json().error, "invalid_request");
  }
});

test("authorize: an expiry month outside 1-12 is rejected as invalid_request", async () => {
  for (const expiryMonth of [0, 13, 1.5, "12"]) {
    const res = await authorize({ ...VALID_CARD, expiryMonth });
    assert.equal(res.statusCode, 400, `month ${String(expiryMonth)}: ${res.body}`);
    assert.equal(res.json().error, "invalid_request");
  }
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

test("payment-link pay: bad cards fail cleanly and the link stays payable", async () => {
  const link = await createLink();

  const expired = await pay(link.token, { ...VALID_CARD, ...bahrainMonth(-1) });
  assert.equal(expired.statusCode, 402, expired.body);
  assert.equal(expired.json().stage, "authorize");
  assert.equal(expired.json().error, "card_declined");
  assert.equal(expired.json().declineReason, "card_expired");

  const badCvv = await pay(link.token, { ...VALID_CARD, cvv: "1" });
  assert.equal(badCvv.statusCode, 400, badCvv.body);
  assert.equal(badCvv.json().error, "invalid_request");

  const badLuhn = await pay(link.token, { ...VALID_CARD, pan: "4242424242424241" });
  assert.equal(badLuhn.statusCode, 400, badLuhn.body);
  assert.equal(badLuhn.json().error, "invalid_request");

  const row = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [link.id]);
  assert.equal(row.rows[0]!.status, "active");

  const ok = await pay(link.token, VALID_CARD);
  assert.equal(ok.statusCode, 200, ok.body);
});

/**
 * Route tests for POST /v1/merchants/:merchantId/refunds and POST /v1/refunds
 * against a real, migrated Postgres. Requires `DATABASE_URL`.
 *
 * Covers: auth, role, idempotency header, body validation, merchant scope,
 * refunds_enabled, the ledger (every fil), the timeline and the outbox event.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("refunds.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

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

async function createMerchant(label: string, opts: { refundsEnabled?: boolean | null; discountBps?: number } = {}) {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps) VALUES ($1, 250, $2) RETURNING id`,
    [`Refund Route ${label} ${randomUUID()}`, opts.discountBps ?? 0],
  );
  const merchantId = merchantResult.rows[0]!.id;
  const userResult = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  if (opts.refundsEnabled !== undefined) {
    await pool.query(`UPDATE merchants SET refunds_enabled = $2 WHERE id = $1`, [merchantId, opts.refundsEnabled]);
  }
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: userResult.rows[0]!.id, label });
  return { merchantId, rawKey: issued.rawKey };
}

async function sessionCookie(merchantId: string, role: "owner" | "finance" | "support"): Promise<string> {
  const userResult = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, $3, 'unused-in-these-tests') RETURNING id`,
    [merchantId, `${role}-${randomUUID()}@example.test`, role],
  );
  const rawToken = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at)
     VALUES ($1, $2, true, now() + interval '1 hour')`,
    [userResult.rows[0]!.id, sha256Hex(rawToken)],
  );
  return `${config.cookieName}=${rawToken}`;
}

async function impersonationCookie(merchantId: string): Promise<string> {
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'unused', 'Test super admin', 'super_admin') RETURNING id`,
    [`admin-${randomUUID()}@example.test`],
  );
  const rawToken = randomToken(32);
  await pool.query(
    `INSERT INTO admin_impersonation_grants (admin_user_id, merchant_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 hour')`,
    [admin.rows[0]!.id, merchantId, sha256Hex(rawToken)],
  );
  return `${config.impersonationCookieName}=${rawToken}`;
}

async function capturedTxn(rawKey: string, amountFils: number, captureFils?: number): Promise<string> {
  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils, card: VALID_CARD, reference: "refund-route" },
  });
  assert.equal(auth.statusCode, 201, auth.body);
  const id = (auth.json() as { id: string }).id;
  const cap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: captureFils === undefined ? {} : { amountFils: captureFils },
  });
  assert.equal(cap.statusCode, 200, cap.body);
  return id;
}

function refund(
  merchantId: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  idempotencyKey: string | null = randomUUID(),
) {
  return app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/refunds`,
    headers: idempotencyKey === null ? headers : { ...headers, "idempotency-key": idempotencyKey },
    payload,
  });
}

const bearer = (rawKey: string) => ({ authorization: `Bearer ${rawKey}` });

/** Net (credit - debit) per account for one transaction, plus totals. */
async function ledgerFor(transactionId: string) {
  const rows = await pool.query<{ account_id: string; net: string }>(
    `SELECT account_id, SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END)::text AS net
       FROM ledger_entries WHERE transaction_id = $1 GROUP BY account_id`,
    [transactionId],
  );
  const totals = await pool.query<{ debits: string; credits: string; unbalanced_groups: number }>(
    `SELECT COALESCE(SUM(amount_fils) FILTER (WHERE direction = 'debit'), 0)::text AS debits,
            COALESCE(SUM(amount_fils) FILTER (WHERE direction = 'credit'), 0)::text AS credits,
            (SELECT COUNT(*)::int FROM (
               SELECT entry_group_id FROM ledger_entries WHERE transaction_id = $1
                GROUP BY entry_group_id
               HAVING SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END) <> 0) g
            ) AS unbalanced_groups
       FROM ledger_entries WHERE transaction_id = $1`,
    [transactionId],
  );
  const net = new Map(rows.rows.map((r) => [r.account_id, Number(r.net)]));
  return {
    merchantPayable: net.get("merchant_payable") ?? 0,
    schemeClearing: net.get("card_scheme_clearing") ?? 0,
    feeRevenue: net.get("platform_fee_revenue") ?? 0,
    debits: Number(totals.rows[0]!.debits),
    credits: Number(totals.rows[0]!.credits),
    unbalancedGroups: totals.rows[0]!.unbalanced_groups,
  };
}

// ---------------------------------------------------------------- access

test("an owner session can refund; the response carries the refund", async () => {
  const m = await createMerchant("owner");
  const txnId = await capturedTxn(m.rawKey, 10_000);
  const res = await refund(m.merchantId, { cookie: await sessionCookie(m.merchantId, "owner") }, {
    transactionId: txnId,
    amountFils: 4_000,
    reason: "customer_request",
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { amountFils: number; transactionStatus: string; refundedTotalFils: number; feeReversedFils: number };
  assert.equal(body.amountFils, 4_000);
  assert.equal(body.transactionStatus, "partially_refunded");
  assert.equal(body.refundedTotalFils, 4_000);
  assert.equal(body.feeReversedFils, 100);
});

test("a finance session can refund", async () => {
  const m = await createMerchant("finance");
  const txnId = await capturedTxn(m.rawKey, 5_000);
  const res = await refund(m.merchantId, { cookie: await sessionCookie(m.merchantId, "finance") }, {
    transactionId: txnId,
    amountFils: 5_000,
    reason: "damaged",
  });
  assert.equal(res.statusCode, 200, res.body);
});

test("a support session is forbidden", async () => {
  const m = await createMerchant("support");
  const txnId = await capturedTxn(m.rawKey, 5_000);
  const res = await refund(m.merchantId, { cookie: await sessionCookie(m.merchantId, "support") }, {
    transactionId: txnId,
    amountFils: 5_000,
    reason: "x",
  });
  assert.equal(res.statusCode, 403, res.body);
});

test("an admin impersonating the merchant (even super_admin) is forbidden", async () => {
  const m = await createMerchant("impersonation");
  const txnId = await capturedTxn(m.rawKey, 5_000);
  const res = await refund(m.merchantId, { cookie: await impersonationCookie(m.merchantId) }, {
    transactionId: txnId,
    amountFils: 5_000,
    reason: "x",
  });
  assert.equal(res.statusCode, 403, res.body);
  const refunds = await pool.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM refunds WHERE transaction_id = $1`, [txnId]);
  assert.equal(refunds.rows[0]!.c, 0);
});

test("no credentials is 401", async () => {
  const res = await refund(randomUUID(), {}, { transactionId: randomUUID(), amountFils: 1, reason: "x" });
  assert.equal(res.statusCode, 401, res.body);
});

test("a path merchant that is not the caller is 403", async () => {
  const m = await createMerchant("path-scope");
  const other = await createMerchant("path-scope-other");
  const txnId = await capturedTxn(m.rawKey, 5_000);
  const res = await refund(other.merchantId, bearer(m.rawKey), { transactionId: txnId, amountFils: 1_000, reason: "x" });
  assert.equal(res.statusCode, 403, res.body);
});

test("another merchant's transaction id is 404 and is not refunded", async () => {
  const owner = await createMerchant("victim");
  const attacker = await createMerchant("attacker");
  const txnId = await capturedTxn(owner.rawKey, 5_000);
  const res = await refund(attacker.merchantId, bearer(attacker.rawKey), {
    transactionId: txnId,
    amountFils: 5_000,
    reason: "x",
  });
  assert.equal(res.statusCode, 404, res.body);
  const row = await pool.query<{ refunded_fils: string }>(`SELECT refunded_fils FROM transactions WHERE id = $1`, [txnId]);
  assert.equal(Number(row.rows[0]!.refunded_fils), 0);
});

test("refunds_enabled false (on hold) is 403 refunds_on_hold", async () => {
  const m = await createMerchant("on-hold", { refundsEnabled: false });
  const txnId = await capturedTxn(m.rawKey, 5_000);
  const res = await refund(m.merchantId, bearer(m.rawKey), { transactionId: txnId, amountFils: 5_000, reason: "x" });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().error, "refunds_on_hold");
});

test("refunds_enabled NULL or true (no hold) lets the refund through", async () => {
  for (const flag of [null, true]) {
    const m = await createMerchant(`no-hold-${String(flag)}`, { refundsEnabled: flag });
    const txnId = await capturedTxn(m.rawKey, 5_000);
    const res = await refund(m.merchantId, bearer(m.rawKey), { transactionId: txnId, amountFils: 5_000, reason: "x" });
    assert.equal(res.statusCode, 200, res.body);
  }
});

// ---------------------------------------------------------------- input

test("a missing Idempotency-Key is 400 and nothing is refunded", async () => {
  const m = await createMerchant("no-key");
  const txnId = await capturedTxn(m.rawKey, 5_000);
  const res = await refund(m.merchantId, bearer(m.rawKey), { transactionId: txnId, amountFils: 5_000, reason: "x" }, null);
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "idempotency_key_required");
  const refunds = await pool.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM refunds WHERE transaction_id = $1`, [txnId]);
  assert.equal(refunds.rows[0]!.c, 0);
});

test("amountFils must be a positive integer number of fils", async () => {
  const m = await createMerchant("bad-amount");
  const txnId = await capturedTxn(m.rawKey, 5_000);
  for (const amountFils of [undefined, 0, -1, 1.5, "1000", "1.000", null]) {
    const res = await refund(m.merchantId, bearer(m.rawKey), { transactionId: txnId, amountFils, reason: "x" });
    assert.equal(res.statusCode, 400, `amountFils=${JSON.stringify(amountFils)}: ${res.body}`);
    assert.equal(res.json().error, "invalid_amount");
  }
});

test("a reason is required", async () => {
  const m = await createMerchant("no-reason");
  const txnId = await capturedTxn(m.rawKey, 5_000);
  for (const reason of [undefined, "", "   ", 42]) {
    const res = await refund(m.merchantId, bearer(m.rawKey), { transactionId: txnId, amountFils: 1_000, reason });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error, "reason_required");
  }
});

test("a malformed transactionId is 400, not 500", async () => {
  const m = await createMerchant("bad-txn-id");
  const res = await refund(m.merchantId, bearer(m.rawKey), { transactionId: "nope", amountFils: 1_000, reason: "x" });
  assert.equal(res.statusCode, 400, res.body);
});

test("refunding 1 fil more than what is left is 422 with the refundable amount", async () => {
  const m = await createMerchant("over");
  const txnId = await capturedTxn(m.rawKey, 10_000);
  const first = await refund(m.merchantId, bearer(m.rawKey), { transactionId: txnId, amountFils: 6_000, reason: "x" });
  assert.equal(first.statusCode, 200, first.body);
  const over = await refund(m.merchantId, bearer(m.rawKey), { transactionId: txnId, amountFils: 4_001, reason: "x" });
  assert.equal(over.statusCode, 422, over.body);
  assert.deepEqual(over.json(), { ok: false, code: "refund_exceeds_refundable", refundableFils: 4_000 });
});

test("the same Idempotency-Key replays the first answer and refunds once", async () => {
  const m = await createMerchant("replay");
  const txnId = await capturedTxn(m.rawKey, 10_000);
  const key = randomUUID();
  const payload = { transactionId: txnId, amountFils: 3_000, reason: "x" };
  const a = await refund(m.merchantId, bearer(m.rawKey), payload, key);
  const b = await refund(m.merchantId, bearer(m.rawKey), payload, key);
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(b.statusCode, 200, b.body);
  assert.deepEqual(b.json(), a.json());
  const row = await pool.query<{ refunded_fils: string }>(`SELECT refunded_fils FROM transactions WHERE id = $1`, [txnId]);
  assert.equal(Number(row.rows[0]!.refunded_fils), 3_000);
});

test("two concurrent full refunds through the route: exactly one succeeds", async () => {
  const m = await createMerchant("race");
  const txnId = await capturedTxn(m.rawKey, 10_000);
  const results = await Promise.all(
    [0, 1].map(() => refund(m.merchantId, bearer(m.rawKey), { transactionId: txnId, amountFils: 10_000, reason: "x" })),
  );
  assert.equal(results.filter((r) => r.statusCode === 200).length, 1, results.map((r) => r.body).join(" | "));
  const row = await pool.query<{ refunded_fils: string }>(`SELECT refunded_fils FROM transactions WHERE id = $1`, [txnId]);
  assert.equal(Number(row.rows[0]!.refunded_fils), 10_000);
});

test("POST /v1/refunds (API-key integrations) uses the same handler", async () => {
  const m = await createMerchant("flat-path");
  const txnId = await capturedTxn(m.rawKey, 2_000);
  const res = await app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { ...bearer(m.rawKey), "idempotency-key": randomUUID() },
    payload: { transactionId: txnId, amountFils: 2_000, reason: "x" },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().transactionStatus, "refunded");
});

// ---------------------------------------------------------------- money

test("ledger: partial + final refund nets every account to 0 for the transaction, to the fil", async () => {
  const m = await createMerchant("ledger-partials", { discountBps: 2000 });
  const txnId = await capturedTxn(m.rawKey, 10_007);
  const before = await ledgerFor(txnId);
  assert.ok(before.merchantPayable > 0);
  const fee = before.feeRevenue;

  const r1 = await refund(m.merchantId, bearer(m.rawKey), { transactionId: txnId, amountFils: 3_333, reason: "x" });
  assert.equal(r1.statusCode, 200, r1.body);
  const mid = await ledgerFor(txnId);
  const r1Body = r1.json() as { feeReversedFils: number };
  assert.equal(mid.merchantPayable, before.merchantPayable - 3_333 + r1Body.feeReversedFils);
  assert.equal(mid.schemeClearing, -10_007 + 3_333);

  const r2 = await refund(m.merchantId, bearer(m.rawKey), { transactionId: txnId, amountFils: 6_674, reason: "x" });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.equal(r2.json().transactionStatus, "refunded");

  const after = await ledgerFor(txnId);
  assert.equal(after.merchantPayable, 0, "merchant payable for this payment is exactly 0");
  assert.equal(after.schemeClearing, 0, "all captured money went back through the scheme");
  assert.equal(after.feeRevenue, 0, "the whole net fee was reversed");
  assert.equal(after.debits, after.credits);
  assert.equal(after.unbalancedGroups, 0);

  const reversed = await pool.query<{ total: string }>(
    `SELECT SUM(fee_reversed_fils)::text AS total FROM refunds WHERE transaction_id = $1`,
    [txnId],
  );
  assert.equal(Number(reversed.rows[0]!.total), fee);
});

test("ledger: a single full refund nets every account to 0 for the transaction", async () => {
  const m = await createMerchant("ledger-full");
  const txnId = await capturedTxn(m.rawKey, 12_345);
  const res = await refund(m.merchantId, bearer(m.rawKey), { transactionId: txnId, amountFils: 12_345, reason: "x" });
  assert.equal(res.statusCode, 200, res.body);
  const after = await ledgerFor(txnId);
  assert.equal(after.merchantPayable, 0);
  assert.equal(after.schemeClearing, 0);
  assert.equal(after.feeRevenue, 0);
  assert.equal(after.debits, after.credits);
  assert.equal(after.unbalancedGroups, 0);
});

// ---------------------------------------------------------------- timeline + outbox

test("timeline and detail show the refunds in order with correct amounts and refundedFils", async () => {
  const m = await createMerchant("timeline");
  const txnId = await capturedTxn(m.rawKey, 10_000);
  await refund(m.merchantId, bearer(m.rawKey), { transactionId: txnId, amountFils: 2_500, reason: "x" });
  await refund(m.merchantId, bearer(m.rawKey), { transactionId: txnId, amountFils: 7_500, reason: "x" });

  const events = await app.inject({ method: "GET", url: `/v1/transactions/${txnId}/events`, headers: bearer(m.rawKey) });
  assert.equal(events.statusCode, 200, events.body);
  const list = events.json() as Array<{ eventType: string; amountFils: number | null }>;
  assert.deepEqual(
    list.map((e) => [e.eventType, e.amountFils]),
    [
      ["authorized", null],
      ["captured", 10_000],
      ["refund_partial", -2_500],
      ["refunded", -7_500],
    ],
  );

  const detail = await app.inject({ method: "GET", url: `/v1/transactions/${txnId}`, headers: bearer(m.rawKey) });
  assert.equal(detail.statusCode, 200, detail.body);
  const dto = detail.json() as { status: string; capturedFils: number; refundedFils: number };
  assert.equal(dto.status, "refunded");
  assert.equal(dto.refundedFils, 10_000);
});

test("each refund enqueues exactly one refund.succeeded outbox event with the full payload", async () => {
  const m = await createMerchant("outbox");
  const txnId = await capturedTxn(m.rawKey, 10_000);
  const r1 = await refund(m.merchantId, bearer(m.rawKey), { transactionId: txnId, amountFils: 4_000, reason: "x" });
  const r2 = await refund(m.merchantId, bearer(m.rawKey), { transactionId: txnId, amountFils: 6_000, reason: "x" });
  const events = await pool.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'refund.succeeded' ORDER BY id`,
    [txnId],
  );
  assert.equal(events.rows.length, 2);
  const b1 = r1.json() as { id: string; feeReversedFils: number };
  const b2 = r2.json() as { id: string; feeReversedFils: number };
  assert.deepEqual(events.rows[0]!.payload, {
    merchantId: m.merchantId,
    transactionId: txnId,
    refundId: b1.id,
    amountFils: 4_000,
    feeReversedFils: b1.feeReversedFils,
    refundedTotalFils: 4_000,
    newStatus: "partially_refunded",
  });
  assert.deepEqual(events.rows[1]!.payload, {
    merchantId: m.merchantId,
    transactionId: txnId,
    refundId: b2.id,
    amountFils: 6_000,
    feeReversedFils: b2.feeReversedFils,
    refundedTotalFils: 10_000,
    newStatus: "refunded",
  });
});

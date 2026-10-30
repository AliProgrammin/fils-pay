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
import { payPaymentLink } from "../paymentLinks/pay.js";
import type { AcquirerSimulator } from "../acquirer/types.js";

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

// ---- Incident 2026-05-14: one link charged twice after the reservation timeout ----

/** Wraps the app's acquirer; the first call of `stage` waits until released. */
function gatedAcquirer(stage: "authorize" | "capture") {
  let reached!: () => void;
  let release!: () => void;
  const reachedP = new Promise<void>((r) => (reached = r));
  const releaseP = new Promise<void>((r) => (release = r));
  let used = false;
  const inner = app.acquirer;
  const acquirer: AcquirerSimulator = {
    authorize: async (req) => {
      if (stage === "authorize" && !used) {
        used = true;
        reached();
        await releaseP;
      }
      return inner.authorize(req);
    },
    capture: async (req) => {
      if (stage === "capture" && !used) {
        used = true;
        reached();
        await releaseP;
      }
      return inner.capture(req);
    },
    refund: (req) => inner.refund(req),
  };
  return { acquirer, reachedP, release };
}

const payConfig = { paymentLinkReservationTimeoutSeconds: 60 };

async function capturedTxnCount(merchantId: string): Promise<number> {
  const r = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM transactions WHERE merchant_id = $1 AND captured_fils > 0`,
    [merchantId],
  );
  return Number(r.rows[0]!.c);
}

function payInput(token: string) {
  return { token, card: APPROVED_CARD, idempotencyKey: randomUUID() };
}

test("2026-05-14: a slow capture past the reservation timeout cannot be overtaken by a second payer", async () => {
  const { merchantId, rawKey } = await merchantWithKey("slow-capture");
  const link = await createLink(rawKey, merchantId);
  const gate = gatedAcquirer("capture");

  const first = payPaymentLink(pool, gate.acquirer, payConfig, payInput(link.token));
  await gate.reachedP;
  // The first payer's capture is still running when the 60 s timeout passes.
  await pool.query(`UPDATE payment_links SET reserved_at = now() - interval '2 minutes' WHERE id = $1`, [link.id]);

  const second = await payPaymentLink(pool, app.acquirer, payConfig, payInput(link.token));
  const readWhileInFlight = await app.inject({ method: "GET", url: `/v1/payment-links/${link.token}` });
  gate.release();
  const firstResult = await first;

  assert.equal(readWhileInFlight.json().status, "processing");

  assert.equal(second.statusCode, 409, JSON.stringify(second.body));
  assert.equal(firstResult.statusCode, 200, JSON.stringify(firstResult.body));
  assert.equal(await capturedTxnCount(merchantId), 1);
  const row = await pool.query<{ status: string; transaction_id: string }>(
    `SELECT status, transaction_id FROM payment_links WHERE id = $1`,
    [link.id],
  );
  assert.equal(row.rows[0]!.status, "paid");
  assert.equal(row.rows[0]!.transaction_id, (firstResult.body as { transactionId: string }).transactionId);
});

test("2026-05-14: a payer who lost the reservation during a slow authorize is voided and gets 409, not 200", async () => {
  const { merchantId, rawKey } = await merchantWithKey("slow-authorize");
  const link = await createLink(rawKey, merchantId);
  const gate = gatedAcquirer("authorize");

  const first = payPaymentLink(pool, gate.acquirer, payConfig, payInput(link.token));
  await gate.reachedP;
  await pool.query(`UPDATE payment_links SET reserved_at = now() - interval '2 minutes' WHERE id = $1`, [link.id]);

  // A second payer re-claims the timed-out reservation and pays.
  const second = await payPaymentLink(pool, app.acquirer, payConfig, payInput(link.token));
  assert.equal(second.statusCode, 200, JSON.stringify(second.body));

  gate.release();
  const firstResult = await first;
  assert.equal(firstResult.statusCode, 409, JSON.stringify(firstResult.body));

  assert.equal(await capturedTxnCount(merchantId), 1);
  const voided = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM transactions WHERE merchant_id = $1 AND status = 'voided'`,
    [merchantId],
  );
  assert.equal(Number(voided.rows[0]!.c), 1);
  const row = await pool.query<{ transaction_id: string }>(`SELECT transaction_id FROM payment_links WHERE id = $1`, [
    link.id,
  ]);
  assert.equal(row.rows[0]!.transaction_id, (second.body as { transactionId: string }).transactionId);
});

// ---- B5: cross-merchant cancel (IDOR) ----

test("B5: merchant B cannot cancel merchant A's payment link (404, link stays active)", async () => {
  const a = await merchantWithKey("idor-victim");
  const b = await merchantWithKey("idor-attacker");
  const link = await createLink(a.rawKey, a.merchantId);

  const res = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${b.merchantId}/payment-links/${link.id}`,
    headers: { authorization: `Bearer ${b.rawKey}` },
  });

  assert.equal(res.statusCode, 404, res.body);
  const row = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [link.id]);
  assert.equal(row.rows[0]!.status, "active");
});

// W7: a capture decline after a good authorize left the authorization
// 'authorized' (and its hold active) with nothing to void it.
test("W7: a declined capture voids the link's authorization and frees the link", async () => {
  const { merchantId, rawKey } = await merchantWithKey("capture-decline");
  const link = await createLink(rawKey, merchantId);
  const inner = app.acquirer;
  const declining: AcquirerSimulator = {
    authorize: (req) => inner.authorize(req),
    capture: async (req) => ({ outcome: "declined", acquirerReference: req.acquirerReference, latencyMs: 0 }),
    refund: (req) => inner.refund(req),
  };

  const result = await payPaymentLink(pool, declining, payConfig, payInput(link.token));
  assert.equal(result.statusCode, 402, JSON.stringify(result.body));
  assert.deepEqual(result.body, { stage: "capture", error: "card_captured_declined" });

  const txns = await pool.query<{ status: string; holds: string }>(
    `SELECT t.status,
            (SELECT count(*) FROM holds h WHERE h.transaction_id = t.id AND h.status = 'active')::text AS holds
       FROM transactions t WHERE t.merchant_id = $1`,
    [merchantId],
  );
  assert.deepEqual(txns.rows, [{ status: "voided", holds: "0" }]);
  const row = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [link.id]);
  assert.equal(row.rows[0]!.status, "active");

  const retry = await payPaymentLink(pool, inner, payConfig, payInput(link.token));
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
});

// W9: a bad amount keeps its 400 but never leaks toFils' internal text.
test("W9: payment-link create with a bad amount gives a clean 400 message", async () => {
  const { merchantId, rawKey } = await merchantWithKey("bad-amount");
  for (const amountFils of [-100, "100", 10.5, null, 1e20]) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/merchants/${merchantId}/payment-links`,
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { amountFils, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    assert.equal(res.statusCode, 400, `${String(amountFils)}: ${res.body}`);
    assert.equal(res.json().error, "invalid_amount");
    assert.doesNotMatch(res.body, /toFils|allowNegative/, res.body);
  }
});

// W10: no length limits on reference or Idempotency-Key.
test("W10: an over-long reference or Idempotency-Key is 400 invalid_request", async () => {
  const { merchantId, rawKey } = await merchantWithKey("long-input");
  const create = (reference: string) =>
    app.inject({
      method: "POST",
      url: `/v1/merchants/${merchantId}/payment-links`,
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { amountFils: 1_000, reference, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
  assert.equal((await create("r".repeat(255))).statusCode, 201);
  const longRef = await create("r".repeat(10_000));
  assert.equal(longRef.statusCode, 400, longRef.body);
  assert.equal(longRef.json().error, "invalid_request");

  const link = await createLink(rawKey, merchantId);
  const longKey = await app.inject({
    method: "POST",
    url: `/v1/payment-links/${link.token}/pay`,
    headers: { "idempotency-key": "k".repeat(5_000) },
    payload: { card: APPROVED_CARD },
  });
  assert.equal(longKey.statusCode, 400, longKey.body);
  assert.equal(longKey.json().error, "invalid_request");

  const longCaptureKey = await app.inject({
    method: "POST",
    url: `/v1/transactions/${randomUUID()}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": "k".repeat(256) },
    payload: {},
  });
  assert.equal(longCaptureKey.statusCode, 400, longCaptureKey.body);
  assert.equal(longCaptureKey.json().error, "invalid_request");
});

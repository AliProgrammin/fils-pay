/**
 * L5: a payment link cut off by a crash past the bind stays 'reserved'
 * forever. The recovery sweep finalizes a captured one, voids and releases an
 * authorized one after the grace period, and never touches a fresh one.
 * Requires DATABASE_URL (migrated Postgres).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { captureTransaction } from "../payments/capture.js";
import { voidTransaction } from "../payments/void.js";
import { payPaymentLink } from "./pay.js";
import { runPaymentLinkRecoveryPass } from "./recovery.js";
import type { AcquirerSimulator } from "../acquirer/types.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("recovery.test.ts requires DATABASE_URL");

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
const sweepConfig = { graceSeconds: 300 };

interface Link {
  merchantId: string;
  linkId: string;
  token: string;
}

async function linkForNewMerchant(): Promise<Link> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Recovery Merchant ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "recovery" });
  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/payment-links`,
    headers: { authorization: `Bearer ${rawKey}` },
    payload: { amountFils: 4_750, reference: "recovery", expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
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

/** Pay until the authorization is bound, then "crash". Returns the bound transaction id. */
async function stopAfterBind(link: Link, idempotencyKey: string): Promise<string> {
  await assert.rejects(
    payPaymentLink(pool, captureCrashes(), payConfig, { token: link.token, card: CARD, idempotencyKey }),
  );
  const r = await pool.query<{ pending_transaction_id: string }>(
    `SELECT pending_transaction_id FROM payment_links WHERE id = $1 AND status = 'reserved'`,
    [link.linkId],
  );
  assert.ok(r.rows[0]?.pending_transaction_id, "link must be reserved with a bound authorization");
  return r.rows[0].pending_transaction_id;
}

/** Make the reservation look as old as a crash long ago would leave it. */
async function ageReservation(linkId: string, seconds: number): Promise<void> {
  await pool.query(`UPDATE payment_links SET reserved_at = now() - ($2 || ' seconds')::interval WHERE id = $1`, [
    linkId,
    seconds,
  ]);
}

async function linkRow(linkId: string) {
  const r = await pool.query<{
    status: string;
    reserved_at: Date | null;
    pending_transaction_id: string | null;
    transaction_id: string | null;
    paid_at: Date | null;
  }>(`SELECT status, reserved_at, pending_transaction_id, transaction_id, paid_at FROM payment_links WHERE id = $1`, [
    linkId,
  ]);
  return r.rows[0]!;
}

async function txnState(txnId: string) {
  const r = await pool.query<{ status: string; holds: string; voided_events: string; voided_outbox: string }>(
    `SELECT t.status,
            (SELECT count(*) FROM holds h WHERE h.transaction_id = t.id AND h.status = 'active')::text AS holds,
            (SELECT count(*) FROM transaction_events e
              WHERE e.transaction_id = t.id AND e.event_type = 'voided')::text AS voided_events,
            (SELECT count(*) FROM outbox_events o
              WHERE o.aggregate_id = t.id AND o.event_type = 'transaction.voided')::text AS voided_outbox
       FROM transactions t WHERE t.id = $1`,
    [txnId],
  );
  const row = r.rows[0]!;
  return {
    status: row.status,
    activeHolds: Number(row.holds),
    voidedEvents: Number(row.voided_events),
    voidedOutbox: Number(row.voided_outbox),
  };
}

test("a link whose bound payment was captured before the crash is marked paid", async () => {
  const link = await linkForNewMerchant();
  const key = randomUUID();
  const txnId = await stopAfterBind(link, key);
  // The capture ran (same key the pay flow uses), then the process died
  // before the finalize step.
  const cap = await captureTransaction(pool, app.acquirer, {
    transactionId: txnId,
    merchantId: link.merchantId,
    idempotencyKey: `paylink:${link.linkId}:${key}:capture`,
    actor: { type: "system", id: link.linkId },
  });
  assert.equal(cap.statusCode, 200, JSON.stringify(cap.body));
  assert.equal((await linkRow(link.linkId)).status, "reserved");

  await runPaymentLinkRecoveryPass(pool, sweepConfig);

  const row = await linkRow(link.linkId);
  assert.equal(row.status, "paid");
  assert.equal(row.transaction_id, txnId);
  assert.ok(row.paid_at);
  assert.equal(row.reserved_at, null);
  assert.equal(row.pending_transaction_id, null);
  assert.equal((await txnState(txnId)).status, "captured");

  // The checkout page now reports it paid; a new pay attempt is refused.
  const read = await app.inject({ method: "GET", url: `/v1/payment-links/${link.token}` });
  assert.equal((read.json() as { status: string }).status, "paid");
  const again = await payPaymentLink(pool, app.acquirer, payConfig, {
    token: link.token,
    card: CARD,
    idempotencyKey: randomUUID(),
  });
  assert.equal(again.statusCode, 409);
  assert.equal((again.body as { error: string }).error, "payment_link_already_paid");
});

test("a link stuck with an old authorization is voided and released, then payable again", async () => {
  const link = await linkForNewMerchant();
  const txnId = await stopAfterBind(link, randomUUID());
  await ageReservation(link.linkId, 301);

  await runPaymentLinkRecoveryPass(pool, sweepConfig);

  const t = await txnState(txnId);
  assert.equal(t.status, "voided");
  assert.equal(t.activeHolds, 0);
  assert.equal(t.voidedEvents, 1);
  assert.equal(t.voidedOutbox, 1);
  const row = await linkRow(link.linkId);
  assert.equal(row.status, "active");
  assert.equal(row.reserved_at, null);
  assert.equal(row.pending_transaction_id, null);
  assert.equal(row.transaction_id, null);

  const paid = await payPaymentLink(pool, app.acquirer, payConfig, {
    token: link.token,
    card: CARD,
    idempotencyKey: randomUUID(),
  });
  assert.equal(paid.statusCode, 200, JSON.stringify(paid.body));
});

test("a fresh bound reservation (live payment) is not touched", async () => {
  const link = await linkForNewMerchant();
  const txnId = await stopAfterBind(link, randomUUID());
  const before = await linkRow(link.linkId);
  // Past the 60 s reservation timeout but well inside the grace period.
  await ageReservation(link.linkId, 120);
  const aged = await linkRow(link.linkId);

  await runPaymentLinkRecoveryPass(pool, sweepConfig);

  const after = await linkRow(link.linkId);
  assert.equal(before.status, "reserved");
  assert.equal(after.status, "reserved");
  assert.equal(after.pending_transaction_id, txnId);
  assert.equal(after.reserved_at?.getTime(), aged.reserved_at?.getTime());
  assert.equal((await txnState(txnId)).status, "authorized");
});

test("running the sweep twice is harmless", async () => {
  const captured = await linkForNewMerchant();
  const ckey = randomUUID();
  const ctxn = await stopAfterBind(captured, ckey);
  await captureTransaction(pool, app.acquirer, {
    transactionId: ctxn,
    merchantId: captured.merchantId,
    idempotencyKey: `paylink:${captured.linkId}:${ckey}:capture`,
    actor: { type: "system", id: captured.linkId },
  });
  const held = await linkForNewMerchant();
  const htxn = await stopAfterBind(held, randomUUID());
  await ageReservation(held.linkId, 600);

  await runPaymentLinkRecoveryPass(pool, sweepConfig);
  const paidOnce = await linkRow(captured.linkId);
  await runPaymentLinkRecoveryPass(pool, sweepConfig);

  const paidTwice = await linkRow(captured.linkId);
  assert.equal(paidTwice.status, "paid");
  assert.equal(paidTwice.paid_at?.getTime(), paidOnce.paid_at?.getTime());
  const t = await txnState(htxn);
  assert.equal(t.status, "voided");
  assert.equal(t.voidedEvents, 1);
  assert.equal(t.voidedOutbox, 1);
  assert.equal((await linkRow(held.linkId)).status, "active");
});

test("a link whose bound authorization was voided before the crash released it is released", async () => {
  const link = await linkForNewMerchant();
  const txnId = await stopAfterBind(link, randomUUID());
  const v = await voidTransaction(pool, {
    transactionId: txnId,
    merchantId: link.merchantId,
    actor: { type: "system", id: link.linkId },
  });
  assert.equal(v.statusCode, 200);
  await ageReservation(link.linkId, 301);

  await runPaymentLinkRecoveryPass(pool, sweepConfig);

  const row = await linkRow(link.linkId);
  assert.equal(row.status, "active");
  assert.equal(row.pending_transaction_id, null);
  assert.equal((await txnState(txnId)).voidedEvents, 1);
});

test("a link reserved with no bound authorization frees itself after the reservation timeout", async () => {
  // Crash between claim and bind: no sweep needed, the claim rule re-opens it.
  const link = await linkForNewMerchant();
  await pool.query(`UPDATE payment_links SET status = 'reserved', reserved_at = now() - interval '61 seconds' WHERE id = $1`, [
    link.linkId,
  ]);
  const read = await app.inject({ method: "GET", url: `/v1/payment-links/${link.token}` });
  assert.equal((read.json() as { status: string }).status, "active");
  const paid = await payPaymentLink(pool, app.acquirer, payConfig, {
    token: link.token,
    card: CARD,
    idempotencyKey: randomUUID(),
  });
  assert.equal(paid.statusCode, 200, JSON.stringify(paid.body));
});

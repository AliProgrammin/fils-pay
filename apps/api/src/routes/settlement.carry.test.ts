/**
 * G11: settlement carries a late capture or refund into a later batch
 * (apps/settlement CloseBatch claims every unbatched item with
 * occurred_at < end). Reconciliation must explain that day by day, not show
 * +net on the event's day and -net on the batch's day.
 *
 * Rows are written with the same SQL as apps/settlement's batch_test.go
 * (insertCaptureEvent) and refund_batch_test.go (insertRefund). closeBatch
 * below is CloseBatch's rule in SQL: claim every unbatched capture and
 * refund before the end of the business day.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { applyRateFils, toFils } from "@filspay/money";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("settlement.carry.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const MDR_BPS = 250;
const fee = (amount: number) => Number(applyRateFils(toFils(amount), MDR_BPS));
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+03:00`);

async function createMerchant() {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status, test_mode) VALUES ($1, $2, 'active', false) RETURNING id`,
    [`G11 carry ${randomUUID()}`, MDR_BPS],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  const key = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "g11" });
  return { merchantId, rawKey: key.rawKey };
}

async function insertCapture(merchantId: string, amount: number, when: Date): Promise<string> {
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
     VALUES ($1, 'captured', $2, $2, $3, $4) RETURNING id`,
    [merchantId, amount, `acq-${randomUUID()}`, when],
  );
  const txnId = t.rows[0]!.id;
  await pool.query(
    `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
     VALUES ($1, 'captured', $2, 'system', $3)`,
    [txnId, amount, when],
  );
  await pool.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ($1, $2, $3, 'card_scheme_clearing', 'debit',  $4, $6, 'capture: gross'),
            ($1, $2, $3, 'merchant_payable',     'credit', $4, $6, 'capture: gross'),
            ($1, $2, $3, 'merchant_payable',     'debit',  $5, $6, 'capture: MDR fee'),
            ($1, $2, $3, 'platform_fee_revenue', 'credit', $5, $6, 'capture: MDR fee')`,
    [randomUUID(), merchantId, txnId, amount, fee(amount), when],
  );
  return txnId;
}

async function insertRefund(merchantId: string, txnId: string, amount: number, feeReversed: number, when: Date) {
  await pool.query(
    `INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
                          acquirer_reference, reason, created_by_type, created_by_id, occurred_at)
     VALUES ($1, $2, $3, $4, 'succeeded', $5, 'test', 'merchant_api_key', $6, $7)`,
    [txnId, merchantId, amount, feeReversed, `acq-refund-${randomUUID()}`, randomUUID(), when],
  );
  await pool.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ($1, $2, $3, 'merchant_payable',     'debit',  $4, $6, 'refund: gross'),
            ($1, $2, $3, 'card_scheme_clearing', 'credit', $4, $6, 'refund: gross'),
            ($1, $2, $3, 'platform_fee_revenue', 'debit',  $5, $6, 'refund: MDR fee reversal'),
            ($1, $2, $3, 'merchant_payable',     'credit', $5, $6, 'refund: MDR fee reversal')`,
    [randomUUID(), merchantId, txnId, amount, feeReversed, when],
  );
}

/** CloseBatch's claim rule: every unbatched capture and refund with occurred_at < end. */
async function closeBatch(merchantId: string, businessDate: string) {
  const end = new Date(at(businessDate, "00:00").getTime() + 24 * 60 * 60 * 1000);
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status) VALUES ($1, $2, 'open') RETURNING id`,
    [merchantId, businessDate],
  );
  const batchId = batch.rows[0]!.id;
  const events = await pool.query<{ id: string; amount_fils: string }>(
    `SELECT te.id, te.amount_fils FROM transaction_events te JOIN transactions t ON t.id = te.transaction_id
      WHERE t.merchant_id = $1 AND te.event_type IN ('captured', 'partially_captured')
        AND te.settlement_batch_id IS NULL AND te.occurred_at < $2`,
    [merchantId, end],
  );
  const refunds = await pool.query<{ id: string; amount_fils: string; fee_reversed_fils: string }>(
    `SELECT id, amount_fils, fee_reversed_fils FROM refunds
      WHERE merchant_id = $1 AND status = 'succeeded' AND settlement_batch_id IS NULL AND occurred_at < $2`,
    [merchantId, end],
  );
  let gross = 0;
  let fees = 0;
  for (const e of events.rows) {
    gross += Number(e.amount_fils);
    fees += fee(Number(e.amount_fils));
  }
  let refund = 0;
  let feeRev = 0;
  for (const r of refunds.rows) {
    refund += Number(r.amount_fils);
    feeRev += Number(r.fee_reversed_fils);
  }
  const net = gross - fees - refund + feeRev;
  assert.ok(net >= 0, "test setup: every refund must fit in its batch");
  await pool.query(
    `UPDATE settlement_batches SET status = 'closed', gross_fils = $2, fee_fils = $3, net_payout_fils = $4,
            refund_fils = $5, refund_fee_reversed_fils = $6, closed_at = now() WHERE id = $1`,
    [batchId, gross, fees, net, refund, feeRev],
  );
  await pool.query(`UPDATE transaction_events SET settlement_batch_id = $2 WHERE id = ANY($1::bigint[])`, [
    events.rows.map((e) => e.id),
    batchId,
  ]);
  await pool.query(`UPDATE refunds SET settlement_batch_id = $2 WHERE id = ANY($1::uuid[])`, [
    refunds.rows.map((r) => r.id),
    batchId,
  ]);
}

interface Report {
  ledgerMerchantPayableNetFils: number;
  settlementNetPayoutFils: number;
  pendingUnbatchedFils: number;
  carriedToLaterBatchFils: number;
  carriedFromEarlierDaysFils: number;
  gapFils: number;
  explained: boolean;
}

async function reconcile(rawKey: string, from: string, to: string): Promise<Report> {
  const res = await app.inject({
    method: "GET",
    url: `/v1/settlement/reconciliation?from=${from}&to=${to}`,
    headers: { authorization: `Bearer ${rawKey}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as Report;
}

test("G11: a late capture and a late refund carried into the next batch reconcile to 0 on both days", async () => {
  const { merchantId, rawKey } = await createMerchant();
  const D = "2026-03-10";
  const D1 = "2026-03-11";
  const D2 = "2026-03-12";

  const txnId = await insertCapture(merchantId, 10_000, at(D, "10:00"));
  await closeBatch(merchantId, D);
  // Both written after D closed, stamped on D: the D+1 batch claims them.
  await insertCapture(merchantId, 7_000, at(D, "23:59"));
  await insertRefund(merchantId, txnId, 2_000, 50, at(D, "23:58"));
  await insertCapture(merchantId, 4_000, at(D1, "12:00"));
  await closeBatch(merchantId, D1);

  const carriedNet = 7_000 - fee(7_000) - (2_000 - 50);

  const day = await reconcile(rawKey, D, D1);
  assert.equal(day.settlementNetPayoutFils, 10_000 - fee(10_000));
  assert.equal(day.carriedToLaterBatchFils, carriedNet);
  assert.equal(day.carriedFromEarlierDaysFils, 0);
  assert.equal(day.gapFils, 0, JSON.stringify(day));
  assert.equal(day.explained, true);

  const next = await reconcile(rawKey, D1, D2);
  assert.equal(next.carriedToLaterBatchFils, 0);
  assert.equal(next.carriedFromEarlierDaysFils, carriedNet);
  assert.equal(next.gapFils, 0, JSON.stringify(next));
  assert.equal(next.explained, true);

  // Both days together: nothing crosses the period edge.
  const both = await reconcile(rawKey, D, D2);
  assert.equal(both.carriedToLaterBatchFils, 0);
  assert.equal(both.carriedFromEarlierDaysFils, 0);
  assert.equal(both.gapFils, 0, JSON.stringify(both));
});

test("G11: a carried item is pending until the later batch claims it, then carried, with no gap either way", async () => {
  const { merchantId, rawKey } = await createMerchant();
  const D = "2026-03-20";
  const D1 = "2026-03-21";

  await insertCapture(merchantId, 5_000, at(D, "09:00"));
  await closeBatch(merchantId, D);
  await insertCapture(merchantId, 3_000, at(D, "23:30"));

  const before = await reconcile(rawKey, D, D1);
  assert.equal(before.pendingUnbatchedFils, 3_000 - fee(3_000));
  assert.equal(before.carriedToLaterBatchFils, 0);
  assert.equal(before.gapFils, 0, JSON.stringify(before));

  await closeBatch(merchantId, D1);
  const after = await reconcile(rawKey, D, D1);
  assert.equal(after.pendingUnbatchedFils, 0);
  assert.equal(after.carriedToLaterBatchFils, 3_000 - fee(3_000));
  assert.equal(after.gapFils, 0, JSON.stringify(after));
});

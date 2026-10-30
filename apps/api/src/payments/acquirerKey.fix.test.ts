/**
 * A DB rollback after an approved acquirer call deletes the idempotency
 * claim. The client's retry (same Idempotency-Key) must send the acquirer
 * the same idempotency key, so the acquirer does not approve the operation
 * twice. Requires DATABASE_URL (migrated Postgres).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool, type PoolClient } from "pg";
import type { Fils } from "@filspay/money";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { recordKycReview } from "../onboarding/review.js";
import { authorizeTransaction } from "./authorize.js";
import { captureTransaction } from "./capture.js";
import { processRefund } from "./processRefund.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("acquirerKey.fix.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
after(async () => {
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

/** Always approves; records every idempotency key it is sent. */
function spyAcquirer() {
  const keys = { authorize: [] as string[], capture: [] as string[], refund: [] as string[] };
  const acquirer: AcquirerSimulator = {
    async authorize(req) {
      keys.authorize.push(req.idempotencyKey);
      return { outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
    },
    async capture(req) {
      keys.capture.push(req.idempotencyKey);
      return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
    },
    async refund(req) {
      keys.refund.push(req.idempotencyKey);
      return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
    },
  } as AcquirerSimulator;
  return { acquirer, keys };
}

/** A pool whose next transaction_events insert fails once, after the acquirer call, so the whole DB transaction rolls back. */
function poolFailingNextEventInsert(): Pool {
  let failed = false;
  const wrapped = {
    query: (...args: unknown[]) => (pool.query as (...a: unknown[]) => unknown)(...args),
    async connect(): Promise<PoolClient> {
      const client = await pool.connect();
      const realQuery = client.query.bind(client) as (...a: unknown[]) => unknown;
      (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
        if (!failed && typeof args[0] === "string" && args[0].includes("INSERT INTO transaction_events")) {
          failed = true;
          return Promise.reject(new Error("simulated DB failure after the acquirer call"));
        }
        return realQuery(...args);
      };
      const release = client.release.bind(client);
      client.release = (err?: Error | boolean) => {
        (client as unknown as { query: unknown }).query = realQuery;
        release(err);
      };
      return client;
    },
  };
  return wrapped as unknown as Pool;
}

async function approvedMerchant(): Promise<string> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Acquirer Key ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  return merchantId;
}

test("acquirer key: a retry after a rollback reuses the authorize key", async () => {
  const merchantId = await approvedMerchant();
  const { acquirer, keys } = spyAcquirer();
  const input = { merchantId, amountFils: 5_000 as Fils, card: CARD, idempotencyKey: randomUUID() };

  await assert.rejects(authorizeTransaction(poolFailingNextEventInsert(), acquirer, input));
  const retry = await authorizeTransaction(pool, acquirer, input);
  assert.equal(retry.statusCode, 201);

  assert.equal(keys.authorize.length, 2);
  assert.equal(keys.authorize[1], keys.authorize[0]);
});

test("acquirer key: a retry after a rollback reuses the capture and refund keys", async () => {
  const merchantId = await approvedMerchant();
  const { acquirer, keys } = spyAcquirer();
  const auth = await authorizeTransaction(pool, acquirer, {
    merchantId,
    amountFils: 5_000 as Fils,
    card: CARD,
    idempotencyKey: randomUUID(),
  });
  const transactionId = (auth.body as { id: string }).id;
  const actor = { type: "merchant_api_key" as const, id: randomUUID() };

  const captureInput = { transactionId, merchantId, amountFils: 5_000 as Fils, idempotencyKey: randomUUID(), actor };
  await assert.rejects(captureTransaction(poolFailingNextEventInsert(), acquirer, captureInput));
  assert.equal((await captureTransaction(pool, acquirer, captureInput)).statusCode, 200);
  assert.equal(keys.capture.length, 2);
  assert.equal(keys.capture[1], keys.capture[0]);

  const refundInput = { transactionId, merchantId, amountFils: 1_000 as Fils, idempotencyKey: randomUUID(), actor };
  await assert.rejects(processRefund(poolFailingNextEventInsert(), acquirer, refundInput));
  const refund = await processRefund(pool, acquirer, refundInput);
  assert.ok(refund.statusCode < 300, JSON.stringify(refund.body));
  assert.equal(keys.refund.length, 2);
  assert.equal(keys.refund[1], keys.refund[0]);
});

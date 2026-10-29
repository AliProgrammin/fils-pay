/**
 * Two dispatch passes (two replicas, or NOTIFY + poll on two processes) must
 * never send the same delivery twice. Each pass must claim a row first.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { loadConfig } from "../config.js";
import { createWebhookEndpoint } from "./create.js";
import { runDispatchPass } from "./dispatcher.js";
import type { WebhookTransport } from "./transport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("dispatcher.claim.fix.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const poolA = new Pool({ connectionString: databaseUrl, max: 3 });
const poolB = new Pool({ connectionString: databaseUrl, max: 3 });
test.after(async () => {
  await poolA.end();
  await poolB.end();
});

test("two concurrent dispatch passes send a due delivery exactly once", async () => {
  const merchant = await poolA.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Claim Fix Merchant ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const url = `http://fake-receiver.test/claim-fix-${randomUUID()}`;
  await createWebhookEndpoint(poolA, config, {
    merchantId,
    url,
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  await enqueueEvent(poolA, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: { merchantId, amountCapturedFils: 1_000, feeFils: 15, newStatus: "captured", capturedTotalFils: 1_000 },
  });

  let sends = 0;
  const slowTransport: WebhookTransport = async (req) => {
    if (req.url === url) sends += 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { statusCode: 200, body: "ok" };
  };

  await Promise.all([runDispatchPass(poolA, slowTransport, config), runDispatchPass(poolB, slowTransport, config)]);

  assert.equal(sends, 1, "the same delivery was sent by both passes");
});

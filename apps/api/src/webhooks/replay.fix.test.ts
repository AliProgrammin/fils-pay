/**
 * ARCHITECTURE.md: every delivery carries a Webhook-Delivery-Id that is
 * stable across retries (and replays), so receivers can dedupe on it.
 * Batch replay only resends deliveries that did not get through.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { loadConfig } from "../config.js";
import { createWebhookEndpoint } from "./create.js";
import { runDispatchPass } from "./dispatcher.js";
import { replayWebhookDelivery } from "./replay.js";
import { replayWebhookDeliveriesBatch } from "./replayBatch.js";
import { WEBHOOK_DELIVERY_ID_HEADER } from "./headers.js";
import type { WebhookTransport, WebhookTransportRequest } from "./transport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("replay.fix.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
test.after(async () => {
  await pool.end();
});

async function setup(label: string) {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Replay Fix ${label} ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const url = `http://fake-receiver.test/replay-fix-${randomUUID()}`;
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId,
    url,
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  return { merchantId, url, endpoint };
}

test("a replay reuses the original Webhook-Delivery-Id (header and body id)", async () => {
  const { merchantId, url, endpoint } = await setup("single");
  await enqueueEvent(pool, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: { merchantId, amountCapturedFils: 2_000, feeFils: 30, newStatus: "captured", capturedTotalFils: 2_000 },
  });

  const sent: WebhookTransportRequest[] = [];
  const transport: WebhookTransport = async (req) => {
    if (req.url === url) sent.push(req);
    return { statusCode: 200, body: "ok" };
  };
  await runDispatchPass(pool, transport, config);
  assert.equal(sent.length, 1);
  const originalId = sent[0]!.headers[WEBHOOK_DELIVERY_ID_HEADER]!;

  const original = await pool.query<{ id: string }>(
    `SELECT id FROM webhook_deliveries WHERE endpoint_id = $1 AND replay_of_delivery_id IS NULL`,
    [endpoint.id],
  );
  await replayWebhookDelivery(pool, { merchantId, endpointId: endpoint.id, deliveryId: original.rows[0]!.id });
  await runDispatchPass(pool, transport, config);

  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.headers[WEBHOOK_DELIVERY_ID_HEADER], originalId);
  assert.equal((JSON.parse(sent[1]!.body) as { id: string }).id, originalId);
});

test("batch replay refuses statuses other than failed/exhausted", async () => {
  const { merchantId, endpoint } = await setup("batch");
  await assert.rejects(
    replayWebhookDeliveriesBatch(pool, {
      merchantId,
      endpointId: endpoint.id,
      adminUserId: randomUUID(),
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-12-31T00:00:00Z"),
      statuses: ["succeeded"],
    }),
    (err: Error & { statusCode?: number }) => err.statusCode === 400,
  );
});

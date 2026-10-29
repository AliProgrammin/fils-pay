/**
 * FP-240: a receiver verifies the HMAC over the RAW bytes it got, never a
 * re-serialised copy. These tests act like a real receiver.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { loadConfig } from "../config.js";
import { createWebhookEndpoint } from "./create.js";
import { runDispatchPass } from "./dispatcher.js";
import { signPayload, verifySignature } from "./sign.js";
import { WEBHOOK_SIGNATURE_HEADER } from "./headers.js";
import type { WebhookTransport, WebhookTransportRequest } from "./transport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("sign.fix.test.ts requires DATABASE_URL");

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

function rawHmacMatches(rawBody: string, header: string, secret: string): boolean {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  assert.ok(match, "signature header has the t=,v1= format");
  const expected = createHmac("sha256", secret).update(`${match[1]}.${rawBody}`).digest("hex");
  return expected === match[2];
}

test("dispatcher: the signature is an HMAC over the exact body bytes sent", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Sign Fix Merchant ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const url = `http://fake-receiver.test/sign-fix-${randomUUID()}`;
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId,
    url,
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  await enqueueEvent(pool, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: { merchantId, amountCapturedFils: 4_750, feeFils: 71, newStatus: "captured", capturedTotalFils: 4_750 },
  });

  const captured: WebhookTransportRequest[] = [];
  const transport: WebhookTransport = async (req) => {
    if (req.url === url) captured.push(req);
    return { statusCode: 200, body: "ok" };
  };
  await runDispatchPass(pool, transport, config);

  assert.equal(captured.length, 1);
  const req = captured[0]!;
  const header = req.headers[WEBHOOK_SIGNATURE_HEADER]!;
  assert.ok(rawHmacMatches(req.body, header, endpoint.secret), "HMAC over the raw body must match");
  assert.deepEqual(verifySignature(req.body, header, endpoint.secret), { valid: true });
});

test("signPayload/verifySignature work on the raw body string, byte for byte", () => {
  const body = '{"b":1,"a":2}';
  const { signature } = signPayload(body, "whsec_x", 1_700_000_000);
  assert.ok(rawHmacMatches(body, signature, "whsec_x"));
  assert.equal(verifySignature('{"a":2,"b":1}', signature, "whsec_x", { now: 1_700_000_000 }).valid, false);
});

/**
 * Deleting a webhook endpoint that already has deliveries crashed with a 500:
 * webhook_deliveries.endpoint_id is NOT NULL with a plain FK, so the DELETE
 * violates it. The intended behaviour (cancel.ts docblock) is to keep the
 * delivery log with endpoint_id set to NULL. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { deleteWebhookEndpoint } from "./cancel.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("cancel.fix.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
test.after(async () => {
  await pool.end();
});

test("deleting an endpoint with delivery history succeeds and keeps the history", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Hook Delete ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const endpoint = await pool.query<{ id: string }>(
    `INSERT INTO webhook_endpoints (merchant_id, url, secret_ciphertext, secret_prefix, created_by_type, created_by_id)
     VALUES ($1, 'https://example.test/hook', 'unused', 'whsec_unused', 'merchant_session', $2)
     RETURNING id`,
    [merchantId, randomUUID()],
  );
  const endpointId = endpoint.rows[0]!.id;
  const outbox = await pool.query<{ id: string }>(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
     VALUES ('test.inert', 'test', $1, '{}'::jsonb) RETURNING id`,
    [randomUUID()],
  );
  const delivery = await pool.query<{ id: string }>(
    `INSERT INTO webhook_deliveries (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload)
     VALUES ($1, $2, 'test.inert', $3, '{}'::jsonb) RETURNING id`,
    [endpointId, outbox.rows[0]!.id, randomUUID()],
  );

  const result = await deleteWebhookEndpoint(pool, { merchantId, id: endpointId });
  assert.equal(result, "deleted");

  const kept = await pool.query<{ endpoint_id: string | null }>(
    `SELECT endpoint_id FROM webhook_deliveries WHERE id = $1`,
    [delivery.rows[0]!.id],
  );
  assert.equal(kept.rowCount, 1, "the delivery log must survive the endpoint");
  assert.equal(kept.rows[0]!.endpoint_id, null);
});

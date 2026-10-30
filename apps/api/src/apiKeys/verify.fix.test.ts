/**
 * H7 (docs/bugs/hunt-2.md): a key whose scheduled revocation time
 * (api_keys.revoke_after) has passed must stop working. No sweep job
 * exists, so the check lives in verifyApiKey. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { issueApiKey, listApiKeys } from "./issue.js";
import { verifyApiKey } from "./verify.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("verify.fix.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
test.after(() => pool.end());

async function newKey() {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`H7 ${randomUUID()}`],
  );
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [m.rows[0]!.id, `h7-${randomUUID()}@example.test`],
  );
  const issued = await issueApiKey(pool, config, { merchantId: m.rows[0]!.id, createdBy: u.rows[0]!.id, label: "h7" });
  const row = await pool.query<{ id: string }>(`SELECT id FROM api_keys WHERE merchant_id = $1`, [m.rows[0]!.id]);
  return { rawKey: issued.rawKey, id: row.rows[0]!.id, merchantId: m.rows[0]!.id };
}

test("H7: a key past its revoke_after time is rejected", async () => {
  const k = await newKey();
  await pool.query(`UPDATE api_keys SET revoke_after = now() - interval '1 minute' WHERE id = $1`, [k.id]);
  assert.equal(await verifyApiKey(pool, k.rawKey), null);
});

test("H7: a key with a future revoke_after, or none, still works", async () => {
  const k = await newKey();
  assert.ok(await verifyApiKey(pool, k.rawKey));
  await pool.query(`UPDATE api_keys SET revoke_after = now() + interval '1 day' WHERE id = $1`, [k.id]);
  assert.ok(await verifyApiKey(pool, k.rawKey));
});

test("H7: the key list shows a passed revoke_after as revokedAt, so the dashboard does not call a dead key active", async () => {
  const k = await newKey();
  await pool.query(`UPDATE api_keys SET revoke_after = now() + interval '1 day' WHERE id = $1`, [k.id]);
  assert.equal((await listApiKeys(pool, k.merchantId))[0]!.revokedAt, null);
  await pool.query(`UPDATE api_keys SET revoke_after = now() - interval '1 minute' WHERE id = $1`, [k.id]);
  assert.ok((await listApiKeys(pool, k.merchantId))[0]!.revokedAt instanceof Date);
});

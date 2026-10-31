/**
 * Route tests for GET /v1/admin/fraud-notes: the read side of
 * acquirer_callback_notes (the acquirer's fraud-review verdicts). Real,
 * migrated Postgres via DATABASE_URL (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../adminAuth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "adminFraudNotes.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const ACQUIRER_SECRET = "acqsec_fraud_notes_test_secret";

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  ACQUIRER_CALLBACK_SIGNING_SECRET: ACQUIRER_SECRET,
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

type AdminRole = "support" | "finance" | "super_admin";
const ADMIN_PASSWORD = "admin-test-password-9000!";
let cachedHash: string | null = null;

function parseCookie(setCookieHeader: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const header of headers) {
    if (header && header.startsWith(`${name}=`)) return header.split(";")[0] as string;
  }
  throw new Error(`expected a Set-Cookie header for ${name}`);
}

async function signedInAdmin(role: AdminRole): Promise<string> {
  cachedHash ??= await hashPassword(ADMIN_PASSWORD, config);
  const email = `fraud-notes-${role}-${randomUUID()}@admin.test`;
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, $3, $4)`,
    [email, cachedHash, `Fraud notes ${role}`, role],
  );
  const login = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: { email, password: ADMIN_PASSWORD },
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = parseCookie(login.headers["set-cookie"], config.adminCookieName);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code: (login.json() as { devOtpCode?: string }).devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return cookie;
}

async function createMerchant(): Promise<{ id: string; name: string }> {
  const name = `Fraud Notes Merchant ${randomUUID()}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [name],
  );
  return { id: result.rows[0]!.id, name };
}

async function createTransaction(merchantId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'captured', 50000, 50000, $2) RETURNING id`,
    [merchantId, `acqref_${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

/** Stores a note the real way: a signed POST /v1/acquirer/callbacks. */
async function postCallback(
  transactionId: string,
  occurredAt: string,
  outcome: "cleared" | "confirmed_fraud",
  note: string,
): Promise<string> {
  const callbackId = `acqcb_${randomUUID()}`;
  const body = { callbackId, type: "fraud_review.completed", transactionId, occurredAt, outcome, note };
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", ACQUIRER_SECRET)
    .update(`${timestamp}.${JSON.stringify(body)}`)
    .digest("hex");
  const res = await app.inject({
    method: "POST",
    url: "/v1/acquirer/callbacks",
    headers: { "acquirer-callback-signature": `t=${timestamp},v1=${signature}` },
    payload: body,
  });
  assert.ok(res.statusCode >= 200 && res.statusCode < 300, res.body);
  return callbackId;
}

interface FraudNote {
  id: string;
  callbackId: string;
  transactionId: string;
  merchantId: string;
  merchantName: string;
  outcome: string;
  note: string;
  receivedAt: string;
}

interface FraudNotePage {
  items: FraudNote[];
  nextCursor: string | null;
}

test("GET /v1/admin/fraud-notes rejects a caller with no admin session", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/admin/fraud-notes" });
  assert.equal(res.statusCode, 401, res.body);
});

test("every admin role can read the fraud notes", async () => {
  for (const role of ["support", "finance", "super_admin"] as const) {
    const cookie = await signedInAdmin(role);
    const res = await app.inject({ method: "GET", url: "/v1/admin/fraud-notes", headers: { cookie } });
    assert.equal(res.statusCode, 200, `${role}: ${res.body}`);
    assert.ok(Array.isArray((res.json() as FraudNotePage).items));
  }
});

test("lists a merchant's notes most recent first, with transaction, merchant, outcome, text and received time", async () => {
  const cookie = await signedInAdmin("support");
  const merchant = await createMerchant();
  const txnA = await createTransaction(merchant.id);
  const txnB = await createTransaction(merchant.id);
  const older = await postCallback(txnA, "2026-09-16T10:00:00.000Z", "cleared", "Reviewed: genuine cardholder.");
  const newer = await postCallback(txnB, "2026-09-17T08:30:00.000Z", "confirmed_fraud", "Card testing pattern.");

  const res = await app.inject({
    method: "GET",
    url: `/v1/admin/fraud-notes?merchantId=${merchant.id}`,
    headers: { cookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  const page = res.json() as FraudNotePage;
  assert.deepEqual(
    page.items.map((n) => n.callbackId),
    [newer, older],
  );
  assert.deepEqual(page.items[0], {
    id: page.items[0]!.id,
    callbackId: newer,
    transactionId: txnB,
    merchantId: merchant.id,
    merchantName: merchant.name,
    outcome: "confirmed_fraud",
    note: "Card testing pattern.",
    receivedAt: "2026-09-17T08:30:00.000Z",
  });
  assert.equal(page.nextCursor, null);
});

test("filters by transaction", async () => {
  const cookie = await signedInAdmin("finance");
  const merchant = await createMerchant();
  const txnA = await createTransaction(merchant.id);
  const txnB = await createTransaction(merchant.id);
  await postCallback(txnA, "2026-09-16T10:00:00.000Z", "cleared", "A");
  const onB = await postCallback(txnB, "2026-09-16T11:00:00.000Z", "cleared", "B");

  const res = await app.inject({
    method: "GET",
    url: `/v1/admin/fraud-notes?transactionId=${txnB}`,
    headers: { cookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(
    (res.json() as FraudNotePage).items.map((n) => n.callbackId),
    [onB],
  );
});

test("pages with limit and nextCursor, with no row lost or repeated", async () => {
  const cookie = await signedInAdmin("support");
  const merchant = await createMerchant();
  const txn = await createTransaction(merchant.id);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    ids.unshift(await postCallback(txn, `2026-09-1${i + 1}T10:00:00.000Z`, "cleared", `note ${i}`));
  }

  const first = await app.inject({
    method: "GET",
    url: `/v1/admin/fraud-notes?merchantId=${merchant.id}&limit=2`,
    headers: { cookie },
  });
  assert.equal(first.statusCode, 200, first.body);
  const page1 = first.json() as FraudNotePage;
  assert.equal(page1.items.length, 2);
  assert.ok(page1.nextCursor);

  const second = await app.inject({
    method: "GET",
    url: `/v1/admin/fraud-notes?merchantId=${merchant.id}&limit=2&cursor=${page1.nextCursor}`,
    headers: { cookie },
  });
  assert.equal(second.statusCode, 200, second.body);
  const page2 = second.json() as FraudNotePage;
  assert.deepEqual(
    [...page1.items, ...page2.items].map((n) => n.callbackId),
    ids,
  );
});

test("a malformed filter or cursor is refused, not a 500", async () => {
  const cookie = await signedInAdmin("support");
  const cases: Array<[string, number]> = [
    ["merchantId=not-a-uuid", 404],
    ["transactionId=not-a-uuid", 404],
    ["cursor=garbage", 400],
    ["limit=abc", 400],
  ];
  for (const [query, status] of cases) {
    const res = await app.inject({ method: "GET", url: `/v1/admin/fraud-notes?${query}`, headers: { cookie } });
    assert.equal(res.statusCode, status, `${query}: ${res.body}`);
  }
});

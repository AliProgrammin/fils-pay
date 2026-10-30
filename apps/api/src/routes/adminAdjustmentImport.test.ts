/**
 * Route-level tests for the admin "Import adjustments" tool, via
 * `app.inject(...)` against a real, migrated Postgres (run `npm run migrate`
 * first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../adminAuth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "adminAdjustmentImport.test.ts requires DATABASE_URL to point at a real, migrated Postgres",
  );
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

type AdminRole = "support" | "finance" | "super_admin";

const ADMIN_PASSWORD = "admin-test-password-9000!";
let cachedAdminPasswordHash: string | null = null;

function parseCookie(setCookieHeader: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const header of headers) {
    if (header && header.startsWith(`${name}=`)) {
      return header.split(";")[0] as string;
    }
  }
  throw new Error(`expected a Set-Cookie header for ${name}`);
}

async function signedInAdmin(role: AdminRole): Promise<{ id: string; cookie: string }> {
  cachedAdminPasswordHash ??= await hashPassword(ADMIN_PASSWORD, config);
  const email = `adj-import-route-${randomUUID()}@admin.test`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, cachedAdminPasswordHash, `Test ${role}`, role],
  );

  const loginRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: { email, password: ADMIN_PASSWORD },
  });
  assert.equal(loginRes.statusCode, 200, loginRes.body);
  const loginBody = loginRes.json() as { devOtpCode?: string };
  const cookie = parseCookie(loginRes.headers["set-cookie"], config.adminCookieName);

  const verifyRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code: loginBody.devOtpCode },
  });
  assert.equal(verifyRes.statusCode, 200, verifyRes.body);
  return { id: inserted.rows[0]!.id, cookie };
}

async function createMerchant(): Promise<string> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
     VALUES ($1, 250, 'active', false) RETURNING id`,
    [`Adj Import Route ${randomUUID()}`],
  );
  return merchant.rows[0]!.id;
}

const PATH = "/v1/admin/adjustment-imports";

test("a valid CSV upload returns 201 and applies every row", async () => {
  const admin = await signedInAdmin("finance");
  const merchantId = await createMerchant();

  const res = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: admin.cookie },
    payload: {
      csvContent: `merchantId,amount,reason\n${merchantId},4.75,statement correction\n${merchantId},1.25,rounding\n`,
      originalFilename: "march-corrections.csv",
    },
  });
  assert.equal(res.statusCode, 201, res.body);

  const body = res.json() as { importId: string; rowCount: number; totalPostedFils: number };
  assert.equal(body.rowCount, 2);
  assert.equal(body.totalPostedFils, 6000);

  const rows = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM adjustment_import_rows WHERE adjustment_import_id = $1`,
    [body.importId],
  );
  assert.equal(Number(rows.rows[0]!.n), 2);
});

test("an unauthenticated upload is a 401", async () => {
  const merchantId = await createMerchant();
  const res = await app.inject({
    method: "POST",
    url: PATH,
    payload: { csvContent: `merchantId,amount,reason\n${merchantId},1.00,x\n` },
  });
  assert.equal(res.statusCode, 401, res.body);
});

test("a support admin cannot upload", async () => {
  const admin = await signedInAdmin("support");
  const merchantId = await createMerchant();
  const res = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: admin.cookie },
    payload: { csvContent: `merchantId,amount,reason\n${merchantId},1.00,x\n` },
  });
  assert.equal(res.statusCode, 403, res.body);
});

test("a missing or empty csvContent is a 400", async () => {
  const admin = await signedInAdmin("finance");
  for (const payload of [{}, { csvContent: "" }, { csvContent: "   " }, { csvContent: 42 }]) {
    const res = await app.inject({
      method: "POST",
      url: PATH,
      headers: { cookie: admin.cookie },
      payload,
    });
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)} -> ${res.body}`);
  }
});

test("a header-only CSV is a 400", async () => {
  const admin = await signedInAdmin("finance");
  const res = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: admin.cookie },
    payload: { csvContent: "merchantId,amount,reason\n" },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test("a row whose merchantId is not a UUID is a 400 and applies nothing", async () => {
  const admin = await signedInAdmin("finance");
  const merchantId = await createMerchant();

  const res = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: admin.cookie },
    payload: {
      csvContent: `merchantId,amount,reason\n${merchantId},1.00,ok\nnot-a-uuid,2.00,bad\n`,
    },
  });
  assert.equal(res.statusCode, 400, res.body);

  const legs = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ledger_entries WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(Number(legs.rows[0]!.n), 0, "validation must run before anything is posted");
});

/** "Malformed" = non-numeric. Trailing garbage after a number (e.g. "4.75abc") is accepted by the parser. */
test("a malformed amount is a 400 and rolls the whole import back", async () => {
  const admin = await signedInAdmin("finance");
  const merchantId = await createMerchant();

  const res = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: admin.cookie },
    payload: {
      csvContent: `merchantId,amount,reason\n${merchantId},1.00,ok\n${merchantId},abc,bad\n`,
    },
  });
  assert.equal(res.statusCode, 400, res.body);

  const legs = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ledger_entries WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(Number(legs.rows[0]!.n), 0);
});

test("the import history lists past uploads and is readable by any admin role", async () => {
  const finance = await signedInAdmin("finance");
  const merchantId = await createMerchant();

  const created = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: finance.cookie },
    payload: {
      csvContent: `merchantId,amount,reason\n${merchantId},9.99,history\n`,
      originalFilename: "history.csv",
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const importId = (created.json() as { importId: string }).importId;

  const support = await signedInAdmin("support");
  const listed = await app.inject({
    method: "GET",
    url: `${PATH}?limit=50`,
    headers: { cookie: support.cookie },
  });
  assert.equal(listed.statusCode, 200, listed.body);

  const items = (listed.json() as { items: Array<{ id: string; originalFilename: string }> }).items;
  const match = items.find((item) => item.id === importId);
  assert.ok(match, "the new import must appear in the history");
  assert.equal(match.originalFilename, "history.csv");
});

// BD has 3 decimals: 4.750 BD is 4750 fils.
test("per-row detail shows the raw text next to the parsed integer", async () => {
  const admin = await signedInAdmin("finance");
  const merchantId = await createMerchant();

  const created = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: admin.cookie },
    payload: { csvContent: `merchantId,amount,reason\n${merchantId},4.750,detail\n` },
  });
  const importId = (created.json() as { importId: string }).importId;

  const res = await app.inject({
    method: "GET",
    url: `${PATH}/${importId}/rows`,
    headers: { cookie: admin.cookie },
  });
  assert.equal(res.statusCode, 200, res.body);

  const rows = (res.json() as { rows: Array<Record<string, unknown>> }).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.rawAmountText, "4.750");
  assert.equal(rows[0]!.merchantId, merchantId);
  assert.equal(rows[0]!.reason, "detail");
});

test("per-row detail for an unknown import is a 404", async () => {
  const admin = await signedInAdmin("finance");
  for (const id of ["not-a-uuid", randomUUID()]) {
    const res = await app.inject({
      method: "GET",
      url: `${PATH}/${id}/rows`,
      headers: { cookie: admin.cookie },
    });
    assert.equal(res.statusCode, 404, `${id} -> ${res.body}`);
  }
});

test("reading the import history requires a session", async () => {
  const res = await app.inject({ method: "GET", url: PATH });
  assert.equal(res.statusCode, 401, res.body);
});

// E9: applying the same sheet twice must not post it twice. The second
// upload (same content, even with other line endings, spacing, file name or
// "4.75" written as "4.750") is a 409 that names the earlier import and
// posts nothing.
test("uploading the same CSV content twice is a 409 adjustment_import_duplicate and posts nothing", async () => {
  const admin = await signedInAdmin("finance");
  const merchantId = await createMerchant();
  const csv = `merchantId,amount,reason\n${merchantId},4.75,statement correction\n${merchantId},1.25,rounding\n`;

  const first = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: admin.cookie },
    payload: { csvContent: csv, originalFilename: "march-corrections.csv" },
  });
  assert.equal(first.statusCode, 201, first.body);
  const firstImportId = (first.json() as { importId: string }).importId;

  const countState = async () => {
    const r = await pool.query<{ legs: string; imports: string; balance: string | null }>(
      `SELECT (SELECT COUNT(*) FROM ledger_entries WHERE merchant_id = $1)::text AS legs,
              (SELECT COUNT(*) FROM adjustment_import_rows WHERE merchant_id = $1)::text AS imports,
              (SELECT cached_payable_fils::text FROM merchant_balances WHERE merchant_id = $1) AS balance`,
      [merchantId],
    );
    return r.rows[0]!;
  };
  const before = await countState();

  const resubmissions = [
    { csvContent: csv, originalFilename: "march-corrections.csv" },
    {
      csvContent: `MerchantId, Amount, Reason\r\n${merchantId.toUpperCase()}, 4.750 ,statement correction\r\n${merchantId},1.250,rounding\r\n\r\n`,
      originalFilename: "march-corrections (1).csv",
    },
  ];
  for (const payload of resubmissions) {
    const res = await app.inject({ method: "POST", url: PATH, headers: { cookie: admin.cookie }, payload });
    assert.equal(res.statusCode, 409, res.body);
    const body = res.json() as { error: string; message: string; existingImportId: string };
    assert.equal(body.error, "adjustment_import_duplicate");
    assert.equal(body.existingImportId, firstImportId);
    assert.match(body.message, new RegExp(firstImportId));
  }

  assert.deepEqual(await countState(), before, "a rejected duplicate must post no ledger legs, rows or balance change");
});

test("a CSV with different content is not a duplicate", async () => {
  const admin = await signedInAdmin("finance");
  const merchantId = await createMerchant();
  for (const amount of ["2.00", "2.50"]) {
    const res = await app.inject({
      method: "POST",
      url: PATH,
      headers: { cookie: admin.cookie },
      payload: { csvContent: `merchantId,amount,reason\n${merchantId},${amount},x\n` },
    });
    assert.equal(res.statusCode, 201, res.body);
  }
});

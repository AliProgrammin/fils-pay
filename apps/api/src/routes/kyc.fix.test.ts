/**
 * H6 (docs/bugs/hunt-2.md): a KYC upload takes exactly one file, and a
 * failed upload leaves no file behind on disk. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { sha256Hex, randomToken } from "../lib/crypto.js";
import { recordKycDocument } from "../onboarding/kyc.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("kyc.fix.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const uploadDir = await mkdtemp(join(tmpdir(), "kyc-h6-"));
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  KYC_UPLOAD_DIR: uploadDir,
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
  await rm(uploadDir, { recursive: true, force: true });
});

const PDF = Buffer.from("%PDF-1.4\n%h6 test pdf\n%%EOF");
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

async function ownerSession() {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`KYC H6 ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `kyc-h6-${randomUUID()}@example.test`],
  );
  const raw = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at)
     VALUES ($1, $2, true, now() + interval '1 hour')`,
    [u.rows[0]!.id, sha256Hex(raw)],
  );
  return { merchantId, userId: u.rows[0]!.id, cookies: { [config.cookieName]: raw } };
}

function multipart(fields: Record<string, string>, files: Array<{ filename: string; data: Buffer }>) {
  const boundary = `----h6${randomUUID().replace(/-/g, "")}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      f.data,
      Buffer.from("\r\n"),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function filesOnDisk(merchantId: string): Promise<string[]> {
  try {
    return await readdir(join(uploadDir, merchantId));
  } catch {
    return [];
  }
}

async function docCount(merchantId: string): Promise<number> {
  const r = await pool.query(`SELECT count(*)::int AS n FROM kyc_documents WHERE merchant_id = $1`, [merchantId]);
  return r.rows[0].n;
}

test("H6: an upload with two or three files is rejected 400 and stores nothing", async () => {
  for (const count of [2, 3]) {
    const s = await ownerSession();
    const files = Array.from({ length: count }, (_, i) => ({
      filename: `${i}.pdf`,
      data: Buffer.from(`%PDF-1.4\n%file ${i}\n%%EOF`),
    }));
    const { payload, contentType } = multipart({ documentType: "owner_id" }, files);
    const res = await app.inject({
      method: "POST",
      url: `/v1/merchants/${s.merchantId}/kyc/documents`,
      cookies: s.cookies,
      headers: { "content-type": contentType },
      payload,
    });
    assert.equal(res.statusCode, 400, `${count} files: ${res.body}`);
    assert.equal(res.json().error, "invalid_request");
    assert.equal(await docCount(s.merchantId), 0);
    assert.deepEqual(await filesOnDisk(s.merchantId), []);
  }
});

test("H6: a single-file upload still works", async () => {
  const s = await ownerSession();
  const { payload, contentType } = multipart({ documentType: "owner_id" }, [{ filename: "a.pdf", data: PDF }]);
  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${s.merchantId}/kyc/documents`,
    cookies: s.cookies,
    headers: { "content-type": contentType },
    payload,
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(await docCount(s.merchantId), 1);
  assert.equal((await filesOnDisk(s.merchantId)).length, 1);
});

test("H6: an image that fails the thumbnail step leaves no file on disk", async () => {
  const s = await ownerSession();
  const { payload, contentType } = multipart({ documentType: "owner_id" }, [{ filename: "id.jpg", data: FAKE_JPEG }]);
  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${s.merchantId}/kyc/documents`,
    cookies: s.cookies,
    headers: { "content-type": contentType },
    payload,
  });
  assert.equal(res.statusCode, 422, res.body);
  assert.deepEqual(await filesOnDisk(s.merchantId), []);
});

test("H6: a failed DB insert removes the file it wrote, but never a file an earlier upload owns", async () => {
  const s = await ownerSession();
  // Fresh bytes, insert fails (uploaded_by is not a real user): no orphan.
  await assert.rejects(
    recordKycDocument(pool, config, {
      merchantId: s.merchantId,
      documentType: "owner_id",
      fileName: "x.pdf",
      buffer: PDF,
      uploadedBy: randomUUID(),
    }),
  );
  assert.deepEqual(await filesOnDisk(s.merchantId), []);

  // Same bytes uploaded for real, then a failing duplicate: the first file stays.
  await recordKycDocument(pool, config, {
    merchantId: s.merchantId,
    documentType: "owner_id",
    fileName: "x.pdf",
    buffer: PDF,
    uploadedBy: s.userId,
  });
  await assert.rejects(
    recordKycDocument(pool, config, {
      merchantId: s.merchantId,
      documentType: "owner_id",
      fileName: "x.pdf",
      buffer: PDF,
      uploadedBy: randomUUID(),
    }),
  );
  const files = await filesOnDisk(s.merchantId);
  assert.equal(files.length, 1);
  await stat(join(uploadDir, s.merchantId, files[0]!));
});

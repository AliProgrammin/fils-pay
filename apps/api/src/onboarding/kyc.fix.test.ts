/**
 * "PDF only" document types must be checked by the detected content (magic
 * bytes), not by the client's filename (ARCHITECTURE: "KYC uploads are
 * validated by detected content type"). Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { AppError } from "../lib/errors.js";
import { recordKycDocument } from "./kyc.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("kyc.fix.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const uploadDir = await mkdtemp(join(tmpdir(), "kyc-fix-"));
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  KYC_UPLOAD_DIR: uploadDir,
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

test.after(async () => {
  await pool.end();
  await rm(uploadDir, { recursive: true, force: true });
});

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PDF_BYTES = Buffer.from("%PDF-1.4\n%fake but magic-correct\n");

async function merchantWithUser(): Promise<{ merchantId: string; userId: string }> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`KYC Fix ${randomUUID()}`],
  );
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role)
     VALUES ($1, $2, 'unused', 'owner') RETURNING id`,
    [m.rows[0]!.id, `kyc-${randomUUID()}@kyc.test`],
  );
  return { merchantId: m.rows[0]!.id, userId: u.rows[0]!.id };
}

test("a JPEG renamed to .pdf is rejected for a PDF-only document type", async () => {
  const { merchantId, userId } = await merchantWithUser();
  await assert.rejects(
    recordKycDocument(pool, config, {
      merchantId,
      documentType: "commercial_registration",
      fileName: "CR-2026.pdf",
      buffer: JPEG_BYTES,
      uploadedBy: userId,
    }),
    (err: unknown) => err instanceof AppError && err.code === "document_must_be_pdf",
  );
});

test("a real PDF named .pdf is accepted for a PDF-only document type", async () => {
  const { merchantId, userId } = await merchantWithUser();
  const result = await recordKycDocument(pool, config, {
    merchantId,
    documentType: "bank_letter",
    fileName: "scan_0001.PDF",
    buffer: PDF_BYTES,
    uploadedBy: userId,
  });
  assert.equal(result.mimeType, "application/pdf");
});

// Contract kept (original handover): the name must also end in .pdf.
test("real PDF bytes named .docx are rejected for a PDF-only document type", async () => {
  const { merchantId, userId } = await merchantWithUser();
  await assert.rejects(
    recordKycDocument(pool, config, {
      merchantId,
      documentType: "commercial_registration",
      fileName: "registration.docx",
      buffer: PDF_BYTES,
      uploadedBy: userId,
    }),
    (err: unknown) => err instanceof AppError && err.code === "document_must_be_pdf",
  );
});

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import { withTransaction } from "../db/withTransaction.js";
import { sha256Hex } from "../lib/crypto.js";
import { NotFoundError, UnprocessableEntityError } from "../lib/errors.js";
import { UUID_RE } from "../admin/merchants.js";
import { detectFileType, extensionFor, mimeTypeFor } from "./fileSignature.js";
import { generateKycThumbnail } from "./kycThumbnail.js";

export type KycDocumentType = "commercial_registration" | "owner_id" | "proof_of_address" | "bank_letter";

/** Document types the registry/bank issues as a PDF, never as a photo. */
const PDF_ONLY_DOCUMENT_TYPES: readonly KycDocumentType[] = ["commercial_registration", "bank_letter"];

/** @property fileName Never trusted for the type; only the PDF-only name rule reads it. */
export interface RecordKycDocumentInput {
  merchantId: string;
  documentType: KycDocumentType;
  fileName: string;
  buffer: Buffer;
  uploadedBy: string;
}

export interface RecordKycDocumentResult {
  id: string;
  documentType: KycDocumentType;
  fileName: string;
  mimeType: string;
  uploadedAt: Date;
  onboardingStatus: string;
  hasThumbnail: boolean;
}

/**
 * Validates the upload from its own bytes (never the client-supplied
 * filename or Content-Type), writes it to disk under
 * `config.kycUploadDir/<merchantId>/<sha256>.<ext>`, and records it — moving
 * onboarding_status to 'under_review' as a side effect of "documents are
 * now in the queue," never touching kyc_passed.
 */
export async function recordKycDocument(
  pool: Pool,
  config: Config,
  input: RecordKycDocumentInput,
): Promise<RecordKycDocumentResult> {
  // The detected bytes decide the type; the client fileName is never
  // trusted for it (A10).
  const detected = detectFileType(input.buffer);
  if (!detected) {
    throw new UnprocessableEntityError("invalid_file_type");
  }

  // Commercial registration certificates and bank letters are always
  // issued as PDFs by the registry or the bank — a phone photo of either
  // isn't an acceptable substitute for review. Both must hold: the bytes
  // are a PDF (A10) and the name ends in .pdf (the original contract).
  if (
    PDF_ONLY_DOCUMENT_TYPES.includes(input.documentType) &&
    (detected !== "pdf" || !input.fileName.toLowerCase().endsWith(".pdf"))
  ) {
    throw new UnprocessableEntityError("document_must_be_pdf", "commercial_registration and bank_letter documents must be a PDF");
  }

  // Thumbnail first: it can reject the image (422), and nothing is on disk yet.
  const thumbnail = await generateKycThumbnail(input.buffer, detected);
  const mimeType = mimeTypeFor(detected);

  const sha256 = sha256Hex(input.buffer);
  const storageKey = join(input.merchantId, `${sha256}.${extensionFor(detected)}`);
  const thumbnailStorageKey = thumbnail ? join(input.merchantId, `${sha256}.thumb.jpg`) : null;
  await mkdir(join(config.kycUploadDir, input.merchantId), { recursive: true });

  // Files are named by content hash, so an earlier upload of the same bytes may
  // own the file already. Track only the files this call creates, and remove
  // just those if the insert fails: no orphans, and never another row's file.
  const createdPaths: string[] = [];
  try {
    if (await writeFileIfAbsent(join(config.kycUploadDir, storageKey), input.buffer)) {
      createdPaths.push(join(config.kycUploadDir, storageKey));
    }
    if (thumbnail && thumbnailStorageKey) {
      const thumbPath = join(config.kycUploadDir, thumbnailStorageKey);
      if (await writeFileIfAbsent(thumbPath, thumbnail.buffer)) createdPaths.push(thumbPath);
    }
    return await insertKycDocument(pool, input, { mimeType, storageKey, sha256, thumbnailStorageKey, thumbnail });
  } catch (err) {
    await Promise.all(createdPaths.map((path) => rm(path, { force: true })));
    throw err;
  }
}

/** Writes `data` only if `path` does not exist. Returns true when it created the file. */
async function writeFileIfAbsent(path: string, data: Buffer): Promise<boolean> {
  try {
    await writeFile(path, data, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

async function insertKycDocument(
  pool: Pool,
  input: RecordKycDocumentInput,
  stored: {
    mimeType: string;
    storageKey: string;
    sha256: string;
    thumbnailStorageKey: string | null;
    thumbnail: { mimeType: string } | null;
  },
): Promise<RecordKycDocumentResult> {
  const { mimeType, storageKey, sha256, thumbnailStorageKey, thumbnail } = stored;
  return withTransaction(pool, async (client) => {
    const inserted = await client.query<{ id: string; uploaded_at: Date }>(
      `INSERT INTO kyc_documents
         (merchant_id, document_type, file_name, mime_type, file_size_bytes, storage_key, sha256, uploaded_by,
          thumbnail_storage_key, thumbnail_mime_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, uploaded_at`,
      [
        input.merchantId,
        input.documentType,
        input.fileName,
        mimeType,
        input.buffer.length,
        storageKey,
        sha256,
        input.uploadedBy,
        thumbnailStorageKey,
        thumbnail ? thumbnail.mimeType : null,
      ],
    );
    const doc = inserted.rows[0];
    if (!doc) {
      throw new Error("recordKycDocument: insert into kyc_documents returned no row");
    }

    const merchantResult = await client.query<{ onboarding_status: string }>(
      `SELECT onboarding_status FROM merchants WHERE id = $1 FOR UPDATE`,
      [input.merchantId],
    );
    const merchant = merchantResult.rows[0];
    if (!merchant) {
      throw new NotFoundError("merchant_not_found");
    }

    let onboardingStatus = merchant.onboarding_status;
    if (onboardingStatus === "submitted" || onboardingStatus === "rejected") {
      onboardingStatus = "under_review";
      await client.query(`UPDATE merchants SET onboarding_status = 'under_review' WHERE id = $1`, [
        input.merchantId,
      ]);
    }

    return {
      id: doc.id,
      documentType: input.documentType,
      fileName: input.fileName,
      mimeType,
      uploadedAt: doc.uploaded_at,
      onboardingStatus,
      hasThumbnail: thumbnail !== null,
    };
  });
}

export interface KycDocumentSummary {
  id: string;
  documentType: KycDocumentType;
  fileName: string;
  mimeType: string;
  uploadedAt: Date;
}

/**
 * Metadata only, never file bytes.
 * — FH
 */
export async function listKycDocuments(pool: Pool, merchantId: string): Promise<KycDocumentSummary[]> {
  const result = await pool.query<{
    id: string;
    document_type: KycDocumentType;
    file_name: string;
    mime_type: string;
    uploaded_at: Date;
  }>(
    `SELECT id, document_type, file_name, mime_type, uploaded_at
       FROM kyc_documents
      WHERE merchant_id = $1
      ORDER BY uploaded_at DESC`,
    [merchantId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    documentType: row.document_type,
    fileName: row.file_name,
    mimeType: row.mime_type,
    uploadedAt: row.uploaded_at,
  }));
}

export interface KycDocumentFile {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

export async function getKycDocumentFile(
  pool: Pool,
  config: Config,
  merchantId: string,
  documentId: string,
): Promise<KycDocumentFile> {
  if (!UUID_RE.test(documentId)) {
    throw new NotFoundError("kyc_document_not_found");
  }
  const result = await pool.query<{ storage_key: string; mime_type: string; file_name: string }>(
    `SELECT storage_key, mime_type, file_name FROM kyc_documents WHERE id = $1 AND merchant_id = $2`,
    [documentId, merchantId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("kyc_document_not_found");
  }
  const buffer = await readFile(join(config.kycUploadDir, row.storage_key));
  return { buffer, mimeType: row.mime_type, fileName: row.file_name };
}

/** The review-UI preview counterpart of `getKycDocumentFile`. A document
 *  with no thumbnail (a PDF, or anything uploaded before 0038) is a 404,
 *  not an empty body — same not-found convention as the document itself. */
/** null for PDFs, which have no thumbnail. */
export async function getKycThumbnailFile(
  pool: Pool,
  config: Config,
  merchantId: string,
  documentId: string,
): Promise<KycDocumentFile> {
  if (!UUID_RE.test(documentId)) {
    throw new NotFoundError("kyc_thumbnail_not_found");
  }
  const result = await pool.query<{
    thumbnail_storage_key: string | null;
    thumbnail_mime_type: string | null;
    file_name: string;
  }>(
    `SELECT thumbnail_storage_key, thumbnail_mime_type, file_name
       FROM kyc_documents WHERE id = $1 AND merchant_id = $2`,
    [documentId, merchantId],
  );
  const row = result.rows[0];
  if (!row || !row.thumbnail_storage_key || !row.thumbnail_mime_type) {
    throw new NotFoundError("kyc_thumbnail_not_found");
  }
  const buffer = await readFile(join(config.kycUploadDir, row.thumbnail_storage_key));
  return { buffer, mimeType: row.thumbnail_mime_type, fileName: row.file_name };
}

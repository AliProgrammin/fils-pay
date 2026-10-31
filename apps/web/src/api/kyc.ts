import { request, requestBlob } from "./client.js";
import type { KycDocumentDto, KycDocumentType, KycUploadResponse } from "../types.js";

/** The list is open to every role; upload and the file itself are
 *  `owner`/`finance` only. */
export function listKycDocuments(merchantId: string): Promise<KycDocumentDto[]> {
  return request(`/v1/merchants/${encodeURIComponent(merchantId)}/kyc/documents`);
}

/** `201`. Multipart with exactly one file. The API checks the file's own
 *  bytes, not its name: `422 invalid_file_type` / `document_must_be_pdf`,
 *  and `413 file_too_large` over the size limit. */
export function uploadKycDocument(
  merchantId: string,
  documentType: KycDocumentType,
  file: File,
): Promise<KycUploadResponse> {
  const form = new FormData();
  // The type field goes first, so the server reads it before the file.
  form.append("documentType", documentType);
  form.append("file", file, file.name);
  return request(`/v1/merchants/${encodeURIComponent(merchantId)}/kyc/documents`, {
    method: "POST",
    body: form,
  });
}

/** The original upload, as the browser got it. */
export function getKycDocumentFile(merchantId: string, documentId: string): Promise<Blob> {
  return requestBlob(
    `/v1/merchants/${encodeURIComponent(merchantId)}/kyc/documents/${encodeURIComponent(documentId)}/file`,
  );
}

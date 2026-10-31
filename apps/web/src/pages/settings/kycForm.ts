import { KYC_MAX_FILE_BYTES, KYC_MAX_FILE_MB } from "../../inputRules.js";
import type { KycDocumentType } from "../../types.js";

/** The four document types the API accepts (routes/kyc.ts), in plain words.
 *  `pdfOnly` mirrors onboarding/kyc.ts PDF_ONLY_DOCUMENT_TYPES: the registry
 *  and the bank issue these as PDFs, never as photos. */
export const KYC_DOCUMENT_TYPES: { value: KycDocumentType; label: string; pdfOnly: boolean }[] = [
  { value: "commercial_registration", label: "Commercial registration (CR)", pdfOnly: true },
  { value: "owner_id", label: "Owner ID (CPR or passport)", pdfOnly: false },
  { value: "proof_of_address", label: "Proof of address", pdfOnly: false },
  { value: "bank_letter", label: "Bank letter", pdfOnly: true },
];

export function kycDocumentLabel(type: string): string {
  return KYC_DOCUMENT_TYPES.find((t) => t.value === type)?.label ?? type.replace(/_/g, " ");
}

/** What the file picker offers for this type. */
export function kycAccept(type: KycDocumentType): string {
  return KYC_DOCUMENT_TYPES.find((t) => t.value === type)?.pdfOnly
    ? ".pdf,application/pdf"
    : ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";
}

/**
 * Null when the file may be sent. Checks only what the API checks the same
 * way: the size limit, and the ".pdf" name a PDF-only type needs. The file
 * type itself is decided by the API from the file's bytes, so a wrong file
 * comes back as `422` and is shown in plain words.
 */
export function checkKycFile(type: KycDocumentType, file: { name: string; size: number } | null): string | null {
  if (!file) return "Choose a file to upload";
  if (file.size === 0) return "This file is empty. Choose another file";
  if (file.size > KYC_MAX_FILE_BYTES) {
    return `This file is ${(file.size / 1_048_576).toFixed(1)} MB. The largest file you can upload is ${KYC_MAX_FILE_MB} MB`;
  }
  const pdfOnly = KYC_DOCUMENT_TYPES.find((t) => t.value === type)?.pdfOnly ?? false;
  if (pdfOnly && !file.name.toLowerCase().endsWith(".pdf")) {
    return `${kycDocumentLabel(type)}: this document must be a PDF file (its name must end in .pdf)`;
  }
  return null;
}

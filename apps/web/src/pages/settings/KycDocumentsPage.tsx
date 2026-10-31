import { useCallback, useEffect, useId, useRef, useState } from "react";
import { getKycDocumentFile, listKycDocuments, uploadKycDocument } from "../../api/kyc.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { FieldNote, describedBy } from "../../components/FieldNote.js";
import { StatusChip } from "../../components/StatusChip.js";
import { useToast } from "../../components/Toast.js";
import { useAction } from "../../components/useAction.js";
import { errorMessage } from "../../errors.js";
import { dateTime } from "../../format.js";
import { KYC_MAX_FILE_MB } from "../../inputRules.js";
import type { KycDocumentDto, KycDocumentType } from "../../types.js";
import { KYC_DOCUMENT_TYPES, checkKycFile, kycAccept, kycDocumentLabel } from "./kycForm.js";

const FILE_KINDS: Record<string, string> = {
  "application/pdf": "PDF",
  "image/jpeg": "JPEG image",
  "image/png": "PNG image",
};

/**
 * `/v1/merchants/:merchantId/kyc/documents`. Every role can see the list;
 * only `owner`/`finance` can upload and open a file, so a `support` user
 * sees the list without the upload form or the file buttons.
 *
 * The first upload moves the shop's account check to "under review", so
 * the session is re-read after an upload to show the new status.
 */
export function KycDocumentsPage() {
  const { me, refresh } = useDashboardAuth();
  const merchantId = me?.merchant.id;

  const [documents, setDocuments] = useState<KycDocumentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [documentType, setDocumentType] = useState<KycDocumentType>("commercial_registration");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploading, runUpload] = useAction();
  const [openingId, setOpeningId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileNoteId = useId();
  const notify = useToast();
  const pdfOnly = KYC_DOCUMENT_TYPES.find((t) => t.value === documentType)?.pdfOnly ?? false;

  const load = useCallback(async () => {
    if (!merchantId) return;
    setLoading(true);
    try {
      setDocuments(await listKycDocuments(merchantId));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [merchantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleUpload(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId) return;
    const problem = checkKycFile(documentType, file);
    setFileError(problem);
    if (problem || !file) return;
    await runUpload(async () => {
      setError(null);
      try {
        await uploadKycDocument(merchantId, documentType, file);
        notify(`${kycDocumentLabel(documentType)} uploaded`);
        setFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        await Promise.all([load(), refresh()]);
      } catch (err) {
        setError(errorMessage(err, "kycUpload"));
      }
    });
  }

  /** Fetches the file with the session cookie, then hands it to the browser
   *  as a local link: a plain link to the API would show a raw error page
   *  on a 403 or 404 instead of a message here. */
  async function handleOpen(doc: KycDocumentDto, mode: "view" | "download"): Promise<void> {
    if (!merchantId || openingId) return;
    // Opened now, inside the click, so a popup blocker allows it.
    const tab = mode === "view" ? window.open("", "_blank") : null;
    setOpeningId(doc.id);
    setError(null);
    try {
      const url = URL.createObjectURL(await getKycDocumentFile(merchantId, doc.id));
      if (tab) {
        tab.location.href = url;
      } else {
        const link = document.createElement("a");
        link.href = url;
        link.download = doc.fileName;
        link.click();
      }
      // The new tab has loaded it by then; free the memory.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      tab?.close();
      setError(errorMessage(err));
    } finally {
      setOpeningId(null);
    }
  }

  return (
    <section>
      <div className="dash-page-head">
        <div>
          <p className="dash-kicker">Settings · account check</p>
          <h1>KYC documents</h1>
        </div>
      </div>

      {me ? (
        <p className="dash-note">
          Account check: <StatusChip status={me.merchant.onboardingStatus} />. FilsPay reviews the documents you
          upload here before your shop can take real payments.
        </p>
      ) : null}

      {error ? <p className="dash-error" role="alert">{error}</p> : null}

      <RequireRole
        allow={["owner", "finance"]}
        fallback={<p className="dash-note">Only the shop owner or a finance user can upload or open documents.</p>}
      >
        <form className="dash-form dash-card" noValidate onSubmit={(e) => void handleUpload(e)}>
          <label>
            Document type
            <select
              value={documentType}
              onChange={(e) => {
                const next = e.target.value as KycDocumentType;
                setDocumentType(next);
                if (fileError) setFileError(checkKycFile(next, file));
              }}
            >
              {KYC_DOCUMENT_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            File
            <input
              ref={fileInputRef}
              type="file"
              accept={kycAccept(documentType)}
              aria-invalid={fileError ? true : undefined}
              aria-describedby={describedBy(fileNoteId, fileError)}
              onChange={(e) => {
                const next = e.target.files?.[0] ?? null;
                setFile(next);
                setFileError(next ? checkKycFile(documentType, next) : null);
              }}
            />
          </label>
          <FieldNote id={fileNoteId} error={fileError} />
          <p className="dash-muted dash-hint">
            {pdfOnly ? "PDF only" : "PDF, JPEG or PNG"}, up to {KYC_MAX_FILE_MB} MB. One file per upload.
          </p>
          <button type="submit" className="dash-button dash-button-primary" disabled={uploading} aria-busy={uploading || undefined}>
            {uploading ? "Uploading…" : "Upload document"}
          </button>
        </form>
      </RequireRole>

      <div className="dash-table-wrap">
        <table className="dash-table dash-table-cards">
          <thead>
            <tr>
              <th>Document</th>
              <th>File name</th>
              <th>Kind</th>
              <th>Uploaded</th>
              <RequireRole allow={["owner", "finance"]}>
                <th>Actions</th>
              </RequireRole>
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.id}>
                <td data-label="Document">{kycDocumentLabel(doc.documentType)}</td>
                <td data-label="File name" className="dash-wrap">{doc.fileName}</td>
                <td data-label="Kind">{FILE_KINDS[doc.mimeType] ?? doc.mimeType}</td>
                <td className="dash-nowrap" data-label="Uploaded">{dateTime(doc.uploadedAt)}</td>
                <RequireRole allow={["owner", "finance"]}>
                  <td className="dash-nowrap" data-label="Actions">
                    <button
                      type="button"
                      className="dash-button dash-button-small"
                      disabled={openingId !== null}
                      aria-busy={openingId === doc.id || undefined}
                      onClick={() => void handleOpen(doc, "view")}
                    >
                      Open
                    </button>{" "}
                    <button
                      type="button"
                      className="dash-button dash-button-small"
                      disabled={openingId !== null}
                      onClick={() => void handleOpen(doc, "download")}
                    >
                      Download
                    </button>
                  </td>
                </RequireRole>
              </tr>
            ))}
            {documents.length === 0 && !loading && !error ? (
              <tr>
                <td colSpan={5} className="dash-empty">No documents uploaded yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {loading ? <p className="dash-loading" role="status">Loading…</p> : null}
    </section>
  );
}

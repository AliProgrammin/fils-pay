import { useId, useState } from "react";
import {
  getAdjustmentImportRows,
  listAdjustmentImports,
  uploadAdjustmentImport,
} from "../../api/adjustmentImports.js";
import { errorMessage } from "../../errors.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd, formatDateTime } from "../../format.js";
import { Pager } from "../../components/Pager.js";
import { usePagedList } from "../../components/usePagedList.js";
import { useAction } from "../../components/useAction.js";
import { useToast } from "../../components/Toast.js";
import type {
  AdjustmentImportRowDetail,
  AdjustmentImportSummary,
} from "../../types.js";
import { FieldNote, describedBy } from "../../components/FieldNote.js";
import { checkAdjustmentCsv, checkCsvFile, FILENAME_MAX, lengthNote } from "../../inputRules.js";

const CSV_PLACEHOLDER = `merchantId,amount,reason
00000000-0000-0000-0000-000000000000,4.750,statement correction`;

/**
 * "Import adjustments" — paste a CSV of manual balance corrections (or choose
 * a .csv file, which is read in the browser into the same box) and apply
 * them. There is no preview step: the box submits directly, because an
 * adjustment CSV is assembled and checked in the spreadsheet it came from.
 *
 * The history table below drills into per-row detail, which shows the raw
 * CSV text next to the integer that was actually posted.
 */
export function AdjustmentImportPage() {
  const [csvContent, setCsvContent] = useState("");
  const [filename, setFilename] = useState("");
  const notify = useToast();
  const [busy, run] = useAction();
  const [error, setError] = useState<string | null>(null);
  /** Shown after a submit (or a blur) found bad lines; re-checked as you edit. */
  const [showCsvProblems, setShowCsvProblems] = useState(false);
  const csvNoteId = useId();
  const filenameNoteId = useId();
  const fileNoteId = useId();
  const [fileError, setFileError] = useState<string | null>(null);
  const csv = checkAdjustmentCsv(csvContent);
  const csvProblems = showCsvProblems ? csv.problems : [];

  const [openImportId, setOpenImportId] = useState<string | null>(null);
  const [rows, setRows] = useState<AdjustmentImportRowDetail[]>([]);
  const [rowsError, setRowsError] = useState<string | null>(null);

  const history = usePagedList<AdjustmentImportSummary>("imports", async (cursor, limit) => {
    const page = await listAdjustmentImports({ limit, cursor });
    return { rows: page.items, nextCursor: page.nextCursor };
  });
  const imports = history.rows;
  const listError = history.error ? errorMessage(history.error) : null;

  /** Amounts are BD with three decimals and are parsed server-side with parseBhdToFils. */
  async function handleApply(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (csv.problems.length > 0) {
      setShowCsvProblems(true);
      return;
    }
    await run(async () => {
      setError(null);
      try {
        const result = await uploadAdjustmentImport(
          csvContent,
          filename.trim() ? filename.trim() : undefined,
        );
        notify(
          `Applied ${result.rowCount} row${result.rowCount === 1 ? "" : "s"}, posting ${bhd(result.totalPostedFils)} in total`,
        );
        setCsvContent("");
        setFilename("");
        setFileError(null);
        setShowCsvProblems(false);
        history.reload();
      } catch (err) {
        setError(errorMessage(err, "adjustmentImport"));
      }
    });
  }

  /** Reads the chosen file into the CSV box; the API call is the same as for a paste. */
  async function handleFileChosen(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Clear the picker so choosing the same file again (after an edit) reads it again.
    input.value = "";
    if (!file) return;
    const problem = checkCsvFile(file);
    setFileError(problem);
    if (problem) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      setFileError("We could not read this file. Check that it is a CSV and try again.");
      return;
    }
    setCsvContent(text);
    setShowCsvProblems(true);
    if (filename.trim() === "") setFilename(file.name.slice(0, FILENAME_MAX));
  }

  async function handleOpenRows(importId: string): Promise<void> {
    if (openImportId === importId) {
      setOpenImportId(null);
      setRows([]);
      return;
    }
    setRowsError(null);
    try {
      setRows(await getAdjustmentImportRows(importId));
      setOpenImportId(importId);
    } catch (err) {
      setRowsError(errorMessage(err));
    }
  }

  return (
    <section>
      <header className="admin-page-head">
        <p className="admin-kicker">Bulk corrections · Money movement</p>
        <h1>Import adjustments</h1>
        <p className="admin-lede">
          Applies a CSV of manual balance corrections immediately. Each row is recorded in the
          ledger as its own correction. Uploading is gated server-side to the <code>finance</code> and{" "}
          <code>super_admin</code> roles.
        </p>
      </header>

      <div className="admin-panel admin-panel-danger">
        <div className="admin-panel-head">
          <h2>Apply a CSV</h2>
          <span className="admin-danger-tag">Moves money · no preview</span>
        </div>
        <RequireRole
          allow={["finance", "super_admin"]}
          fallback={
            <p className="admin-muted">
              Your role is read-only here. The import history below is still available.
            </p>
          }
        >
          <form className="admin-form" noValidate onSubmit={(e) => void handleApply(e)}>
            <label>
              File name (optional)
              <input
                type="text"
                maxLength={FILENAME_MAX}
                autoComplete="off"
                aria-describedby={describedBy(filenameNoteId, null, lengthNote(filename, FILENAME_MAX))}
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                placeholder="march-corrections.csv"
              />
            </label>
            <FieldNote id={filenameNoteId} note={lengthNote(filename, FILENAME_MAX)} />
            <label>
              Choose a CSV file, or paste the CSV below
              <input
                type="file"
                accept=".csv,text/csv"
                aria-invalid={fileError ? true : undefined}
                aria-describedby={describedBy(fileNoteId, fileError)}
                onChange={(e) => void handleFileChosen(e)}
              />
            </label>
            <FieldNote id={fileNoteId} error={fileError} />
            <label>
              CSV (columns: merchantId, amount, reason)
              <textarea
                value={csvContent}
                onChange={(e) => {
                  setCsvContent(e.target.value);
                  setFileError(null);
                }}
                onBlur={() => {
                  if (csvContent.trim() !== "") setShowCsvProblems(true);
                }}
                rows={8}
                placeholder={CSV_PLACEHOLDER}
                spellCheck={false}
                required
                aria-invalid={csvProblems.length > 0 ? true : undefined}
                aria-describedby={csvProblems.length > 0 || csv.rowCount > 0 ? csvNoteId : undefined}
              />
            </label>
            {csvProblems.length > 0 ? (
              <div id={csvNoteId} role="alert">
                <p className="admin-field-error">Fix these lines before you apply the CSV:</p>
                <ul className="admin-problem-list">
                  {csvProblems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            ) : csv.problems.length === 0 && csv.rowCount > 0 ? (
              <FieldNote
                id={csvNoteId}
                note={`${csv.rowCount} row${csv.rowCount === 1 ? "" : "s"}, ${bhd(csv.totalFils)} in total`}
              />
            ) : null}
            <div>
              <button type="submit" className="admin-btn-danger" disabled={busy || !csvContent.trim()}>
                {busy ? "Applying…" : "Apply"}
              </button>
            </div>
          </form>
        </RequireRole>

        {error ? <p className="admin-error" role="alert">{error}</p> : null}
      </div>

      <div className="admin-panel">
        <h2>Past imports</h2>
        {listError ? <p className="admin-error" role="alert">{listError}</p> : null}
        {history.loading && imports.length === 0 ? (
          <p className="admin-loading" role="status">Loading imports…</p>
        ) : imports.length === 0 ? (
          <p className="admin-empty">No imports yet.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Applied</th>
                  <th>File</th>
                  <th className="admin-num">Rows</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {imports.map((item) => (
                  <tr key={item.id}>
                    <td>{formatDateTime(item.appliedAt)}</td>
                    <td>{item.originalFilename}</td>
                    <td className="admin-num">{item.rowCount}</td>
                    <td className="admin-cell-actions">
                      <button
                        type="button"
                        className="admin-btn-small"
                        aria-expanded={openImportId === item.id}
                        onClick={() => void handleOpenRows(item.id)}
                      >
                        {openImportId === item.id ? "Hide rows" : "View rows"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Pager
          page={history.page}
          size={history.size}
          count={imports.length}
          hasNext={history.hasNext}
          loading={history.loading}
          onPrev={history.goPrev}
          onNext={history.goNext}
          onSize={history.setSize}
        />

        {rowsError ? <p className="admin-error" role="alert">{rowsError}</p> : null}

        {openImportId ? (
          <div>
            <h3>Rows</h3>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th className="admin-num">#</th>
                    <th>Merchant</th>
                    <th className="admin-num">CSV amount</th>
                    <th className="admin-num">Posted</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.rowNumber}>
                      <td className="admin-num">{row.rowNumber}</td>
                      <td>
                        <code>{row.merchantId}</code>
                      </td>
                      <td className="admin-num">
                        <code>{row.rawAmountText}</code>
                      </td>
                      <td className="admin-num admin-strong">{bhd(row.parsedAmountFils)}</td>
                      <td>{row.reason ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

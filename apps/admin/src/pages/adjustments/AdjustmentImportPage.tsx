import { useCallback, useEffect, useState } from "react";
import {
  getAdjustmentImportRows,
  listAdjustmentImports,
  uploadAdjustmentImport,
} from "../../api/adjustmentImports.js";
import { describeError } from "../../api/client.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd, formatDateTime } from "../../format.js";
import type {
  AdjustmentImportRowDetail,
  AdjustmentImportSummary,
} from "../../types.js";

const CSV_PLACEHOLDER = `merchantId,amount,reason
00000000-0000-0000-0000-000000000000,4.750,statement correction`;

/**
 * "Import adjustments" — paste a CSV of manual balance corrections and apply
 * them. There is no preview step: the paste box submits directly, because an
 * adjustment CSV is assembled and checked in the spreadsheet it came from.
 *
 * The history table below drills into per-row detail, which shows the raw
 * CSV text next to the integer that was actually posted.
 */
export function AdjustmentImportPage() {
  const [csvContent, setCsvContent] = useState("");
  const [filename, setFilename] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [imports, setImports] = useState<AdjustmentImportSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);

  const [openImportId, setOpenImportId] = useState<string | null>(null);
  const [rows, setRows] = useState<AdjustmentImportRowDetail[]>([]);
  const [rowsError, setRowsError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setListError(null);
    try {
      const page = await listAdjustmentImports({ limit: 25 });
      setImports(page.items);
    } catch (err) {
      setListError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  /** Amounts are BD with three decimals and are parsed server-side with parseBhdToFils. */
  async function handleApply(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await uploadAdjustmentImport(
        csvContent,
        filename.trim() ? filename.trim() : undefined,
      );
      setNotice(
        `Applied ${result.rowCount} row(s), posting ${bhd(result.totalPostedFils)} in total.`,
      );
      setCsvContent("");
      setFilename("");
      await loadHistory();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
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
      setRowsError(describeError(err));
    }
  }

  return (
    <section>
      <header className="admin-page-head">
        <p className="admin-kicker">Bulk corrections · Money movement</p>
        <h1>Import adjustments</h1>
        <p className="admin-lede">
          Applies a CSV of manual balance corrections immediately — one balanced ledger posting per
          row. Uploading is gated server-side to the <code>finance</code> and{" "}
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
          <form className="admin-form" onSubmit={(e) => void handleApply(e)}>
            <label>
              File name (optional)
              <input
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                placeholder="march-corrections.csv"
              />
            </label>
            <label>
              CSV (columns: merchantId, amount, reason)
              <textarea
                value={csvContent}
                onChange={(e) => setCsvContent(e.target.value)}
                rows={8}
                placeholder={CSV_PLACEHOLDER}
                required
              />
            </label>
            <div>
              <button type="submit" className="admin-btn-danger" disabled={busy || !csvContent.trim()}>
                {busy ? "Applying…" : "Apply"}
              </button>
            </div>
          </form>
        </RequireRole>

        {error ? <p className="admin-error" role="alert">{error}</p> : null}
        {notice ? <p className="admin-notice" role="status">{notice}</p> : null}
      </div>

      <div className="admin-panel">
        <h2>Past imports</h2>
        {listError ? <p className="admin-error" role="alert">{listError}</p> : null}
        {imports.length === 0 ? (
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

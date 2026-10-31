import { useEffect, useState } from "react";
import {
  REPORT_ROW_LIMIT,
  getExportSummary,
  getTransactionsReport,
  type ExportSummary,
} from "../../api/reporting.js";
import { errorMessage } from "../../errors.js";
import { bhd } from "../../format.js";
import { bahrainToday } from "../../dateRange.js";
import { formatCount } from "../../utils/helpers.js";
import { useAction } from "../../components/useAction.js";
import { useToast } from "../../components/Toast.js";
import { csvFileName, reportCsv, toReportFilter, type PageFilters } from "./reportFilters.js";

function downloadCsv(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  // Freed after the click has handed the file to the browser.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Two reporting reads:
 * - `GET /v1/reporting/export-summary`: all-time totals. It takes no filter,
 *   so the panel says so and never shows them as the filtered figures.
 * - `GET /v1/reporting/transactions`: the CSV, built in the browser from the
 *   current filters. That route returns the newest 500 rows at most, takes
 *   one status and no search; the panel says when a file is cut or can't be made.
 */
export function ExportPanel({ filters, dateError }: { filters: PageFilters; dateError: string | null }) {
  const notify = useToast();
  const [summary, setSummary] = useState<ExportSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [cutAt, setCutAt] = useState(false);
  const [downloading, runDownload] = useAction();
  const report = toReportFilter(filters);
  const blocked = dateError ?? (report.ok ? null : report.message);
  const filterKey = JSON.stringify(filters);

  useEffect(() => {
    let cancelled = false;
    getExportSummary()
      .then((result) => {
        if (!cancelled) setSummary(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setSummaryError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A message about the last file belongs to the filters it was made with.
  useEffect(() => {
    setDownloadError(null);
    setCutAt(false);
  }, [filterKey]);

  async function download(): Promise<void> {
    if (!report.ok || dateError) return;
    setDownloadError(null);
    await runDownload(async () => {
      try {
        const rows = await getTransactionsReport(report.filter);
        downloadCsv(reportCsv(rows), csvFileName(filters, bahrainToday()));
        setCutAt(rows.length >= REPORT_ROW_LIMIT);
        notify(rows.length === 0 ? "CSV downloaded (no payments match)" : "CSV downloaded");
      } catch (err) {
        setDownloadError(errorMessage(err));
      }
    });
  }

  return (
    <section className="dash-panel" aria-labelledby="export-panel-title">
      <div className="dash-panel-head">
        <h2 className="dash-panel-title" id="export-panel-title">Export</h2>
        <span className="dash-panel-meta">All time · amounts in BHD</span>
      </div>
      <div className="dash-panel-body">
        {summaryError ? <p className="dash-error" role="alert">{summaryError}</p> : null}
        {summary ? (
          <dl className="dash-dl dash-dl-money">
            <dt>
              Days with activity
              <span className="dash-dt-help">Bahrain days with at least one capture, void or refund.</span>
            </dt>
            <dd className="dash-money">{formatCount(summary.totalDays)}</dd>
            <dt>Captured</dt>
            <dd className="dash-money">{bhd(summary.grossFils)}</dd>
            <dt>Refunded</dt>
            <dd className="dash-money">{bhd(summary.refundedFils)}</dd>
            <dt className="dash-dl-total">
              Captured less refunds
              <span className="dash-dt-help">Before FilsPay fees.</span>
            </dt>
            <dd className="dash-money dash-dl-total">{bhd(summary.grossFils - summary.refundedFils)}</dd>
          </dl>
        ) : !summaryError ? (
          <p className="dash-loading" role="status">Loading…</p>
        ) : null}
        <p className="dash-note">
          These totals cover every day on record and do not follow the filters above. The reporting service
          updates them, so the newest payments can take a short time to appear.
        </p>

        <div className="dash-actions">
          <button
            type="button"
            className="dash-button dash-button-primary"
            disabled={downloading || blocked !== null}
            aria-busy={downloading || undefined}
            onClick={() => void download()}
          >
            {downloading ? "Preparing…" : "Download CSV"}
          </button>
          <span className="dash-muted">Payments that match the filters above, newest first.</span>
        </div>
        {blocked ? <p className="dash-hint">{blocked}</p> : null}
        {downloadError ? <p className="dash-error" role="alert">{downloadError}</p> : null}
        {cutAt ? (
          <p className="dash-callout" role="status">
            The file has the newest {REPORT_ROW_LIMIT} payments only. Choose a shorter date range to get the rest.
          </p>
        ) : null}
      </div>
    </section>
  );
}

import { request } from "./client.js";
import { buildQuery } from "./query.js";

/**
 * The `/v1/reporting/*` reads and writes (apps/api/src/routes/reporting.ts).
 * Every route is merchant-scoped from the session cookie and open to every
 * merchant role. Types live here, not in ../types.ts, because only the
 * Transactions page uses them.
 */

/** `GET /v1/reporting/transactions` filter: one status, ISO instants
 *  (`occurred_at >= from`, `occurred_at < to`). */
export interface TransactionReportFilter {
  status?: string;
  from?: string;
  to?: string;
}

/** One report row. Money is BD text with 3 decimals ("12.500"), not fils,
 *  unlike the rest of the API. */
export interface TransactionReportRow {
  id: string;
  merchantId: string;
  status: string;
  amountBhd: string;
  capturedBhd: string;
  refundedBhd: string;
  reference: string | null;
  occurredAt: string;
}

/** The API answers at most this many rows, newest first. */
export const REPORT_ROW_LIMIT = 500;

/** `200 TransactionReportRow[]`. This is the one route that takes its filter
 *  as a JSON object in a single `filter` query param. */
export function getTransactionsReport(filter: TransactionReportFilter): Promise<TransactionReportRow[]> {
  return request(`/v1/reporting/transactions${buildQuery({ filter: JSON.stringify(filter) })}`);
}

/** The API stores `filter` as opaque JSON and returns it as it was sent. */
export interface SavedFilterDto {
  id: string;
  name: string;
  filter: Record<string, unknown>;
  createdAt: string;
}

/** `200 SavedFilterDto[]`, newest first. There is no delete route. */
export function listSavedFilters(): Promise<SavedFilterDto[]> {
  return request("/v1/reporting/saved-filters");
}

/** `201 SavedFilterDto`. */
export function createSavedFilter(input: { name: string; filter: Record<string, unknown> }): Promise<SavedFilterDto> {
  return request("/v1/reporting/saved-filters", { method: "POST", body: JSON.stringify(input) });
}

/**
 * `GET /v1/reporting/export-summary`: all-time totals from the reporting
 * rollup (merchant_daily_volume). Takes no filter.
 * @property totalDays Asia/Bahrain days with at least one capture, void or refund.
 * @property grossFils Captured amount, integer fils.
 * @property refundedFils Refunded amount, integer fils.
 */
export interface ExportSummary {
  totalDays: number;
  grossFils: number;
  refundedFils: number;
}

export function getExportSummary(): Promise<ExportSummary> {
  return request("/v1/reporting/export-summary");
}

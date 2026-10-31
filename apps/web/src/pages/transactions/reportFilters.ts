import { bahrainDayStartIso, exclusiveTo, inclusiveTo, isDateValue } from "../../dateRange.js";
import type { TransactionReportFilter, TransactionReportRow } from "../../api/reporting.js";
import type { TransactionStatus } from "../../types.js";

/**
 * Pure logic behind saved filters and the CSV download on the Transactions
 * page (no React), so it runs under plain `tsx --test`.
 */

export const TRANSACTION_STATUSES: TransactionStatus[] = [
  "authorized",
  "captured",
  "partially_captured",
  "voided",
  "partially_refunded",
  "refunded",
  "chargeback",
];

/** The Transactions page's filters as the URL holds them. `to` is the
 *  inclusive Bahrain date the person sees. */
export interface PageFilters {
  statuses: TransactionStatus[];
  from: string;
  to: string;
  search: string;
}

/** No API limit; kept short so the saved-filter buttons stay readable. */
export const SAVED_FILTER_NAME_MAX = 60;

/**
 * The body stored for a saved filter: Bahrain dates (not times), `to`
 * exclusive like every API `to`. Empty fields are left out.
 */
export function toSavedFilter(f: PageFilters): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.statuses.length > 0) out.status = [...f.statuses];
  if (f.from) out.from = f.from;
  if (f.to) out.to = exclusiveTo(f.to);
  if (f.search) out.search = f.search;
  return out;
}

const SAVED_KEYS = new Set(["status", "from", "to", "search"]);

/**
 * A stored filter as page filters, or null when this page cannot show it
 * exactly (for example one saved through the API with times or other keys).
 * A filter is never applied in part.
 */
export function fromSavedFilter(filter: Record<string, unknown>): PageFilters | null {
  if (Object.keys(filter).some((key) => !SAVED_KEYS.has(key))) return null;
  const { status, from, to, search } = filter;
  const rawStatuses = status === undefined ? [] : typeof status === "string" ? [status] : status;
  if (!Array.isArray(rawStatuses)) return null;
  if (!rawStatuses.every((s) => TRANSACTION_STATUSES.includes(s as TransactionStatus))) return null;
  if (from !== undefined && (typeof from !== "string" || !isDateValue(from))) return null;
  if (to !== undefined && (typeof to !== "string" || !isDateValue(to))) return null;
  if (search !== undefined && typeof search !== "string") return null;
  return {
    statuses: TRANSACTION_STATUSES.filter((s) => rawStatuses.includes(s)),
    from: from ?? "",
    to: to ? inclusiveTo(to) : "",
    search: search ?? "",
  };
}

/** True when two filter sets select the same payments (status order ignored). */
export function sameFilters(a: PageFilters, b: PageFilters): boolean {
  return (
    a.from === b.from &&
    a.to === b.to &&
    a.search === b.search &&
    a.statuses.length === b.statuses.length &&
    a.statuses.every((s) => b.statuses.includes(s))
  );
}

/** Null when the name can be saved, else a plain message. */
export function checkFilterName(name: string, existing: string[]): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Enter a name for these filters.";
  if (trimmed.length > SAVED_FILTER_NAME_MAX) return `Use at most ${SAVED_FILTER_NAME_MAX} characters.`;
  if (existing.some((n) => n.trim().toLowerCase() === trimmed.toLowerCase())) {
    return "You already have saved filters with this name. Choose another name.";
  }
  return null;
}

export type ReportFilterResult = { ok: true; filter: TransactionReportFilter } | { ok: false; message: string };

/**
 * The page filters as a `GET /v1/reporting/transactions` filter. That route
 * takes one status at most and has no search, so those cases are refused
 * with a message, never sent wider than what the page shows.
 */
export function toReportFilter(f: PageFilters): ReportFilterResult {
  if (f.search) return { ok: false, message: "The CSV can't use a search. Clear the search box to download." };
  if (f.statuses.length > 1) {
    return { ok: false, message: "The CSV can use one status at most. Choose one status, or none, to download." };
  }
  const filter: TransactionReportFilter = {};
  if (f.statuses[0]) filter.status = f.statuses[0];
  if (f.from) filter.from = bahrainDayStartIso(f.from);
  if (f.to) filter.to = bahrainDayStartIso(exclusiveTo(f.to));
  return { ok: true, filter };
}

const BAHRAIN_OFFSET_MS = 3 * 60 * 60 * 1000;

/** `2026-10-30T07:00:00.000Z` -> `2026-10-30 10:00:00` (Asia/Bahrain). */
export function bahrainTimestamp(iso: string): string {
  return new Date(Date.parse(iso) + BAHRAIN_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
}

/** One CSV cell: quoted when needed, and a leading = + - @ is made plain
 *  text so a spreadsheet never runs a reference typed by a customer. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const CSV_HEADER = [
  "Occurred (Asia/Bahrain)",
  "Reference",
  "Status",
  "Authorized (BHD)",
  "Captured (BHD)",
  "Refunded (BHD)",
  "Transaction ID",
];

/** The report rows as CSV text (CRLF line ends, header first). */
export function reportCsv(rows: TransactionReportRow[]): string {
  const lines = [CSV_HEADER, ...rows.map((r) => [
    bahrainTimestamp(r.occurredAt),
    r.reference ?? "",
    r.status,
    r.amountBhd,
    r.capturedBhd,
    r.refundedBhd,
    r.id,
  ])];
  return `${lines.map((cells) => cells.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** `filspay-transactions-2026-10-01-to-2026-10-31.csv`, from the inclusive dates. */
export function csvFileName(f: PageFilters, today: string): string {
  const parts = ["filspay-transactions"];
  if (f.statuses[0]) parts.push(f.statuses[0].replace(/_/g, "-"));
  parts.push(f.from || "start", "to", f.to || today);
  return `${parts.join("-")}.csv`;
}

import { formatBhd, toFils } from "@filspay/money";

/**
 * The dashboard's display helpers. Deliberately thin: `bhd` delegates to
 * `@filspay/money`'s `formatBhd`, the same formatter the checkout page uses,
 * so there is exactly one answer to "how is a BHD amount shown" across both
 * halves of this app. Never `/1000`, never `toFixed`.
 */
// Negative amounts are real here (refunds, a reconciliation gap), so allow them.
export function bhd(amountFils: number): string {
  return `${formatBhd(toFils(amountFils, { allowNegative: true }))} BHD`;
}

/** `—` for a null/absent value, so an empty table cell is visibly empty
 *  rather than ambiguously blank. */
export function dash(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

/**
 * Every date and time on the dashboard is shown in Asia/Bahrain, the business
 * time zone the rest of the platform uses, whatever the viewer's browser is
 * set to. One formatter each, so no page invents its own style.
 */
const BAHRAIN_DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bahrain",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const BAHRAIN_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bahrain",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// A plain calendar date (YYYY-MM-DD) has no zone; format it as-is in UTC so
// it never shifts by a day.
const CALENDAR_DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "2-digit",
  month: "short",
  year: "numeric",
});

/** Formats with a three-letter month everywhere (some engines write "Sept"). */
function shortMonth(format: Intl.DateTimeFormat, date: Date): string {
  return format
    .formatToParts(date)
    .map((part) => (part.type === "month" ? part.value.slice(0, 3) : part.value))
    .join("");
}

/** `"30 Aug 2026, 07:05"` in Asia/Bahrain, or `—` when absent. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : shortMonth(BAHRAIN_DATE_TIME, date);
}

/** `"07:05"` in Asia/Bahrain, or `—` when absent. */
export function timeOfDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : BAHRAIN_TIME.format(date);
}

/** A business date (`"2026-08-30"`) as `"30 Aug 2026"`. Anything that is not
 *  a YYYY-MM-DD date is returned unchanged rather than guessed at. */
export function calendarDate(value: string | null | undefined): string {
  if (!value) return "—";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : shortMonth(CALENDAR_DATE, date);
}

/**
 * An `<input type="date">` value (YYYY-MM-DD) as the ISO instant that day
 * starts in Asia/Bahrain (UTC+3, no DST) — the business day the rest of the
 * platform uses. Used for both `from` (inclusive) and `to` (exclusive), so
 * "to" ends at the Bahrain midnight that starts the chosen day.
 */
export function dayStartIso(dateValue: string): string | undefined {
  return dateValue ? `${dateValue}T00:00:00+03:00` : undefined;
}

/**
 * A `<input type="datetime-local">` value (local wall time, no zone) as an
 * ISO 8601 instant. `new Date(local)` interprets it in the browser's own
 * timezone, which is what the user meant when they typed it.
 */
export function localDateTimeToIso(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

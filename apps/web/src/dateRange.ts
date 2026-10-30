/**
 * Date-range helpers for every date filter in the dashboard. Pure (no React,
 * no Vite env), so they run under plain `tsx --test`.
 *
 * Dates are Asia/Bahrain calendar dates (YYYY-MM-DD). Bahrain is UTC+3 with
 * no daylight saving, so a fixed offset is exact.
 *
 * The UI shows "To" as INCLUSIVE (the last day the person wants to see). The
 * API's `to` is EXCLUSIVE, so every caller sends `exclusiveTo(to)` — the day
 * after — and the request means exactly what it meant before.
 */

const DAY_MS = 86_400_000;
const BAHRAIN_OFFSET_MS = 3 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real YYYY-MM-DD calendar date. */
export function isDateValue(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Today's Asia/Bahrain calendar date. */
export function bahrainToday(now: Date = new Date()): string {
  return new Date(now.getTime() + BAHRAIN_OFFSET_MS).toISOString().slice(0, 10);
}

/** Adds `days` (may be negative) to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The inclusive "To" the person picked, as the API's exclusive `to`. */
export function exclusiveTo(toInclusive: string): string {
  return addDays(toInclusive, 1);
}

/** The API's exclusive `to`, as the inclusive last day to show a person. */
export function inclusiveTo(toExclusive: string): string {
  return addDays(toExclusive, -1);
}

/** The instant a Bahrain calendar day starts, e.g. `2026-10-30T00:00:00+03:00`. */
export function bahrainDayStartIso(date: string): string {
  return `${date}T00:00:00+03:00`;
}

export type DatePresetId = "today" | "yesterday" | "last7" | "thisMonth" | "lastMonth";

export const DATE_PRESETS: ReadonlyArray<{ id: DatePresetId; label: string }> = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "last7", label: "Last 7 days" },
  { id: "thisMonth", label: "This month" },
  { id: "lastMonth", label: "Last month" },
];

/** A preset as an inclusive { from, to } range of Bahrain dates. */
export function presetRange(id: DatePresetId, now: Date = new Date()): { from: string; to: string } {
  const today = bahrainToday(now);
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (id) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const yesterday = addDays(today, -1);
      return { from: yesterday, to: yesterday };
    }
    case "last7":
      return { from: addDays(today, -6), to: today };
    case "thisMonth":
      return { from: monthStart, to: today };
    case "lastMonth": {
      const lastDay = addDays(monthStart, -1);
      return { from: `${lastDay.slice(0, 7)}-01`, to: lastDay };
    }
  }
}

/**
 * A plain message when the range cannot be sent, or `null` when it can.
 * Empty values are allowed (no bound). Callers make no request on a message.
 */
export function rangeError(from: string, to: string, today: string): string | null {
  if (from && !isDateValue(from)) return "Enter a valid From date.";
  if (to && !isDateValue(to)) return "Enter a valid To date.";
  if (from && from > today) return "From can't be later than today.";
  if (to && to > today) return "To can't be later than today.";
  if (from && to && to < from) return "To is before From. Choose a To date on or after the From date.";
  return null;
}

const SHORT_DATE = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });

function shortDate(date: string): string {
  return SHORT_DATE.formatToParts(new Date(`${date}T00:00:00Z`))
    .map((part) => (part.type === "month" ? part.value.slice(0, 3) : part.value))
    .join("");
}

/** A short label for an inclusive range: "30 Oct–31 Oct", "30 Oct",
 *  "from 30 Oct", "until 31 Oct", or "" for no range. */
export function rangeLabel(from: string, to: string): string {
  if (from && to) return from === to ? shortDate(from) : `${shortDate(from)}–${shortDate(to)}`;
  if (from) return `from ${shortDate(from)}`;
  if (to) return `until ${shortDate(to)}`;
  return "";
}

/** Now, as a `datetime-local` value in Bahrain time ("YYYY-MM-DDTHH:mm"). */
export function bahrainNowInputValue(now: Date = new Date()): string {
  return new Date(now.getTime() + BAHRAIN_OFFSET_MS).toISOString().slice(0, 16);
}

/** The default expiry for a new payment link, as a `datetime-local` value in
 *  Bahrain time: 7 days from now, rounded up to the next full hour. */
export function defaultLinkExpiryInputValue(now: Date = new Date()): string {
  const HOUR_MS = 60 * 60 * 1000;
  const target = Math.floor((now.getTime() + 7 * DAY_MS) / HOUR_MS + 1) * HOUR_MS;
  return new Date(target + BAHRAIN_OFFSET_MS).toISOString().slice(0, 16);
}

/** A `datetime-local` value typed in Bahrain time, as an ISO instant, or
 *  null when it is not a valid value. */
export function bahrainInputToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00+03:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

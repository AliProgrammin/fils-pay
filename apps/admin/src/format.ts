import { formatBhd, toFils } from "@filspay/money";

/** One place for how the console shows money, dates and times.
 *  Every date and time is shown in Asia/Bahrain time (UTC+3, no daylight
 *  saving), en-GB style: "30 Aug 2026, 07:05". */

const TIME_ZONE = "Asia/Bahrain";

const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
});

const timeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Calendar dates (YYYY-MM-DD) have no time zone: show them as written. */
const calendarFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** An instant, e.g. "30 Aug 2026, 07:05" (Bahrain time). */
export function formatDateTime(value: string | Date): string {
  return dateTimeFormat.format(new Date(value));
}

/** The Bahrain calendar day of an instant, e.g. "30 Aug 2026". */
export function formatDate(value: string | Date): string {
  return dateFormat.format(new Date(value));
}

/** The Bahrain clock time of an instant, e.g. "07:05". */
export function formatTime(value: string | Date): string {
  return timeFormat.format(new Date(value));
}

/** A business date such as a batch date ("2026-08-30") → "30 Aug 2026". */
export function formatBusinessDate(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate;
  return calendarFormat.format(new Date(`${isoDate}T00:00:00Z`));
}

/** Today's Bahrain calendar day as YYYY-MM-DD (for date inputs). */
export function bahrainTodayIso(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(now);
}

/** An instant as a `datetime-local` value ("YYYY-MM-DDTHH:mm") in Bahrain time. */
export function toBahrainInputValue(date: Date): string {
  return new Date(date.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

/** A `datetime-local` value typed in Bahrain time → ISO-8601 instant. */
export function fromBahrainInputValue(value: string): string {
  return new Date(`${value}:00+03:00`).toISOString();
}

/** Fils → "1,234.500" (three decimals, exact; never floats). The comma
 *  grouping is display only: the text is never parsed back into money. */
export function bhdAmount(fils: number): string {
  const plain = formatBhd(toFils(fils, { allowNegative: true }));
  const [whole = "", fraction = ""] = plain.split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const digits = sign ? whole.slice(1) : whole;
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

/** Fils → "1,234.500 BHD". */
export function bhd(fils: number): string {
  return `${bhdAmount(fils)} BHD`;
}

/** Plain words for status and code values: "under_review" → "under review". */
export function label(value: string): string {
  return value.replace(/_/g, " ");
}

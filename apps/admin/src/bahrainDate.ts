/**
 * Yesterday's Asia/Bahrain business date as YYYY-MM-DD. The settlement
 * business day is the Bahrain calendar day; `toISOString()` gives the UTC
 * day, which between 00:00 and 03:00 Bahrain is still the day before.
 */
export function bahrainYesterdayIso(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bahrain" }).format(now);
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

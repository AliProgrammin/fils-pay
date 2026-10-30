/** Strict YYYY-MM-DD that is a real calendar day (rejects 2026-13-45, 2026-02-30). */
export function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** A YYYY-MM-DD day, or an ISO 8601 timestamp on a real day (what Postgres timestamptz accepts). */
export function isValidDateOrTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(value);
  return match !== null && isValidDateOnly(match[1]) && !Number.isNaN(Date.parse(value));
}

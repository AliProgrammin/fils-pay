import { UUID_RE } from "../admin/merchants.js";
import { BadRequestError } from "./errors.js";

/**
 * Parses a `limit` query value. A non-integer is a 400. An integer outside
 * the allowed range is left to the caller, which clamps it (existing
 * behaviour: limit=0 gives one row, limit=1000 gives the max).
 */
export function parseLimitQuery(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^-?\d{1,9}$/.test(raw)) {
    throw new BadRequestError("invalid_request", "limit must be an integer");
  }
  return Number(raw);
}

// Postgres's text rendering of a timestamptz, e.g. "2026-10-30 09:15:02.123456+00".
const PG_TIMESTAMPTZ_RE =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?[+-](\d{2})(?::\d{2}){0,2}$/;

function isPgTimestamptzText(text: string): boolean {
  const m = PG_TIMESTAMPTZ_RE.exec(text);
  if (!m) return false;
  const [y, mo, d, h, mi, s, offsetHours] = m.slice(1).map(Number) as number[];
  if (offsetHours! > 15) return false;
  // Rejects values Postgres would reject (month 13, Feb 30, hour 25, ...).
  const date = new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!, s!));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo! - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    date.getUTCSeconds() === s
  );
}

/**
 * Decodes a keyset cursor: base64url("<timestamptz as printed by Postgres>|<uuid>").
 * No cursor gives null (first page). A malformed cursor is a 400: it never
 * reaches the SQL (where it was a 500) and never silently restarts at page one.
 */
export function decodeKeysetCursor(cursor: string | null | undefined): { timestamp: string; id: string } | null {
  if (!cursor) return null;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separatorIndex = decoded.indexOf("|");
  const timestamp = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);
  if (separatorIndex === -1 || !isPgTimestamptzText(timestamp) || !UUID_RE.test(id)) {
    throw new BadRequestError("invalid_request", "cursor is malformed");
  }
  return { timestamp, id };
}

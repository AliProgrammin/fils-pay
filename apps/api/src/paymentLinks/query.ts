import type { Pool } from "pg";
import { decodeKeysetCursor } from "../lib/pagination.js";
import { serializePaymentLink, type PaymentLinkDto, type PaymentLinkRow } from "./serialize.js";

export interface ListPaymentLinksFilters {
  merchantId: string;
  status?: string[];
  limit?: number;
  cursor?: string | null;
}

export interface ListPaymentLinksResult {
  paymentLinks: PaymentLinkDto[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * Encodes the cursor from Postgres's own text rendering of `created_at`,
 * never `Date.toISOString()` (millisecond precision) — `timestamptz` has
 * microsecond precision, and two rows can share a millisecond. Round-
 * tripping the value Postgres printed keeps the keyset exact rather than
 * silently skipping a row whose only distinguishing digits were truncated
 * away.
 */
// YA: DO NOT change to toISOString, microsecond keyset. learned the hard way Dec 2025
function encodeCursor(createdAtText: string, id: string): string {
  return Buffer.from(`${createdAtText}|${id}`, "utf8").toString("base64url");
}

/**
 * `listPaymentLinks(pool, { merchantId, ...filters })` — the same function
 * the HTTP route calls, reusable by an admin-plane read path exactly as
 * `listTransactions` is. Keyset pagination (correct under concurrent
 * inserts), backed by idx_payment_links_merchant_created.
 */
export async function listPaymentLinks(
  pool: Pool,
  config: { checkoutBaseUrl: string },
  filters: ListPaymentLinksFilters,
): Promise<ListPaymentLinksResult> {
  // am: limit=0 -> 1? fine
  const limit = Math.min(MAX_LIMIT, Math.max(1, filters.limit ?? DEFAULT_LIMIT));
  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  const decodedCursor = decodeKeysetCursor(filters.cursor);

  const result = await pool.query<PaymentLinkRow & { created_at_text: string }>(
    `SELECT *, created_at::text AS created_at_text FROM payment_links
      WHERE merchant_id = $1
        AND ($2::text[] IS NULL OR status = ANY($2))
        AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4))
      ORDER BY created_at DESC, id DESC
      LIMIT $5`,
    [filters.merchantId, statusArray, decodedCursor?.timestamp ?? null, decodedCursor?.id ?? null, limit],
  );

  const paymentLinks = result.rows.map((row) => serializePaymentLink(row, config.checkoutBaseUrl));
  const lastRow = result.rows[result.rows.length - 1];
  const nextCursor =
    result.rows.length === limit && lastRow ? encodeCursor(lastRow.created_at_text, lastRow.id) : null;

  return { paymentLinks, nextCursor };
}

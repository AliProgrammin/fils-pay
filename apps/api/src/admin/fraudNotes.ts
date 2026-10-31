import type { Pool } from "pg";
import { decodeKeysetCursor } from "../lib/pagination.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** One acquirer fraud-review verdict (acquirer_callback_notes). */
export interface FraudNoteRecord {
  id: string;
  /** The acquirer's own id for the callback. */
  callbackId: string;
  transactionId: string;
  merchantId: string;
  merchantName: string;
  outcome: string;
  note: string;
  /** When the acquirer says the review finished (the callback's occurredAt). */
  receivedAt: string;
}

interface FraudNoteRow {
  id: string;
  callback_id: string;
  transaction_id: string;
  merchant_id: string;
  merchant_name: string;
  outcome: string;
  note: string;
  received_at: Date;
  received_at_text: string;
}

/** Cursor from Postgres's own text of received_at (microseconds kept), never Date.toISOString(). */
function encodeCursor(receivedAtText: string, id: string): string {
  return Buffer.from(`${receivedAtText}|${id}`, "utf8").toString("base64url");
}

/** Most recent first (received_at, then id). Keyset-paginated; limit clamped 1..100. */
export async function listFraudNotes(
  pool: Pool,
  input: { merchantId?: string; transactionId?: string; limit?: number; cursor?: string | null },
): Promise<{ items: FraudNoteRecord[]; nextCursor: string | null }> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
  const decodedCursor = decodeKeysetCursor(input.cursor);

  const result = await pool.query<FraudNoteRow>(
    `SELECT n.id, n.callback_id, n.transaction_id, n.merchant_id,
            m.display_name AS merchant_name, n.outcome, n.note,
            n.received_at, n.received_at::text AS received_at_text
       FROM acquirer_callback_notes n
       JOIN merchants m ON m.id = n.merchant_id
      WHERE ($1::uuid IS NULL OR n.merchant_id = $1)
        AND ($2::uuid IS NULL OR n.transaction_id = $2)
        AND ($3::timestamptz IS NULL OR (n.received_at, n.id) < ($3, $4::uuid))
      ORDER BY n.received_at DESC, n.id DESC
      LIMIT $5`,
    [
      input.merchantId ?? null,
      input.transactionId ?? null,
      decodedCursor?.timestamp ?? null,
      decodedCursor?.id ?? null,
      limit,
    ],
  );

  const items = result.rows.map((row) => ({
    id: row.id,
    callbackId: row.callback_id,
    transactionId: row.transaction_id,
    merchantId: row.merchant_id,
    merchantName: row.merchant_name,
    outcome: row.outcome,
    note: row.note,
    receivedAt: row.received_at.toISOString(),
  }));
  const lastRow = result.rows[result.rows.length - 1];
  const nextCursor =
    result.rows.length === limit && lastRow ? encodeCursor(lastRow.received_at_text, lastRow.id) : null;
  return { items, nextCursor };
}

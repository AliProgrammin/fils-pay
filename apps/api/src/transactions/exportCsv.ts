import type { Pool } from "pg";
import { formatBhd, toFils } from "@filspay/money";
import type { TransactionRow } from "./serialize.js";

export interface TransactionsExportFilters {
  merchantId: string;
  from?: Date;
  to?: Date;
  status?: string[];
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvRow(row: TransactionRow): string {
  return [
    row.id,
    row.status,
    formatBhd(toFils(Number(row.amount_fils))),
    formatBhd(toFils(Number(row.captured_fils))),
    csvEscape(row.reference ?? ""),
    row.occurred_at.toISOString(),
  ].join(",");
}

const CSV_HEADER = "id,status,amount_bhd,captured_bhd,reference,occurred_at";
const PAGE_SIZE = 1000;

/** Whole CSV as one string. Small exports and tests only; the route streams. */
export async function buildTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
): Promise<string> {
  let csv = "";
  for await (const chunk of streamTransactionsExportCsv(pool, filters)) csv += chunk;
  return csv.replace(/\n$/, "");
}

/**
 * Streams the export one page at a time, so memory stays at one page however
 * large the range is. Keyset on (occurred_at, id): rows that share a
 * timestamp are never skipped at a page boundary. The cursor uses Postgres's
 * own text form of occurred_at (microseconds), not a JS Date (milliseconds).
 */
export async function* streamTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
): AsyncGenerator<string> {
  yield CSV_HEADER + "\n";

  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  let cursor: { occurredAt: string; id: string } | null = null;

  while (true) {
    const result: { rows: Array<TransactionRow & { occurred_at_text: string }> } = await pool.query(
      `SELECT *, occurred_at::text AS occurred_at_text FROM transactions
        WHERE merchant_id = $1
          AND ($2::timestamptz IS NULL OR occurred_at >= $2)
          AND ($3::timestamptz IS NULL OR occurred_at <  $3)
          AND ($4::text[] IS NULL OR status = ANY($4))
          AND ($5::timestamptz IS NULL OR (occurred_at, id) > ($5::timestamptz, $6::uuid))
        ORDER BY occurred_at ASC, id ASC
        LIMIT $7`,
      [
        filters.merchantId,
        filters.from ?? null,
        filters.to ?? null,
        statusArray,
        cursor?.occurredAt ?? null,
        cursor?.id ?? null,
        PAGE_SIZE,
      ],
    );

    if (result.rows.length > 0) {
      yield result.rows.map((row) => toCsvRow(row) + "\n").join("");
    }
    if (result.rows.length < PAGE_SIZE) return;
    const last = result.rows[result.rows.length - 1]!;
    cursor = { occurredAt: last.occurred_at_text, id: last.id };
  }
}

import type { QueryableClient } from "@filspay/events";

/**
 * reporting_outbox_cursor read/advance — this consumer's own watermark,
 * never a reuse of outbox_events.processed_at.
 */
export interface ConsumerCursor {
  /** xid8 of the last applied event's inserting transaction, as text.
   *  The cursor is the pair (txid, id) — see migration 0080. */
  lastProcessedTxid: string;
  lastProcessedId: bigint;
}

/**
 * last_processed_id is BIGINT; pg returns it as a string, hence the union.
 */
interface CursorRow {
  last_processed_txid: string;
  last_processed_id: string | number;
}

/**
 * Seeds the row on first ever run (INSERT ... ON CONFLICT DO NOTHING),
 * then reads it. Never throws on a missing row — a worker's first pass
 * against a fresh database always starts from 0.
 *
 * Must be called inside the pass transaction: the row is locked FOR UPDATE
 * until that transaction ends, so two passes with the same consumer name
 * (the live worker and `reporting catch-up`, or two worker replicas) run
 * one after the other and never apply the same events twice. listener.ts's
 * `running` flag only guards one process.
 */
export async function readCursor(client: QueryableClient, consumerName: string): Promise<ConsumerCursor> {
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id)
     VALUES ($1, 0)
     ON CONFLICT (consumer_name) DO NOTHING`,
    [consumerName],
  );

  const result = (await client.query(`SELECT last_processed_txid::text AS last_processed_txid, last_processed_id
       FROM reporting_outbox_cursor WHERE consumer_name = $1 FOR UPDATE`, [
    consumerName,
  ])) as { rows: CursorRow[] };

  const row = result.rows[0];
  return {
    lastProcessedTxid: row ? row.last_processed_txid : "0",
    lastProcessedId: row ? BigInt(row.last_processed_id) : 0n,
  };
}

/** Moves the (txid, id) watermark forward only: a stale value can never
 *  move it back and cause events to be applied again. */
export async function advanceCursor(
  client: QueryableClient,
  consumerName: string,
  newCursor: ConsumerCursor,
): Promise<void> {
  await client.query(
    `UPDATE reporting_outbox_cursor
        SET last_processed_txid = $2::xid8, last_processed_id = $3::bigint, updated_at = now()
      WHERE consumer_name = $1
        AND (last_processed_txid, last_processed_id) < ($2::xid8, $3::bigint)`,
    [consumerName, newCursor.lastProcessedTxid, newCursor.lastProcessedId.toString()],
  );
}

/** Resets this consumer's watermark to 0 — used only by the `rebuild`
 *  subcommand (cli/rebuild.ts) before replaying the entire outbox history. */
// MK: rebuild only. never call from the worker.
export async function resetCursor(client: QueryableClient, consumerName: string): Promise<void> {
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_txid, last_processed_id, updated_at)
     VALUES ($1, '0', 0, now())
     ON CONFLICT (consumer_name) DO UPDATE SET last_processed_txid = '0', last_processed_id = 0, updated_at = now()`,
    [consumerName],
  );
}

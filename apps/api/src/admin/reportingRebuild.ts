import type { PoolClient } from "pg";

/** How many rows each rollup table held before the rebuild cleared it. */
export interface RebuildAnalyticsSummary {
  volumeRows: number;
  trendRows: number;
}

/**
 * Starts a full analytics rebuild, the same way the `reporting rebuild` CLI
 * does (apps/reporting/src/cli/rebuild.ts): empty both rollup tables
 * (merchant_daily_volume, merchant_payout_trends) and move the reporting
 * consumer's cursor back to the start, in the caller's transaction. The
 * reporting worker then replays the whole outbox through its normal code
 * path. The rollups have one writer, so a rebuild can never count an event
 * twice (U5).
 *
 * The cursor row is reset FIRST: that waits for a running consumer pass
 * (it holds the row FOR UPDATE) and blocks the next one until this commits.
 * Truncating first could deadlock against a pass that holds the cursor and
 * waits on the tables.
 */
export async function refreshAnalyticsRollups(client: PoolClient): Promise<RebuildAnalyticsSummary> {
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_txid, last_processed_id, updated_at)
     VALUES ('reporting', '0', 0, now())
     ON CONFLICT (consumer_name) DO UPDATE SET last_processed_txid = '0', last_processed_id = 0, updated_at = now()`,
  );
  const counts = await client.query<{ volume_rows: number; trend_rows: number }>(
    `SELECT (SELECT count(*)::int FROM merchant_daily_volume) AS volume_rows,
            (SELECT count(*)::int FROM merchant_payout_trends) AS trend_rows`,
  );
  await client.query(`TRUNCATE merchant_daily_volume, merchant_payout_trends`);
  return { volumeRows: counts.rows[0]!.volume_rows, trendRows: counts.rows[0]!.trend_rows };
}

-- Look up a batch's capture events by settlement_batch_id (batch detail
-- event count in apps/api settlement/query.ts, RecalculateMDR's per-batch
-- fee recompute). There was no index on this column, so each lookup was a
-- full (parallel) scan of transaction_events. Partial: unbatched rows
-- (settlement_batch_id IS NULL) are never looked up this way, and the
-- existing idx_transaction_events_unbatched covers them.
CREATE INDEX idx_transaction_events_settlement_batch
    ON transaction_events (settlement_batch_id)
    WHERE settlement_batch_id IS NOT NULL;

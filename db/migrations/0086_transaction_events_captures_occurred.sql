-- E8: GET /v1/settlement/summary reads capture events by date window.
-- The only occurred_at index on transaction_events (0023) is partial on
-- settlement_batch_id IS NULL, so for batched (older) events the query
-- read the whole table. This partial index covers every capture event,
-- and INCLUDE lets the summary read transaction_id and amount_fils from
-- the index alone (index-only scan, no heap pages).
CREATE INDEX idx_transaction_events_captures_occurred
    ON transaction_events (occurred_at)
    INCLUDE (transaction_id, amount_fils)
    WHERE event_type IN ('captured', 'partially_captured');

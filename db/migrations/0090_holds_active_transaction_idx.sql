-- capture.ts, void.ts and processRefund.ts all run
--   UPDATE holds SET status = 'released' WHERE transaction_id = $1 AND status = 'active'
-- inside the money-moving transaction. holds had no index on transaction_id,
-- so each of these was a sequential scan of the whole table, and the table
-- grows with every authorization. A partial index on the active rows only
-- stays small (released holds drop out of it).
--
-- Not CONCURRENTLY: db/migrate.ts runs each file inside BEGIN/COMMIT.
CREATE INDEX IF NOT EXISTS idx_holds_active_transaction
    ON holds (transaction_id)
 WHERE status = 'active';

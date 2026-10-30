-- The deferred balance trigger (0007, check_ledger_group_balance) runs
--   SELECT sum(...) FROM ledger_entries WHERE entry_group_id = $1
-- once for EVERY ledger row written. ledger_entries had no index on
-- entry_group_id, so each capture, refund and settlement posting did several
-- sequential scans of the whole ledger. The cost grew with the ledger and
-- was the main Postgres CPU cost of a checkout under load (CAPACITY.md).
--
-- Not CONCURRENTLY: db/migrate.ts runs each file inside BEGIN/COMMIT.
CREATE INDEX IF NOT EXISTS idx_ledger_entries_entry_group
    ON ledger_entries (entry_group_id);

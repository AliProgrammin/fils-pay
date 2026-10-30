-- L5: the payment-link recovery sweep (apps/api/src/paymentLinks/recovery.ts)
-- runs every 30 s and looks only at links in status 'reserved'. Without an
-- index that is a sequential scan of every link ever created. A partial
-- index on the reserved rows stays tiny (paid/active/canceled rows drop out).
--
-- Not CONCURRENTLY: db/migrate.ts runs each file inside BEGIN/COMMIT.
CREATE INDEX IF NOT EXISTS idx_payment_links_reserved
    ON payment_links (reserved_at)
 WHERE status = 'reserved';

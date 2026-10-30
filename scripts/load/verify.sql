-- Correctness checks after a load test. Every "bad" count must be 0.
--   docker compose -f ops/docker-compose.prod.yml -p <project> exec -T postgres \
--     psql -U filspay -d filspay -v run_id="'<RUN_ID>-%'" -f - < scripts/load/verify.sql
-- run_id is a LIKE pattern: '<RUN_ID>-%' for one run, 'load-%' for all runs.
\pset footer off

\echo '1. Ledger: every entry group balances (debits = credits)'
SELECT count(*) AS unbalanced_groups FROM (
  SELECT entry_group_id FROM ledger_entries GROUP BY entry_group_id
  HAVING sum(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END) <> 0
) g;

\echo '2. Ledger: whole ledger nets to zero'
SELECT coalesce(sum(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END), 0) AS ledger_net_fils
  FROM ledger_entries;

\echo '3. This run: transactions, captures and ledger agree'
WITH run AS (
  SELECT id, status, amount_fils, captured_fils FROM transactions WHERE reference LIKE :run_id
), journal AS (
  SELECT l.transaction_id,
         count(DISTINCT l.entry_group_id) AS groups,
         sum(l.amount_fils) FILTER (WHERE l.account_id = 'card_scheme_clearing'
                                      AND l.direction = 'debit') AS gross
    FROM ledger_entries l JOIN run ON run.id = l.transaction_id
   GROUP BY l.transaction_id
)
SELECT count(*)                                                          AS transactions,
       count(*) FILTER (WHERE r.status = 'captured')                     AS captured,
       count(*) FILTER (WHERE r.status = 'authorized')                   AS still_authorized,
       count(*) FILTER (WHERE r.status = 'captured'
                          AND r.captured_fils <> r.amount_fils)          AS bad_capture_amount,
       count(*) FILTER (WHERE r.status = 'captured'
                          AND coalesce(j.groups, 0) <> 1)                AS bad_capture_journal_count,
       count(*) FILTER (WHERE r.status = 'captured'
                          AND coalesce(j.gross, 0) <> r.captured_fils)   AS bad_ledger_gross,
       count(*) FILTER (WHERE r.status <> 'captured' AND j.groups > 0)   AS bad_journal_without_capture
  FROM run r LEFT JOIN journal j ON j.transaction_id = r.id;

\echo '4. This run: payment links paid exactly once'
SELECT count(*)                                                    AS links,
       count(*) FILTER (WHERE pl.status = 'paid')                  AS paid,
       count(*) FILTER (WHERE pl.status <> 'paid')                 AS not_paid,
       count(*) FILTER (WHERE pl.status = 'paid' AND NOT EXISTS (
         SELECT 1 FROM transactions t WHERE t.id = pl.transaction_id
            AND t.status = 'captured'))                            AS bad_paid_without_capture
  FROM payment_links pl
 WHERE pl.reference LIKE :run_id;

\echo '5. This run: no checkout charged twice (one captured transaction per reference)'
SELECT count(*) AS bad_charged_twice FROM (
  SELECT reference FROM transactions
   WHERE reference LIKE :run_id AND captured_fils > 0
   GROUP BY reference HAVING count(*) > 1
) d;

\echo '6. This run: no transaction captured twice (one capture journal each)'
SELECT count(*) AS bad_double_captured FROM (
  SELECT l.transaction_id FROM ledger_entries l
    JOIN transactions t ON t.id = l.transaction_id
   WHERE t.reference LIKE :run_id AND l.description = 'capture: gross'
   GROUP BY l.transaction_id HAVING count(*) > 2
) d;

\echo '7. This run: links left mid-payment (a crash between authorize and finalize).'
\echo '   Not lost: each has its authorization or capture; listed for void/reconcile.'
SELECT pl.status AS link_status, t.status AS transaction_status, count(*) AS links
  FROM payment_links pl
  LEFT JOIN transactions t ON t.id = pl.pending_transaction_id
 WHERE pl.reference LIKE :run_id AND pl.status = 'reserved'
 GROUP BY 1, 2;

-- Recreates refund_merchant_summary (0072), which had two bugs:
--   1. It joined `t.id = r.id` (a refund id against a transaction id), so
--      no refund ever matched and the view was empty.
--   2. SUM(t.captured_fils) over refund rows counted a transaction's
--      captured amount once per refund: two partial refunds of a 10.000 BD
--      capture reported 20.000 BD captured.
-- Fixed: join on r.transaction_id, and sum per transaction first so each
-- transaction's captured amount counts once per merchant and business day.
-- Same columns, same types, same unique index.

DROP MATERIALIZED VIEW refund_merchant_summary;

CREATE MATERIALIZED VIEW refund_merchant_summary AS
WITH per_transaction AS (
    SELECT
        r.merchant_id,
        date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain') AS business_date,
        r.transaction_id,
        COUNT(*)                 AS refund_count,
        SUM(r.amount_fils)       AS refunded_fils,
        SUM(r.fee_reversed_fils) AS fee_reversed_fils
    FROM refunds r
    WHERE r.status = 'succeeded'
    GROUP BY r.merchant_id, date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain'), r.transaction_id
)
SELECT
    p.merchant_id,
    p.business_date,
    SUM(p.refund_count)::bigint AS refund_count,
    SUM(p.refunded_fils)        AS total_refunded_fils,
    SUM(p.fee_reversed_fils)    AS total_fee_reversed_fils,
    SUM(t.captured_fils)        AS original_captured_fils
FROM per_transaction p
JOIN transactions t ON t.id = p.transaction_id
GROUP BY p.merchant_id, p.business_date;

CREATE UNIQUE INDEX idx_refund_merchant_summary_pk
    ON refund_merchant_summary (merchant_id, business_date);

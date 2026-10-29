-- Convenience views.
--
-- This file came from an abandoned PR and never applied anywhere: it also
-- defined v_unbatched_capture_events (reads settlement_batch_events, a table
-- that does not exist) and v_active_api_keys. No code reads either view, so
-- they are removed. merchant_payable_position is kept because
-- apps/settlement/internal/ledger/refresh.go reads it.

CREATE OR REPLACE VIEW merchant_payable_position AS
SELECT sb.merchant_id,
       COALESCE(SUM(sel.amount_fils), 0) AS payable_fils
  FROM scheme_export_lines sel
  JOIN settlement_batches sb ON sb.id = sel.settlement_batch_id
 GROUP BY sb.merchant_id;

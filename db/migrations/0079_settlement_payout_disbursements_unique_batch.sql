-- One payout disbursement per settlement batch. The webhook dispatcher used
-- to insert a row on every first attempt of every settlement.paid delivery
-- (one per endpoint, and again on every replay), so a batch could get many
-- disbursement instructions. Keep the earliest row per batch, drop the
-- duplicates, and enforce one row per batch from now on.
DELETE FROM settlement_payout_disbursements d
 USING settlement_payout_disbursements keep
 WHERE d.settlement_batch_id = keep.settlement_batch_id
   AND (keep.created_at, keep.id) < (d.created_at, d.id);

CREATE UNIQUE INDEX uq_settlement_payout_disbursements_batch
    ON settlement_payout_disbursements (settlement_batch_id);

-- One payout disbursement per paid settlement batch, written by apps/settlement
-- inside the payout transaction (0057's intent). A split parent's batch pays
-- each child, so it gets one disbursement per child instead. child_merchant_id
-- is NULL for a normal (non-split) batch.
--
-- The 0079 unique index (settlement_batch_id) cannot hold several child rows
-- for one batch. Replace it with (settlement_batch_id, child_merchant_id)
-- NULLS NOT DISTINCT, so a normal batch still has at most one row (NULL
-- counts as equal) and a split batch has at most one row per child.
ALTER TABLE settlement_payout_disbursements
    ADD COLUMN child_merchant_id UUID REFERENCES merchants (id);

DROP INDEX uq_settlement_payout_disbursements_batch;

CREATE UNIQUE INDEX uq_settlement_payout_disbursements_batch_child
    ON settlement_payout_disbursements (settlement_batch_id, child_merchant_id)
    NULLS NOT DISTINCT;

-- Refunds in settlement (FP-300). A batch now nets the refunds it claims
-- (refunds.settlement_batch_id, 0042) out of the payout:
--   net_payout_fils = gross_fils - fee_fils - refund_fils + refund_fee_reversed_fils
-- Stored on the batch so the payout can be explained from the row alone.
ALTER TABLE settlement_batches
    ADD COLUMN refund_fils               BIGINT NOT NULL DEFAULT 0 CHECK (refund_fils >= 0),
    ADD COLUMN refund_fee_reversed_fils  BIGINT NOT NULL DEFAULT 0 CHECK (refund_fee_reversed_fils >= 0);

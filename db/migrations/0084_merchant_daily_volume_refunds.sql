-- Refunds in the reporting daily rollup (FP-300). apps/reporting adds one
-- refund.succeeded event per refund to the merchant's Asia/Bahrain day.
ALTER TABLE merchant_daily_volume
    ADD COLUMN refund_count      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN refund_gross_fils BIGINT  NOT NULL DEFAULT 0;

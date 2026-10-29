-- merchants.lifetime_net_payout_monitoring_estimate was REAL (float4), which
-- is exact only up to 16,777,216 fils (16,777.216 BD). Past that, every
-- payout added to it is rounded. Store whole fils as BIGINT (ADR-0001).
-- Existing values are rounded to the nearest fils; drift already in them stays.
ALTER TABLE merchants
    ALTER COLUMN lifetime_net_payout_monitoring_estimate TYPE BIGINT
    USING round(lifetime_net_payout_monitoring_estimate)::bigint;

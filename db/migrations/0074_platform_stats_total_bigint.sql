-- platform_stats.total_processed_fils was INTEGER (max 2,147,483,647 fils =
-- 2,147,483.647 BD), only 7% above the 2,000,000,000 fils volume-tier
-- threshold. Money is BIGINT everywhere else (ADR-0001).
ALTER TABLE platform_stats
    ALTER COLUMN total_processed_fils TYPE BIGINT;

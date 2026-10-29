-- Intentionally empty.
--
-- This file came from an abandoned PR and never applied anywhere. It inserted
-- two suspense accounts (fx_rounding_difference, chargeback_suspense) using
-- columns that chart_of_accounts does not have (code, account_type,
-- description) and a kind ('suspense') that 0007's CHECK does not allow.
-- No code posts to either account, so the insert is removed. The file stays
-- so migration numbering and schema_migrations history remain stable.
SELECT 1;

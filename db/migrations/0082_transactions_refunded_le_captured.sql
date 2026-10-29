-- A transaction can never have refunded more than it captured. 0043 only
-- checked refunded_fils >= 0 and left the ceiling to the application, which
-- used the authorized amount by mistake (FP-300, R2). This makes the database
-- the last line of defense. NOT VALID is not used: no existing row breaks it.
ALTER TABLE transactions
    ADD CONSTRAINT chk_transactions_refunded_le_captured
    CHECK (refunded_fils <= captured_fils);

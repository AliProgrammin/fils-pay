-- ledger_entries is append-only (ARCHITECTURE: corrections are new entries).
-- The 0007 balance trigger only checks that each group still nets to zero,
-- so a balanced UPDATE of both legs, a DELETE of a whole group, or a
-- TRUNCATE all passed. These triggers reject every UPDATE, DELETE and
-- TRUNCATE.
--
-- The one exception is the dev/test seed, which wipes fixture data with
-- TRUNCATE ... CASCADE. It opts in for its own transaction only with
-- SET LOCAL filspay.allow_ledger_reset = 'on'. UPDATE and DELETE have no
-- exception.

CREATE FUNCTION reject_ledger_entries_change() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'TRUNCATE'
       AND current_setting('filspay.allow_ledger_reset', true) = 'on' THEN
        RETURN NULL;
    END IF;
    RAISE EXCEPTION 'ledger_entries is append-only: % is not allowed; post a correcting entry group instead', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_no_update_delete
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION reject_ledger_entries_change();

CREATE TRIGGER ledger_entries_no_truncate
    BEFORE TRUNCATE ON ledger_entries
    FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_entries_change();

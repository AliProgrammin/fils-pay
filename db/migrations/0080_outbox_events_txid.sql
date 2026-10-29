-- Gap-safe outbox reads for cursor consumers (apps/reporting).
--
-- outbox_events.id comes from a sequence taken at INSERT time, but a row is
-- only visible at COMMIT time. Two writers (apps/api and apps/settlement) can
-- commit out of id order, so a consumer that reads "id > cursor" skips a
-- lower id that commits late, forever.
--
-- txid records the inserting transaction. A consumer only reads rows whose
-- txid is below pg_snapshot_xmin(pg_current_snapshot()): every transaction
-- below that horizon has finished, so that set of rows can no longer grow.
-- It walks them in (txid, id) order and keeps (txid, id) as its cursor.
--
-- Existing rows all get this migration's own transaction id (the default is
-- evaluated in this transaction), so they keep their id order, and the
-- existing reporting cursor is moved to (this txid, last_processed_id) to
-- resume exactly where it was.
ALTER TABLE outbox_events
    ADD COLUMN txid xid8 NOT NULL DEFAULT pg_current_xact_id();

CREATE INDEX idx_outbox_events_txid_id ON outbox_events (txid, id);

ALTER TABLE reporting_outbox_cursor
    ADD COLUMN last_processed_txid xid8 NOT NULL DEFAULT '0';

UPDATE reporting_outbox_cursor SET last_processed_txid = pg_current_xact_id();

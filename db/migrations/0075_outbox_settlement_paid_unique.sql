-- At most one settlement.paid outbox event per settlement batch
-- (incident 2026-08-21: daemon + `run-batch` both enqueued one, merchants got
-- two payout notifications). EnqueuePayoutNotifications checked NOT EXISTS
-- and then inserted, with no lock and no unique index, so two concurrent
-- scans could both insert. A code comment claimed this index already existed;
-- it did not.
--
-- Existing duplicates: keep the first event (lowest id) per batch. The later
-- copies are kept for audit but renamed to 'settlement.paid.duplicate' so no
-- consumer (webhooks, reporting rebuild) treats them as a real payout event
-- again. They cannot be deleted: webhook_deliveries references them.
UPDATE outbox_events oe
   SET event_type = 'settlement.paid.duplicate'
 WHERE oe.event_type = 'settlement.paid'
   AND EXISTS (
     SELECT 1 FROM outbox_events first
      WHERE first.event_type = 'settlement.paid'
        AND first.aggregate_id = oe.aggregate_id
        AND first.id < oe.id
   );

CREATE UNIQUE INDEX uq_outbox_events_settlement_paid_aggregate
    ON outbox_events (event_type, aggregate_id)
    WHERE event_type = 'settlement.paid';

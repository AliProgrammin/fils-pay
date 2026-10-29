-- Incident 2026-05-14 (double charge on one payment link): the reservation
-- timeout let a second payer re-claim a link while the first payer's
-- capture was still running. pay.ts now records the authorized transaction
-- here BEFORE it captures. While it is set, the link cannot be re-claimed by
-- the timeout (unless that transaction was voided), so at most one capture
-- can ever be in flight for a link. Cleared on finalize or on release.
-- transaction_id keeps its meaning ("the payment that paid this link").

ALTER TABLE payment_links
    ADD COLUMN pending_transaction_id UUID REFERENCES transactions (id);

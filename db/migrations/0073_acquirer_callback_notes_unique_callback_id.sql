-- FP-201: acquirer callbacks are redelivered (acquirer retries and our own
-- withCallbackRetry). 0051 left callback_id unconstrained and no
-- processed_events table exists, so every redelivery wrote another note.
-- callback_id is the acquirer's id for ONE callback, so it must be unique.
-- Remove existing duplicates first, keeping the earliest row per callback_id.

DELETE FROM acquirer_callback_notes a
 USING acquirer_callback_notes b
 WHERE a.callback_id = b.callback_id
   AND (a.created_at, a.id) > (b.created_at, b.id);

CREATE UNIQUE INDEX uq_acquirer_callback_notes_callback_id
    ON acquirer_callback_notes (callback_id);

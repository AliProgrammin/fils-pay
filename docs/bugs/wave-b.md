# Wave B bug fixes

### B1 Acquirer callbacks are not deduplicated
- Severity: Critical / Ticket: FP-201 / Where: apps/api/src/acquirer/callbacks.ts:37, db/migrations/0051_acquirer_callback_notes.sql
- What is wrong: the same acquirer callback (same `callback_id`) is stored again each time it arrives.
- Why it happens: the insert is a plain `INSERT`. There is no unique index on `callback_id`. The `processed_events` table that CHANGELOG 1.9.0 and the 0051 comment talk about does not exist. `withCallbackRetry` and the acquirer both resend the same callback.
- What it breaks: one fraud verdict shows as 2, 3 or more notes on the transaction timeline. Support and finance see "confirmed fraud" many times and can act on it more than once (for example void or refund twice).
- Fix: new migration `0073_acquirer_callback_notes_unique_callback_id.sql` deletes old duplicates (keeps the earliest row) and adds a unique index on `callback_id`. The insert now uses `ON CONFLICT (callback_id) DO NOTHING`, so a resend is a safe no-op and still returns 200.
- Test: apps/api/src/acquirer/callbacks.fix.test.ts "FP-201: a redelivered callback (same callback_id) is recorded once" (sends the same callback 4 times, also in parallel; expects 1 row).

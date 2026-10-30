# Hunt 3 bug fixes: U5-U8, U11-U13

The auditor called these R5-R8 and R11-R13. They are written here as U5-U8
and U11-U13 so they do not clash with the refund bugs R1-R8 in refunds.md.
The other hunt-3 entries are in hunt-3-g.md.

### U5 Admin "Rebuild analytics" counts events twice
- Severity: Medium
- Ticket: R5
- Where: apps/api/src/admin/reportingRebuild.ts, apps/api/src/routes/admin.ts (`POST /v1/admin/reporting/rebuild`)
- What is wrong: The admin rebuild filled merchant_daily_volume and merchant_payout_trends again from transaction_events and settlement_batches, but it did not move the reporting worker's cursor. The rows now held every event, and the worker then applied the events after its cursor again. The auditor reproduced +4 captures and +1,234,753 fils. The route comment said it "replays the outbox from the start". That was false.
- Why it happens: There were two writers of the same rollups: the reporting consumer (from the outbox, in order, with a cursor) and this SQL (from source tables, with no cursor). The two did not agree on which events were already counted.
- What it breaks: After a rebuild, the merchant analytics (volumes, counts, refunds) show too much money until the next rebuild.
- Fix: The admin rebuild now does what the `reporting rebuild` CLI does. In one transaction it resets the reporting cursor to 0 and truncates both rollups. The reporting worker then replays the whole outbox once, through its normal code. The cursor is reset first: that waits for a running worker pass and blocks the next one until the commit, so the two cannot deadlock or interleave. Same route, same response shape `{ volumeRows, trendRows }`; the numbers are now the rows that were cleared. The admin page text says "Cleared ... the reporting worker is now rebuilding them".
- Note: On a seeded database the outbox holds only a few events (the seed writes history straight into tables), so after a rebuild the rollups show what the worker shows on a fresh seed, not the full transaction_events total. That is the one-writer design of the reporting service.
- Test: apps/api/src/admin/reportingRebuild.test.ts (a cursor part-way through the outbox and an existing rollup row: after the rebuild both rollups are empty, the cursor is (0, 0), and the response gives the cleared counts). The old test for the source-table refund columns is replaced, because that code is gone; the consumer already rolls up refunds (applyEvent.test.ts).

### U6 Payout trend stays "closed" after the batch is paid
- Severity: Medium
- Ticket: R6
- Where: apps/reporting/src/consumer/applyEvent.ts, apps/reporting/src/consumer/runConsumerPass.ts
- What is wrong: The trend row got its status and paid_at once, at settlement.batch_closed. At that time the batch is still `closed` and paid_at is null. The worker did not read settlement.paid, so the row never changed.
- Why it happens: settlement.paid was not in REPORTING_EVENT_TYPES and had no applier.
- What it breaks: The merchant payout-trend chart shows paid batches as closed with no paid date.
- Fix: The worker now reads settlement.paid. Its applier reads the batch row from settlement_batches and upserts status, paid_at, gross, fee and net onto the trend row. An upsert is safe to replay (rebuild) and also works if no trend row exists yet. A missing batch is a no-op, like batch_closed.
- Test: apps/reporting/src/consumer/runConsumerPass.test.ts, "settlement.paid moves the payout trend from closed to paid (U6)" (batch_closed while closed, then the batch is paid and settlement.paid is enqueued with the payout_notify.go payload: the row shows `paid` and the paid_at).

### U7 Merchants are logged out 10 minutes after login
- Severity: Medium
- Ticket: R7
- Where: apps/api/src/routes/auth.ts (`POST /v1/auth/login`, `POST /v1/auth/otp/verify`)
- What is wrong: Login set the session cookie with maxAge = the pending-session TTL (600 s). OTP verify made the server session last 12 h but did not set the cookie again. The browser deleted the cookie after 10 minutes.
- Why it happens: The admin verify sets the cookie again with the full TTL; the merchant verify did not.
- What it breaks: Every merchant has to log in again 10 minutes after each login.
- Fix: OTP verify sets the cookie again with maxAge = sessionTtlHours * 3600, like admin verify. Verify does not rotate the token (promoteSession only updates the row), so the same token is used.
- Test: apps/api/src/routes/auth.fix.test.ts, "OTP verify re-sets the session cookie with the full session lifetime".

### U8 Transaction list date filter uses the UTC day
- Severity: Low-Medium
- Ticket: R8
- Where: apps/web/src/format.ts (`dayStartIso`), apps/web/src/pages/transactions/TransactionListPage.tsx
- What is wrong: `dayStartIso` returned `${d}T00:00:00.000Z`. A comment said it used Bahrain time; it did not.
- Why it happens: The date was turned into UTC midnight, which is 03:00 in Bahrain.
- What it breaks: A day filter starts and ends at 03:00 Bahrain. Captures between 00:00 and 03:00 show under the wrong day, and do not match settlement days.
- Fix: Return `${d}T00:00:00+03:00`. The same function gives the "To (exclusive)" end, so the end is also the Bahrain midnight. The web client sends it through URLSearchParams, so the `+` is encoded.
- Test: apps/web/src/dashboard.test.ts, "dayStartIso converts a date input to the Asia/Bahrain day boundary" (the old test locked in the UTC value).

### U11 Admin Settlement page default date is two days ago after midnight
- Severity: Low
- Ticket: R11
- Where: apps/admin/src/pages/settlement/SettlementPage.tsx, apps/admin/src/bahrainDate.ts (new)
- What is wrong: The default business date was yesterday by `toISOString()`, which is the UTC day.
- Why it happens: Between 00:00 and 03:00 Bahrain the UTC date is still the day before, so "yesterday" was two days ago.
- What it breaks: An admin who runs a batch at that hour gets the wrong default day.
- Fix: `bahrainYesterdayIso()` takes today in Asia/Bahrain (Intl.DateTimeFormat, en-CA) and goes back one day. The date input also gets `max` = yesterday, to match U12.
- Test: apps/admin/test/bahrainDate.test.ts (01:30 Bahrain on 30 Oct gives 29 Oct; month and year roll-over). Run with `cd apps/admin && npm test`.

### U12 Admin "run batch" accepts today or a future date
- Severity: High (TS half; the Go half is in hunt-3-g.md)
- Ticket: R12
- Where: apps/api/src/routes/admin.ts (`POST /v1/admin/settlement/run-batch`)
- What is wrong: The route accepted any YYYY-MM-DD, including today and later days.
- Why it happens: Only the format was checked.
- What it breaks: Closing a day before it ends leaves the captures made later that day outside every batch, so they are never paid out.
- Fix: Return 400 `invalid_request` for a date >= today in Asia/Bahrain. The check runs before the audit row is written and before the settlement service is called.
- Test: apps/api/src/routes/admin.test.ts, "settlement run-batch rejects today and future Asia/Bahrain business dates" (today, tomorrow and 2999-01-01: 400, no call, no audit row).

### U13 Admin list cursors give a 500 on a bad cursor
- Severity: Low
- Ticket: R13
- Where: apps/api/src/admin/credits.ts, apps/api/src/admin/merchants.ts
- What is wrong: Each file had its own cursor decoder that passed any text to SQL. A bad timestamp or id made Postgres throw (500). Text with no `|` silently went back to page one.
- Why it happens: They did not use the shared decoder in apps/api/src/lib/pagination.ts that the transactions and payment-links lists use.
- What it breaks: A bad or old cursor gives a 500 instead of a clear 400.
- Fix: Both use `decodeKeysetCursor`, which returns 400 `invalid_request` for a malformed cursor. Good cursors work the same.
- Test: apps/api/src/routes/admin.test.ts and apps/api/src/routes/adminCredits.test.ts, "rejects a malformed cursor with 400, not 500".

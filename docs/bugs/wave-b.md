# Wave B bug fixes

### B1 Acquirer callbacks are not deduplicated
- Severity: Critical / Ticket: FP-201 / Where: apps/api/src/acquirer/callbacks.ts:37, db/migrations/0051_acquirer_callback_notes.sql
- What is wrong: the same acquirer callback (same `callback_id`) is stored again each time it arrives.
- Why it happens: the insert is a plain `INSERT`. There is no unique index on `callback_id`. The `processed_events` table that CHANGELOG 1.9.0 and the 0051 comment talk about does not exist. `withCallbackRetry` and the acquirer both resend the same callback.
- What it breaks: one fraud verdict shows as 2, 3 or more notes on the transaction timeline. Support and finance see "confirmed fraud" many times and can act on it more than once (for example void or refund twice).
- Fix: new migration `0073_acquirer_callback_notes_unique_callback_id.sql` deletes old duplicates (keeps the earliest row) and adds a unique index on `callback_id`. The insert now uses `ON CONFLICT (callback_id) DO NOTHING`, so a resend is a safe no-op and still returns 200.
- Test: apps/api/src/acquirer/callbacks.fix.test.ts "FP-201: a redelivered callback (same callback_id) is recorded once" (sends the same callback 4 times, also in parallel; expects 1 row).

### B2 Acquirer callback signature can be skipped, replayed, and is checked over the wrong bytes
- Severity: Critical / Ticket: FP-240 (inbound part) / Where: apps/api/src/webhooks/inboundVerify.ts:40-70, apps/api/src/config.ts:259, apps/api/src/routes/acquirerCallbacks.ts:57
- What is wrong: four faults in the only auth this public endpoint has.
  1. No signature header = accepted. `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` defaults to `false`.
  2. The compare uses `Buffer.compare`, which is not constant time.
  3. The HMAC is computed over `JSON.stringify(parsedBody)`, not the bytes the acquirer sent.
  4. The `t=` timestamp is never checked, so an old signed callback can be replayed forever.
- Why it happens: the "optional while the sandbox is not signing" mode was left as the default, and the verifier re-serialises the parsed body instead of using the raw body.
- What it breaks: anyone on the internet can post an unsigned "confirmed_fraud" verdict for any transaction id. A captured callback can be replayed at any time. Real acquirer callbacks with different spacing or key order fail with 401. A timing attack can guess the HMAC byte by byte.
- Fix: default is now `true` (docs/ARCHITECTURE.md updated). Compare uses `crypto.timingSafeEqual`. The callback route keeps the raw request body (a JSON parser scoped to this route only) and the HMAC is over `<t>.<rawBody>`. `t` must be within ±300 s of server time, else 401 `timestamp_out_of_tolerance`. The opt-out env var still exists for local sandbox use.
- Test: apps/api/src/webhooks/inboundVerify.fix.test.ts and apps/api/src/routes/acquirerCallbacks.fix.test.ts (unsigned -> 401, raw-body signature -> 200, stale timestamp -> 401). Existing tests that asserted "unsigned gets 200" now assert 401; their fixed 2025 timestamps now use the current time.

### B3 Expired payment link can be paid by sending an old `submittedAt`
- Severity: Critical / Ticket: FP-187 / Where: apps/api/src/paymentLinks/pay.ts:32-38 and :60, apps/api/src/routes/paymentLinks.ts:157-166
- What is wrong: the expiry check uses a time the client sends (`submittedAt`) instead of the server clock.
- Why it happens: `expiryReferenceTime()` returns the client value if it parses. The pay route is public and unauthenticated, and passes `submittedAt` straight through. The route comment says it is "ignored unless authenticated with an API key", but no such check exists (and the route has no auth at all).
- What it breaks: anyone can pay a link after it expired by sending `"submittedAt": "2000-01-01T00:00:00Z"`. A merchant who set a short expiry on an invoice (for example a price valid for 1 hour) is charged at the old price days later. Expiry has no effect.
- Fix: pay uses the server's time only. `expiryReferenceTime` and the `submittedAt` input are removed from the API; the web checkout no longer sends it. docs/ARCHITECTURE.md said "client clock for offline terminals"; that is updated, because a public route cannot trust a client time and no authenticated terminal path exists.
- Test: apps/api/src/routes/paymentLinks.fix.test.ts "FP-187: an expired link cannot be paid by sending an old submittedAt" (was 200, now 410). apps/api/src/paymentLinks/pay.test.ts is removed: it only tested `expiryReferenceTime`, and its "round-trips exactly" case locked the bug in.

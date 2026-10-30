# Hunt 2 bug fixes

H4 is in hunt-2-h4.md.

### H1 Public payment-link page leaks API key data
- Severity: High
- Ticket: none
- Where: apps/api/src/paymentLinks/read.ts:47-57 and :82-83
- What is wrong: `GET /v1/payment-links/:token` needs no login. It returned `merchantPublicKey` (the newest live API key's `key_prefix`) and `merchantIntegrationId` (that key's `key_hash`).
- Why it happens: The query had a `LEFT JOIN LATERAL` on `api_keys`. The comment on the DTO says it shows nothing but the display name, but the code added both key fields.
- What it breaks: Anyone with a payment link (a link is made to be shared) sees part of the merchant's live key and its full SHA-256 hash. The prefix narrows the search for the raw key. The hash is the exact value `verifyApiKey` matches on, so it must never leave the server. No client used these fields.
- Fix: Remove the join and both fields. The other fields and the response shape stay the same.
- Test: apps/api/src/routes/paymentLinks.test.ts, "payment link lifecycle" (now checks that neither field and no `fp_` text is in the public read).

### H2 Support role can capture and void
- Severity: High
- Ticket: none
- Where: apps/api/src/routes/transactions.ts:96 (capture) and :124 (void)
- What is wrong: Capture and void used only `requireMerchantAuth`. Any merchant user, including `support`, could move money.
- Why it happens: The role gate was never added. The old TODO on void asked about it. The web UI hides the buttons from support, but its comment said the server did not check.
- What it breaks: A support user (read-only by role) captures or voids a payment by calling the API. Refunds already had the owner/finance gate, so this was the one money route without it.
- Fix: Add `requireMerchantRole("owner", "finance")` to both routes, the same gate as refunds. API keys still pass, by design (an owner issues them). The web comments now say the server checks too.
- Test: apps/api/src/routes/transactions.fix.test.ts, "H2: a support session cannot capture or void (403); owner and finance sessions and API keys can"

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

### H5 KYC image decompression bomb
- Severity: Medium
- Ticket: none
- Where: apps/api/src/onboarding/kycThumbnail.ts:32
- What is wrong: The thumbnail step decoded any JPEG/PNG with sharp's default pixel limit (about 268 megapixels). A sharp failure was a 500.
- Why it happens: The 8 MiB upload cap limits the file, not the picture. A PNG of a few hundred KB can declare a canvas of tens of thousands of pixels each way.
- What it breaks: A few uploads of a small "bomb" PNG make the API decode gigabytes of pixels, so memory and CPU run out for every merchant. A broken image that only has the right magic bytes gave a 500.
- Fix: `limitInputPixels: 40_000_000` (40 MP is more than any phone photo or scan). Any sharp failure becomes `422 invalid_image`.
- Test: apps/api/src/onboarding/kycThumbnail.fix.test.ts, "H5: a PNG over the pixel limit (small file, 48 MP) is rejected 422 before it is decoded" and "H5: bytes with a JPEG signature that sharp cannot decode are rejected 422, not 500"

### H6 KYC upload takes many files and leaves orphan files
- Severity: Medium
- Ticket: none
- Where: apps/api/src/plugins/multipart.ts; apps/api/src/routes/kyc.ts:48-55; apps/api/src/onboarding/kyc.ts:68-77
- What is wrong: (1) The multipart plugin limited only file size, not the file count. (2) The route read every file part into memory and kept the last one. (3) The file was written to disk before the thumbnail and the DB insert.
- Why it happens: The plugin comment said the route enforces one file; it did not. The write came first, and nothing cleaned up after a later error.
- What it breaks: One request with many 8 MiB files makes the server hold them all in memory. A failed thumbnail (now a 422, see H5) or a failed insert leaves a file on disk with no row, so private ID documents pile up with nothing pointing to them.
- Fix: The route answers `400 invalid_request` on a second file, before it reads it. The plugin caps file parts at 2, not 1: at the limit busboy destroys the file stream the handler is still reading, so with 1 a second file made the first read fail with "Premature close" (a 500). With 2 the route sees the second part and rejects it; a third is cut by the plugin. The thumbnail now runs before any write. Files are written with `wx` (create only), and on any error only the files this call created are removed. Files are named by content hash, so an earlier row with the same bytes keeps its file.
- Test: apps/api/src/routes/kyc.fix.test.ts, "H6: an upload with two or three files is rejected 400 and stores nothing", "H6: an image that fails the thumbnail step leaves no file on disk", "H6: a failed DB insert removes the file it wrote, but never a file an earlier upload owns"

### H7 api_keys.revoke_after is ignored
- Severity: Low
- Ticket: none
- Where: apps/api/src/apiKeys/verify.ts:19
- What is wrong: A key with a passed `revoke_after` still works.
- Why it happens: Migration 0056 added `revoke_after` and says a sweep job revokes keys once it passes. No such job exists, and `verifyApiKey` checks only `revoked_at`.
- What it breaks: A staged key rotation never ends. The old key, which the merchant thinks is dead, keeps working forever.
- Fix: Add `AND (revoke_after IS NULL OR revoke_after > now())` to the verify query. The key list (`listApiKeys`) reports a passed `revoke_after` as `revokedAt`, so the dashboard does not show a dead key as active.
- Test: apps/api/src/apiKeys/verify.fix.test.ts, "H7: a key past its revoke_after time is rejected", "H7: a key with a future revoke_after, or none, still works", "H7: the key list shows a passed revoke_after as revokedAt, ..."

### H8 Dead BD parser with the wrong unit
- Severity: Low
- Ticket: none
- Where: apps/api/src/payments/discountAdjustment.ts (`parsePromotionalDiscountFils`)
- What is wrong: It parsed a BD string with `parseFloat(raw) * 100`. 1 BD is 1000 fils, so `"4.750"` gave 475, not 4750. It also used float maths on money.
- Why it happens: It was written for cents. Nothing calls it.
- What it breaks: Nothing today. But it is an exported, plausible-looking helper, so the next person to need a BD parser could wire it in and pay out a tenth of every discount.
- Fix: Delete it. Text BD amounts use `parseBhdToFils` from `@filspay/money`.
- Test: apps/api/src/payments/discountAdjustment.fix.test.ts, "H8: the float BD parser is gone; parseBhdToFils gives the right fils"

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

### H10 Three inputs still crashed the API with a 500
- Severity: Low
- Ticket: none (found by our blind verifier after H3)
- Where: apps/api/src/paymentLinks/create.ts, routes/transactions.ts, routes/paymentLinks.ts, plugins/errorHandler.ts
- What is wrong: a payment link for 0 fils, a card number sent as a number (`"pan": 4242...`), and a NUL byte in any text field each gave `500 internal_error`.
- Why it happens: `toFils(0)` is valid, so the 0 reached the database CHECK; the card simulator calls `pan.endsWith(...)` on a number; Postgres refuses NUL bytes in text (error 22021) and that error was not mapped.
- What it breaks: clients get a server error for their own mistake; on the pay path the link also stays reserved until the timeout.
- Fix: reject amounts of 0 or less with 400 `invalid_amount`; require a string `pan`; map Postgres 22021 to 400 `invalid_request` in the one error handler.
- Test: apps/api/src/routes/transactions.fix.test.ts, the three "H10" tests

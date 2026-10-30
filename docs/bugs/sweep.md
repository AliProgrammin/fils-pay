# Sweep bug fixes

Found in a last sweep of scripts, docs and auth paths (W1 to W6), and in a black-box test of the live server (W7 to W10). Each fix has a test that failed on the old code and passes now.

### W1 `npm run seed` wipes any database it is pointed at
- Severity: High
- Ticket: none
- Where: db/seed/generate.ts:211-216 (TRUNCATE), db/seed/index.ts, docs/RUNBOOK.md ("Resetting a non-production environment"), ops/docker-compose.yml (seed comment)
- What is wrong: The seed runs `TRUNCATE ... RESTART IDENTITY CASCADE` on merchants, transactions and the ledger with no guard. The comment in `generate.ts`, the dev compose file and the RUNBOOK all said it only touches its own fixture tables and is "safe against a shared staging database".
- How found and reproduced: Sweep, by reading `generate.ts` against the RUNBOOK. The RUNBOOK itself has the note "staging-2 got reset this way". Reproduced by `npm run seed` on a database with merchants: before the fix it truncated everything; now it exits 1 with "refusing to reset". Test: `scripts/seed_reset_guard.test.ts` failed before (no guard existed).
- Why it happens: `CASCADE` follows every foreign key, so the truncate reaches every table that references a merchant. The comment and the RUNBOOK describe what the author meant, not what the SQL does.
- What it breaks: Anyone who follows the RUNBOOK on a shared staging database (or a production URL by mistake) loses all merchants, payments and ledger rows. The ledger is append-only (E4), but the seed is the one caller allowed to truncate it.
- Fix: `db/seed/resetGuard.ts` (called by `db/seed/index.ts` before `generate()`) refuses a database that has merchants unless `SEED_ALLOW_RESET=1`. An empty database still seeds. Checked the callers: the production compose runs `seed:once`, which skips a database with merchants before the guard and seeds an empty one (tested both); CI runs the seed after `npm test` has added merchants, so its step now sets `SEED_ALLOW_RESET=1`; the dev compose (its own local database) sets it too. The RUNBOOK, README test steps, compose comment and `generate.ts` comment now say what the seed really does.
- Test: scripts/seed_reset_guard.test.ts, "refuses a database that has merchants, unless SEED_ALLOW_RESET=1" and "allows an empty database (first deploy, CI before tests)"
- Effect on existing data: None from this change. A redeploy of the live server runs `seed:once`, which still skips because merchants exist, so live data is not touched.

### W2 Month-end residue sweep would post scheme residue twice
- Severity: High
- Ticket: FP-187
- Where: scripts/reconcile_march.ts, docs/RUNBOOK.md ("Month-end residue")
- What is wrong: The RUNBOOK told finance to copy and run `reconcile_march.ts` every month. Since fix C9, `CloseBatch` already posts the scheme rounding residue for each scheme line when it closes the batch. The sweep did not look for those rows.
- How found and reproduced: Sweep, by reading the RUNBOOK against `apps/settlement/internal/settlement/batch.go` (residue posted at close). Reproduced by `scripts/reconcile_march.fix.test.ts`: a month with a close-time residue row; the script had no check for it (the test failed before the fix).
- Why it happens: C9 moved residue posting into `CloseBatch`, but the old manual sweep and its RUNBOOK step stayed.
- What it breaks: Every month swept after C9 gets the residue journaled twice: `scheme_rounding_residue` is debited twice and `card_scheme_clearing` no longer ties to the scheme file.
- Fix: New `periodHasCloseTimeResidue(client, year, month)`: true when a `scheme_rounding_residue` row tied to a settlement batch belongs to a transaction of that Bahrain month. The script refuses such a month (exit 1, nothing posted). The RUNBOOK now says residue is automatic and the sweep is only for March 2026, closed before C9.
- Test: scripts/reconcile_march.fix.test.ts, "a month with close-time residue rows is detected; an empty month is not"
- Effect on existing data: If anyone ran a copied sweep for a month closed after C9, the extra groups have the description "... scheme rounding residue sweep ...". To find them: `SELECT entry_group_id, merchant_id, amount_fils, occurred_at FROM ledger_entries WHERE account_id = 'scheme_rounding_residue' AND settlement_batch_id IS NULL AND description LIKE '%residue sweep%';` Finance must reverse them with new entries. We did not run this on real data.

### W3 A suspended or closed merchant can still take and move money
- Severity: Medium
- Ticket: none
- Where: apps/api/src/apiKeys/verify.ts (`verifyApiKey`), apps/api/src/auth/sessions.ts (`lookupSession`), used by apps/api/src/auth/requireMerchantAuth.ts
- What is wrong: Login checks `merchants.status = 'active'`, but the API-key check and the session lookup did not. A merchant suspended after login, or any of its API keys, could still authorize, capture, void and refund.
- How found and reproduced: Sweep, by comparing the login query (`routes/auth.ts`) with the two lookups. Reproduced by `merchantStatus.fix.test.ts`: after `UPDATE merchants SET status = 'suspended'`, the API key and the session still got 200 on `GET /v1/transactions`.
- Why it happens: The status rule was written in the login route only, not in the two functions every request uses.
- What it breaks: Suspending a merchant (for fraud or a compliance hold) does not stop it. Its integration keeps taking payments and can refund money out.
- Fix: Both lookups join `merchants` and require `status = 'active'`, so a non-active merchant gets 401, the same answer as a revoked key. "View as merchant" (admin) is not changed, so support can still look at a suspended merchant read-only. All seed merchants are active; no test relied on a non-active merchant acting (the only non-active merchants in tests are in `auth.loginShops.test.ts`, which checks they cannot log in).
- Test: apps/api/src/auth/merchantStatus.fix.test.ts, "a suspended merchant's API key and session are refused (401)" and "a closed merchant's API key and session are refused (401)"
- Effect on existing data: None stored is wrong. To list payments made by merchants that are not active: `SELECT t.id, t.merchant_id, t.status, t.occurred_at FROM transactions t JOIN merchants m ON m.id = t.merchant_id WHERE m.status <> 'active';` (we cannot tell from the data which came after the suspension).

### W4 The refunds demo script writes to any database
- Severity: Medium
- Ticket: FP-300
- Where: scripts/demo_refund.sh
- What is wrong: The script inserts demo transactions and ledger rows for the real seed merchant and runs `settlement run-batch` on whatever `DATABASE_URL` points at. Nothing stops it on a shared or live database.
- How found and reproduced: Sweep, by reading the script. Reproduced by `scripts/demo_refund.guard.test.ts`: with a remote `DATABASE_URL` the old script started its work instead of refusing.
- Why it happens: It was written for a local database and never checked where it runs.
- What it breaks: Run once against staging or production, it adds fake payments and ledger rows and closes and pays a batch for a real merchant.
- Fix: At the start, the script reads the host of `DATABASE_URL` and refuses (exit 1) unless it is `localhost`, `127.0.0.1` or `[::1]`, or `DEMO_ALLOW_REMOTE=1` is set.
- Test: scripts/demo_refund.guard.test.ts, "refuses a non-local DATABASE_URL: ..." (three URLs) and "a local DATABASE_URL passes the guard"
- Effect on existing data: None known. We did not find a run against a shared database.

### W5 Report filter with a non-UUID merchantId gives a 500
- Severity: Low
- Ticket: none
- Where: apps/api/src/reporting/scope.ts:12
- What is wrong: `GET /v1/reporting/transactions?filter={"merchantId":"not-a-uuid"}` answered 500.
- How found and reproduced: Sweep. Reproduced by `reportingExportSummary.fix.test.ts`: the old code sent the string to Postgres as a uuid and got "invalid input syntax for type uuid".
- Why it happens: `resolveReportMerchantId` passed the client value straight into a uuid query parameter.
- What it breaks: A bad input shows as a server error (and in error logs) instead of a clear 400.
- Fix: A `merchantId` that is not a UUID string answers `400 invalid_request`, like the other bad-input fixes (H3, H10).
- Test: apps/api/src/routes/reportingExportSummary.fix.test.ts, "GET /v1/reporting/transactions with a non-UUID filter merchantId answers 400 invalid_request"
- Effect on existing data: None.

### W6 Dead settlement client call with the wrong unit
- Severity: Low
- Ticket: none
- Where: apps/api/src/admin/settlementClient.ts:276-298 (`notifySettlementRefundAdjustment`)
- What is wrong: The function divided fils by 10 (`amountFils / 10`) and called `/internal/refund-adjustment`, a route the Go settlement service does not have. Nothing called it.
- How found and reproduced: Sweep, by reading the file and the Go router (`internalapi/server.go`). Reproduced by `settlementClient.routes.fix.test.ts`: it lists every path the client calls and checks the Go router has it; it failed on `/internal/refund-adjustment`.
- Why it happens: Left from an older refund design (cents, a separate adjustment call). Refunds now go into the batch through the ledger.
- What it breaks: Nothing today. Anyone who wired it up would get a 404 and send a refund 10x too small.
- Fix: Delete the function.
- Test: apps/api/src/admin/settlementClient.routes.fix.test.ts, "each callSettlementInternal path is a route of the Go internal API"
- Effect on existing data: None.

### W7 A declined capture leaves the payment-link authorization open
- Severity: Medium
- Ticket: none
- Where: apps/api/src/paymentLinks/pay.ts (`captureAndFinalize`)
- What is wrong: When the authorize succeeds and the capture is declined (`402 {"stage":"capture","error":"card_captured_declined"}`), the flow freed the link but left the transaction `authorized` with its hold active. Nothing voided it.
- How found and reproduced: Black-box test of the live server: a pay with card `4242` got the 402 and the transaction stayed `authorized` (live transaction `ebdb5052...`). Reproduced by `paymentLinks.fix.test.ts` with an acquirer that declines the capture: the transaction stayed `authorized`.
- Why it happens: The capture-failure branch only released the link reservation. The void was written for the lost-reservation branch, not for this one.
- What it breaks: Each such payment leaves an open authorization and an active hold on the customer's card, and an `authorized` row in the merchant's list that will never be captured.
- Fix: On a capture decline (402, final), the flow voids the authorization (which releases the hold) and then frees the link, so the customer can pay again. A retryable failure (502) is not changed: the capture may still go through on a retry with the same key. No card format check was added to the API (team decision: card format checks stay in the UI).
- Test: apps/api/src/routes/paymentLinks.fix.test.ts, "W7: a declined capture voids the link's authorization and frees the link"
- Effect on existing data: Old declined captures are still `authorized`. To list them: `SELECT t.id, t.merchant_id, t.amount_fils FROM idempotency_keys c JOIN idempotency_keys a ON a.merchant_id = c.merchant_id AND a.key = left(c.key, -length(':capture')) || ':authorize' JOIN transactions t ON t.id = a.resource_id WHERE c.key LIKE 'paylink:%:capture' AND c.response_status_code = 402 AND t.status = 'authorized';` (checked on a test database: it finds the row the old code left). Void them with `POST /v1/transactions/:id/void`. We did not change live data.

### W8 Bad dates and odd report filters give a 500
- Severity: Low
- Ticket: none
- Where: apps/api/src/routes/settlement.ts (`/reconciliation`, `/summary`), apps/api/src/routes/reporting.ts (`/transactions`)
- What is wrong: `GET /v1/settlement/reconciliation?from=2026-13-45&to=xyz` and `GET /v1/reporting/transactions?filter={"from":"x","__proto__":{"a":1}}` answered 500.
- How found and reproduced: Black-box test of the live server. Reproduced by `reportingExportSummary.fix.test.ts`: the old code passed the values to Postgres, which failed the date cast.
- Why it happens: The routes checked only that `from` and `to` were present, and the report filter values went to SQL with no type check.
- What it breaks: Bad input shows as a server error instead of a clear 400.
- Fix: Settlement `from` and `to` must be real `YYYY-MM-DD` days; report `from` and `to` must be a real day or an ISO timestamp, and `status` a string. Otherwise `400 invalid_request`. A filter that is valid JSON but not an object is `400 invalid_filter` (same code as bad JSON). Shared check in `apps/api/src/lib/dateInput.ts`.
- Test: apps/api/src/routes/reportingExportSummary.fix.test.ts, "bad reporting filter values and bad reconciliation dates answer 400"
- Effect on existing data: None.

### W9 Payment-link create leaks internal error text for a bad amount
- Severity: Low
- Ticket: none
- Where: apps/api/src/paymentLinks/create.ts
- What is wrong: `amountFils` of `-100`, `"100"`, `10.5`, `null` or a huge number gave `400 invalid_amount` with the internal message "toFils: expected a non-negative amount ... (pass { allowNegative: true } ...)".
- How found and reproduced: Black-box test of the live server. Reproduced by `paymentLinks.fix.test.ts`, which checks the body has no `toFils` text.
- Why it happens: The route copied the `RangeError` message from `toFils` into the response.
- What it breaks: The API shows internal function names and options to clients.
- Fix: Same status and code (`400 invalid_amount`), with the same clean message the refund route uses: "amountFils must be a positive integer number of fils".
- Test: apps/api/src/routes/paymentLinks.fix.test.ts, "W9: payment-link create with a bad amount gives a clean 400 message"
- Effect on existing data: None.

### W10 No length limit on payment-link reference or Idempotency-Key
- Severity: Low
- Ticket: none
- Where: apps/api/src/paymentLinks/create.ts, the Idempotency-Key readers in apps/api/src/routes/transactions.ts, refunds.ts and paymentLinks.ts (now one helper, apps/api/src/lib/idempotencyHeader.ts)
- What is wrong: A 10,000-character `reference` was stored (201), and a 5,000-character `Idempotency-Key` was accepted. Both columns are `TEXT` with no limit.
- How found and reproduced: Black-box test of the live server. Reproduced by `paymentLinks.fix.test.ts`.
- Why it happens: No length check in the routes and none in the schema.
- What it breaks: Large values bloat rows and indexes (the idempotency key is part of a unique index) and are shown on the public checkout page.
- Fix: `reference` at most 255 characters, `Idempotency-Key` at most 255 characters (far above any UUID), else `400 invalid_request`. The three copies of the header reader are now one helper.
- Test: apps/api/src/routes/paymentLinks.fix.test.ts, "W10: an over-long reference or Idempotency-Key is 400 invalid_request"
- Effect on existing data: Longer values stored before stay. To find them: `SELECT id, length(reference) FROM payment_links WHERE length(reference) > 255;` and `SELECT id, length(key) FROM idempotency_keys WHERE length(key) > 255;`

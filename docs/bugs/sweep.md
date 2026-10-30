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
- Type: Clean-up (dead code, nothing calls it). No effect on users, money, data or security in production.
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

## Outside review (X1 to X11)

An outside review on 30 Oct sent us 12 claims. We reproduced each one with a test before we changed code: 10 were real, 2 were partly right. We fixed 11 (X1 to X11), each with a test that failed on the old code and passes now. Claim 7 (fraud-review notes are stored but never shown to operators) is a feature that was never built, not a bug in code that exists; it is in [Decisions and open risks](../../BUGS.md#open-risks).

### X1 A retry after a rollback sends the bank a new idempotency key, so the bank approves twice
- Severity: High
- Ticket: outside review, claim 1
- Where: apps/api/src/payments/idempotency.ts (new `acquirerIdempotencyKey`), apps/api/src/payments/authorize.ts, capture.ts, processRefund.ts
- What is wrong: The key sent to the acquirer was `claim row id : attempt count`. If the database transaction rolled back after the acquirer approved, the claim row was deleted with it. The client's retry (same `Idempotency-Key`) made a new claim row, so the acquirer got a new key and approved the authorize, capture or refund a second time.
- How found and reproduced: Found by an outside review on 30 Oct. Reproduced by our test `acquirerKey.fix.test.ts`: it forces a rollback after an approved acquirer call, retries with the same client key, and checks the acquirer saw the same key both times. On the old code the two keys were different.
- Why it happens: The acquirer key was built from a value (the row id) that lives only inside the transaction that can roll back, not from the client's own key, which survives the rollback.
- What it breaks: A customer is charged (or refunded) twice at the bank while our ledger shows one operation.
- Fix: The acquirer key is now `merchant : endpoint : client Idempotency-Key : attempt count`. The same client retry sends the same key, so the acquirer returns its first answer. The attempt count still gives a new key after a committed transient failure.
- Test: apps/api/src/payments/acquirerKey.fix.test.ts, "acquirer key: a retry after a rollback reuses the authorize key" and "acquirer key: a retry after a rollback reuses the capture and refund keys"
- Effect on existing data: A double approval leaves no row in our database (the rolled-back work is gone), so it cannot be found from our tables. Compare the acquirer's settlement report with `SELECT acquirer_reference, amount_fils FROM transactions;` and look for approvals we do not have. We did not change data.

### X2 A credit's fee reversal ignores the merchant's negotiated discount
- Severity: Medium
- Ticket: outside review, claim 2
- Where: apps/api/src/admin/creditThreshold.ts (`calculateCreditFeeReversal`), apps/api/src/admin/credits.ts (`createCreditRequest`)
- What is wrong: A credit with "reverse fee" gave back the full MDR on the amount. Capture charges the MDR after the merchant's negotiated discount. So the merchant got back more fee than it paid: on 10.000 BD at 250 bps with a 20% discount, 250 fils back instead of 200 (50 fils too much).
- How found and reproduced: Found by an outside review on 30 Oct. Reproduced by our test in `credits.test.ts` (10.000 BD, 250 bps, 2000 bps discount): the old code gave 250 fils.
- Why it happens: The reversal used `applyRateFils(amount, mdr)`, not the same function capture uses (`netCaptureFeeFils`, which applies the discount and the same rounding).
- What it breaks: Every fee reversal for a discounted merchant pays out too much; the platform loses the difference.
- Fix: `calculateCreditFeeReversal` calls `netCaptureFeeFils(amount, mdr, discount)`, and the credit reads `negotiated_discount_bps` with the rate in force (V3). Merchants with no discount get the same result as before.
- Test: apps/api/src/admin/credits.test.ts, "a fee reversal gives back the discounted fee capture charged, not the undiscounted fee"
- Effect on existing data: Old credits for discounted merchants have a fee reversal that is too high. To list them: `SELECT cr.id, cr.merchant_id, cr.base_amount_fils, cr.fee_reversal_fils, m.negotiated_discount_bps FROM credit_requests cr JOIN merchants m ON m.id = cr.merchant_id WHERE cr.fee_reversal_fils > 0 AND m.negotiated_discount_bps > 0;` Finance must post correcting entries. We did not change data.

### X3 An MDR recalculation adjustment is dated today, not in the batch's business day
- Severity: Medium
- Ticket: outside review, claim 3
- Where: apps/settlement/internal/settlement/recalculate_mdr.go (`postMdrAdjustment`)
- What is wrong: The recalculation changes the net payout of the old batch, but both ledger legs of the adjustment were dated `now()`. Reconciliation then showed a gap in two periods: +50 fils in the batch's day and -50 fils in today's.
- How found and reproduced: Found by an outside review on 30 Oct. Reproduced by our Go test `TestRecalculateMDR_AdjustmentDatedInBatchPeriod_Fix`: on the old code both legs fell outside the batch's business day.
- Why it happens: The old comment chose `now()` "so no closed period is reopened". But `docs/ARCHITECTURE.md` says a correction carries the date of the period it corrects, and the batch row itself is changed in its own period.
- What it breaks: Reconciliation is wrong for both days until someone explains the gap by hand.
- Fix: Both legs are dated at the start of the batch's Bahrain business day (`BusinessDayWindow(batchDate)`).
- Test: apps/settlement/internal/settlement/recalculate_mdr_period_fix_test.go, `TestRecalculateMDR_AdjustmentDatedInBatchPeriod_Fix`
- Effect on existing data: Old adjustments keep their old date (the ledger is append-only). To list them: `SELECT entry_group_id, merchant_id, settlement_batch_id, occurred_at FROM ledger_entries WHERE description = 'MDR recalculation adjustment';` Finance can explain or move them with correcting entries. We did not change data.

### X4 Recompute statuses turns a chargeback back into a refundable payment
- Severity: Medium
- Ticket: outside review, claim 4
- Where: apps/api/src/admin/transactionStatusRecompute.ts
- What is wrong: The admin "Recompute statuses" action set the status from the amounts alone. A `chargeback` row has captured and refunded amounts like a normal payment, so it became `captured` (or `partially_refunded`) again.
- How found and reproduced: Found by an outside review on 30 Oct. Reproduced by our test in `adminMerchantsRecompute.fix.test.ts`: a `chargeback` row changed status on the old code.
- Why it happens: The query left out `authorized` and `voided` but not `chargeback`, a status that the amounts cannot show.
- What it breaks: A payment the bank already took back can be refunded again, so the merchant pays the money out twice.
- Fix: `chargeback` is left out of the recompute, like `authorized` and `voided`.
- Test: apps/api/src/routes/adminMerchantsRecompute.fix.test.ts, "recompute never changes a chargeback transaction"
- Effect on existing data: The old code left no trace (no event for a status change), so a rewritten chargeback cannot be found from our tables. Compare the acquirer's chargeback list with `SELECT id, status FROM transactions WHERE acquirer_reference = ANY($1);`. We did not change data.

### X5 MDR recalculation does not tell reporting, so the payout trend keeps the old fee
- Severity: Medium
- Ticket: outside review, claim 5
- Where: apps/settlement/internal/settlement/recalculate_mdr.go (`RecalculateMDR`)
- What is wrong: The recalculation changed the batch's fee and net payout, but enqueued no outbox event. Reporting builds the payout trend from `settlement.batch_closed` events, so it kept the old fee and net.
- How found and reproduced: Found by an outside review on 30 Oct. Reproduced by our Go test `TestRecalculateMDR_EnqueuesCorrectedBatchEvent_Fix`: on the old code the latest event still had fee 250 and net 9,750, not 300 and 9,700.
- Why it happens: `CloseBatch` enqueues the event; the recalculation, written later, changed the same figures without it.
- What it breaks: The merchant's payout trend and reports show a net payout that is not what the batch pays.
- Fix: In the same transaction, the recalculation enqueues `settlement.batch_closed` with the corrected figures (same payload as `CloseBatch`). Reporting applies events in commit order (D5), so the newest figures win.
- Test: apps/settlement/internal/settlement/recalculate_mdr_period_fix_test.go, `TestRecalculateMDR_EnqueuesCorrectedBatchEvent_Fix`
- Effect on existing data: Batches recalculated before the fix still show the old figures in reporting. To list them: `SELECT DISTINCT settlement_batch_id FROM ledger_entries WHERE description = 'MDR recalculation adjustment';` Running the recalculation again for those days, or a reporting rebuild, corrects them. We did not change data.

### X6 A signed acquirer callback with an unknown outcome is stored and answered 200
- Severity: Medium
- Ticket: outside review, claim 6
- Where: apps/api/src/routes/acquirerCallbacks.ts
- What is wrong: The comment said any outcome other than the allowed values is a 400, but nothing checked it. A callback with `outcome: "totally_invalid"` was stored as a fraud-review note and answered 200.
- How found and reproduced: Found by an outside review on 30 Oct. Reproduced by our test in `acquirerCallbacks.fix.test.ts`: on the old code it got 200 and one stored row.
- Why it happens: The route trusted the TypeScript type of the body; the type is not checked at run time.
- What it breaks: Notes with a verdict that is neither "cleared" nor "confirmed_fraud" are stored as fact, and the acquirer is told the callback was accepted, so it never resends a correct one.
- Fix: After the signature check, an `outcome` other than `cleared` or `confirmed_fraud` is `400 invalid_request` and nothing is stored. An unsigned callback is still 401. This changes a status code (200 to 400) for bad input only: see "Contract kept" in BUGS.md.
- Test: apps/api/src/routes/acquirerCallbacks.fix.test.ts, "callback: a signed callback with an unknown outcome is a 400 and is not stored"
- Effect on existing data: To list bad notes: `SELECT callback_id, transaction_id, outcome FROM acquirer_callback_notes WHERE outcome NOT IN ('cleared', 'confirmed_fraud');` We did not change data.

### X7 A signed acquirer callback with a bad occurredAt gives a 500
- Severity: Low
- Ticket: outside review, claim 8
- Where: apps/api/src/routes/acquirerCallbacks.ts
- What is wrong: `occurredAt: "not-a-date"` went to Postgres. The insert failed three times (the callback retry) and the route answered 500.
- How found and reproduced: Found by an outside review on 30 Oct. Reproduced by our test in `acquirerCallbacks.fix.test.ts`: 500 on the old code.
- Why it happens: No format check before the insert.
- What it breaks: The acquirer sees a server error and keeps resending a callback that can never be stored; our error logs fill.
- Fix: After the signature check, `occurredAt` must be an ISO 8601 timestamp, else `400 invalid_request` (shared check in `lib/dateInput.ts`).
- Test: apps/api/src/routes/acquirerCallbacks.fix.test.ts, "callback: a signed callback with a malformed occurredAt is a 400, not a 500"
- Effect on existing data: None (nothing was stored).

### X8 An expired link with a timed-out reservation reads "active" and pay says "processing"
- Severity: Low
- Ticket: outside review, claim 9
- Where: apps/api/src/paymentLinks/status.ts (`derivePublicStatus`), apps/api/src/paymentLinks/pay.ts (`classifyClaimFailure`)
- What is wrong: A link in `reserved` whose reservation had timed out and whose expiry had passed showed status `active` on the checkout page, and pay answered `409 payment_link_processing`. It cannot be paid (B3 holds), but both answers were wrong.
- How found and reproduced: Found by an outside review on 30 Oct. Reproduced by our test in `paymentLinks.fix.test.ts`: on the old code GET said `active` and pay said 409.
- Why it happens: The expiry check ran only for `active` links; a timed-out `reserved` link went to "active" without it, and the pay error path treated every `reserved` link as busy.
- What it breaks: The customer sees a pay button for a link that has expired, then a "processing" error.
- Fix: A timed-out reservation is read like an `active` link, so the expiry check applies: GET says `expired` and pay answers `410 payment_link_expired`, the same as any expired link.
- Test: apps/api/src/routes/paymentLinks.fix.test.ts, "an expired link with a timed-out reservation reads expired and pay says 410"
- Effect on existing data: None. The status is worked out on read.

### X9 Malformed list queries, path ids and profile keys give a 500
- Severity: Low
- Ticket: outside review, claim 10
- Where: apps/api/src/routes/settlement.ts, apps/api/src/settlement/query.ts, apps/api/src/routes/webhooks.ts, apps/api/src/webhooks/deliveries.ts, apps/api/src/onboarding/businessProfile.ts, apps/api/src/onboarding/kyc.ts
- What is wrong: A bad `limit`, `from` or `cursor` on the settlement batch list and the webhook delivery list, a non-UUID settlement batch id or KYC document id, and an unknown key in the business-profile PATCH all answered 500.
- How found and reproduced: Found by an outside review on 30 Oct. Reproduced by our test `malformedInput.fix.test.ts`: each input gave 500 on the old code.
- Why it happens: These routes passed the raw values to Postgres; the earlier bad-input fixes (H3, H10, U13, W5, W8) did not cover them.
- What it breaks: Bad input shows as a server error instead of a clear answer.
- Fix: Bad `limit`, `from`/`to` or `cursor` is `400 invalid_request` (shared `parseLimitQuery` and `decodeKeysetCursor`); a non-UUID batch or document id is 404, the same as an unknown id; an unknown business-profile key is `400 invalid_request`. Valid queries and real cursors work as before.
- Test: apps/api/src/routes/malformedInput.fix.test.ts (five tests, for example "settlement batch list: bad limit, from or cursor is 400; bad batch id is 404" and "settlement batch list: a real nextCursor still pages")
- Effect on existing data: None.

### X10 The dashboard and admin cut a 4th BD decimal instead of refusing it
- Severity: Low
- Ticket: outside review, claim 11
- Where: apps/web/src/inputRules.ts, apps/admin/src/inputRules.ts (`filterAmountInput`, `checkAmount`)
- What is wrong: Typing or pasting `1.2345` BD changed the field to `1.234` with no message.
- How found and reproduced: Found by an outside review on 30 Oct. Reproduced by our tests in `inputRules.test.ts` (web and admin): `1.2345` became `1.234` and passed the check. The claim was partly right: the field showed the cut value, so the amount sent always matched the screen; no wrong amount was sent without the user seeing it. That is why we rate it Low.
- Why it happens: The input filter cut the fraction to 3 digits as the user typed.
- What it breaks: A user who pastes a value with 4 decimals may not notice that it changed.
- Fix: The filter keeps every digit, and `checkAmount` refuses more than 3 decimals with "BD amounts have at most 3 decimals (1 BD = 1000 fils)". The old test that asserted the cut was changed in the same commit.
- Test: apps/web/src/inputRules.test.ts and apps/admin/test/inputRules.test.ts, "an amount with more than 3 decimals is refused with a clear message, never cut"
- Effect on existing data: None.

### X11 Detail Back links lose the list's search, filters, page and size
- Severity: Low
- Ticket: outside review, claim 12
- Where: apps/web/src/pager.ts and apps/admin/src/pager.ts (new `listBackHref`), apps/web/src/pages/transactions/TransactionDetailPage.tsx and TransactionListPage.tsx, apps/admin/src/pages/merchants/MerchantDetailPage.tsx and MerchantListPage.tsx
- What is wrong: From page 3 of a filtered list, opening a detail and pressing Back went to page 1 of the plain list.
- How found and reproduced: Found by an outside review on 30 Oct. Reproduced by our tests in `pager.test.ts` (web and admin): the helper did not exist, and the Back links were fixed paths.
- Why it happens: The Back links were written as fixed paths.
- What it breaks: Support and merchants lose their place and must set the filters again.
- Fix: A list row link passes its own query string to the detail page; Back goes to the list with that query. A detail opened directly goes to the plain list. Only a query string is kept (no other URL).
- Test: apps/web/src/pager.test.ts and apps/admin/test/pager.test.ts, "listBackHref keeps the list's search, filters, page and size from the list link"
- Effect on existing data: None.

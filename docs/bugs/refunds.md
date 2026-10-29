# Refunds (FP-212 / FP-300) bug fixes

Each entry: one bug, one failing test first, one smallest fix, one commit.

### R7 Every refund fails with `chk_refunds_reason_not_null`
- Severity: Critical
- Ticket: FP-300
- Where: `apps/api/src/payments/processRefund.ts` (the `INSERT INTO refunds`)
- What is wrong: Every refund failed at the last step. 11 refund tests failed with `chk_refunds_reason_not_null`.
- Why it happens: Migration 0070 sets `refunds.reason` default to `'unspecified'` and adds a CHECK that the reason is not NULL. Its comment says the CHECK is there "to catch application code that accidentally passes NULL". The code passed `input.reason ?? null`, so an explicit NULL went in. A column default only applies when the column is left out, not when NULL is passed.
- What it breaks: No refund could be written at all.
- Fix: `processRefund` now uses the caller's reason (trimmed), or `'unspecified'` (the same value as the 0070 default) when there is none. The constraint is not weakened. The route (see FP-300 wiring) requires a reason from the merchant.
- Test: `apps/api/src/payments/processRefund.test.ts` ("a refund without a reason stores 'unspecified'...") plus the 11 tests that now pass.

### R1 Two refunds at the same time both succeed
- Severity: Critical
- Ticket: FP-209
- Where: `apps/api/src/payments/processRefund.ts` (the old three-step flow: validate, acquirer, journal)
- What is wrong: Two refunds for the full amount, sent at the same time with different idempotency keys, both succeeded. The cardholder got the money back twice, and `refunded_fils` showed only one of them.
- Why it happens: Step 1 read the transaction with no `FOR UPDATE`, validated, and committed. Step 2 called the acquirer outside any transaction. Step 3 wrote `refunded_fils = old value + amount` from the stale step-1 read. Both requests read `refunded_fils = 0`, both passed, both paid out, and the last write won. Capture (`capture.ts`) does not have this bug because it holds a row lock across the acquirer call.
- What it breaks: Double refunds (real money lost), a wrong `refunded_fils`, and a ledger that does not match the transaction row.
- Fix: One database transaction from the idempotency claim to the journal, same as capture. The transaction row is locked with `SELECT ... FOR UPDATE` before validation and the lock is held across the acquirer call. A second refund waits for the lock, then is validated against the new refunded total and is refused (409 `transaction_not_refundable` once the row is `refunded`, or 422 `refund_exceeds_refundable` if only part is left).
- Test: `apps/api/src/payments/processRefund.test.ts` ("two concurrent full refunds: exactly one succeeds ...")

### R2 Refund limit uses the authorized amount, not the captured amount
- Severity: Critical
- Ticket: FP-300
- Where: `apps/api/src/payments/processRefund.ts` (`refundableFils`), `apps/api/src/payments/refundValidation.test.ts` (fixture)
- What is wrong: A merchant could refund more than was captured. Authorize 10.000 BD, capture 4.000 BD, and a refund of up to 10.000 BD was accepted.
- Why it happens: The code computed `refundable = amount_fils (authorized) - refunded_fils`. Money that was only authorized was never taken from the card, so it cannot go back. The unit test fixture built `refundableFils` with the same wrong formula, so the tests agreed with the bug. Migration 0043 only checked `refunded_fils >= 0`.
- What it breaks: The platform pays the cardholder money it never collected. The merchant's payable goes negative.
- Fix: `refundable = captured_fils - refunded_fils`. The test fixture uses the same formula. New migration `0082_transactions_refunded_le_captured.sql` adds `CHECK (refunded_fils <= captured_fils)`, so the database refuses an over-refund from any code path.
- Test: `apps/api/src/payments/processRefund.test.ts` ("a partially captured transaction cannot refund more than it captured", "the database refuses refunded_fils greater than captured_fils"), `refundValidation.test.ts` ("... cannot refund past what it captured").

### R3 A merchant can refund another merchant's transaction
- Severity: Critical
- Ticket: FP-300
- Where: `apps/api/src/refunds/initiateMerchantRefund.ts` (transaction lookup), `apps/api/src/payments/processRefund.ts` (row lock query)
- What is wrong: Merchant B could send merchant A's transaction id and the refund went through. It was booked against merchant A (A's money went to the cardholder).
- Why it happens: Both lookups used `WHERE id = $1` only, and `initiateMerchantRefund` then passed `txn.merchant_id` (the owner of the row) on to `processRefund` instead of the authenticated merchant. The path scope check only compares the URL merchant id with the session, not the transaction's owner. The test that would have caught this was deleted as "redundant".
- What it breaks: Any merchant (or a leaked API key) can drain another merchant's captured payments.
- Fix: Both lookups are `WHERE id = $1 AND merchant_id = $2` with the authenticated merchant id, and the authenticated id is what is passed on. Another merchant's transaction answers 404 (`transaction_not_found`), never 403, so its existence is not confirmed.
- Test: `apps/api/src/payments/processRefund.test.ts` ("another merchant's transaction answers 404 ..."), `apps/api/src/refunds/initiateMerchantRefund.test.ts` ("another merchant's existing transactionId is a 404 ...").

### R4 `refunds_enabled = NULL` is treated as enabled
- Severity: High
- Ticket: FP-300
- Where: `apps/api/src/refunds/initiateMerchantRefund.ts` (`assertRefundsNotOnHold`, now `assertRefundsEnabled`)
- What is wrong: Every merchant could refund, including merchants support never enabled.
- Why it happens: The check was `refunds_enabled === false`. Migration 0052 adds the column with no default, so every merchant starts at NULL, and the note in 0052 says "NULL is treated as disabled until support explicitly enables refunds per merchant, so nothing refunds by accident at launch". The code read NULL as "no hold".
- What it breaks: At launch every merchant gets live refunds at once, with no per-merchant control.
- Fix: Only `refunds_enabled = true` passes. NULL and false answer 403 `refunds_not_enabled`. The test helper enables refunds for its merchants, and a new test covers NULL.
- Test: `apps/api/src/refunds/initiateMerchantRefund.test.ts` ("a refund is refused when refunds_enabled is NULL (never enabled)").

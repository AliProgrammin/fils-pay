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

### R5 Fee reversal does not add up to the fee charged
- Severity: High
- Ticket: FP-300
- Where: `packages/money/src/fils.ts` (`calculateRefundFee`), `apps/api/src/payments/processRefund.ts` (fee base query)
- What is wrong: (1) Partial refunds did not reverse the whole fee. Fee 25 fils on a 1.000 BD capture, ten refunds of 0.100 BD: each reversed round(2.5) = 2, so 20 in total, not 25. The merchant lost 5 fils for a payment that was fully refunded. (2) For a merchant with a negotiated discount, the refund reversed the gross MDR, not the net fee the merchant was really charged, so the merchant got the discount back a second time.
- Why it happens: (1) `calculateRefundFee` rounded each refund alone, with no memory of earlier refunds. Yousif's handover says it "sums back to the original fee across partials"; it did not. (2) The fee base summed only the `platform_fee_revenue` credits and ignored the `capture: negotiated discount adjustment` debits.
- What it breaks: Merchant payable for a fully refunded payment is not 0. Fees and payouts are off by a few fils per refund, and by the whole discount for discounted merchants.
- Fix: Cumulative reversal. `reversed_after = round(fee * refunded_after / captured)` (banker's rounding, bigint), this refund reverses `reversed_after - already_reversed`. When everything is refunded, `reversed_after = fee` exactly, so the last refund takes the exact remainder. The fee base is now the net fee: capture fee credits minus discount debits on `platform_fee_revenue` for this transaction (refund reversals left out); `already_reversed` is the sum of earlier `refunds.fee_reversed_fils`. `calculateRefundFee` takes a named-field object so the five inputs cannot be swapped by mistake.
- Test: `packages/money/src/fils.test.ts` ("ten partial refunds of 100 ... reverse exactly the 25 fee", "any split ... sums back to the fee"), `apps/api/src/payments/processRefund.test.ts` ("ten partial refunds reverse, in total, exactly the fee charged", "a full refund for a discounted merchant reverses the net fee and leaves payable at 0").

### R6 A partial capture that is fully refunded never shows `refunded`
- Severity: Medium
- Ticket: FP-300
- Where: `apps/api/src/payments/refundState.ts` (`nextStatusAfterRefund`)
- What is wrong: Authorize 10.000 BD, capture 4.000 BD, refund the 4.000 BD: the status stayed `partially_captured`. A partial refund of it also stayed `partially_captured`. The timeline said "refunded" while the status said the payment was still open for capture.
- Why it happens: The function returned `partially_captured` first whenever `captured < authorized`, before it looked at refunds. This contradicts the type's own contract ("refunded means refunded_fils === captured_fils") and Huda's finance rule ("a transaction is refunded when every fils we captured went back").
- What it breaks: Dashboards, filters and reports showed fully refunded payments as open captures. The merchant could even capture more on a payment the customer was already refunded for, and the hold on the unused authorization was never released.
- Fix: Status now follows the refunded total first: 0 refunded keeps the capture status; `0 < refunded < captured` is `partially_refunded`; `refunded = captured` is `refunded`. When a refund moves a payment out of the capture statuses, `processRefund` releases the active hold, because capture is no longer possible (same rule capture uses when nothing is left).
- Test: `apps/api/src/payments/refundState.test.ts` ("a partial capture refunded in full is refunded", "... in part is partially_refunded"), `apps/api/src/payments/processRefund.test.ts` ("refunding everything captured on a partial capture lands on refunded and releases the hold").

### R8 No way to put refunds on hold, except raw SQL
- Severity: High
- Ticket: FP-300 ("works from start to end, through the API")
- Where: merchants.refunds_enabled (migration 0052), apps/api/src/routes/adminMerchants.ts
- What is wrong: `refunds_enabled` is a per-merchant hold switch (NULL = no hold, false = on hold, migration 0052), but no API or console screen could change it.
- Why it happens: the switch was added to the database, but the admin route and the console button were never built.
- What it breaks: support cannot put a merchant's refunds on hold (a chargeback-rate review, a compliance hold), or release the hold, without editing the production database by hand. Found by our blind judge.
- Fix: `PUT /v1/admin/merchants/:id/refunds-enabled` (`enabled: false` puts refunds on hold, `true` releases the hold) for finance and super_admin, with an audit row in the same transaction, a "Put refunds on hold" / "Release the hold" button on the admin merchant page, and `refundsEnabled` in the admin merchant data (`refunds_enabled !== false`, so NULL shows as refunds on). While on hold a refund answers 403 `refunds_on_hold`, as in the original code.
- Test: apps/api/src/routes/adminRefundsEnabled.fix.test.ts

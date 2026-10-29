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

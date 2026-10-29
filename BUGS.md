# FilsPay: bugs found, fixed and explained

Every bug below has: a test that failed on the old code and passes now, the smallest fix, its own commit, and a plain-English explanation (what is wrong, why it happens, what it breaks).

**65 bugs fixed**: 17 critical, 28 high, 18 medium, 2 low.

Ground truth we used: the case brief, `docs/ARCHITECTURE.md`, the ADRs and Yousif's handover. We did **not** follow `CLAUDE.md`, `AGENTS.md` or `.cursorrules`: they contain false rules (cents instead of fils, UTC windows, "never change tests", "Math.random is fine") that protect the bugs.

When an existing test asserted the buggy behaviour, we changed it in the same commit and wrote why in the commit body.

## Proof in numbers

| | Before | After |
|---|---|---|
| Fresh database | migrations stop at 0054 | 79 migrations + seed pass |
| TypeScript tests | 414 / 430 pass | 553 / 553 pass |
| Go tests | 54 / 54 pass | 71 / 71 pass |
| Refunds (FP-300) | `501 Not Implemented` | end to end: API, ledger, fees, payouts, webhook, timeline, reports, reconciliation |

Run the refunds proof yourself: `scripts/demo_refund.sh` (see the comment at the top for setup). It ends in `RESULT: ALL PASS`.

Independent checks: a separate agent that saw only the requirements (not our fixes) re-tested 45 bug requirements (44 passed first time, the 1 miss is fixed: A12) and the FP-300 "done when" list (its one blocker is fixed: R8).

## All bugs

| # | Severity | Bug | Ticket | Area | Details |
|---|---|---|---|---|---|
| A1 | Critical | Login works without the OTP | none | Auth and admin | [explain](docs/bugs/wave-a.md#a1-login-works-without-the-otp) |
| A2 | Critical | Login binds to the wrong merchant user | none | Auth and admin | [explain](docs/bugs/wave-a.md#a2-login-binds-to-the-wrong-merchant-user) |
| B1 | Critical | Acquirer callbacks are not deduplicated | FP-201 | Payments and links | [explain](docs/bugs/wave-b.md#b1-acquirer-callbacks-are-not-deduplicated) |
| B2 | Critical | Acquirer callback signature can be skipped, replayed, and is checked over the wrong bytes | FP-240 (inbound part) | Payments and links | [explain](docs/bugs/wave-b.md#b2-acquirer-callback-signature-can-be-skipped-replayed-and-is-checked-over-the-wrong-bytes) |
| B3 | Critical | Expired payment link can be paid by sending an old `submittedAt` | FP-187 | Payments and links | [explain](docs/bugs/wave-b.md#b3-expired-payment-link-can-be-paid-by-sending-an-old-submittedat) |
| C1 | Critical | Admin "Rebuild cached balances" reads the scheme export, not the ledger | FP-203 | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c1-admin-rebuild-cached-balances-reads-the-scheme-export-not-the-ledger) |
| C2 | Critical | Sub-merchant split loses or invents fils | FP-250 | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c2-sub-merchant-split-loses-or-invents-fils) |
| C3 | Critical | Scheme file amount is rounded from gross, not the truncated fils | ADR-0002 | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c3-scheme-file-amount-is-rounded-from-gross-not-the-truncated-fils) |
| C4 | Critical | Platform volume counter overflows at 2,147,483,647 fils | platform volume tier (HANDOVER) | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c4-platform-volume-counter-overflows-at-2147483647-fils) |
| C5 | Critical | Net payout computed with float32 | ADR-0001 | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c5-net-payout-computed-with-float32) |
| D1 | Critical | Webhook signature covers different bytes than the body sent | FP-240 | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d1-webhook-signature-covers-different-bytes-than-the-body-sent) |
| E1 | Critical | Adjustment CSV import posts 10x too little money | E1 | Data, scripts, DB | [explain](docs/bugs/wave-e.md#e1-adjustment-csv-import-posts-10x-too-little-money) |
| R1 | Critical | Two refunds at the same time both succeed | FP-209 | Refunds | [explain](docs/bugs/refunds.md#r1-two-refunds-at-the-same-time-both-succeed) |
| R2 | Critical | Refund limit uses the authorized amount, not the captured amount | FP-300 | Refunds | [explain](docs/bugs/refunds.md#r2-refund-limit-uses-the-authorized-amount-not-the-captured-amount) |
| R3 | Critical | A merchant can refund another merchant's transaction | FP-300 | Refunds | [explain](docs/bugs/refunds.md#r3-a-merchant-can-refund-another-merchants-transaction) |
| R7 | Critical | Every refund fails with `chk_refunds_reason_not_null` | FP-300 | Refunds | [explain](docs/bugs/refunds.md#r7-every-refund-fails-with-chkrefundsreasonnotnull) |
| S1 | Critical | A fresh database cannot be migrated | none (handover: "migration gaps | setup | [explain](docs/bugs/setup.md#s1-a-fresh-database-cannot-be-migrated) |
| A12 | High | Impersonation could still write through routes with no role gate | "some admin actions don't seem to have the right role checks" | Auth and admin | [explain](docs/bugs/wave-a.md#a12-impersonation-could-still-write-through-routes-with-no-role-gate) |
| A3 | High | Support admin can issue credits | case card "Missing role checks" | Auth and admin | [explain](docs/bugs/wave-a.md#a3-support-admin-can-issue-credits) |
| A4 | High | Second-approver check compares display names, not admin ids | case card "Missing role checks" (self-approve by renaming) | Auth and admin | [explain](docs/bugs/wave-a.md#a4-second-approver-check-compares-display-names-not-admin-ids) |
| A5 | High | API key rotation never revokes the old key | case card "Key rotation" | Auth and admin | [explain](docs/bugs/wave-a.md#a5-api-key-rotation-never-revokes-the-old-key) |
| A6 | High | OTP codes, payment link tokens and invite codes use Math.random | case card "OTP still safe?" | Auth and admin | [explain](docs/bugs/wave-a.md#a6-otp-codes-payment-link-tokens-and-invite-codes-use-mathrandom) |
| A7 | High | OTP attempt limit can be raced, and resend resets the budget | case card "OTP still safe?" | Auth and admin | [explain](docs/bugs/wave-a.md#a7-otp-attempt-limit-can-be-raced-and-resend-resets-the-budget) |
| A8 | High | Impersonation gives finance and super_admin write roles | case card "Missing role checks" (impersonation gives owner) | Auth and admin | [explain](docs/bugs/wave-a.md#a8-impersonation-gives-finance-and-superadmin-write-roles) |
| A9 | High | Recompute statuses takes test merchants out of test mode | case card "Test merchants in real settlement" | Auth and admin | [explain](docs/bugs/wave-a.md#a9-recompute-statuses-takes-test-merchants-out-of-test-mode) |
| B4 | High | One payment link charged twice (the real cause of incident 2026-05-14) | incident 2026-05-14 (FP-198) | Payments and links | [explain](docs/bugs/wave-b.md#b4-one-payment-link-charged-twice-the-real-cause-of-incident-2026-05-14) |
| B5 | High | Merchant A can cancel merchant B's payment link (IDOR) | none | Payments and links | [explain](docs/bugs/wave-b.md#b5-merchant-a-can-cancel-merchant-bs-payment-link-idor) |
| B6 | High | Large transactions CSV export loads everything into memory; the unused streaming version drops rows | large export | Payments and links | [explain](docs/bugs/wave-b.md#b6-large-transactions-csv-export-loads-everything-into-memory-the-unused-streaming-version-drops-rows) |
| C6 | High | MDR recalculation rewrites paid batches at the wrong rate | admin "Recalculate MDR" | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c6-mdr-recalculation-rewrites-paid-batches-at-the-wrong-rate) |
| C7 | High | Daily close runs at 03:00 Bahrain, not after midnight | case brief "settlement closes every day at midnight Bahrain time (UTC+3)" | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c7-daily-close-runs-at-0300-bahrain-not-after-midnight) |
| C8 | High | Admin shows a fee rate that is not the billed rate (245 vs 225 bps) | admin merchant detail, fee schedules | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c8-admin-shows-a-fee-rate-that-is-not-the-billed-rate-245-vs-225-bps) |
| D15 | High | Reconciliation shows a gap of minus the payout once a batch is paid | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d15-reconciliation-shows-a-gap-of-minus-the-payout-once-a-batch-is-paid) |
| D2 | High | Duplicate settlement.paid payout notifications (incident 2026-08-21) | incident 2026-08-21 | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d2-duplicate-settlementpaid-payout-notifications-incident-2026-08-21) |
| D3 | High | Webhook dispatcher does not claim rows, so two passes send the same delivery | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d3-webhook-dispatcher-does-not-claim-rows-so-two-passes-send-the-same-delivery) |
| D4 | High | Payout disbursement written many times per settlement batch | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d4-payout-disbursement-written-many-times-per-settlement-batch) |
| D5 | High | Reporting consumer reads the outbox by id, not commit order, and skips events forever | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d5-reporting-consumer-reads-the-outbox-by-id-not-commit-order-and-skips-events-forever) |
| D6 | High | Reporting cursor is not locked, so worker + catch-up apply events twice | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d6-reporting-cursor-is-not-locked-so-worker--catch-up-apply-events-twice) |
| D7 | High | Transactions report can be scoped to another merchant's split child | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d7-transactions-report-can-be-scoped-to-another-merchants-split-child) |
| D8 | High | SSRF through merchant webhook URLs | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d8-ssrf-through-merchant-webhook-urls) |
| E2 | High | March residue sweep uses the UTC month, posts the wrong legs, and double-posts on re-run | E2 (FP-187) | Data, scripts, DB | [explain](docs/bugs/wave-e.md#e2-march-residue-sweep-uses-the-utc-month-posts-the-wrong-legs-and-double-posts-on-re-run) |
| E3 | High | Hold expiry job deletes holds (and can delete every hold) | E3 (FP-219) | Data, scripts, DB | [explain](docs/bugs/wave-e.md#e3-hold-expiry-job-deletes-holds-and-can-delete-every-hold) |
| R4 | High | `refunds_enabled = NULL` is treated as enabled | FP-300 | Refunds | [explain](docs/bugs/refunds.md#r4-refundsenabled--null-is-treated-as-enabled) |
| R5 | High | Fee reversal does not add up to the fee charged | FP-300 | Refunds | [explain](docs/bugs/refunds.md#r5-fee-reversal-does-not-add-up-to-the-fee-charged) |
| R8 | High | No way to turn refunds on, except raw SQL | FP-300 ("works from start to end, through the API") | Refunds | [explain](docs/bugs/refunds.md#r8-no-way-to-turn-refunds-on-except-raw-sql) |
| S2 | High | The Dockerfiles that compose needs are missing | none (ops | setup | [explain](docs/bugs/setup.md#s2-the-dockerfiles-that-compose-needs-are-missing) |
| A10 | Medium | KYC "PDF only" check trusts the filename | none | Auth and admin | [explain](docs/bugs/wave-a.md#a10-kyc-pdf-only-check-trusts-the-filename) |
| A11 | Medium | Bulk KYC approve ignores status and writes no review rows | none | Auth and admin | [explain](docs/bugs/wave-a.md#a11-bulk-kyc-approve-ignores-status-and-writes-no-review-rows) |
| B7 | Medium | Capture idempotency ignores which transaction is captured | none | Payments and links | [explain](docs/bugs/wave-b.md#b7-capture-idempotency-ignores-which-transaction-is-captured) |
| C10 | Medium | `rebuild-balances --merchant=X` never writes, and the full rebuild races CloseBatch/PayoutBatch | HANDOVER "Balances" | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c10-rebuild-balances---merchantx-never-writes-and-the-full-rebuild-races-closebatchpayoutbatch) |
| C11 | Medium | Lifetime payout estimate drifts (float32 into a REAL column) | ops monitoring (migration 0040) | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c11-lifetime-payout-estimate-drifts-float32-into-a-real-column) |
| C9 | Medium | Scheme rounding residue is never journaled | ADR-0002 | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c9-scheme-rounding-residue-is-never-journaled) |
| D10 | Medium | Reporting consumer is stopped by poison events (null merchant_id, missing rollup row) | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d10-reporting-consumer-is-stopped-by-poison-events-null-merchantid-missing-rollup-row) |
| D11 | Medium | Replays mint a new Webhook-Delivery-Id; batch replay resends succeeded deliveries | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d11-replays-mint-a-new-webhook-delivery-id-batch-replay-resends-succeeded-deliveries) |
| D12 | Medium | Dev fallback webhook encryption key is 34 bytes, so the API cannot boot in dev | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d12-dev-fallback-webhook-encryption-key-is-34-bytes-so-the-api-cannot-boot-in-dev) |
| D14 | Medium | Deleting a webhook endpoint with history crashes with a 500 | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d14-deleting-a-webhook-endpoint-with-history-crashes-with-a-500) |
| D16 | Medium | Reconciliation estimates pending fees at the wrong rate, with float rounding | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d16-reconciliation-estimates-pending-fees-at-the-wrong-rate-with-float-rounding) |
| D17 | Medium | Reports show gross only and leave out refunds | FP-300 (refunds) follow-up | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d17-reports-show-gross-only-and-leave-out-refunds) |
| D9 | Medium | Flaky backoff test: "failing endpoint: backoff/exhaustion ..." | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d9-flaky-backoff-test-failing-endpoint-backoffexhaustion-) |
| E4 | Medium | Ledger can be edited or wiped without error | E4 | Data, scripts, DB | [explain](docs/bugs/wave-e.md#e4-ledger-can-be-edited-or-wiped-without-error) |
| E5 | Medium | "Adjust balance" changes only the cached balance, not the ledger | E5 | Data, scripts, DB | [explain](docs/bugs/wave-e.md#e5-adjust-balance-changes-only-the-cached-balance-not-the-ledger) |
| E6 | Medium | Refund summary view joins the wrong column and double counts captures | E6 | Data, scripts, DB | [explain](docs/bugs/wave-e.md#e6-refund-summary-view-joins-the-wrong-column-and-double-counts-captures) |
| R6 | Medium | A partial capture that is fully refunded never shows `refunded` | FP-300 | Refunds | [explain](docs/bugs/refunds.md#r6-a-partial-capture-that-is-fully-refunded-never-shows-refunded) |
| S3 | Medium | The stack starts in the wrong order | none | setup | [explain](docs/bugs/setup.md#s3-the-stack-starts-in-the-wrong-order) |
| D13 | Low | Report export summary had no login check | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d13-report-export-summary-had-no-login-check) |
| E7 | Low | Dashboard crashes on a negative amount | E7 | Data, scripts, DB | [explain](docs/bugs/wave-e.md#e7-dashboard-crashes-on-a-negative-amount) |

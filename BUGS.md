# FilsPay: bugs found, fixed and explained

Every bug below has the smallest fix and a plain-English explanation (what is wrong, why it happens, what it breaks). Every behaviour bug has a test that failed on the old code and passes now; the few speed and capacity fixes are proven by the load test instead (CAPACITY.md).

**103 bugs fixed**: 18 critical, 40 high, 32 medium, 13 low.

Ground truth we used: the case brief, `docs/ARCHITECTURE.md`, the ADRs and Yousif's handover. We did **not** follow the `CLAUDE.md`, `AGENTS.md` or `.cursorrules` we were handed (now kept in `ai-setup/handed-over/`): they contain false rules (cents instead of fils, UTC windows, "never change tests", "Math.random is fine") that protect the bugs.

When an existing test asserted the buggy behaviour, we changed it in the same commit and wrote why in the commit body.

## Proof in numbers

| | Before | After |
|---|---|---|
| Fresh database | migrations stop at 0054 | 85 migrations + seed pass |
| TypeScript tests | 414 / 430 pass | 605 / 605 pass |
| Go tests | 54 / 54 pass | 84 / 84 pass |
| Refunds (FP-300) | `POST /v1/refunds` returned `501`; the dashboard drawer posted to an unregistered path (`404`) | end to end: API, ledger, fees, payouts, webhook, timeline, reports, reconciliation |

Run the refunds proof yourself: `scripts/demo_refund.sh` (see the comment at the top for setup). It ends in `RESULT: ALL PASS`.

How we found them: three independent audit rounds, then a separate agent that saw only the requirements (not our fixes) re-tested them. Its first pass on 45 requirements found 44 correct, the refunds check found one gap, and the final pass on 23 new requirements found 22 correct. Every miss (A12, R8, H10) is fixed. Bugs we could not prove with a test are not listed.

## All bugs

| No. | # | Severity | Bug | Ticket | Area | Details |
|---:|---|---|---|---|---|---|
| 1 | A1 | Critical | Login works without the OTP | none | Auth and admin | [explain](docs/bugs/wave-a.md#a1-login-works-without-the-otp) |
| 2 | A2 | Critical | Login binds to the wrong merchant user | none | Auth and admin | [explain](docs/bugs/wave-a.md#a2-login-binds-to-the-wrong-merchant-user) |
| 3 | B1 | Critical | Acquirer callbacks are not deduplicated | FP-201 | Payments and links | [explain](docs/bugs/wave-b.md#b1-acquirer-callbacks-are-not-deduplicated) |
| 4 | B2 | Critical | Acquirer callback signature can be skipped, replayed, and is checked over the wrong bytes | FP-240 | Payments and links | [explain](docs/bugs/wave-b.md#b2-acquirer-callback-signature-can-be-skipped-replayed-and-is-checked-over-the-wrong-bytes) |
| 5 | B3 | Critical | Expired payment link can be paid by sending an old `submittedAt` | FP-187 | Payments and links | [explain](docs/bugs/wave-b.md#b3-expired-payment-link-can-be-paid-by-sending-an-old-submittedat) |
| 6 | C1 | Critical | Admin "Rebuild cached balances" reads the scheme export, not the ledger | FP-203 | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c1-admin-rebuild-cached-balances-reads-the-scheme-export-not-the-ledger) |
| 7 | C2 | Critical | Sub-merchant split loses or invents fils | FP-250 | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c2-sub-merchant-split-loses-or-invents-fils) |
| 8 | C3 | Critical | Scheme file amount is rounded from gross, not the truncated fils | ADR-0002 | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c3-scheme-file-amount-is-rounded-from-gross-not-the-truncated-fils) |
| 9 | C4 | Critical | Platform volume counter overflows at 2,147,483,647 fils | platform volume tier | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c4-platform-volume-counter-overflows-at-2147483647-fils) |
| 10 | C5 | Critical | Net payout computed with float32 | ADR-0001 | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c5-net-payout-computed-with-float32) |
| 11 | D1 | Critical | Webhook signature covers different bytes than the body sent | FP-240 | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d1-webhook-signature-covers-different-bytes-than-the-body-sent) |
| 12 | E1 | Critical | Adjustment CSV import posts 10x too little money | E1 | Data, scripts, DB | [explain](docs/bugs/wave-e.md#e1-adjustment-csv-import-posts-10x-too-little-money) |
| 13 | E9 | Critical | The same adjustment CSV can be applied twice and double every posting | E9 | Data, scripts, DB | [explain](docs/bugs/wave-e.md#e9-the-same-adjustment-csv-can-be-applied-twice-and-double-every-posting) |
| 14 | R1 | Critical | Two refunds at the same time both succeed | FP-209 | Refunds | [explain](docs/bugs/refunds.md#r1-two-refunds-at-the-same-time-both-succeed) |
| 15 | R2 | Critical | Refund limit uses the authorized amount, not the captured amount | FP-300 | Refunds | [explain](docs/bugs/refunds.md#r2-refund-limit-uses-the-authorized-amount-not-the-captured-amount) |
| 16 | R3 | Critical | A merchant can refund another merchant's transaction | FP-300 | Refunds | [explain](docs/bugs/refunds.md#r3-a-merchant-can-refund-another-merchants-transaction) |
| 17 | R7 | Critical | Every refund fails with `chk_refunds_reason_not_null` | FP-300 | Refunds | [explain](docs/bugs/refunds.md#r7-every-refund-fails-with-chk_refunds_reason_not_null) |
| 18 | S1 | Critical | A fresh database cannot be migrated | none | Setup (could not start) | [explain](docs/bugs/setup.md#s1-a-fresh-database-cannot-be-migrated) |
| 19 | A12 | High | Impersonation could still write through routes with no role gate | some admin actions don't seem to have the right role checks | Auth and admin | [explain](docs/bugs/wave-a.md#a12-impersonation-could-still-write-through-routes-with-no-role-gate) |
| 20 | A3 | High | Support admin can issue credits | case card | Auth and admin | [explain](docs/bugs/wave-a.md#a3-support-admin-can-issue-credits) |
| 21 | A4 | High | Second-approver check compares display names, not admin ids | case card | Auth and admin | [explain](docs/bugs/wave-a.md#a4-second-approver-check-compares-display-names-not-admin-ids) |
| 22 | A5 | High | API key rotation never revokes the old key | case card | Auth and admin | [explain](docs/bugs/wave-a.md#a5-api-key-rotation-never-revokes-the-old-key) |
| 23 | A6 | High | OTP codes, payment link tokens and invite codes use Math.random | case card | Auth and admin | [explain](docs/bugs/wave-a.md#a6-otp-codes-payment-link-tokens-and-invite-codes-use-mathrandom) |
| 24 | A7 | High | OTP attempt limit can be raced, and resend resets the budget | case card | Auth and admin | [explain](docs/bugs/wave-a.md#a7-otp-attempt-limit-can-be-raced-and-resend-resets-the-budget) |
| 25 | A8 | High | Impersonation gives finance and super_admin write roles | case card | Auth and admin | [explain](docs/bugs/wave-a.md#a8-impersonation-gives-finance-and-super_admin-write-roles) |
| 26 | A9 | High | Recompute statuses takes test merchants out of test mode | case card | Auth and admin | [explain](docs/bugs/wave-a.md#a9-recompute-statuses-takes-test-merchants-out-of-test-mode) |
| 27 | B4 | High | One payment link charged twice (the real cause of incident 2026-05-14) | incident 2026-05-14 | Payments and links | [explain](docs/bugs/wave-b.md#b4-one-payment-link-charged-twice-the-real-cause-of-incident-2026-05-14) |
| 28 | B5 | High | Merchant A can cancel merchant B's payment link (IDOR) | none | Payments and links | [explain](docs/bugs/wave-b.md#b5-merchant-a-can-cancel-merchant-bs-payment-link-idor) |
| 29 | B6 | High | Large transactions CSV export loads everything into memory; the unused streaming version drops rows | large export | Payments and links | [explain](docs/bugs/wave-b.md#b6-large-transactions-csv-export-loads-everything-into-memory-the-unused-streaming-version-drops-rows) |
| 30 | C12 | High | Unapproved platform-wide fee discount (-15 bps for every merchant) | HANDOVER | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c12-unapproved-platform-wide-fee-discount--15-bps-for-every-merchant) |
| 31 | C6 | High | MDR recalculation rewrites paid batches at the wrong rate | admin | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c6-mdr-recalculation-rewrites-paid-batches-at-the-wrong-rate) |
| 32 | C7 | High | Daily close runs at 03:00 Bahrain, not after midnight | case brief | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c7-daily-close-runs-at-0300-bahrain-not-after-midnight) |
| 33 | C8 | High | Admin shows a fee rate that is not the billed rate (245 vs 225 bps) | admin merchant detail, fee schedules | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c8-admin-shows-a-fee-rate-that-is-not-the-billed-rate-245-vs-225-bps) |
| 34 | D15 | High | Reconciliation shows a gap of minus the payout once a batch is paid | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d15-reconciliation-shows-a-gap-of-minus-the-payout-once-a-batch-is-paid) |
| 35 | D2 | High | Duplicate settlement.paid payout notifications (incident 2026-08-21) | incident 2026-08-21 | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d2-duplicate-settlementpaid-payout-notifications-incident-2026-08-21) |
| 36 | D3 | High | Webhook dispatcher does not claim rows, so two passes send the same delivery | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d3-webhook-dispatcher-does-not-claim-rows-so-two-passes-send-the-same-delivery) |
| 37 | D4 | High | Payout disbursement written many times per settlement batch | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d4-payout-disbursement-written-many-times-per-settlement-batch) |
| 38 | D5 | High | Reporting consumer reads the outbox by id, not commit order, and skips events forever | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d5-reporting-consumer-reads-the-outbox-by-id-not-commit-order-and-skips-events-forever) |
| 39 | D6 | High | Reporting cursor is not locked, so worker + catch-up apply events twice | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d6-reporting-cursor-is-not-locked-so-worker--catch-up-apply-events-twice) |
| 40 | D7 | High | Transactions report can be scoped to another merchant's split child | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d7-transactions-report-can-be-scoped-to-another-merchants-split-child) |
| 41 | D8 | High | SSRF through merchant webhook URLs | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d8-ssrf-through-merchant-webhook-urls) |
| 42 | E2 | High | March residue sweep uses the UTC month, posts the wrong legs, and double-posts on re-run | E2 | Data, scripts, DB | [explain](docs/bugs/wave-e.md#e2-march-residue-sweep-uses-the-utc-month-posts-the-wrong-legs-and-double-posts-on-re-run) |
| 43 | E3 | High | Hold expiry job deletes holds (and can delete every hold) | E3 | Data, scripts, DB | [explain](docs/bugs/wave-e.md#e3-hold-expiry-job-deletes-holds-and-can-delete-every-hold) |
| 44 | E8 | High | Settlement summary counts a multi-capture transaction once per capture | E8 | Data, scripts, DB | [explain](docs/bugs/wave-e.md#e8-settlement-summary-counts-a-multi-capture-transaction-once-per-capture) |
| 45 | G1 | High | One merchant's failure stops settlement for all later merchants | none | Settlement money (Go) | [explain](docs/bugs/hunt-3-g.md#g1-one-merchants-failure-stops-settlement-for-all-later-merchants) |
| 46 | G2 | High | A late capture is never settled, and run-batch accepts today and future dates | none | Settlement money (Go) | [explain](docs/bugs/hunt-3-g.md#g2-a-late-capture-is-never-settled-and-run-batch-accepts-today-and-future-dates) |
| 47 | G3 | High | The payout disbursement is only written when a webhook is sent | none | Settlement money (Go) | [explain](docs/bugs/hunt-3-g.md#g3-the-payout-disbursement-is-only-written-when-a-webhook-is-sent) |
| 48 | H1 | High | Public payment-link page leaks API key data | none | Payments and API | [explain](docs/bugs/hunt-2.md#h1-public-payment-link-page-leaks-api-key-data) |
| 49 | H2 | High | Support role can capture and void | none | Payments and API | [explain](docs/bugs/hunt-2.md#h2-support-role-can-capture-and-void) |
| 50 | H4 | High | Payment-link captures never get the negotiated discount in the ledger | H4 | Payments and API | [explain](docs/bugs/hunt-2.md#h4-payment-link-captures-never-get-the-negotiated-discount-in-the-ledger) |
| 51 | L1 | High | The ledger balance check reads the whole ledger on every write | none | Capacity (load test) | [explain](docs/bugs/load.md#l1-the-ledger-balance-check-reads-the-whole-ledger-on-every-write) |
| 52 | L3 | High | A payment cut off by a crash leaves the link stuck and the card held | INC 05-14 family | Capacity (load test) | [explain](docs/bugs/load.md#l3-a-payment-cut-off-by-a-crash-leaves-the-link-stuck-and-the-card-held) |
| 53 | R4 | High | `refunds_enabled = NULL` is treated as enabled | FP-300 | Refunds | [explain](docs/bugs/refunds.md#r4-refunds_enabled--null-is-treated-as-enabled) |
| 54 | R5 | High | Fee reversal does not add up to the fee charged | FP-300 | Refunds | [explain](docs/bugs/refunds.md#r5-fee-reversal-does-not-add-up-to-the-fee-charged) |
| 55 | R8 | High | No way to turn refunds on, except raw SQL | FP-300 | Refunds | [explain](docs/bugs/refunds.md#r8-no-way-to-turn-refunds-on-except-raw-sql) |
| 56 | S2 | High | The Dockerfiles that compose needs are missing | none | Setup (could not start) | [explain](docs/bugs/setup.md#s2-the-dockerfiles-that-compose-needs-are-missing) |
| 57 | U12 | High | Admin "run batch" accepts today or a future date | R12 | Reporting, auth, UI | [explain](docs/bugs/hunt-3-r.md#u12-admin-run-batch-accepts-today-or-a-future-date) |
| 58 | V1 | High | The seed charges every capture the old merchant rate, not the rate in force at that time | venue whiteboard hint | Venue whiteboard clue | [explain](docs/bugs/venue-hint.md#v1-the-seed-charges-every-capture-the-old-merchant-rate-not-the-rate-in-force-at-that-time) |
| 59 | A10 | Medium | KYC "PDF only" check trusts the filename | none | Auth and admin | [explain](docs/bugs/wave-a.md#a10-kyc-pdf-only-check-trusts-the-filename) |
| 60 | A11 | Medium | Bulk KYC approve ignores status and writes no review rows | none | Auth and admin | [explain](docs/bugs/wave-a.md#a11-bulk-kyc-approve-ignores-status-and-writes-no-review-rows) |
| 61 | A13 | Medium | A disabled admin keeps their "view as merchant" grant | none | Auth and admin | [explain](docs/bugs/wave-a.md#a13-a-disabled-admin-keeps-their-view-as-merchant-grant) |
| 62 | B7 | Medium | Capture idempotency ignores which transaction is captured | none | Payments and links | [explain](docs/bugs/wave-b.md#b7-capture-idempotency-ignores-which-transaction-is-captured) |
| 63 | B8 | Medium | CSV formula injection in the transactions export | none | Payments and links | [explain](docs/bugs/wave-b.md#b8-csv-formula-injection-in-the-transactions-export) |
| 64 | C10 | Medium | `rebuild-balances --merchant=X` never writes, and the full rebuild races CloseBatch/PayoutBatch | HANDOVER | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c10-rebuild-balances---merchantx-never-writes-and-the-full-rebuild-races-closebatchpayoutbatch) |
| 65 | C11 | Medium | Lifetime payout estimate drifts (float32 into a REAL column) | ops monitoring | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c11-lifetime-payout-estimate-drifts-float32-into-a-real-column) |
| 66 | C9 | Medium | Scheme rounding residue is never journaled | ADR-0002 | Settlement money (Go) | [explain](docs/bugs/wave-c.md#c9-scheme-rounding-residue-is-never-journaled) |
| 67 | D10 | Medium | Reporting consumer is stopped by poison events (null merchant_id, missing rollup row) | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d10-reporting-consumer-is-stopped-by-poison-events-null-merchant_id-missing-rollup-row) |
| 68 | D11 | Medium | Replays mint a new Webhook-Delivery-Id; batch replay resends succeeded deliveries | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d11-replays-mint-a-new-webhook-delivery-id-batch-replay-resends-succeeded-deliveries) |
| 69 | D12 | Medium | Dev fallback webhook encryption key is 34 bytes, so the API cannot boot in dev | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d12-dev-fallback-webhook-encryption-key-is-34-bytes-so-the-api-cannot-boot-in-dev) |
| 70 | D14 | Medium | Deleting a webhook endpoint with history crashes with a 500 | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d14-deleting-a-webhook-endpoint-with-history-crashes-with-a-500) |
| 71 | D16 | Medium | Reconciliation estimates pending fees at the wrong rate, with float rounding | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d16-reconciliation-estimates-pending-fees-at-the-wrong-rate-with-float-rounding) |
| 72 | D17 | Medium | Reports show gross only and leave out refunds | FP-300 | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d17-reports-show-gross-only-and-leave-out-refunds) |
| 73 | D9 | Medium | Flaky backoff test: "failing endpoint: backoff/exhaustion ..." | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d9-flaky-backoff-test-failing-endpoint-backoffexhaustion-) |
| 74 | E4 | Medium | Ledger can be edited or wiped without error | E4 | Data, scripts, DB | [explain](docs/bugs/wave-e.md#e4-ledger-can-be-edited-or-wiped-without-error) |
| 75 | E5 | Medium | "Adjust balance" changes only the cached balance, not the ledger | E5 | Data, scripts, DB | [explain](docs/bugs/wave-e.md#e5-adjust-balance-changes-only-the-cached-balance-not-the-ledger) |
| 76 | E6 | Medium | Refund summary view joins the wrong column and double counts captures | E6 | Data, scripts, DB | [explain](docs/bugs/wave-e.md#e6-refund-summary-view-joins-the-wrong-column-and-double-counts-captures) |
| 77 | G11 | Medium | A late capture or refund makes two days fail reconciliation | none | Settlement money (Go) | [explain](docs/bugs/hunt-3-g.md#g11-a-late-capture-or-refund-makes-two-days-fail-reconciliation) |
| 78 | G4 | Medium | merchant_balances drifts after every rebuild | none | Settlement money (Go) | [explain](docs/bugs/hunt-3-g.md#g4-merchant_balances-drifts-after-every-rebuild) |
| 79 | H3 | Medium | Bad input gives a 500, not a 400 | none | Payments and API | [explain](docs/bugs/hunt-2.md#h3-bad-input-gives-a-500-not-a-400) |
| 80 | H5 | Medium | KYC image decompression bomb | none | Payments and API | [explain](docs/bugs/hunt-2.md#h5-kyc-image-decompression-bomb) |
| 81 | H6 | Medium | KYC upload takes many files and leaves orphan files | none | Payments and API | [explain](docs/bugs/hunt-2.md#h6-kyc-upload-takes-many-files-and-leaves-orphan-files) |
| 82 | L2 | Medium | Every API-key request writes the same database row | none | Capacity (load test) | [explain](docs/bugs/load.md#l2-every-api-key-request-writes-the-same-database-row) |
| 83 | L4 | Medium | The bank simulator's memory grows without limit | none | Capacity (load test) | [explain](docs/bugs/load.md#l4-the-bank-simulators-memory-grows-without-limit) |
| 84 | R6 | Medium | A partial capture that is fully refunded never shows `refunded` | FP-300 | Refunds | [explain](docs/bugs/refunds.md#r6-a-partial-capture-that-is-fully-refunded-never-shows-refunded) |
| 85 | S3 | Medium | The stack starts in the wrong order | none | Setup (could not start) | [explain](docs/bugs/setup.md#s3-the-stack-starts-in-the-wrong-order) |
| 86 | U5 | Medium | Admin "Rebuild analytics" counts events twice | R5 | Reporting, auth, UI | [explain](docs/bugs/hunt-3-r.md#u5-admin-rebuild-analytics-counts-events-twice) |
| 87 | U6 | Medium | Payout trend stays "closed" after the batch is paid | R6 | Reporting, auth, UI | [explain](docs/bugs/hunt-3-r.md#u6-payout-trend-stays-closed-after-the-batch-is-paid) |
| 88 | U7 | Medium | Merchants are logged out 10 minutes after login | R7 | Reporting, auth, UI | [explain](docs/bugs/hunt-3-r.md#u7-merchants-are-logged-out-10-minutes-after-login) |
| 89 | V2 | Medium | Capture picks the fee rate by the API server's clock, not the database clock | venue whiteboard hint | Venue whiteboard clue | [explain](docs/bugs/venue-hint.md#v2-capture-picks-the-fee-rate-by-the-api-servers-clock-not-the-database-clock) |
| 90 | V3 | Medium | An admin credit reverses the fee at the old merchant rate, not the rate in force | found while checking the admin console | Venue whiteboard clue | [explain](docs/bugs/venue-hint.md#v3-an-admin-credit-reverses-the-fee-at-the-old-merchant-rate-not-the-rate-in-force) |
| 91 | B9 | Low | Ops docs say the settlement daemon falls back to `dev-token` | none | Payments and links | [explain](docs/bugs/wave-b.md#b9-ops-docs-say-the-settlement-daemon-falls-back-to-dev-token) |
| 92 | D13 | Low | Report export summary had no login check | none | Webhooks and reporting | [explain](docs/bugs/wave-d.md#d13-report-export-summary-had-no-login-check) |
| 93 | E7 | Low | Dashboard crashes on a negative amount | E7 | Data, scripts, DB | [explain](docs/bugs/wave-e.md#e7-dashboard-crashes-on-a-negative-amount) |
| 94 | G10 | Low | Bad daemon timing values crash or stall the daemon | none | Settlement money (Go) | [explain](docs/bugs/hunt-3-g.md#g10-bad-daemon-timing-values-crash-or-stall-the-daemon) |
| 95 | G9 | Low | Batch event lookups scan the whole transaction_events table | none | Settlement money (Go) | [explain](docs/bugs/hunt-3-g.md#g9-batch-event-lookups-scan-the-whole-transaction_events-table) |
| 96 | H10 | Low | Three inputs still crashed the API with a 500 | none | Payments and API | [explain](docs/bugs/hunt-2.md#h10-three-inputs-still-crashed-the-api-with-a-500) |
| 97 | H11 | Low | Dead v1 transaction routes with an unauthenticated capture endpoint | none | Payments and API | [explain](docs/bugs/hunt-2.md#h11-dead-v1-transaction-routes-with-an-unauthenticated-capture-endpoint) |
| 98 | H7 | Low | api_keys.revoke_after is ignored | none | Payments and API | [explain](docs/bugs/hunt-2.md#h7-api_keysrevoke_after-is-ignored) |
| 99 | H8 | Low | Dead BD parser with the wrong unit | none | Payments and API | [explain](docs/bugs/hunt-2.md#h8-dead-bd-parser-with-the-wrong-unit) |
| 100 | H9 | Low | No index for releasing a hold | none | Payments and API | [explain](docs/bugs/hunt-2.md#h9-no-index-for-releasing-a-hold) |
| 101 | U11 | Low | Admin Settlement page default date is two days ago after midnight | R11 | Reporting, auth, UI | [explain](docs/bugs/hunt-3-r.md#u11-admin-settlement-page-default-date-is-two-days-ago-after-midnight) |
| 102 | U13 | Low | Admin list cursors give a 500 on a bad cursor | R13 | Reporting, auth, UI | [explain](docs/bugs/hunt-3-r.md#u13-admin-list-cursors-give-a-500-on-a-bad-cursor) |
| 103 | U8 | Low | Transaction list date filter uses the UTC day | R8 | Reporting, auth, UI | [explain](docs/bugs/hunt-3-r.md#u8-transaction-list-date-filter-uses-the-utc-day) |

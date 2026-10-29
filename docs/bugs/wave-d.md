# Wave D bugs

### D1 Webhook signature covers different bytes than the body sent
- Severity: Critical. Ticket: FP-240. Where: apps/api/src/webhooks/sign.ts:36, apps/api/src/webhooks/dispatcher.ts:158-172
- What is wrong: the dispatcher signed `canonicalJson(payload)` (keys sorted) but sent `JSON.stringify(row.payload)` (jsonb key order). The two strings are different.
- Why it happens: the payload is stored as jsonb, which changes key order. The signer serialised the object one way and the sender another way. The old tests re-parsed and re-canonicalised the body before they verified it, so they could not see the mismatch.
- What it breaks: every merchant that verifies the HMAC over the raw request body (the correct way, and what ARCHITECTURE.md promises) rejects every webhook. Merchants either drop real events or turn off verification.
- Fix: serialise the body once, sign that exact string, send that exact string (dispatcher and test-send). `signPayload` and `verifySignature` now take the raw body string. Existing tests that verified a re-parsed object now verify the raw body; the test that locked in sorted-key signing is replaced.
- Test: apps/api/src/webhooks/sign.fix.test.ts (a receiver checks the HMAC over the raw bytes).

### D9 Flaky backoff test: "failing endpoint: backoff/exhaustion ..."
- Severity: Medium. Ticket: none. Where: apps/api/src/webhooks/dispatcher.test.ts:195 and :215
- What is wrong: the test asserts `backoffDelayMs(1, config) === 1000`, but the function adds a random +/-10 % jitter, so it returns 900..1100 (seen: 926, 950, 1081).
- Why it happens: the test calls the jittered function with the default `Math.random`. The code is correct (jitter is the documented design); the test is wrong.
- What it breaks: the suite fails at random, so a real dispatcher regression is hidden in noise.
- Fix: the test passes a fixed jitter (`() => 0.5`, the midpoint) when it computes the expected value. The real delay is still checked inside a time window.
- Test: the same test, now stable (ran 3 times, all pass).

### D3 Webhook dispatcher does not claim rows, so two passes send the same delivery
- Severity: High. Ticket: none. Where: apps/api/src/webhooks/dispatcher.ts:219-228 (attemptDueDeliveries)
- What is wrong: Step B did a plain SELECT of due 'pending' rows, then sent each one. Nothing marked a row as "taken".
- Why it happens: two passes running at the same time (two API replicas, or a NOTIFY pass and a poll pass on different processes) read the same due rows before either writes the outcome. A comment said "only ever run one replica", but staging runs two.
- What it breaks: merchants get the same webhook two or more times, and attempt_count / backoff is wrong.
- Fix: claim one row at a time with `SELECT ... FOR UPDATE SKIP LOCKED` inside an `UPDATE ... RETURNING` that pushes next_attempt_at forward by a lease (request timeout + 30 s). Other passes skip the row while it is sent. If the process dies, the row is due again after the lease.
- Test: apps/api/src/webhooks/dispatcher.claim.fix.test.ts (two concurrent passes, slow receiver, exactly one send).

### D4 Payout disbursement written many times per settlement batch
- Severity: High. Ticket: none. Where: apps/api/src/webhooks/dispatcher.ts:160 (PRE_DELIVERY_EFFECTS), apps/api/src/webhooks/payoutDisbursement.ts:14, db/migrations/0057
- What is wrong: the dispatcher inserts a settlement_payout_disbursements row before the first attempt (attempt_count 0) of every settlement.paid delivery. There is one delivery per endpoint, and a replay is a new row with attempt_count 0. The table has no unique key per batch.
- Why it happens: a money side effect hangs off a per-delivery, at-least-once path, and the insert is not idempotent.
- What it breaks: a merchant with 2 endpoints, or one replay, gets 2+ payout instructions for one batch (double payout risk). Concurrent passes can also both insert.
- Fix: migration 0079 drops existing duplicate rows (keeps the earliest per batch) and adds a unique index on settlement_batch_id; the insert uses `ON CONFLICT (settlement_batch_id) DO NOTHING`. Known remaining design gap (not changed, out of scope): the record is still only written when the merchant has an active webhook endpoint; it belongs in the settlement pay step.
- Test: apps/api/src/webhooks/payoutDisbursement.fix.test.ts (concurrent + repeated calls keep one row).

### D11 Replays mint a new Webhook-Delivery-Id; batch replay resends succeeded deliveries
- Severity: Medium. Ticket: none. Where: apps/api/src/webhooks/replay.ts:48, apps/api/src/webhooks/replayBatch.ts:21 (also used by archiveReplay.ts)
- What is wrong: `insertReplayDeliveryRow` made a new random delivery_event_id and wrote it into the envelope `id`. Batch replay accepted any status, including `succeeded`.
- Why it happens: a comment claimed receivers dedupe on something else. ARCHITECTURE.md and migration 0022 say the id is stable and receivers dedupe on it.
- What it breaks: a receiver that already processed the event cannot see the replay is the same event, so it processes it twice (for example double-credits a capture). A bulk replay of `succeeded` rows sends every merchant events they already handled.
- Fix: a replay copies the original envelope unchanged and reuses its id (header and body). Batch replay rejects any status other than `failed`/`exhausted` with 400. Two existing tests locked the old behaviour (expected a new id; expected `statuses: ["succeeded"]` to be accepted) and are updated.
- Test: apps/api/src/webhooks/replay.fix.test.ts.

### D12 Dev fallback webhook encryption key is 34 bytes, so the API cannot boot in dev
- Severity: Medium. Ticket: none. Where: apps/api/src/config.ts:153
- What is wrong: `DEV_FALLBACK_WEBHOOK_KEY_B64` decodes to "test-key-for-dev-only-not-for-prod", which is 34 bytes. AES-256 needs exactly 32.
- Why it happens: the fallback string was never checked against the 32-byte rule that `loadConfig` itself enforces.
- What it breaks: `loadConfig` throws in development and test whenever WEBHOOK_SECRET_ENCRYPTION_KEY is not set, so the dev fallback never works.
- Fix: replace it with a 32-byte dev key. Production is unchanged: it still has no fallback and still fails boot without the env var.
- Test: apps/api/src/config.fix.test.ts.

### D8 SSRF through merchant webhook URLs
- Severity: High. Ticket: none. Where: apps/api/src/webhooks/create.ts:15-29 (also update.ts), apps/api/src/webhooks/transport.ts:38-48
- What is wrong: a webhook URL was only checked for http/https. The transport used `fetch`, which follows redirects, and the dispatcher stores the first 2000 chars of the response body, which the merchant can read in the delivery log.
- Why it happens: comments assumed "create.ts blocks private IPs" and "https-only is our SSRF protection". Neither was true, and a DNS name or a redirect gets around any URL-only check.
- What it breaks: a merchant can make the API POST to internal services (127.0.0.1, 10.x, the cloud metadata service 169.254.169.254, the settlement internal server) and read the response in the delivery log.
- Fix: the real transport now uses node:http(s) with a `lookup` hook that rejects loopback, private, CGNAT, link-local, multicast and reserved addresses on the exact IP the socket connects to (so DNS rebinding cannot bypass it); IP literals are checked directly. Redirects are never followed (a 3xx is a failed attempt). The response read is capped at 64 KB. Production registration also rejects localhost and internal IP literals early. A local receiver still works behind the explicit dev flag `WEBHOOK_ALLOW_PRIVATE_TARGETS=true`, which is ignored in production; the end-to-end route tests pass that flag.
- Test: apps/api/src/webhooks/transport.fix.test.ts.

### D7 Transactions report can be scoped to another merchant's split child
- Severity: High. Ticket: none. Where: apps/api/src/reporting/scope.ts:12-15
- What is wrong: when a caller passes a `merchantId` filter, the code only checks that the id is a split child of *some* parent, not of the caller.
- Why it happens: the query filters on `child_merchant_id` only and forgets `parent_merchant_id`.
- What it breaks: any merchant can read the full transactions report of any marketplace sub-merchant on the platform (cross-tenant data leak). ARCHITECTURE.md says merchant-scoped queries take the merchant from the authenticated context.
- Fix: also require `parent_merchant_id = caller`. Otherwise the report falls back to the caller's own data, as before.
- Test: apps/api/src/reporting/scope.fix.test.ts.

### D2 Duplicate settlement.paid payout notifications (incident 2026-08-21)
- Severity: High. Ticket: incident 2026-08-21. Where: apps/settlement/internal/settlement/payout_notify.go:32-94, db/migrations/0009_outbox_events.sql
- What is wrong: EnqueuePayoutNotifications selects paid batches that have no settlement.paid event (NOT EXISTS), then inserts one. There is no lock and no unique index. A comment said "outbox_events has a unique index on (event_type, aggregate_id)"; it does not.
- Why it happens: check-then-insert race. The daemon tick and a manual `run-batch` run at the same time; both see "no event yet" and both insert.
- What it breaks: merchants get two (or more) settlement.paid webhooks for one payout, and every consumer of the outbox sees the payout twice. The test reproduced 6 events for one batch with 8 concurrent scans.
- Fix: migration 0075 renames existing duplicates to 'settlement.paid.duplicate' (keeps the lowest id; rows are referenced by webhook_deliveries so they are not deleted) and adds a partial unique index on outbox_events(event_type, aggregate_id) WHERE event_type = 'settlement.paid'. The insert uses ON CONFLICT DO NOTHING and counts only rows really inserted.
- Test: apps/settlement/internal/settlement/payout_notify_fix_test.go.

### D10 Reporting consumer is stopped by poison events (null merchant_id, missing rollup row)
- Severity: Medium. Ticket: none. Where: apps/api/src/webhooks/archiveReplay.test.ts:62 (fixture), apps/reporting/src/consumer/applyEvent.ts:147
- What is wrong: two different things stop every reporting pass.
  1. archiveReplay.test.ts inserted real `transaction.captured` / `transaction.voided` outbox rows with an empty `{}` payload into the shared database. The reporting consumer reads them, inserts merchant_id NULL into merchant_daily_volume, the pass rolls back, and the cursor never moves again. (The producers capture.ts, void.ts and the Go CloseBatch all send `merchantId`; there is no field name mismatch. routes/admin.test.ts already uses an inert event type for the same reason.)
  2. applyBatchClosed's parity check read `rollupResult.rows[0].captured_count` with no null check. When a day has real captures but no rollup row yet (consumer lag, the exact case the check exists to report), it throws instead of warning, and again the whole pass rolls back.
- Why it happens: one bad row blocks the consumer by design (exactly-once, all-or-nothing pass), so any malformed row or crash in an applier stops reporting for every merchant.
- What it breaks: dashboards and reports stop updating. A fresh database passes the reporting tests (11/11); the database after the API test suite failed 4.
- Fix: the fixture now writes an inert, already-processed event type (`archive.test.fixture`). The parity check treats a missing rollup row as 0 and warns. Existing shared test DBs keep old poison rows; clean them once with: `UPDATE outbox_events oe SET event_type='archive.test.fixture' WHERE event_type IN ('transaction.captured','transaction.voided') AND payload::text='{}' AND EXISTS (SELECT 1 FROM webhook_deliveries wd WHERE wd.outbox_event_id = oe.id);`
- Test: apps/api/src/webhooks/archiveReplay.test.ts ("fixtures never enqueue a rollup-eligible outbox event"), apps/reporting/src/consumer/applyEvent.fix.test.ts.

### D6 Reporting cursor is not locked, so worker + catch-up apply events twice
- Severity: High. Ticket: none. Where: apps/reporting/src/consumer/cursor.ts:23-51
- What is wrong: readCursor did a plain SELECT of the watermark and advanceCursor did an absolute SET.
- Why it happens: two passes (the live worker and `reporting catch-up`, which the RUNBOOK says is safe to run beside it, or two replicas) both read the same watermark, both apply the same events, then both write it. The `running` flag in listener.ts only guards one process. An absolute SET can also move the watermark back.
- What it breaks: merchant_daily_volume counts and totals are inflated (the test saw 39 captures counted for 20 real ones). This matches the 2026-09-14 note "rollup looked high after catch-up".
- Fix: lock the cursor row `FOR UPDATE` inside the pass transaction, so passes with the same consumer name run one after the other; advance with `GREATEST(last_processed_id, $2)` so the watermark never goes back.
- Test: apps/reporting/src/consumer/cursor.fix.test.ts.

### D5 Reporting consumer reads the outbox by id, not commit order, and skips events forever
- Severity: High. Ticket: none. Where: apps/reporting/src/consumer/runConsumerPass.ts:46-53, db/migrations/0030 (cursor)
- What is wrong: the consumer reads `WHERE id > last_processed_id ORDER BY id` and moves the cursor to the highest id it saw.
- Why it happens: the id comes from a sequence when the row is INSERTed, but the row is only visible when its transaction COMMITs. Two writers (apps/api and apps/settlement) commit in any order. If id 100 commits after id 101 was consumed, the cursor is already past 100 and event 100 is never read. A comment said "ids are monotonic, fine for now".
- What it breaks: silent, permanent loss of captures, voids and batch-closed events from merchant reports, with no error.
- Fix: migration 0080 adds `outbox_events.txid xid8 DEFAULT pg_current_xact_id()` (the inserting transaction), an index on (txid, id), and `last_processed_txid` on the cursor. The consumer only reads rows with `txid < pg_snapshot_xmin(pg_current_snapshot())` (every such transaction has finished, so the set cannot grow), in (txid, id) order, and stores (txid, id) as its cursor (forward-only). Existing rows and the existing cursor are moved to the migration's txid, so the consumer resumes exactly where it was. Trade-off: a very long open transaction anywhere in the database delays reporting until it ends (delay, never loss).
- Test: apps/reporting/src/consumer/commitOrder.fix.test.ts (a lower id held open while a higher id is consumed; both must be applied).

### D13 Report export summary had no login check
- Severity: Low
- Ticket: none
- Where: apps/api/src/routes/reporting.ts (GET /export-summary)
- What is wrong: the route had no `requireMerchantAuth` hook, unlike every other reporting route.
- Why it happens: the handler reads `request.merchantAuth!.merchantId`, but nothing sets it, so it is undefined.
- What it breaks: every call crashes with a 500; one small change away from leaking data.
- Fix: add `preHandler: requireMerchantAuth`.
- Test: apps/api/src/routes/reportingExportSummary.fix.test.ts

### D14 Deleting a webhook endpoint with history crashes with a 500
- Severity: Medium
- Ticket: none
- Where: apps/api/src/webhooks/cancel.ts, db/migrations/0022 and 0068 (endpoint_id foreign keys)
- What is wrong: `DELETE .../webhook-endpoints/:id` fails with a foreign-key error once the endpoint has any deliveries.
- Why it happens: `endpoint_id` is NOT NULL with a plain foreign key. Two code comments claim "ON DELETE SET NULL (0029)" and "ON DELETE CASCADE (0047)". Neither migration does that.
- What it breaks: a merchant cannot remove an old or leaked webhook URL; support has to touch the database.
- Fix: migration 0085 makes the column nullable with ON DELETE SET NULL, so the delivery log stays as an audit trail. The dispatcher skips pending rows whose endpoint is gone, so one deleted endpoint cannot block the queue.
- Test: apps/api/src/webhooks/cancel.fix.test.ts

### D15 Reconciliation shows a gap of minus the payout once a batch is paid
- Severity: High
- Ticket: none
- Where: apps/api/src/settlement/query.ts (getReconciliationReport, ledger query)
- What is wrong: after a batch is paid, `GET /v1/settlement/reconciliation` shows `gapFils = -netPayout` (e.g. -5835) for a merchant with no refunds, and `explained: false`.
- Why it happens: the ledger side sums every `merchant_payable` entry in the window, including the payout leg (`merchant_payable` debit, `platform_cash` credit) that PayoutBatch posts. The settlement side also counts the same batch as `settlementNetPayoutFils`. So the payout is subtracted twice. The old test hid this by putting the payout outside the one-day window; any wider window (a week, a month) includes it.
- What it breaks: finance sees an unexplained gap for every paid batch, so the report cannot be used to find real gaps.
- Fix: the ledger side leaves out payout legs (entries whose entry group has a `platform_cash` leg). It now counts what the merchant earned, which is what the batch and pending figures explain.
- Test: apps/api/src/routes/settlement.test.ts ("GET /v1/settlement/reconciliation stays at gap 0 when the window also covers the batch payout").

### D16 Reconciliation estimates pending fees at the wrong rate, with float rounding
- Severity: Medium
- Ticket: none
- Where: apps/api/src/settlement/query.ts (pending estimate), apps/api/src/fees/estimate.ts
- What is wrong: before settlement, a merchant on a negotiated rate shows a gap (e.g. 90 fils on a 36.000 BD capture at 225 bps against a 250 bps merchant rate).
- Why it happens: the pending estimate reads `merchants.mdr_bps`. Capture bills at the `fee_schedules` row in effect at the capture time (fees/feeSchedule.ts), less the platform volume tier. A code comment said a "0046 trigger" keeps the two in sync; no such trigger exists (0046 is settlement splits). The estimate also used float rates and `Math.round` (half up), while capture uses `applyRateFils` (integer, half to even), so a 0.5 fil fee could differ by 1.
- What it breaks: the report shows false gaps for every merchant with a rate change, so finance cannot trust `explained`.
- Fix: the pending query resolves the rate per capture with the same rule as getEffectiveMdrBps (effective_from <= capture time, newest first, created_at as tie-break, else merchants.mdr_bps) and takes off the volume tier bonus, as capture does. estimateFeeFils now uses applyRateFils for the fee and for the negotiated discount.
- Test: apps/api/src/routes/settlement.test.ts ("GET /v1/settlement/reconciliation prices pending captures at the effective fee schedule rate"), apps/api/src/fees/estimate.test.ts ("estimateFeeFils rounds an exact half to even, the same as capture").

### D17 Reports show gross only and leave out refunds
- Severity: Medium
- Ticket: FP-300 (refunds) follow-up
- Where: apps/api/src/reporting/transactionsReportQuery.ts, apps/api/src/routes/reporting.ts (GET /export-summary)
- What is wrong: `/v1/reporting/transactions` rows show amount and captured, but not what was refunded. `/v1/reporting/export-summary` returns `grossFils` only.
- Why it happens: both were written before refunds existed. Refunds later added `transactions.refunded_fils` (0043) and `merchant_daily_volume.refund_gross_fils` (0084), but nobody added them to the reports.
- What it breaks: a merchant reading a report sees more money than they kept. A fully refunded sale looks like a normal sale.
- Fix: each report row now has `refundedBhd` (same BD string format as `capturedBhd`). The export summary now has `refundedFils` (sum of `refund_gross_fils`). Existing fields are unchanged; the transactions CSV export is not touched.
- Test: apps/api/src/reporting/transactionsReportQuery.test.ts ("each row carries the refunded amount next to the captured amount"), apps/api/src/routes/reportingExportSummary.fix.test.ts ("export-summary reports the refunded total next to gross").

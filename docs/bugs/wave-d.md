# Wave D bugs

### D1 Webhook signature covers different bytes than the body sent
- Severity: Critical. Ticket: FP-240. Where: apps/api/src/webhooks/sign.ts:36, apps/api/src/webhooks/dispatcher.ts:158-172
- What is wrong: the dispatcher signed `canonicalJson(payload)` (keys sorted) but sent `JSON.stringify(row.payload)` (jsonb key order). The two strings are different.
- Why it happens: the payload is stored as jsonb, which changes key order. The signer serialised the object one way and the sender another way. The old tests re-parsed and re-canonicalised the body before they verified it, so they could not see the mismatch.
- What it breaks: every merchant that verifies the HMAC over the raw request body (the correct way, and what ARCHITECTURE.md promises) rejects every webhook. Merchants either drop real events or turn off verification.
- Fix: serialise the body once, sign that exact string, send that exact string (dispatcher and test-send). `signPayload` and `verifySignature` now take the raw body string. Existing tests that verified a re-parsed object now verify the raw body; the test that locked in sorted-key signing is replaced.
- Test: apps/api/src/webhooks/sign.fix.test.ts (a receiver checks the HMAC over the raw bytes).
- How found and reproduced: Case card ticket FP-240 and audit round 1 (finding 7). Evidence: `docs/exports/webhook-deliveries-beta-2026-09.csv` has 59 of 220 Beta deliveries that failed with 401 "invalid signature". Reproduced by `sign.fix.test.ts`: a receiver checks the HMAC over the raw bytes it got; on the old code the check failed.
- Effect on existing data: Deliveries already marked failed or exhausted stay that way, so merchants missed those events. They can be sent again with the admin replay (it now keeps the original id, see D11). To list them: `SELECT id, endpoint_id, event_type, status FROM webhook_deliveries WHERE status IN ('failed', 'exhausted') AND response_status_code = 401;`

### D9 Flaky backoff test: "failing endpoint: backoff/exhaustion ..."
- Severity: Medium. Ticket: none. Where: apps/api/src/webhooks/dispatcher.test.ts:195 and :215
- What is wrong: the test asserts `backoffDelayMs(1, config) === 1000`, but the function adds a random +/-10 % jitter, so it returns 900..1100 (seen: 926, 950, 1081).
- Why it happens: the test calls the jittered function with the default `Math.random`. The code is correct (jitter is the documented design); the test is wrong.
- What it breaks: the suite fails at random, so a real dispatcher regression is hidden in noise.
- Fix: the test passes a fixed jitter (`() => 0.5`, the midpoint) when it computes the expected value. The real delay is still checked inside a time window.
- Test: the same test, now stable (ran 3 times, all pass).
- How found and reproduced: Our baseline test run before any fix (TS 414/430): this dispatcher test was 1 of the 16 failures. Reproduced by running it again: the delay was 926, 950 and 1081, not 1000.
- Effect on existing data: None: test code only.

### D3 Webhook dispatcher does not claim rows, so two passes send the same delivery
- Severity: High. Ticket: none. Where: apps/api/src/webhooks/dispatcher.ts:219-228 (attemptDueDeliveries)
- What is wrong: Step B did a plain SELECT of due 'pending' rows, then sent each one. Nothing marked a row as "taken".
- Why it happens: two passes running at the same time (two API replicas, or a NOTIFY pass and a poll pass on different processes) read the same due rows before either writes the outcome. A comment said "only ever run one replica", but staging runs two.
- What it breaks: merchants get the same webhook two or more times, and attempt_count / backoff is wrong.
- Fix: claim one row at a time with `SELECT ... FOR UPDATE SKIP LOCKED` inside an `UPDATE ... RETURNING` that pushes next_attempt_at forward by a lease (request timeout + 30 s). Other passes skip the row while it is sent. If the process dies, the row is due again after the lease.
- Test: apps/api/src/webhooks/dispatcher.claim.fix.test.ts (two concurrent passes, slow receiver, exactly one send).
- How found and reproduced: Audit round 1 (finding 18, linked to incident 2026-08-21), by reading step B of `dispatcher.ts`: it selects due rows with no lock. Reproduced by `dispatcher.claim.fix.test.ts`: two passes at the same time with a slow receiver; the old code sent the delivery twice.
- Effect on existing data: Duplicate webhooks already sent cannot be recalled, and old rows can show a wrong `attempt_count`. No money row is written by this path (the disbursement side effect is D4). We did not change old rows.

### D4 Payout disbursement written many times per settlement batch
- Severity: High. Ticket: none. Where: apps/api/src/webhooks/dispatcher.ts:160 (PRE_DELIVERY_EFFECTS), apps/api/src/webhooks/payoutDisbursement.ts:14, db/migrations/0057
- What is wrong: the dispatcher inserts a settlement_payout_disbursements row before the first attempt (attempt_count 0) of every settlement.paid delivery. There is one delivery per endpoint, and a replay is a new row with attempt_count 0. The table has no unique key per batch.
- Why it happens: a money side effect hangs off a per-delivery, at-least-once path, and the insert is not idempotent.
- What it breaks: a merchant with 2 endpoints, or one replay, gets 2+ payout instructions for one batch (double payout risk). Concurrent passes can also both insert.
- Fix: migration 0079 drops existing duplicate rows (keeps the earliest per batch) and adds a unique index on settlement_batch_id; the insert uses `ON CONFLICT (settlement_batch_id) DO NOTHING`. Known remaining design gap (not changed, out of scope): the record is still only written when the merchant has an active webhook endpoint; it belongs in the settlement pay step.
- Test: apps/api/src/webhooks/payoutDisbursement.fix.test.ts (concurrent + repeated calls keep one row).
- How found and reproduced: Audit round 1 (finding 19, incident 2026-08-21 family), by reading `PRE_DELIVERY_EFFECTS` in `dispatcher.ts`. Reproduced by `payoutDisbursement.fix.test.ts`: repeated and parallel calls for one batch; the old code wrote more than one row.
- Effect on existing data: Yes, old rows were wrong. Migration 0079 deletes the duplicate disbursement rows and keeps the earliest per batch. If a bank paid a duplicate instruction, finance must check that with the bank; the database cannot show it. Before the migration this query showed them: `SELECT settlement_batch_id, count(*) FROM settlement_payout_disbursements GROUP BY 1 HAVING count(*) > 1;`

### D11 Replays mint a new Webhook-Delivery-Id; batch replay resends succeeded deliveries
- Severity: Medium. Ticket: none. Where: apps/api/src/webhooks/replay.ts:48, apps/api/src/webhooks/replayBatch.ts:21 (also used by archiveReplay.ts)
- What is wrong: `insertReplayDeliveryRow` made a new random delivery_event_id and wrote it into the envelope `id`. Batch replay accepted any status, including `succeeded`.
- Why it happens: a comment claimed receivers dedupe on something else. ARCHITECTURE.md and migration 0022 say the id is stable and receivers dedupe on it.
- What it breaks: a receiver that already processed the event cannot see the replay is the same event, so it processes it twice (for example double-credits a capture). A bulk replay of `succeeded` rows sends every merchant events they already handled.
- Fix: a replay copies the original envelope unchanged and reuses its id (header and body). Batch replay rejects any status other than `failed`/`exhausted` with 400. Two existing tests locked the old behaviour (expected a new id; expected `statuses: ["succeeded"]` to be accepted) and are updated.
- Test: apps/api/src/webhooks/replay.fix.test.ts.
- How found and reproduced: Audit round 1 (finding 50), by reading `replay.ts` against ARCHITECTURE.md and the 0022 comment ("receivers dedupe on this"). Reproduced by `replay.fix.test.ts`: a replay got a new `Webhook-Delivery-Id`, and batch replay accepted `succeeded` rows.
- Effect on existing data: Replays already sent carried new ids; they cannot be recalled, and a receiver may have processed them twice. We did not change old rows. To list them: `SELECT r.id, r.delivery_event_id, o.delivery_event_id AS original_id FROM webhook_deliveries r JOIN webhook_deliveries o ON o.id = r.replay_of_delivery_id WHERE r.delivery_event_id <> o.delivery_event_id;`

### D12 Dev fallback webhook encryption key is 34 bytes, so the API cannot boot in dev
- Severity: Medium. Ticket: none. Where: apps/api/src/config.ts:153
- What is wrong: `DEV_FALLBACK_WEBHOOK_KEY_B64` decodes to "test-key-for-dev-only-not-for-prod", which is 34 bytes. AES-256 needs exactly 32.
- Why it happens: the fallback string was never checked against the 32-byte rule that `loadConfig` itself enforces.
- What it breaks: `loadConfig` throws in development and test whenever WEBHOOK_SECRET_ENCRYPTION_KEY is not set, so the dev fallback never works.
- Fix: replace it with a 32-byte dev key. Production is unchanged: it still has no fallback and still fails boot without the env var.
- Test: apps/api/src/config.fix.test.ts.
- How found and reproduced: Found during our first setup (Phase 0): the API did not start in dev without `WEBHOOK_SECRET_ENCRYPTION_KEY`. Reproduced by `config.fix.test.ts`: the old fallback key decodes to 34 bytes and `loadConfig` throws.
- Effect on existing data: None: configuration only. Production never used the fallback.

### D8 SSRF through merchant webhook URLs
- Severity: High. Ticket: none. Where: apps/api/src/webhooks/create.ts:15-29 (also update.ts), apps/api/src/webhooks/transport.ts:38-48
- What is wrong: a webhook URL was only checked for http/https. The transport used `fetch`, which follows redirects, and the dispatcher stores the first 2000 chars of the response body, which the merchant can read in the delivery log.
- Why it happens: comments assumed "create.ts blocks private IPs" and "https-only is our SSRF protection". Neither was true, and a DNS name or a redirect gets around any URL-only check.
- What it breaks: a merchant can make the API POST to internal services (127.0.0.1, 10.x, the cloud metadata service 169.254.169.254, the settlement internal server) and read the response in the delivery log.
- Fix: the real transport now uses node:http(s) with a `lookup` hook that rejects loopback, private, CGNAT, link-local, multicast and reserved addresses on the exact IP the socket connects to (so DNS rebinding cannot bypass it); IP literals are checked directly. Redirects are never followed (a 3xx is a failed attempt). The response read is capped at 64 KB. Production registration also rejects localhost and internal IP literals early. A local receiver still works behind the explicit dev flag `WEBHOOK_ALLOW_PRIVATE_TARGETS=true`, which is ignored in production; the end-to-end route tests pass that flag.
- Test: apps/api/src/webhooks/transport.fix.test.ts.
- How found and reproduced: Audit round 1 (finding 36), by reading `create.ts` and `transport.ts`: only the scheme was checked, redirects were followed, and the response body is shown to the merchant. Reproduced by `transport.fix.test.ts`: sends to loopback, private addresses and a redirect, which the old transport allowed.
- Effect on existing data: No money data is affected. Old delivery rows can hold response text from an internal service in `response_body_excerpt`. To check: `SELECT id, merchant_id, url FROM webhook_endpoints WHERE url ~* '://(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)';` and clear the excerpts of their deliveries if any are found. We did not change old rows.

### D7 Transactions report can be scoped to another merchant's split child
- Severity: High. Ticket: none. Where: apps/api/src/reporting/scope.ts:12-15
- What is wrong: when a caller passes a `merchantId` filter, the code only checks that the id is a split child of *some* parent, not of the caller.
- Why it happens: the query filters on `child_merchant_id` only and forgets `parent_merchant_id`.
- What it breaks: any merchant can read the full transactions report of any marketplace sub-merchant on the platform (cross-tenant data leak). ARCHITECTURE.md says merchant-scoped queries take the merchant from the authenticated context.
- Fix: also require `parent_merchant_id = caller`. Otherwise the report falls back to the caller's own data, as before.
- Test: apps/api/src/reporting/scope.fix.test.ts.
- How found and reproduced: Audit round 1 (finding 35), by reading `reporting/scope.ts`: the query checks `child_merchant_id` only. Reproduced by `scope.fix.test.ts`: a merchant asks for the report of another parent's split child; the old code returned that child's data.
- Effect on existing data: None stored: this was a read-only leak. The API keeps no read log, so we cannot tell if anyone used it.

### D2 Duplicate settlement.paid payout notifications (incident 2026-08-21)
- Severity: High. Ticket: incident 2026-08-21. Where: apps/settlement/internal/settlement/payout_notify.go:32-94, db/migrations/0009_outbox_events.sql
- What is wrong: EnqueuePayoutNotifications selects paid batches that have no settlement.paid event (NOT EXISTS), then inserts one. There is no lock and no unique index. A comment said "outbox_events has a unique index on (event_type, aggregate_id)"; it does not.
- Why it happens: check-then-insert race. The daemon tick and a manual `run-batch` run at the same time; both see "no event yet" and both insert.
- What it breaks: merchants get two (or more) settlement.paid webhooks for one payout, and every consumer of the outbox sees the payout twice. The test reproduced 6 events for one batch with 8 concurrent scans.
- Fix: migration 0075 renames existing duplicates to 'settlement.paid.duplicate' (keeps the lowest id; rows are referenced by webhook_deliveries so they are not deleted) and adds a partial unique index on outbox_events(event_type, aggregate_id) WHERE event_type = 'settlement.paid'. The insert uses ON CONFLICT DO NOTHING and counts only rows really inserted.
- Test: apps/settlement/internal/settlement/payout_notify_fix_test.go.
- How found and reproduced: Incident 2026-08-21 and audit round 1 (finding 18): the comment in `payout_notify.go` claimed a unique index that no migration creates. Reproduced by `payout_notify_fix_test.go`: 8 parallel scans made 6 `settlement.paid` events for one batch on the old code.
- Effect on existing data: Yes, old rows were wrong. Migration 0075 renames the later copies to `settlement.paid.duplicate` (they cannot be deleted: `webhook_deliveries` points to them), so no consumer uses them again. Webhooks already sent for the copies cannot be recalled. To list them: `SELECT aggregate_id, count(*) FROM outbox_events WHERE event_type = 'settlement.paid.duplicate' GROUP BY 1;`

### D10 Reporting consumer is stopped by poison events (null merchant_id, missing rollup row)
- Severity: Medium. Ticket: none. Where: apps/api/src/webhooks/archiveReplay.test.ts:62 (fixture), apps/reporting/src/consumer/applyEvent.ts:147
- What is wrong: two different things stop every reporting pass.
  1. archiveReplay.test.ts inserted real `transaction.captured` / `transaction.voided` outbox rows with an empty `{}` payload into the shared database. The reporting consumer reads them, inserts merchant_id NULL into merchant_daily_volume, the pass rolls back, and the cursor never moves again. (The producers capture.ts, void.ts and the Go CloseBatch all send `merchantId`; there is no field name mismatch. routes/admin.test.ts already uses an inert event type for the same reason.)
  2. applyBatchClosed's parity check read `rollupResult.rows[0].captured_count` with no null check. When a day has real captures but no rollup row yet (consumer lag, the exact case the check exists to report), it throws instead of warning, and again the whole pass rolls back.
- Why it happens: one bad row blocks the consumer by design (exactly-once, all-or-nothing pass), so any malformed row or crash in an applier stops reporting for every merchant.
- What it breaks: dashboards and reports stop updating. A fresh database passes the reporting tests (11/11); the database after the API test suite failed 4.
- Fix: the fixture now writes an inert, already-processed event type (`archive.test.fixture`). The parity check treats a missing rollup row as 0 and warns. Existing shared test DBs keep old poison rows; clean them once with: `UPDATE outbox_events oe SET event_type='archive.test.fixture' WHERE event_type IN ('transaction.captured','transaction.voided') AND payload::text='{}' AND EXISTS (SELECT 1 FROM webhook_deliveries wd WHERE wd.outbox_event_id = oe.id);`
- Test: apps/api/src/webhooks/archiveReplay.test.ts ("fixtures never enqueue a rollup-eligible outbox event"), apps/reporting/src/consumer/applyEvent.fix.test.ts.
- How found and reproduced: Our baseline test run before any fix: 4 reporting tests failed with `merchant_id` NULL. A fresh database passed 11/11; the database after the API suite failed 4. Reproduced by `applyEvent.fix.test.ts` (a day with captures but no rollup row) and the new fixture test in `archiveReplay.test.ts`.
- Effect on existing data: Only test databases got the poison rows; the one-time UPDATE in the Fix field cleans them. In production a crashed pass rolls back, so it wrote no wrong rows; it only delayed reporting.

### D6 Reporting cursor is not locked, so worker + catch-up apply events twice
- Severity: High. Ticket: none. Where: apps/reporting/src/consumer/cursor.ts:23-51
- What is wrong: readCursor did a plain SELECT of the watermark and advanceCursor did an absolute SET.
- Why it happens: two passes (the live worker and `reporting catch-up`, which the RUNBOOK says is safe to run beside it, or two replicas) both read the same watermark, both apply the same events, then both write it. The `running` flag in listener.ts only guards one process. An absolute SET can also move the watermark back.
- What it breaks: merchant_daily_volume counts and totals are inflated (the test saw 39 captures counted for 20 real ones). This matches the 2026-09-14 note "rollup looked high after catch-up".
- Fix: lock the cursor row `FOR UPDATE` inside the pass transaction, so passes with the same consumer name run one after the other; advance with `GREATEST(last_processed_id, $2)` so the watermark never goes back.
- Test: apps/reporting/src/consumer/cursor.fix.test.ts.
- How found and reproduced: Audit round 1 (finding 34), by reading `cursor.ts` and RUNBOOK.md, which says catch-up is safe beside the worker while MK's note says it double-applies. Reproduced by `cursor.fix.test.ts`: worker and catch-up at the same time counted 39 captures for 20 real ones.
- Effect on existing data: Rollups inflated in the past stay inflated; the fix does not rewrite them. The admin "Rebuild analytics" (U5) replays the outbox, but the outbox does not hold all seeded history (open risk). To find days that differ: `SELECT v.merchant_id, v.volume_date, v.captured_count, e.n FROM merchant_daily_volume v LEFT JOIN (SELECT payload->>'merchantId' AS mid, (created_at AT TIME ZONE 'Asia/Bahrain')::date AS d, count(*) AS n FROM outbox_events WHERE event_type = 'transaction.captured' GROUP BY 1, 2) e ON e.mid = v.merchant_id::text AND e.d = v.volume_date WHERE v.captured_count <> coalesce(e.n, 0);`

### D5 Reporting consumer reads the outbox by id, not commit order, and skips events forever
- Severity: High. Ticket: none. Where: apps/reporting/src/consumer/runConsumerPass.ts:46-53, db/migrations/0030 (cursor)
- What is wrong: the consumer reads `WHERE id > last_processed_id ORDER BY id` and moves the cursor to the highest id it saw.
- Why it happens: the id comes from a sequence when the row is INSERTed, but the row is only visible when its transaction COMMITs. Two writers (apps/api and apps/settlement) commit in any order. If id 100 commits after id 101 was consumed, the cursor is already past 100 and event 100 is never read. A comment said "ids are monotonic, fine for now".
- What it breaks: silent, permanent loss of captures, voids and batch-closed events from merchant reports, with no error.
- Fix: migration 0080 adds `outbox_events.txid xid8 DEFAULT pg_current_xact_id()` (the inserting transaction), an index on (txid, id), and `last_processed_txid` on the cursor. The consumer only reads rows with `txid < pg_snapshot_xmin(pg_current_snapshot())` (every such transaction has finished, so the set cannot grow), in (txid, id) order, and stores (txid, id) as its cursor (forward-only). Existing rows and the existing cursor are moved to the migration's txid, so the consumer resumes exactly where it was. Trade-off: a very long open transaction anywhere in the database delays reporting until it ends (delay, never loss).
- Test: apps/reporting/src/consumer/commitOrder.fix.test.ts (a lower id held open while a higher id is consumed; both must be applied).
- How found and reproduced: Audit round 1 (finding 33), by reading `runConsumerPass.ts`: it reads `id > cursor`. Reproduced by `commitOrder.fix.test.ts`: a lower id is held open while a higher id is consumed; the old code never applied the lower id.
- Effect on existing data: Events skipped in the past are still missing from the rollups. Migration 0080 resumes the cursor where it was and does not re-read old rows. The admin "Rebuild analytics" (U5) re-reads the outbox. The same query as in D6 shows days whose counts differ from the outbox.

### D13 Report export summary had no login check
- Severity: Low
- Ticket: none
- Where: apps/api/src/routes/reporting.ts (GET /export-summary)
- What is wrong: the route had no `requireMerchantAuth` hook, unlike every other reporting route.
- Why it happens: the handler reads `request.merchantAuth!.merchantId`, but nothing sets it, so it is undefined.
- What it breaks: every call crashes with a 500; one small change away from leaking data.
- Fix: add `preHandler: requireMerchantAuth`.
- Test: apps/api/src/routes/reportingExportSummary.fix.test.ts
- How found and reproduced: Audit round 1 (finding 56) and our blind verifier, which saw every call return 500. Reproduced by `reportingExportSummary.fix.test.ts`: a call with a valid merchant session got 500 on the old code.
- Effect on existing data: None: request-time check only.

### D14 Deleting a webhook endpoint with history crashes with a 500
- Severity: Medium
- Ticket: none
- Where: apps/api/src/webhooks/cancel.ts, db/migrations/0022 and 0068 (endpoint_id foreign keys)
- What is wrong: `DELETE .../webhook-endpoints/:id` fails with a foreign-key error once the endpoint has any deliveries.
- Why it happens: `endpoint_id` is NOT NULL with a plain foreign key. Two code comments claim "ON DELETE SET NULL (0029)" and "ON DELETE CASCADE (0047)". Neither migration does that.
- What it breaks: a merchant cannot remove an old or leaked webhook URL; support has to touch the database.
- Fix: migration 0085 makes the column nullable with ON DELETE SET NULL, so the delivery log stays as an audit trail. The dispatcher skips pending rows whose endpoint is gone, so one deleted endpoint cannot block the queue.
- Test: apps/api/src/webhooks/cancel.fix.test.ts
- How found and reproduced: Found while we ran the refunds demo: deleting a webhook endpoint returned 500 (a foreign-key error). Reproduced by `cancel.fix.test.ts`: delete an endpoint that has deliveries; the old code failed.
- Effect on existing data: No rows are changed. Migration 0085 only changes the foreign keys to ON DELETE SET NULL, so the delivery history stays after an endpoint is deleted.

### D15 Reconciliation shows a gap of minus the payout once a batch is paid
- Severity: High
- Ticket: none
- Where: apps/api/src/settlement/query.ts (getReconciliationReport, ledger query)
- What is wrong: after a batch is paid, `GET /v1/settlement/reconciliation` shows `gapFils = -netPayout` (e.g. -5835) for a merchant with no refunds, and `explained: false`.
- Why it happens: the ledger side sums every `merchant_payable` entry in the window, including the payout leg (`merchant_payable` debit, `platform_cash` credit) that PayoutBatch posts. The settlement side also counts the same batch as `settlementNetPayoutFils`. So the payout is subtracted twice. The old test hid this by putting the payout outside the one-day window; any wider window (a week, a month) includes it.
- What it breaks: finance sees an unexplained gap for every paid batch, so the report cannot be used to find real gaps.
- Fix: the ledger side leaves out payout legs (entries whose entry group has a `platform_cash` leg). It now counts what the merchant earned, which is what the batch and pending figures explain.
- Test: apps/api/src/routes/settlement.test.ts ("GET /v1/settlement/reconciliation stays at gap 0 when the window also covers the batch payout").
- How found and reproduced: Our blind FP-300 judge found a reconciliation gap after a batch was paid. Reproduced by the test in `settlement.test.ts` "... stays at gap 0 when the window also covers the batch payout": the old query gave a gap of minus the net payout.
- Effect on existing data: None: the report is computed at request time. Reports read before the fix showed false gaps, but no stored row was wrong.

### D16 Reconciliation estimates pending fees at the wrong rate, with float rounding
- Severity: Medium
- Ticket: none
- Where: apps/api/src/settlement/query.ts (pending estimate), apps/api/src/fees/estimate.ts
- What is wrong: before settlement, a merchant on a negotiated rate shows a gap (e.g. 90 fils on a 36.000 BD capture at 225 bps against a 250 bps merchant rate).
- Why it happens: the pending estimate reads `merchants.mdr_bps`. Capture bills at the `fee_schedules` row in effect at the capture time (fees/feeSchedule.ts), less the platform volume tier. A code comment said a "0046 trigger" keeps the two in sync; no such trigger exists (0046 is settlement splits). The estimate also used float rates and `Math.round` (half up), while capture uses `applyRateFils` (integer, half to even), so a 0.5 fils fee could differ by 1.
- What it breaks: the report shows false gaps for every merchant with a rate change, so finance cannot trust `explained`.
- Fix: the pending query resolves the rate per capture with the same rule as getEffectiveMdrBps (effective_from <= capture time, newest first, created_at as tie-break, else merchants.mdr_bps) and takes off the volume tier bonus, as capture does. estimateFeeFils now uses applyRateFils for the fee and for the negotiated discount.
- Test: apps/api/src/routes/settlement.test.ts ("GET /v1/settlement/reconciliation prices pending captures at the effective fee schedule rate"), apps/api/src/fees/estimate.test.ts ("estimateFeeFils rounds an exact half to even, the same as capture").
- How found and reproduced: Our blind FP-300 judge found a pending-fee gap for merchants with a negotiated rate. Reproduced by `settlement.test.ts` "... prices pending captures at the effective fee schedule rate" and `estimate.test.ts` "estimateFeeFils rounds an exact half to even ..."; both failed on the old code.
- Effect on existing data: None: the estimate is computed at request time. The fees actually charged at capture were not affected.

### D17 Reports show gross only and leave out refunds
- Severity: Medium
- Ticket: FP-300 (refunds) follow-up
- Where: apps/api/src/reporting/transactionsReportQuery.ts, apps/api/src/routes/reporting.ts (GET /export-summary)
- What is wrong: `/v1/reporting/transactions` rows show amount and captured, but not what was refunded. `/v1/reporting/export-summary` returns `grossFils` only.
- Why it happens: both were written before refunds existed. Refunds later added `transactions.refunded_fils` (0043) and `merchant_daily_volume.refund_gross_fils` (0084), but nobody added them to the reports.
- What it breaks: a merchant reading a report sees more money than they kept. A fully refunded sale looks like a normal sale.
- Fix: each report row now has `refundedBhd` (same BD string format as `capturedBhd`). The export summary now has `refundedFils` (sum of `refund_gross_fils`). Existing fields are unchanged; the transactions CSV export is not touched.
- Test: apps/api/src/reporting/transactionsReportQuery.test.ts ("each row carries the refunded amount next to the captured amount"), apps/api/src/routes/reportingExportSummary.fix.test.ts ("export-summary reports the refunded total next to gross").
- How found and reproduced: Our blind FP-300 judge saw reports without refunds. Reproduced by `transactionsReportQuery.test.ts` ("each row carries the refunded amount ...") and `reportingExportSummary.fix.test.ts` ("export-summary reports the refunded total next to gross").
- Effect on existing data: None: the reports read columns that are already stored (`refunded_fils`, `refund_gross_fils`). Refunds did not exist before this fork, so no old report hid a refund.

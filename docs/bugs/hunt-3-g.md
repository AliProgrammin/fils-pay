# Hunt 3: settlement bugs (G)

### G1 One merchant's failure stops settlement for all later merchants
- Severity: High
- Ticket: none (auditor reproduction)
- Where: apps/settlement/internal/settlement/batch.go `RunDailyBatch`; apps/settlement/internal/scheduler/daemon.go `runIfDue`; cmd/settlement/main.go `run-batch`
- What is wrong: the daily pass returns on the first close or payout error. The daemon then skips the payout notification step.
- Why it happens: each error is returned at once with `return report, err`, although every merchant's close and payout are their own transactions and do not depend on each other.
- What it breaks: one broken merchant (for example split weights that do not sum to 10000) stops every merchant after it in id order, on every tick, for ever. Merchants that were paid before it get no `settlement.paid` notification.
- Fix: log and collect each merchant's error, continue with the next merchant, and return one combined error at the end. The daemon and the CLI always run the notification step, then report the error.
- Test: `TestRunDailyBatch_BrokenMerchantDoesNotBlockLaterMerchants_Fix` (a broken split parent sorted first; the merchant after it is paid and the error names the broken one). `TestRunDay_NotifiesPaidMerchantsWhenAnotherMerchantFails_Fix` (the paid merchant gets its `settlement.paid` event).

### G2 A late capture is never settled, and run-batch accepts today and future dates
- Severity: High
- Ticket: none (evidence: docs/exports/admin-audit-2026-09.csv row 1 ran 2026-09-01 for the same business day)
- Where: apps/settlement/internal/settlement/batch.go `CloseBatch` step 6; cmd/settlement/main.go `run-batch`; apps/settlement/internal/internalapi/server.go `handleRunBatch`
- What is wrong: close claims captures only inside its own day `[start, end)`. Nothing claims a capture whose day is already closed. Run-batch also lets an operator close today or a future day.
- Why it happens: refunds use `occurred_at < end` (carry forward), but captures were left with a lower bound too. No check compares the date with the Bahrain clock.
- What it breaks: a capture written after its day closed (slow write, or a day closed early by hand) is never paid to the merchant. Closing today freezes a batch while captures for that day still arrive, which then fall into that gap.
- Fix: claim every unbatched capture with `occurred_at < end`, the same rule as refunds. The CLI and the internal API refuse a business date that has not ended in Asia/Bahrain (API: 400 `business_date_not_closed`). The admin route guard in apps/api is a separate change.
- Test: `TestCloseBatch_LateCaptureIsCarriedForward_Fix`, `TestValidateClosableBusinessDate_Fix`, `TestRunBatch_RejectsTodayAndFuture_Fix`. `TestCloseBatch_EligibleEventSelection` now closes the previous day first, because an unbatched earlier capture is now carried forward on purpose.

### G3 The payout disbursement is only written when a webhook is sent
- Severity: High
- Ticket: none (ARCHITECTURE.md: "pay posts payout legs and records disbursement"; migration 0057: "written inside PayoutBatch's transaction")
- Where: apps/api/src/webhooks/dispatcher.ts (pre-delivery effect); apps/settlement/internal/settlement/batch.go `PayoutBatch`; apps/settlement/internal/splits/allocate.go `PayoutSplitBatch`
- What is wrong: the `settlement_payout_disbursements` row was written by the webhook dispatcher, just before the first delivery of `settlement.paid`.
- Why it happens: the dispatcher only creates deliveries for merchants with an active webhook endpoint. Split children have no `settlement.paid` event of their own.
- What it breaks: a merchant with no webhook endpoint, and every split child, never gets a payout instruction. The ledger says the money went out, but the payout rail was never told.
- Fix: `PayoutBatch` inserts the disbursement in the same transaction as its payout legs. `PayoutSplitBatch` inserts one per paid child. Migration 0091 adds `child_merchant_id` and replaces the 0079 unique index with `(settlement_batch_id, child_merchant_id) NULLS NOT DISTINCT`, so a normal batch still has at most one row. `ON CONFLICT DO NOTHING` keeps re-runs safe. The dispatcher effect and its helper are removed. The webhook itself is unchanged.
- Test: `TestPayoutBatch_RecordsDisbursementOnce_Fix` (merchant with no endpoint, paid twice, one row with the net amount). `TestPayoutSplitBatch_RecordsOneDisbursementPerChild_Fix` (three children, amounts equal their allocations, total equals net).

### G4 merchant_balances drifts after every rebuild
- Severity: Medium-High
- Ticket: none (evidence: docs/exports/merchant-balances-rebuild-2026-09-15.csv; auditor reproduced 418,483 fils)
- Where: apps/settlement/internal/balances/cache.go; apps/settlement/internal/ledger/rebuild.go; callers in batch.go, allocate.go, recalculate_mdr.go
- What is wrong: the rebuild sets the cache to the ledger's `merchant_payable`. Close then adds `+net` and payout subtracts `net`.
- Why it happens: two meanings for one number. Close posts no `merchant_payable` leg, so `+net` counts money the ledger already holds from the captures. Only payout is a real ledger leg.
- What it breaks: after any rebuild, each close and payout leaves the cache too high by that day's net. The admin console shows wrong balances, and the next rebuild "corrects" them again.
- Fix: one meaning: the cache equals the ledger's `merchant_payable`. `balances.RefreshFromLedger` locks the row, sums the ledger and writes the result. Close, payout, split payout and MDR recalculation call it in their own transaction, and the rebuild uses the same function. Rule for apps/api: manual credits, CSV adjustment import and journaled adjustments add exactly the leg they post, in the same transaction. Capture and refund do not touch the cache; the next settlement step brings it back to the ledger. (`applyBalanceCorrection` changes the cache only, which breaks the rule, but no route calls it.)
- Test: `TestMerchantBalances_MatchLedgerAfterRebuildCloseAndPay_Fix` (rebuild, close, pay: the cache equals the ledger each time; before the fix it was 19500 vs 9750). `TestCloseAndPayout_MerchantBalancesIncremental` now compares the cache with the ledger, not with the batch net; the old check only held when the cache started at 0. Seed check: rebuild, run-batch for 2026-10-29, rebuild again: 0 merchants changed.

### G9 Batch event lookups scan the whole transaction_events table
- Severity: Low (performance)
- Ticket: none (auditor saw a Parallel Seq Scan at 401k rows)
- Where: db/migrations (new 0092); queries in apps/api/src/settlement/query.ts and RecalculateMDR
- What is wrong: no index on `transaction_events.settlement_batch_id`.
- Why it happens: the only partial index covers the unbatched rows (`settlement_batch_id IS NULL`).
- What it breaks: the batch detail page and MDR recalculation get slower as events grow.
- Fix: partial index `idx_transaction_events_settlement_batch` on `(settlement_batch_id) WHERE settlement_batch_id IS NOT NULL`.
- Test: `TestTransactionEventsHasPartialSettlementBatchIndex_Fix`. EXPLAIN ANALYZE at about 402k rows, count of one batch's events: before, Parallel Seq Scan, 18.0 ms; after, Bitmap Index Scan on the new index, 0.17 ms.

### G10 Bad daemon timing values crash or stall the daemon
- Severity: Low
- Ticket: none
- Where: apps/settlement/internal/config/config.go `Load`
- What is wrong: `SETTLEMENT_DAEMON_POLL_INTERVAL_SECONDS=0` (or less) and `SETTLEMENT_DAEMON_RUN_DELAY_MINUTES` of 1440 or more are accepted.
- Why it happens: the values are parsed but never checked.
- What it breaks: a poll of 0 panics in `time.NewTicker`. A delay of one day or more is never reached before the next midnight, so the daemon never closes a day and nobody is told.
- Fix: boot fails with a clear error unless poll > 0 and 0 <= delay <= 1439.
- Test: `TestLoad_RejectsBadDaemonTiming_Fix`, `TestLoad_AcceptsDaemonTimingBounds_Fix`.

### G11 A late capture or refund makes two days fail reconciliation
- Severity: Medium (no money is lost; the report says money is missing when it is not)
- Ticket: none (regression from G2; reproduced on a migrated and seeded DB with the Go CLI and the API)
- Where: apps/api/src/settlement/query.ts `getReconciliationReport` (`GET /v1/settlement/reconciliation`); apps/web ReconciliationPage
- What is wrong: since G2, close claims every unbatched capture and refund with `occurred_at < end`. A capture of day D written after D was closed is paid in the D+1 batch. The report shows a gap on both days. Reproduction, 250 bps, capture of 10.000 BD on D, close D, late capture of 7.000 BD stamped D 23:59, capture of 4.000 BD on D+1, close D+1:
  - [D, D+1): ledger 16575, batches 9750, pending 0, gap +6825, explained false
  - [D+1, D+2): ledger 3900, batches 10725, pending 0, gap -6825, explained false
  - [D, D+2): gap 0
  - A late refund has the same effect with the sign reversed: refund of 2.000 BD (fee reversed 50) gives -1950 on D and +1950 on D+1.
- Why it happens: the report counts the ledger and pending by the event's own business day, but counts batches by `batch_date`. A carried item is in D's ledger, but in D+1's batch. No line in the report bridges the two days.
- What it breaks: finance sees an "unexplained" gap on two days for each late item, and the two gaps cancel. A real gap on those days is hidden in the noise.
- Fix: two new fields; no field changed. `carriedToLaterBatchFils` is the net of captures and refunds that happened in the period but were settled by a batch dated after it. `carriedFromEarlierDaysFils` is the net of items that happened before the period but were settled by a batch dated in it. Gap = ledger - batches - pending - carried to later + carried from earlier. A capture is priced with the same rule as pending (fee schedule at the capture time, volume tier); a refund uses its stored fee reversal. The dashboard shows both lines.
  - Why this and not "count batches by event day": `settlementNetPayoutFils` stays the exact frozen batch total, the same figure as the batch list and the bank payout. Re-dating batch events would turn that figure into a fee estimate, and the report would no longer compare the ledger with what was really paid.
  - After the fix, the same reproduction gives gap 0 and explained true on D (carried to later 6825), on D+1 (carried from earlier 6825) and on [D, D+2) (both 0). The refund case gives -1950 in the carried lines and gap 0.
- Test: apps/api/src/routes/settlement.carry.test.ts. "a late capture and a late refund carried into the next batch reconcile to 0 on both days" (before the fix: the new fields are missing and the gap is not 0). "a carried item is pending until the later batch claims it, then carried, with no gap either way".

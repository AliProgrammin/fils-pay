# Wave C bugs

### C1 Admin "Rebuild cached balances" reads the scheme export, not the ledger
- Severity: Critical. Ticket: FP-203. Where: `apps/settlement/internal/internalapi/server.go:268`, old `apps/settlement/internal/ledger/refresh.go:61`.
- What is wrong: the admin button called `ledger.RefreshBalanceCache`. That function summed the `merchant_payable_position` view. The view is `SUM(scheme_export_lines.amount_fils)`. It is not the ledger.
- Why it happens: ADR-0004 added a "fast path" for the button. Yousif's handover says the rebuild must read the ledger only. The CLI already does that with `RebuildAllBalances`.
- What it breaks: the export holds gross amounts and ignores fees, refunds and adjustments. A merchant with a 12.000 BD capture and a 0.300 BD fee is owed 11.700 BD. The button wrote 12.000 BD into the cache. Every fee becomes a fake over-payment in the balance.
- Fix: the handler calls `ledger.RebuildAllBalances` (the same ledger walk as the CLI). The wrong function `RefreshBalanceCache` and its tests are removed. The old server test comment that said "export total is right" now says ledger.
- Test: `TestRebuildBalances_ReadsLedgerNotSchemeExport_Fix` in `internal/internalapi/rebuild_fix_test.go`.
- How found and reproduced: Case card ticket FP-203 ("balance 135K to 7K") and audit round 1. The September admin audit export (`docs/exports/admin-audit-2026-09.csv`) shows `balance_rebuild` runs on 2026-09-15 and 2026-09-22 with `"source":"scheme_export_lines"` and `"changed":5`. Reproduced by `TestRebuildBalances_ReadsLedgerNotSchemeExport_Fix`: a capture with a fee, then the button; the old code wrote the gross into the cache.
- Effect on existing data: Only the `merchant_balances` cache was wrong. The ledger was not changed. One run of the fixed rebuild (button or `settlement rebuild-balances`) writes every cache row again from the ledger. Manual balance adjustments made to "fix" the wrong cache (for example the 2026-09-06 audit row "after rebuild, see FP-203") must be reviewed by finance (see E5).

### C2 Sub-merchant split loses or invents fils
- Severity: Critical. Ticket: FP-250. Where: `apps/settlement/internal/splits/allocate.go:94`, `apps/settlement/internal/splits/shares.go:11`.
- What is wrong: each child got `ApplyRateFils(net, weightBps)`, rounded on its own. Nothing checked that the weights sum to 10000.
- Why it happens: per-child rounding drops or adds the remainder of each share. No one gives the leftover fils to anyone.
- What it breaks: net 100 fils over 3333/3333/3334 pays 33+33+33 = 99. One fils stays in `merchant_payable` forever. Net 1001 fils pays 334+334+334 = 1002, one fils more than the batch. Weights of 5000+4000 pay out only 90% and mark the batch paid.
- Fix: new `money.AllocateRemainder` (the Go port of `allocateRemainder` in `packages/money`, largest remainder method). `ChildShares` and `PayoutSplitBatch` use it, so shares sum to net exactly. `PayoutSplitBatch` returns an error, and leaves the batch closed, when weights do not sum to 10000.
- Test: `TestChildShares_SumToNetWithRemainders_Fix`, `TestPayoutSplitBatch_PaysExactNet_Fix`, `TestPayoutSplitBatch_RejectsWeightsNotSummingTo10000_Fix` in `internal/splits/shares_fix_test.go`.
- How found and reproduced: Case card complaint "splits a few fils short" (FP-250) and audit round 1. Reproduced by `TestChildShares_SumToNetWithRemainders_Fix`: 100 fils over 3333/3333/3334 paid 99 on the old code.
- Effect on existing data: Split batches paid before the fix can be a few fils short or over. The seeded weights for Delta Marketplace (5000/3000/2000) sum to 10000, so only rounding is lost. We did not rewrite past payouts; finance must post correcting entries. Query: `SELECT b.id, b.batch_date, b.net_payout_fils, SUM(s.allocated_fils) FROM settlement_batches b JOIN settlement_batch_splits s ON s.settlement_batch_id = b.id GROUP BY b.id HAVING SUM(s.allocated_fils) <> b.net_payout_fils;`

### C3 Scheme file amount is rounded from gross, not the truncated fils
- Severity: Critical. Ticket: ADR-0002 / ADR-0001. Where: `apps/settlement/internal/settlement/batch.go:255`, `apps/settlement/internal/settlement/scheme_export.go:29`.
- What is wrong: `amount_fils` stored the gross truncated to 10 fils. But `amount` stored `SchemeAmountBD(gross) = float64(gross)/1000`. Postgres rounds that into `NUMERIC(10,2)`. The export file reads `amount`.
- Why it happens: two columns for one value, built from different inputs (truncated vs gross) and with a float. The 0050 comment said "same truncation". It is not: NUMERIC(10,2) rounds.
- What it breaks: 4.747 BD is sent to the scheme as 4.75, but `amount_fils` says 4740. 1.239 goes as 1.24, 1.005 goes as 1.01 (float). The scheme file is up to 9 fils per line over the ledger figure. The file and the fils column never agree, so residue (C9) and reconciliation are wrong.
- Fix: `amount` is computed in SQL from the same truncated integer: `$3::bigint::numeric / 1000`. No float. `SchemeAmountBD` is removed. Rows already exported are not rewritten, because they match what the scheme received.
- Test: `TestSchemeExportAmountMatchesTruncatedFils_Fix` in `internal/settlement/scheme_export_fix_test.go`.
- How found and reproduced: Case card complaint "scheme total always over", ADR-0002 and audit round 1. In `docs/exports/scheme/scheme_export_lines-delta-wholesale-2026-09-14.tsv`, 123 of 260 lines are 10 fils over `amount_fils`, and the file is 77 fils over the batch gross. Reproduced by `TestSchemeExportAmountMatchesTruncatedFils_Fix` (4,747 fils was stored as 4.75).
- Effect on existing data: Lines already exported keep the old `amount`, because that is what the scheme received. We did not rewrite them. Finance must settle the difference with the scheme. Query: `SELECT id, settlement_batch_id, amount_fils, amount FROM scheme_export_lines WHERE amount * 1000 <> amount_fils;`

### C9 Scheme rounding residue is never journaled
- Severity: Medium. Ticket: ADR-0002 / FP-187. Where: `apps/settlement/internal/settlement/batch.go:250`.
- What is wrong: ADR-0002 says CloseBatch posts `gross - amount_fils` per line to `scheme_rounding_residue`. The code only inserts the export line. No ledger posting exists. The ADR status "implemented" is false.
- Why it happens: the residue step was never written. The `scheme_rounding_residue` account (migration 0007) has never had a single entry.
- What it breaks: `card_scheme_clearing` is debited the full gross at capture but the scheme pays only the truncated amount. Captures of 4.747 and 1.239 BD leave 16 fils in clearing with no record. Over a month this is a few BD per busy merchant. Ledger, report and scheme statement cannot agree.
- Fix: inside CloseBatch, in the same transaction as the export line, post one balanced group per line with residue > 0: credit `card_scheme_clearing`, debit `scheme_rounding_residue`, with merchant, transaction and batch ids.
- Test: `TestCloseBatch_JournalsSchemeRoundingResidue_Fix` in `internal/settlement/residue_fix_test.go`.
- How found and reproduced: ADR-0002 says "implemented", but the `scheme_rounding_residue` account had no entry. Audit round 1. Reproduced by `TestCloseBatch_JournalsSchemeRoundingResidue_Fix`: the old CloseBatch posted no residue group.
- Effect on existing data: Lines exported before the fix have no residue posting, so their residue is still in `card_scheme_clearing` with no record (for the 2026-09-14 Delta file: gross 20,000,123 fils, sum of `amount_fils` 19,998,970). We did not backfill. Finance must post the residue for old lines. Query: `SELECT l.id, l.transaction_id, l.amount_fils FROM scheme_export_lines l WHERE NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.transaction_id = l.transaction_id AND e.account_id = 'scheme_rounding_residue');` (lines with residue 0 need nothing).

### C4 Platform volume counter overflows at 2,147,483,647 fils
- Severity: Medium (first rated Critical; lowered because the real counter is far below the limit and no fee was ever charged wrong; it is a time bomb, not a loss today). Ticket: platform volume tier (HANDOVER). Where: `db/migrations/0049_platform_stats.sql`, `apps/settlement/internal/settlement/platform_volume.go:13-27`.
- What is wrong: `platform_stats.total_processed_fils` is INTEGER. Go reads it as `int32`, adds the batch gross in Go, and writes it back.
- Why it happens: INTEGER and int32 max is 2,147,483,647 fils (2,147,483.647 BD). The tier threshold is 2,000,000,000 fils, only 7% below. The Go add wraps silently.
- What it breaks: at 2,147,000,000 fils, one 1,000.000 BD batch writes -2,146,967,296. The tier bonus (15 bps) turns off for every merchant, and fees jump back up. The counter is wrong forever after.
- Fix: migration `0074_platform_stats_total_bigint.sql` makes the column BIGINT. Go uses `int64`. The increment is done in SQL (`SET total = total + $1`). The existing `TestRecordPlatformProcessedVolume_SmallValuesExact` is changed only for the new signature (no `current` argument) and to scan `int64`. The TS reader (`apps/api/src/fees/platformVolumeTier.ts`) gets BIGINT as a string from `pg`; JS `>=` coerces it, so its tests still pass, but its type says `number`. Not changed (out of scope), call out.
- Test: `TestRecordPlatformProcessedVolume_PastInt32Max_Fix` in `internal/settlement/platform_volume_fix_test.go`.
- How found and reproduced: HANDOVER "platform volume tier" and audit round 1: the INTEGER limit is only 7% above the 2,000,000,000 fils threshold. Reproduced by `TestRecordPlatformProcessedVolume_PastInt32Max_Fix`: the old code wrapped to a negative value.
- Effect on existing data: None in the seed: `db/seed/generate.ts` sets the counter to 0. Migration 0074 widens the column and keeps the value. On a real system a negative value shows a wrap: `SELECT total_processed_fils FROM platform_stats;`

### C11 Lifetime payout estimate drifts (float32 into a REAL column)
- Severity: Medium. Ticket: ops monitoring (migration 0040). Where: `apps/settlement/internal/settlement/payout_estimate.go:19`, `db/migrations/0040_merchants_lifetime_payout_monitoring_estimate.sql`.
- What is wrong: `PayoutBatch` adds `float32(net)` to `lifetime_net_payout_monitoring_estimate`, which is `REAL` (float4).
- Why it happens: float4 holds only 24 bits of precision. It is exact only up to 16,777,216 fils (16,777.216 BD). Above that, each add is rounded.
- What it breaks: payouts of 16,777,217 + 3 + 1,234,567,891 fils should total 1,251,345,111. The column shows 1.2513452e+09, about 89 fils off, and more after every payout. Ops compare merchants against a wrong lifetime total. ADR-0001 says whole fils only.
- Fix: migration `0078_lifetime_payout_estimate_bigint.sql` makes the column BIGINT (existing values rounded to whole fils). Go passes `int64`. The seed (`db/seed/generate.ts`) no longer imitates float4 with `Math.fround`.
- Test: `TestUpdateLifetimePayoutMonitoringEstimate_LargeValuesExact_Fix` in `internal/settlement/payout_estimate_fix_test.go`.
- How found and reproduced: Audit round 1 (REAL column written with float32). Reproduced by `TestUpdateLifetimePayoutMonitoringEstimate_LargeValuesExact_Fix`: the old code was about 89 fils off on three payouts.
- Effect on existing data: Migration 0078 rounds stored values to whole fils, but drift already in them stays (its comment says so). It is a monitoring figure, not money paid. To check it: `SELECT m.id, m.lifetime_net_payout_monitoring_estimate, SUM(b.net_payout_fils) FROM merchants m JOIN settlement_batches b ON b.merchant_id = m.id AND b.status = 'paid' GROUP BY m.id;`

### C5 Net payout computed with float32
- Severity: Critical. Ticket: ADR-0001. Where: `apps/settlement/internal/settlement/payable.go:10`.
- What is wrong: `NetPayableFils` turns gross and fee into float32 BD, subtracts, and rounds back to fils.
- Why it happens: float32 has about 7 significant digits. Above about 16,777 BD the fils digit is lost.
- What it breaks: this is the merchant's real payout (`net_payout_fils`, the payout ledger legs and the balance cache). Gross 20,000.001 BD minus fee 500.000 BD pays 19,500.000, not 19,500.001. Gross 123,456.789 minus 3,086.420 pays 120,370.367, 2 fils short. Bigger batches lose or gain more. The ledger capture legs no longer match the payout.
- Fix: `return grossFils - feeFils`. Plain integer fils.
- Test: `TestNetPayableFils_ExactInteger_Fix` in `internal/settlement/payable_fix_test.go`.
- How found and reproduced: ADR-0001 (whole fils, no floats) and audit round 1. In `docs/exports/settlement-batches-2026-09-01_20.csv`, 13 of 80 paid batches have `net_payout_fils` not equal to `gross_fils - fee_fils` (1 or 2 fils off). Reproduced by `TestNetPayableFils_ExactInteger_Fix`.
- Effect on existing data: Paid batches keep their old net, because that amount went to the bank. We did not rewrite them. Finance must post correcting entries for each batch that is off. Query: `SELECT id, batch_date, gross_fils, fee_fils, net_payout_fils FROM settlement_batches WHERE net_payout_fils <> gross_fils - fee_fils - refund_fils + refund_fee_reversed_fils;`

### C6 MDR recalculation rewrites paid batches at the wrong rate
- Severity: High. Ticket: admin "Recalculate MDR". Where: `apps/settlement/internal/settlement/recalculate_mdr.go:63-127`.
- What is wrong: the scan selects `status <> 'open'`, so paid batches are included. It overwrites `fee_fils` and `net_payout_fils` on them and moves the balance cache. It also uses the current `merchants.mdr_bps` for every event and ignores `fee_schedules`.
- Why it happens: the filter was too wide, and the fee loop did not reuse CloseBatch's rate rule (`EffectiveMdrBpsAt` per event, less the volume-tier bonus).
- What it breaks: a paid 10.000 BD batch at 250 bps is rewritten to fee 0.300 / net 9.700, but 9.750 was already paid out. The batch record now disagrees with the bank. A merchant on a 200 bps fee schedule gets "corrected" up to its 250 bps fallback rate (+0.050 BD per 10 BD) even though its contract did not change.
- Fix: only `status = 'closed'` batches are recalculated. Each event is priced with `EffectiveMdrBpsAt(schedules, occurred_at, mdr_bps)` minus the tier bonus, the same as CloseBatch.
- Test: `TestRecalculateMDR_NeverTouchesPaidBatch_Fix`, `TestRecalculateMDR_UsesEffectiveFeeSchedule_Fix` in `internal/settlement/recalculate_mdr_fix_test.go`.
- How found and reproduced: Case card complaint "MDR recalc changes paid batches" and audit round 1. The admin audit export shows a `mdr_recalculation` on 2026-09-11 for Delta Marketplace Bahrain (2026-08-01 to 2026-09-10, `batchesAdjusted` 9, `totalDiffFils` -41870). Reproduced by `TestRecalculateMDR_NeverTouchesPaidBatch_Fix` and `TestRecalculateMDR_UsesEffectiveFeeSchedule_Fix`.
- Effect on existing data: The fix stops new rewrites only. Paid batches that an old run rewrote keep the wrong `fee_fils` and `net_payout_fils`, and their adjustment legs stay in the ledger. We did not restore them; finance must compare each with the bank instruction and reverse wrong legs. Query: `SELECT DISTINCT b.id, b.batch_date, b.fee_fils, b.net_payout_fils FROM settlement_batches b JOIN ledger_entries e ON e.settlement_batch_id = b.id WHERE e.description = 'MDR recalculation adjustment' AND b.status = 'paid';`

### C7 Daily close runs at 03:00 Bahrain, not after midnight
- Severity: Medium (first rated High; lowered because the right business day was closed with the right amounts, only about 3 hours late). Ticket: case brief "settlement closes every day at midnight Bahrain time (UTC+3)". Where: `apps/settlement/internal/scheduler/daemon.go:80-90`, `apps/settlement/internal/settlement/window.go:42`.
- What is wrong: the daemon calls `BusinessDayWindow(time.Now().UTC())`. `BusinessDayWindow` takes the calendar date from the value's own location, so it gets the UTC date.
- Why it happens: from 00:00 to 03:00 Bahrain, the UTC date is still yesterday. So "today" is one day behind, and the day that "just ended" is two days ago (already closed, a no-op).
- What it breaks: with a 15 min delay, the close of 14 May should run at 00:15 on 15 May Bahrain time. It runs at 03:15. Merchants are paid about 3 hours late every day, and the logs ("close ~03:15 local") show it.
- Fix: the decision is moved into `dueBusinessDate(now, delay)`, which converts now to Asia/Bahrain with the new `settlement.InBusinessDayLocation` before it takes the date. `BusinessDayWindow` keeps its calendar-date contract, because the CLI, the API and CloseBatch's `batch_date` all pass a calendar date. Its comment now says that.
- Test: `TestDueBusinessDate_BahrainMidnight_Fix` in `internal/scheduler/daemon_fix_test.go`.
- How found and reproduced: Case brief ("settlement closes every day at midnight Bahrain time") and audit round 1. The batch export shows every `paid_at_bh` between 03:05 and 03:09. Reproduced by `TestDueBusinessDate_BahrainMidnight_Fix`.
- Effect on existing data: None on amounts. The old daemon closed the right business day, only about 3 hours late. No row needs a correction.

### C8 Admin shows a fee rate that is not the billed rate (245 vs 225 bps)
- Severity: High. Ticket: admin merchant detail, fee schedules. Where: `apps/api/src/fees/currentFeeScheduleDisplay.ts:30-37`, `apps/settlement/internal/settlement/fee_schedule.go:32`.
- What is wrong: the admin "current rate" took the row with the newest `created_at`. Billing (`feeSchedule.ts`) takes `effective_from <= now ORDER BY effective_from DESC, created_at DESC`. Go sorted by `effective_from` only, with no tie-break.
- Why it happens: "newest typed in" is not "in force now". A backdated correction or a future-dated row is newest by `created_at`, but not the current rate.
- What it breaks: a merchant renegotiated to 225 bps from 1 Aug. A correction for March at 245 bps was keyed in on 15 Aug. The admin page shows 245 bps while billing charges 225: 0.20% wrong (2 fils per 1 BD) on what support tells the merchant. A future-dated 150 bps row shows as current before it starts. In Go, two rows with the same `effective_from` resolve in random heap order, so Go and TS can bill different rates.
- Fix: the display uses the billing rule. Go `LoadFeeSchedules` adds `created_at ASC` so the newest entry wins a tie, like TS. The old TS test "returns the most recently entered schedule even when an older period was backfilled later" asserted 245; it now asserts 225.
- Test: `apps/api/src/fees/currentFeeScheduleDisplay.fix.test.ts` (2 tests), `TestEffectiveMdrBpsAt_SameEffectiveFromNewestCreatedWins_Fix` in `internal/settlement/fee_schedule_fix_test.go`.
- How found and reproduced: Case card complaint "dashboard 245 vs 225 bps" and audit round 1. Reproduced by `currentFeeScheduleDisplay.fix.test.ts` (a backdated 245 row showed while billing charged 225) and the Go tie-break test.
- Effect on existing data: None for the display: it is computed when read. In Go, two schedule rows with the same `effective_from` could bill either rate. Query for such ties: `SELECT merchant_id, effective_from, count(*) FROM fee_schedules GROUP BY 1, 2 HAVING count(*) > 1;` Batches of those merchants after that date need a check.

### C10 `rebuild-balances --merchant=X` never writes, and the full rebuild races CloseBatch/PayoutBatch
- Severity: Medium. Ticket: HANDOVER "Balances". Where: `apps/settlement/cmd/settlement/main.go:149`, `apps/settlement/internal/ledger/rebuild.go:20` and `:91` (old TODO).
- What is wrong: (1) `--merchant=X` calls `RebuildMerchantBalance`, which only ran a SELECT. It printed "rebuilt" but the cache stayed wrong. (2) `RebuildAllBalances` reads the ledger, then upserts the cache, with no row lock before the read (Yousif's TODO).
- Why it happens: (1) the function was a read helper, and the CLI comment said it writes. (2) Under READ COMMITTED, a payout that commits between the rebuild's ledger read and its write is overwritten by the stale sum.
- What it breaks: (1) an operator "fixes" a merchant with a 999.999 BD drifted cache and it stays 999.999. (2) Ledger 10.000 BD, a 4.000 BD payout commits during the rebuild: the cache ends at 10.000 instead of 6.000. The merchant looks owed 4.000 BD that was already paid.
- Fix: one shared step `rebuildMerchantInTx` locks the `merchant_balances` row (`INSERT ... ON CONFLICT DO NOTHING`, then `SELECT ... FOR UPDATE`) before it reads the ledger, then writes. `RebuildMerchantBalance` (the `--merchant` path) and `RebuildAllBalances` (CLI and admin button) both use it. Merchants are processed in id order so lock order is stable.
- Test: `TestRebuildMerchantBalance_WritesCache_Fix`, `TestRebuildAllBalances_ConcurrentPayoutNotClobbered_Fix` in `internal/ledger/rebuild_fix_test.go`.
- How found and reproduced: HANDOVER "Balances", Yousif's TODO in `rebuild.go`, and audit round 1. Reproduced by `TestRebuildMerchantBalance_WritesCache_Fix` and `TestRebuildAllBalances_ConcurrentPayoutNotClobbered_Fix` (the cache ended at 10.000 BD, not 6.000).
- Effect on existing data: Only the `merchant_balances` cache could be wrong. The ledger was not changed. One full rebuild after the fix writes every cache row from the ledger.

### C12 Unapproved platform-wide fee discount (-15 bps for every merchant)
- Severity: High (money). Ticket: HANDOVER "Platform volume tier". Where: `apps/api/src/fees/platformVolumeTier.ts`, used by `apps/api/src/payments/capture.ts:171`, `apps/api/src/settlement/query.ts` (reconciliation estimate); `apps/settlement/internal/settlement/platform_volume.go` (`VolumeTierMdrBonusBps`), used by `batch.go:147` and `recalculate_mdr.go:75`.
- What is wrong: when platform volume passes 2,000,000,000 fils (2,000,000.000 BD), every merchant's MDR drops by 15 bps. Nobody approved this discount.
- Why it happens: Yousif wrote in HANDOVER: "Huda floated a platform-wide discount once total volume passes a threshold. I said no until finance signs off in writing." The code says "approved by finance — am", and MK's note under it says "which finance ticket? cant find one. Huda didnt know about it when i asked". CHANGELOG 1.9.2 points to commit d69a813 and says "No pricing change for existing merchants". That commit does not exist in the repo, and the change does reduce the price for every merchant. We found no written sign-off in the #fp-finance or #fp-ops Slack exports, the meeting notes, ARCHITECTURE or the ADRs. The only discount finance wrote about is Delta Marketplace's own contract discount (a per-merchant `discount_bps`, not this).
- What it breaks: after the threshold, the platform loses 15 bps on all volume. Example: a 10.000 BD capture at 250 bps should cost 0.250 BD; it costs 0.235 BD. On 1,000,000.000 BD of later volume, the platform loses 1,500.000 BD of fee revenue that finance never agreed to give away. Capture (TS), CloseBatch and Recalculate MDR (Go) and the reconciliation estimate all apply it.
- Fix: the bonus is 0 in both places (`VOLUME_TIER_BONUS_BPS` in TS and `volumeTierBonusBps` in Go), so TS and Go stay the same. The functions and their callers stay as they are, and the volume counter still counts. If finance signs off in writing, they change the one constant on each side. Old tests that asserted 15 bps now assert 0.
- Test: `apps/api/src/fees/platformVolumeTier.fix.test.ts` (capture after the threshold is charged 250 fils, not 235), `TestCloseBatch_PastVolumeThreshold_ChargesFullRate_Fix` in `internal/settlement/volume_tier_fix_test.go`.
- How found and reproduced: HANDOVER "Platform volume tier" (Yousif: "no until finance signs off in writing"). The code comment has no ticket, and CHANGELOG 1.9.2 cites commit d69a813, which is not in git. Reproduced by `platformVolumeTier.fix.test.ts`: a capture past the threshold was charged 235 fils, not 250.
- Effect on existing data: None in the seed: the volume counter starts at 0 and seeded fees use the plain rate. On a real system, captures after the threshold were charged 15 bps too little; finance must decide whether to recover it. First check: `SELECT total_processed_fils FROM platform_stats;` (at or above 2,000,000,000 means the discount was active).

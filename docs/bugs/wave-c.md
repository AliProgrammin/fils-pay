# Wave C bugs

### C1 Admin "Rebuild cached balances" reads the scheme export, not the ledger
- Severity: Critical. Ticket: FP-203. Where: `apps/settlement/internal/internalapi/server.go:268`, old `apps/settlement/internal/ledger/refresh.go:61`.
- What is wrong: the admin button called `ledger.RefreshBalanceCache`. That function summed the `merchant_payable_position` view. The view is `SUM(scheme_export_lines.amount_fils)`. It is not the ledger.
- Why it happens: ADR-0004 added a "fast path" for the button. Yousif's handover says the rebuild must read the ledger only. The CLI already does that with `RebuildAllBalances`.
- What it breaks: the export holds gross amounts and ignores fees, refunds and adjustments. A merchant with a 12.000 BD capture and a 0.300 BD fee is owed 11.700 BD. The button wrote 12.000 BD into the cache. Every fee becomes a fake over-payment in the balance.
- Fix: the handler calls `ledger.RebuildAllBalances` (the same ledger walk as the CLI). The wrong function `RefreshBalanceCache` and its tests are removed. The old server test comment that said "export total is right" now says ledger.
- Test: `TestRebuildBalances_ReadsLedgerNotSchemeExport_Fix` in `internal/internalapi/rebuild_fix_test.go`.

### C2 Sub-merchant split loses or invents fils
- Severity: Critical. Ticket: FP-250. Where: `apps/settlement/internal/splits/allocate.go:94`, `apps/settlement/internal/splits/shares.go:11`.
- What is wrong: each child got `ApplyRateFils(net, weightBps)`, rounded on its own. Nothing checked that the weights sum to 10000.
- Why it happens: per-child rounding drops or adds the remainder of each share. No one gives the leftover fils to anyone.
- What it breaks: net 100 fils over 3333/3333/3334 pays 33+33+33 = 99. One fils stays in `merchant_payable` forever. Net 1001 fils pays 334+334+334 = 1002, one fils more than the batch. Weights of 5000+4000 pay out only 90% and mark the batch paid.
- Fix: new `money.AllocateRemainder` (the Go port of `allocateRemainder` in `packages/money`, largest remainder method). `ChildShares` and `PayoutSplitBatch` use it, so shares sum to net exactly. `PayoutSplitBatch` returns an error, and leaves the batch closed, when weights do not sum to 10000.
- Test: `TestChildShares_SumToNetWithRemainders_Fix`, `TestPayoutSplitBatch_PaysExactNet_Fix`, `TestPayoutSplitBatch_RejectsWeightsNotSummingTo10000_Fix` in `internal/splits/shares_fix_test.go`.

### C3 Scheme file amount is rounded from gross, not the truncated fils
- Severity: Critical. Ticket: ADR-0002 / ADR-0001. Where: `apps/settlement/internal/settlement/batch.go:255`, `apps/settlement/internal/settlement/scheme_export.go:29`.
- What is wrong: `amount_fils` stored the gross truncated to 10 fils. But `amount` stored `SchemeAmountBD(gross) = float64(gross)/1000`. Postgres rounds that into `NUMERIC(10,2)`. The export file reads `amount`.
- Why it happens: two columns for one value, built from different inputs (truncated vs gross) and with a float. The 0050 comment said "same truncation". It is not: NUMERIC(10,2) rounds.
- What it breaks: 4.747 BD is sent to the scheme as 4.75, but `amount_fils` says 4740. 1.239 goes as 1.24, 1.005 goes as 1.01 (float). The scheme file is up to 9 fils per line over the ledger figure. The file and the fils column never agree, so residue (C9) and reconciliation are wrong.
- Fix: `amount` is computed in SQL from the same truncated integer: `$3::bigint::numeric / 1000`. No float. `SchemeAmountBD` is removed. Rows already exported are not rewritten, because they match what the scheme received.
- Test: `TestSchemeExportAmountMatchesTruncatedFils_Fix` in `internal/settlement/scheme_export_fix_test.go`.

### C9 Scheme rounding residue is never journaled
- Severity: Medium. Ticket: ADR-0002 / FP-187. Where: `apps/settlement/internal/settlement/batch.go:250`.
- What is wrong: ADR-0002 says CloseBatch posts `gross - amount_fils` per line to `scheme_rounding_residue`. The code only inserts the export line. No ledger posting exists. The ADR status "implemented" is false.
- Why it happens: the residue step was never written. The `scheme_rounding_residue` account (migration 0007) has never had a single entry.
- What it breaks: `card_scheme_clearing` is debited the full gross at capture but the scheme pays only the truncated amount. Captures of 4.747 and 1.239 BD leave 16 fils in clearing with no record. Over a month this is a few BD per busy merchant. Ledger, report and scheme statement cannot agree.
- Fix: inside CloseBatch, in the same transaction as the export line, post one balanced group per line with residue > 0: credit `card_scheme_clearing`, debit `scheme_rounding_residue`, with merchant, transaction and batch ids.
- Test: `TestCloseBatch_JournalsSchemeRoundingResidue_Fix` in `internal/settlement/residue_fix_test.go`.

### C4 Platform volume counter overflows at 2,147,483,647 fils
- Severity: Critical. Ticket: platform volume tier (HANDOVER). Where: `db/migrations/0049_platform_stats.sql`, `apps/settlement/internal/settlement/platform_volume.go:13-27`.
- What is wrong: `platform_stats.total_processed_fils` is INTEGER. Go reads it as `int32`, adds the batch gross in Go, and writes it back.
- Why it happens: INTEGER and int32 max is 2,147,483,647 fils (2,147,483.647 BD). The tier threshold is 2,000,000,000 fils, only 7% below. The Go add wraps silently.
- What it breaks: at 2,147,000,000 fils, one 1,000.000 BD batch writes -2,146,967,296. The tier bonus (15 bps) turns off for every merchant, and fees jump back up. The counter is wrong forever after.
- Fix: migration `0074_platform_stats_total_bigint.sql` makes the column BIGINT. Go uses `int64`. The increment is done in SQL (`SET total = total + $1`). The existing `TestRecordPlatformProcessedVolume_SmallValuesExact` is changed only for the new signature (no `current` argument) and to scan `int64`. The TS reader (`apps/api/src/fees/platformVolumeTier.ts`) gets BIGINT as a string from `pg`; JS `>=` coerces it, so its tests still pass, but its type says `number`. Not changed (out of scope), call out.
- Test: `TestRecordPlatformProcessedVolume_PastInt32Max_Fix` in `internal/settlement/platform_volume_fix_test.go`.

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

# Wave C bugs

### C1 Admin "Rebuild cached balances" reads the scheme export, not the ledger
- Severity: Critical. Ticket: FP-203. Where: `apps/settlement/internal/internalapi/server.go:268`, old `apps/settlement/internal/ledger/refresh.go:61`.
- What is wrong: the admin button called `ledger.RefreshBalanceCache`. That function summed the `merchant_payable_position` view. The view is `SUM(scheme_export_lines.amount_fils)`. It is not the ledger.
- Why it happens: ADR-0004 added a "fast path" for the button. Yousif's handover says the rebuild must read the ledger only. The CLI already does that with `RebuildAllBalances`.
- What it breaks: the export holds gross amounts and ignores fees, refunds and adjustments. A merchant with a 12.000 BD capture and a 0.300 BD fee is owed 11.700 BD. The button wrote 12.000 BD into the cache. Every fee becomes a fake over-payment in the balance.
- Fix: the handler calls `ledger.RebuildAllBalances` (the same ledger walk as the CLI). The wrong function `RefreshBalanceCache` and its tests are removed. The old server test comment that said "export total is right" now says ledger.
- Test: `TestRebuildBalances_ReadsLedgerNotSchemeExport_Fix` in `internal/internalapi/rebuild_fix_test.go`.

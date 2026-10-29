# Wave E bug fixes

### E1 Adjustment CSV import posts 10x too little money
- Severity: Critical
- Ticket: E1
- Where: `apps/api/src/admin/adjustmentCsvParsing.ts:7`
- What is wrong: The CSV import read BD amounts with 2 decimals. "4.75" became 475 fils (0.475 BD) instead of 4750 fils (4.750 BD). Every row posted 10x too little to the ledger and the balance. "4.755" was cut to 475 fils, so the last fils was lost too.
- Why it happens: The parser called `parseDecimalMinor(raw)` from `lib/decimal.ts`, whose default is `decimals = 2` (cents). The BD has 3 decimals (1 BD = 1000 fils, ADR-0001). The tests were written to match the bug (475, 125, 600), so they passed. Commit 9567ea0 (Yousif) already said "the CSV import is 10x off ... the test is wrong".
- What it breaks: Every finance correction since the import shipped. A 4.75 BD correction paid 0.475 BD. ADR-0001 says finance sheets must go through `parseBhdToFils`.
- Fix: Use `parseBhdToFils` from `@filspay/money`. It gives exact fils, accepts 0-3 decimals and rejects more than 3 (the row fails with `invalid_amount`, the whole import rolls back). Fixed the tests that locked in the bug: `adjustmentImport.test.ts` (475->4750, 125->1250, 600->6000, 350->3500, 500->5000) and `adminAdjustmentImport.test.ts` (600->6000, removed the wrong "2dp" comment).
- Test: `apps/api/src/admin/adjustmentCsvParsing.fix.test.ts`

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

### E2 March residue sweep uses the UTC month, posts the wrong legs, and double-posts on re-run
- Severity: High
- Ticket: E2 (FP-187)
- Where: `scripts/reconcile_march.ts:21` (`monthBounds`), `:91` (`postResidueCorrection`)
- What is wrong: (1) The window was the UTC month [2026-03-01T00:00Z, 2026-04-01T00:00Z). The Bahrain month is [2026-02-28T21:00Z, 2026-03-31T21:00Z). Captures between 00:00 and 03:00 Bahrain time on 1 March were missed, and captures on 1 April 00:00-03:00 Bahrain time were counted as March. (2) Each run made a new `randomUUID()` entry group, so every run posted the residue again. The 3 July "dry run" (the script has no dry-run mode) posted the 13 lines / 70 fils a second time. (3) The legs were debit `merchant_payable` / credit `scheme_rounding_residue`. ADR-0002 says debit `scheme_rounding_residue` / credit `card_scheme_clearing`. Debiting `merchant_payable` took the residue from the merchant, and the balance cache was not updated, so ledger and cache also drift.
- Why it happens: `Date.UTC` was used for the month (ADR-0003's UTC rule is disputed; Yousif's handover says the March script must use the Bahrain month). The comment "re-running is safe, entry_group_id dedupes it" was false: nothing dedupes a random id.
- What it breaks: March books. Each extra run takes the residue (70 fils per run on the 13 known lines) from merchants again.
- Fix: `monthBounds` subtracts the fixed UTC+3 offset. The group id is now a hash of (merchant, year, month); before insert the script checks the group does not exist, under a transaction advisory lock so two parallel runs cannot both post. Legs follow ADR-0002. `reconcile_march.test.ts` asserted the UTC window (`getUTCMonth() === 2`); it now asserts the Bahrain bounds.
- Follow-up (not done here): the groups already posted by earlier real runs stay in the ledger (append-only). Finance must reverse them with new correcting entries.
- Test: `scripts/reconcile_march.fix.test.ts`

### E3 Hold expiry job deletes holds (and can delete every hold)
- Severity: High
- Ticket: E3 (FP-219)
- Where: `scripts/expire_holds.ts` (old lines 25-46), `scripts/lib/sqlFilter.ts:27`
- What is wrong: The nightly job DELETEd expired holds. The handover says "Holds are never deleted"; the schema has an `expired` status for this. Worse: (1) it SELECTed the ids first and DELETEd later by id with no status check, so a hold captured or released between the two statements was deleted too; (2) on a night with no expired holds, `buildWhere` skips the empty id list and `buildDelete` returns `DELETE FROM holds` with no WHERE, which deletes every hold, active ones included.
- Why it happens: FP-219 changed the job to "keep the table small" with a generic filter builder that drops empty filters. The test asserted the DELETE text, so it locked the bug in.
- What it breaks: Lost hold history (audit, disputes). On a quiet night all active holds vanish, so open authorizations lose their hold and the merchant's available balance is wrong.
- Fix: One atomic statement: `UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at < now()`. The status re-check is in the same statement, so no race. Removed the now-unused `scripts/lib/sqlFilter.ts` (its unscoped DELETE is a trap). `expire_holds.test.ts` asserted DELETE; it now asserts the UPDATE. (The stale comment in migration 0005 is left as is, because applied migrations are not edited.)
- Test: `scripts/expire_holds.fix.test.ts`

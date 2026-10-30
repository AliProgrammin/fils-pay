# Venue hint bugs (V1, V2)

Money is in integer fils (1 BD = 1,000 fils). Rates are basis points (bps).

---

## V1 — The seed charges every capture the old merchant rate, not the rate in force at that time

- **Severity:** High (money)
- **Ticket:** "venue whiteboard hint"
- **Where:** `db/seed/fixtures/transactions.ts` (`generateInstalmentCaptures`, `buildCaptureLedgerGroup`, `generateMarketplaceOrdersForMerchant`), `db/seed/fixtures/marchReconciliation.ts`, `db/seed/generate.ts`

**How the whiteboard leads here:**
1. "My clock says 07:58 / Theirs says 08:30" are the times of commits `0af74f0` ("dead man's switch") and `800e1e6` (Yousif's access revoked).
2. Between them is the "ghost" commit `098c2de` ("minor cleanup"), which added `db/seed/fixtures/transactions.ts` in one go.
3. "Trust the time I wrote, not the place" = charge the fee by the event's own time (`occurred_at`), not by the merchant row's fixed rate. "It sits in the 1" = the bug is in that one file.

**What is wrong:** The seed computes every capture fee as `applyRateFils(amount, merchants.mdr_bps)`. Alpha Retail's `mdr_bps` is 250. But Alpha Retail has fee-schedule rows: 245 bps from 2026-03-01 and 225 bps from 2026-08-01. The live code (`capture.ts`, `settlement/query.ts`, Go `EffectiveMdrBpsAt`) charges the schedule rate in force at the event's `occurred_at`.

**Why it happens:** The seed inserted the `fee_schedules` rows at the very end, after all the captures were built. The generators only took one fixed number (`mdrBps`), so they never saw the schedule.

**What it breaks:** The ledger holds one fee and settlement charges another.
- The 11 instalment captures on 2026-08-26: the ledger fee is 16,250 fils. Go `run-batch` charges 14,625. After the payout, Alpha's `merchant_payable` for that day is **-1,625 fils**: the merchant is paid 1.625 BD more than the ledger owes, and fee revenue is overstated.
- The other 29 August captures for Alpha are overcharged by 18,321 fils in total (about 18.3 BD).
- 14 mid-March captures (rate 245) are overcharged by 1,715 fils in total.
- The reconciliation and fee screens show fees that settlement will never agree with.

**Fix:** The fee-schedule rows now live in one list, `db/seed/fixtures/feeSchedules.ts`. A small function `mdrBpsAtFor(merchantKey, mdr_bps)` returns the rate in force at an instant, with the same rule as `getEffectiveMdrBps` / `EffectiveMdrBpsAt`: newest `effective_from <= time`, tie goes to the newest `created_at`, else `merchants.mdr_bps`. Every generator now takes this function (`mdrBpsAt`) and asks it for the rate at each event's own `occurredAt`. The pre-built batch totals and the outbox payload use it too. The `fee_schedules` insert reads the same list, so the seed and the table cannot drift apart. No random draws changed, so the seed stays deterministic.

**Test:** `db/seed/feeAtEventTime.integration.test.ts` (failed before: 54 wrong ledger groups, 11 wrong event fees, 16,250 vs 14,625):
- every seeded capture ledger group's fee = `applyRateFils(amount, rate in force at occurred_at)`;
- every seeded capture event's `metadata.feeFils` matches the same rate;
- the 2026-08-26 instalment captures post 14,625 fils, the fee Go `run-batch` charges;
- every pre-built closed batch's `fee_fils` equals the ledger fee of its captures.

Manual check: after the fix, Go `run-batch --date=2026-08-26` for Alpha pays 635,375 and the day's `merchant_payable` ends at exactly **0** (was -1,625). The seed's own REAL assertions all pass.

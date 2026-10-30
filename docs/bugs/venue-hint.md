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

---

## V2 — Capture picks the fee rate by the API server's clock, not the database clock

- **Severity:** Medium (money)
- **Ticket:** "venue whiteboard hint" ("My clock says 07:58 / Theirs says 08:30")
- **Where:** `apps/api/src/payments/capture.ts` (rate lookup), `apps/api/src/fees/feeSchedule.ts`

**What is wrong:** Capture looked up the fee rate with `new Date()`, the API server's clock. But the capture's `transaction_events` row and ledger rows are stamped with the database `now()`. Settlement then charges the rate in force at the event's stored `occurred_at`. So two different clocks chose the rate.

**Why it happens:** The rate lookup took a JS `Date`, and capture passed "now" from the app server. Server clocks drift. Nothing tied the lookup to the instant the rows were written.

**What it breaks:** When the API clock and the DB clock differ near a rate change, capture and settlement charge different fees. Reproduced with a 32-minute skew (API clock ahead, new rate starts 10 minutes later by DB time): capture billed **1,500** fils, settlement charges **2,500** on 100.000 BD. With the clock behind, the reverse: 2,500 vs 1,500. The payout then does not match the ledger.

**Fix:** `getEffectiveMdrBps` now accepts `asOf = null`, which means the database's own `now()` (`effective_from <= COALESCE($2, now())`). Capture passes `null`. Inside the capture transaction `now()` is one fixed instant, the same value the ledger rows and the event's `occurred_at` (DEFAULT `now()`) get. So the rate is chosen at exactly the event's time. Callers that pass a real date (settlement recompute) work as before. API paths and response shapes do not change.

Also checked:
- `processRefund.ts` does not pick a rate. It reads the fee actually charged from the ledger. No change.
- `paymentLinks/pay.ts` charges through `captureTransaction`, so this fix covers it. Its `new Date()` is only for the link expiry check, not a rate. No change.

**Test:** `apps/api/src/payments/captureClockSkew.fix.test.ts` moves the JS clock with `mock.timers` (Date only) and checks that the event's `feeFils` and the ledger fee equal the rate in force at the stored `occurred_at`:
- API clock 32 min ahead, schedule starts in 10 min by DB time (failed before: billed 1,500, expected 2,500);
- API clock 32 min behind, schedule started 10 min ago by DB time (failed before: billed 2,500, expected 1,500).

# Venue hint bugs (V1, V2)

Money is in integer fils (1 BD = 1,000 fils). Rates are basis points (bps).

---

### V1 The seed charges every capture the old merchant rate, not the rate in force at that time

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

**How found and reproduced:** Venue whiteboard hint (see "How the whiteboard leads here" above), traced to the ghost commit `098c2de`. Reproduced by Go `run-batch --date=2026-08-26` (Alpha `merchant_payable` ended at -1,625 fils) and by `db/seed/feeAtEventTime.integration.test.ts` (54 wrong ledger groups on the old seed).

**Effect on existing data:** Seed data only; no production code wrote these rows. A database seeded before commit `f6fbe4f` keeps the wrong fees and must be seeded again. We reseeded the live server after the fix.

---

### V2 Capture picks the fee rate by the API server's clock, not the database clock

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

**How found and reproduced:** Runner-up lead from the venue whiteboard ("My clock says 07:58 / Theirs says 08:30"). Reproduced by `apps/api/src/payments/captureClockSkew.fix.test.ts` with a 32-minute clock skew (billed 1,500, settlement 2,500).

**Effect on existing data:** Not known for stored rows: a wrong fee needs clock skew near a rate change. Only captures close to a schedule start are at risk: `SELECT te.transaction_id, te.occurred_at, te.amount_fils, te.metadata->>'feeFils' AS fee_fils, f.mdr_bps, f.effective_from FROM transaction_events te JOIN transactions t ON t.id = te.transaction_id JOIN fee_schedules f ON f.merchant_id = t.merchant_id WHERE te.event_type IN ('captured','partially_captured') AND te.occurred_at BETWEEN f.effective_from - interval '1 hour' AND f.effective_from + interval '1 hour';` Check each fee by hand.

### V3 An admin credit reverses the fee at the old merchant rate, not the rate in force

- **Severity:** Medium (money)
- **Ticket:** found while checking the admin console (same family as V1)
- **Where:** `apps/api/src/admin/credits.ts` (`createCreditRequest`), `apps/admin/src/pages/merchants/MerchantDetailPage.tsx` (label)

**What is wrong:** When finance issues a credit with "Also reverse the MDR", the reversal used `merchants.mdr_bps`. Capture charges the rate from `fee_schedules` (the negotiated rate in force). For Alpha Retail that is 250 bps against 225 bps. The admin form also showed 2.50%.

**Why it happens:** `merchants.mdr_bps` is not kept in sync with `fee_schedules` (the code says so in `settlement/query.ts`). Capture and settlement use `getEffectiveMdrBps`; the credit path did not.

**What it breaks:** The platform gives back more fee than it charged. A 20.000 BD credit with fee reversal posted 500 fils, but the capture fee was 450. The extra 50 fils per 20 BD is a direct loss, and the admin screen shows a rate the merchant does not pay.

**Fix:** The credit path calls `getEffectiveMdrBps(client, merchantId, null, merchant.mdr_bps)`, the same lookup capture uses (DB `now()`, falls back to `mdr_bps` when no schedule applies). The admin label shows the rate in force. API paths and response shapes do not change.

**Test:** `apps/api/src/admin/credits.test.ts` "V3: a fee reversal uses the merchant's rate in force" (merchant at 250 bps with a 225 bps schedule in force; failed before: 500, expected 450).

**How found and reproduced:** Found while checking the admin console after V1 (same rate rule). Reproduced by `apps/api/src/admin/credits.test.ts` "V3: a fee reversal uses the merchant's rate in force" (500 fils on the old code, 450 expected).

**Effect on existing data:** Credits with a fee reversal made before the fix, for merchants with a fee schedule, gave back too much fee. We did not change them; finance must decide on a correction. Query: `SELECT id, merchant_id, base_amount_fils, fee_reversal_fils, effective_date, status FROM credit_requests WHERE fee_reversal_fils > 0 AND merchant_id IN (SELECT merchant_id FROM fee_schedules);`

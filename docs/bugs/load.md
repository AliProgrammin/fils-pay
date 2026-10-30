# Bugs found by the load test

Found while load testing the production stack with the hosting limits
(API 0.5 vCPU / 512 MB, whole stack 1 vCPU / 2 GB). Method and numbers:
[CAPACITY.md](../../CAPACITY.md).

### L1 The ledger balance check reads the whole ledger on every write

- **Severity:** High (capacity)
- **Ticket:** none (found by the load test)
- **Where:** balance trigger on `ledger_entries` (`db/migrations/0007_ledger_double_entry.sql`); new `db/migrations/0093_ledger_entries_entry_group_idx.sql`

**What is wrong:** Every ledger row fires a trigger that checks its entry group still nets to zero. `ledger_entries` had no index on `entry_group_id`, so each check scanned the whole ledger.

**Why it happens:** The trigger filters by `entry_group_id`, but no migration ever indexed that column.

**What it breaks:** Each payment gets slower as the ledger grows. In the first 6 minutes of load, Postgres read 724 million rows for these checks, and checkout time kept rising.

**Fix:** Migration `0093` adds an index on `ledger_entries (entry_group_id)`. The check now reads only the rows of one group.

**Test:** The load test (`scripts/load/run.sh`): checkout time stays flat over the run, and `verify.sql` finds 0 unbalanced groups.

### L2 Every API-key request writes the same database row

- **Severity:** Medium (capacity)
- **Ticket:** none (found by the load test)
- **Where:** `apps/api/src/apiKeys/verify.ts`

**What is wrong:** Each request made with an API key updated `api_keys.last_used_at` on that key's row.

**Why it happens:** The "last used" time was written on every request, not now and then.

**What it breaks:** All requests of one merchant wait in line for the lock on that one row: about 10 ms each, more under load. A busy merchant slows itself down.

**Fix:** `last_used_at` is written at most once a minute per key. The value shown to the merchant is still correct to the minute.

**Test:** The existing API-key tests (`apps/api/src/apiKeys/verify.fix.test.ts`) still pass, and the API-flow load test (`MODE=api`) no longer queues on the key row. No new unit test: this is a speed fix, not a change of behaviour.

### L3 A payment cut off by a crash leaves the link stuck and the card held

- **Severity:** High
- **Ticket:** INC 05-14 family (payment links)
- **Where:** `apps/api/src/paymentLinks/pay.ts` (`resumeBoundPayment`)

**What is wrong:** If the API stops (crash, restart) after a payment link's authorization is saved but before the link is marked paid, the link stays "reserved" with a live authorization. A retry by the same customer is refused.

**Why it happens:** The reservation timeout does not apply once an authorization is bound (so a slow capture is never overtaken), and nothing finished a bound payment on retry.

**What it breaks:** In our crash test, 55 links were left reserved with a live card hold, and 6 of those were already captured: the customer paid, but the link never showed paid.

**Fix:** A retry with the same `Idempotency-Key` finishes the payment (capture, then mark paid). Both steps are idempotent. A different payer still gets 409. The success response is unchanged.

**Test:** `apps/api/src/routes/paymentLinks.resume.test.ts`; crash test `scripts/load/chaos.sh` (after the fix: 0 stuck links with a live authorization, paid links = captured transactions).

### L4 The bank simulator's memory grows without limit

- **Severity:** Medium (capacity)
- **Ticket:** none (found by the load test)
- **Where:** `apps/api/src/acquirer/simulator.ts`

**What is wrong:** The simulated bank keeps one entry per request in in-memory maps that are never cleared.

**Why it happens:** A code comment said "cleared on restart and we deploy daily. not a leak". Under steady traffic the maps grow until the next restart.

**What it breaks:** The API container has 512 MB. Under sustained load it fills up and is killed for running out of memory.

**Fix:** Each map keeps at most 50,000 entries and drops the oldest first.

**Test:** No unit test. In the 120-user load run the API used 102 MB of its 512 MB (CAPACITY.md).

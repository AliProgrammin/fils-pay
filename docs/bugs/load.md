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

**How found and reproduced:** Load test of the production stack (CAPACITY.md): checkout time kept rising, and Postgres read 724 million rows for the balance check in the first 6 minutes. Reproduced by the same load test.

**Effect on existing data:** None: index only. Migration 0093 builds it over existing rows. No ledger row changes.

### L2 Every API-key request writes the same database row

- **Severity:** Medium (capacity)
- **Ticket:** none (found by the load test)
- **Where:** `apps/api/src/apiKeys/verify.ts`

**What is wrong:** Each request made with an API key updated `api_keys.last_used_at` on that key's row.

**Why it happens:** The "last used" time was written on every request, not now and then.

**What it breaks:** All requests of one merchant wait in line for the lock on that one row: about 10 ms each, more under load. A busy merchant slows itself down.

**Fix:** `last_used_at` is written at most once a minute per key. The value shown to the merchant is still correct to the minute.

**Test:** The existing API-key tests (`apps/api/src/apiKeys/verify.fix.test.ts`) still pass, and the API-flow load test (`MODE=api`) no longer queues on the key row. No new unit test: this is a speed fix, not a change of behaviour.

**How found and reproduced:** Load test, API-key flow (`MODE=api`): requests of one merchant queued on the lock of one `api_keys` row.

**Effect on existing data:** None. `last_used_at` can now be up to one minute old; no other data changes.

### L3 A payment cut off by a crash leaves the link stuck and the card held

- **Severity:** High
- **Ticket:** INC 05-14 family (payment links)
- **Where:** `apps/api/src/paymentLinks/pay.ts` (`resumeBoundPayment`)

**What is wrong:** If the API stops (crash, restart) after a payment link's authorization is saved but before the link is marked paid, the link stays "reserved" with a live authorization. A retry by the same customer is refused.

**Why it happens:** The reservation timeout does not apply once an authorization is bound (so a slow capture is never overtaken), and nothing finished a bound payment on retry.

**What it breaks:** In our crash test, 55 links were left reserved with a live card hold, and 6 of those were already captured: the customer paid, but the link never showed paid.

**Fix:** A retry with the same `Idempotency-Key` finishes the payment (capture, then mark paid). Both steps are idempotent. A different payer still gets 409. The success response is unchanged.

**Test:** `apps/api/src/routes/paymentLinks.resume.test.ts`; crash test `scripts/load/chaos.sh` (after the fix: 0 stuck links with a live authorization, paid links = captured transactions).

**How found and reproduced:** Crash test `scripts/load/chaos.sh` (API killed under load): 55 links stayed reserved with a live hold, 6 of them already captured. Reproduced by `apps/api/src/routes/paymentLinks.resume.test.ts`.

**Effect on existing data:** No money row is wrong: captured payments are in the ledger; only the link status is stale. Links stuck before the fix are cleared by the L5 recovery sweep, which also runs at boot.

### L4 The bank simulator's memory grows without limit

- **Severity:** Medium (capacity)
- **Ticket:** none (found by the load test)
- **Where:** `apps/api/src/acquirer/simulator.ts`

**What is wrong:** The simulated bank keeps one entry per request in in-memory maps that are never cleared.

**Why it happens:** A code comment said "cleared on restart and we deploy daily. not a leak". Under steady traffic the maps grow until the next restart.

**What it breaks:** The API container has 512 MB. Under sustained load it fills up and is killed for running out of memory.

**Fix:** Each map keeps at most 50,000 entries and drops the oldest first.

**Test:** No unit test. In the 120-user load run the API used 102 MB of its 512 MB (CAPACITY.md).

**How found and reproduced:** Load test review of the simulator: the maps are never cleared, and a code comment said "not a leak". Checked in the 120-user run (API at 102 MB of 512 MB after the fix).

**Effect on existing data:** None: in-memory data of the bank simulator only. Nothing is stored.

### L5 A payment link cut off by a crash stays reserved forever

- **Severity:** High
- **Ticket:** INC 05-14 family (payment links); found by the crash test on the live server
- **Where:** `apps/api/src/paymentLinks/pay.ts`; new `apps/api/src/paymentLinks/recovery.ts`, started in `apps/api/src/index.ts`; new `db/migrations/0094_payment_links_reserved_idx.sql`

**What is wrong:** If the API stops after a payment link's authorization is bound to the link, and the customer does not retry with the same `Idempotency-Key`, the link stays "reserved" for ever. A comment in `pay.ts` said such a link "is freed by voiding that authorization", but no code did that.

**Why it happens:** Once an authorization is bound, the 60 s reservation timeout no longer applies (so a slow capture is never overtaken, incident 05-14). L3 lets the same payer finish the payment, but nothing handles the case where nobody retries.

**What it breaks:** In the live crash test (200 users, `kill -9` of the API), 40 links stayed stuck: 5 with a captured transaction (the customer paid, but the link never shows paid) and 35 with a card hold nobody releases (and no other customer can pay the link).

**Fix:** A recovery sweep runs in the API process, once at boot and every 30 s (`PAYMENT_LINK_RECOVERY_INTERVAL_MS`):
1. Bound transaction fully captured: mark the link paid with the same conditional update as the live finalize step (`finalizePaidLink`, now shared). A live request that finalizes second still answers 200 paid.
2. Bound transaction still authorized and the reservation older than the grace period (`PAYMENT_LINK_RECOVERY_GRACE_SECONDS`, default 300 s, far above a normal payment): void it through the normal `voidTransaction` (hold released, `voided` event, `transaction.voided` webhook), then release the link to active.
3. Bound transaction already voided: release the link.

A live request is never overtaken: the void takes the transaction row lock (a running capture holds it, and then the void answers 409 and the next pass marks the link paid), and the release only matches while `reserved_at` is unchanged. Migration `0094` adds a partial index on reserved links, so the sweep does not scan every link. No API path, body or response changed.

**Test:** `apps/api/src/paymentLinks/recovery.test.ts`: each stuck state (captured, old authorization, voided) is fixed by one pass; a fresh bound reservation is not touched; a second pass changes nothing (one `voided` event, one outbox event); a link reserved with no authorization frees itself after the 60 s timeout. 4 of the 6 tests failed on the old code (no sweep).

**How found and reproduced:** Live crash test on the hosted server (200 users, `kill -9` of the API): 40 links stuck, 5 paid but not marked paid, 35 with a card hold. Reproduced by `apps/api/src/paymentLinks/recovery.test.ts` (4 of 6 tests failed on the old code).

**Effect on existing data:** The sweep runs at boot over the rows already stored, so links stuck by earlier crashes are repaired with no manual step: captured ones are marked paid, old authorizations are voided and the link is released. To see them first: `SELECT id, reserved_at FROM payment_links WHERE status = 'reserved' AND reserved_at < now() - interval '5 minutes';`

# FilsPay capacity

## Our estimate (measured on the live Dilmune server)

**About 70 concurrent checkout users by our strict rule (pay p95 under
1.5 s, 0 failed checkouts, 0 server errors, 0 refused); up to about 90
users with every checkout completing (14.0 checkouts/s, pay p95 2.17 s,
0 failed, 0 refused).** At 70 users: 12.4 completed checkouts per second,
about 63 HTTP requests per second, pay call p95 1.41 s.
0 failed checkouts, 0 server errors, 0 refused requests. Measured on the
live server `Orbit` (1 vCPU, 2 GB, Bangalore) over HTTPS, from a laptop in
Bahrain, with `scripts/load/run.sh` (scenario `link`: create a payment link,
open the checkout page, pay, double-click check).

The estimate of about 70 users uses these rules: pay p95 under 1.5 s,
0 failed checkouts, 0 server errors, 0 refused (503) requests. It does
**not** meet our other rule, p95 under 300 ms for create link and read
link: on the live server create link p95 was 318, 333 and 365 ms at 30,
50 and 70 users, and read link p95 was 389 ms at 70 users (299 and 301 ms
at 30 and 50). Most of this time is the network path from the laptop in
Bahrain to the server in Bangalore, over HTTPS: the checkout page is a
static file from nginx with no database work, and its median is already
about 155 ms (p95 210 to 222 ms). The median of create link (170 to
178 ms) and read link (165 to 167 ms) is only about 10 to 20 ms more. The
laptop runs below have no such network path.

## Live server

| Users | Checkouts/s | HTTP req/s | Pay p95 | Create link p95 | Read link p95 | Failed checkouts | 5xx | Refused (503) |
|---|---|---|---|---|---|---|---|---|
| 30 | 5.4 | 28 | 1.06 s | 318 ms | 299 ms | 0 | 0 | 0 |
| 50 | 9.0 | 46 | 1.05 s | 333 ms | 301 ms | 0 | 0 | 0 |
| **70** | **12.4** | **63** | **1.41 s** | **365 ms** | **389 ms** | **0** | **0** | **0** |
| 90 | 14.0 | 72 | 2.17 s | 531 ms | 494 ms | 0 | 0 | 0 |
| 120 | 10.7 | 56 | 7.37 s | 1076 ms | 785 ms | 0 | 0 | 92 (0.6/s) |

- The rows 30 to 90 are with the final CPU caps (Postgres 0.90, Caddy 0.40,
  API 0.50). At 90 users it still completes every checkout, but slower. At
  120 users it is past the limit: checkouts drop to 10.7/s, pay p95 rises to
  7.4 s, and the excess is refused with 503 + Retry-After; every accepted
  checkout still completes. The API refuses work when its database queue is
  full, not when it gets slow, so accepted payments slow down first.
- A first run with Postgres capped at 0.30 CPU (all caps adding up to
  exactly 1.0) served only about 30 users at the same speed (50 users: pay
  p95 3.0 s). The live server's shared vCPU is about 3x slower than our
  laptop's core, and Postgres needs the CPU. The hosting rule caps only the
  API (0.5 vCPU / 512 MB), so the other caps now only stop one service from
  taking the whole machine (`ops/docker-compose.tls.yml`).
- "Declined" checkouts in the k6 output are the bank simulator's planned
  card declines, not errors.

The laptop numbers below (about 120 users) show the same code on a faster
CPU with the same Docker limits. They are not our estimate for the server.

## Machine limits

The whole stack runs from `ops/docker-compose.prod.yml` on one server with
1 vCPU and 2 GB RAM. The live server adds the HTTPS layer
(`ops/docker-compose.tls.yml`): it adds Caddy and raises the Postgres cap.
Docker enforces these limits:

| Service | CPU, prod file | CPU, live (HTTPS layer) | Memory | Restart | Health check |
|---|---|---|---|---|---|
| api (Node) | 0.50 | **0.50** (hard cap) | **512 MB** (hard cap; heap max 320 MB) | always | `GET /readyz` |
| postgres 16 | 0.35 | 0.90 | 640 MB | always | `pg_isready` |
| caddy (HTTPS) | not in this file | 0.40 | 96 MB | always | `GET /config/` on its admin API (127.0.0.1:2019, inside the container) |
| web (nginx) | 0.07 | 0.07 | 64 MB | always | `GET /` |
| settlement (Go) | 0.03 | 0.03 | 64 MB | always | port 8091 open |
| reporting (Node) | 0.05 | 0.05 | 192 MB | always | none (no HTTP port; restart covers a crash) |
| **Total of the caps** | **1.00** | **about 1.95** | **1.47 GB** (live: 1.56 GB) | | |

Only the API has the hosting rule's hard cap (0.5 vCPU / 512 MB). Docker CPU
limits are caps, not reservations: on the live server all services share
the one vCPU, and the other caps only stop one service from taking all of
it. That is why the live caps can add up to more than 1.0.

`migrate` and `seed` are one-off jobs that end before the api starts.
Postgres data is in the named volume `pgdata`, so a container restart or a
rebuild keeps it. Logs are capped at 3 x 10 MB per service, Caddy included.

Where each test ran:

| Test | Where |
|---|---|
| Capacity estimate, 30 to 120 users ("Live server" above) | Live server |
| Capacity steps on a laptop ("Results on a laptop" below) | Laptop, same Docker limits |
| Overload, 400 users | Laptop, same Docker limits (live server: 200 users, in the crash test) |
| Crash and recovery (`SIGKILL` of the api) | Laptop, same Docker limits, and live server (done) |

Sizing that matters:

- **Postgres pool.** A payment holds its database connection while the
  (simulated) acquirer answers, 0.1 to 0.4 s per call, twice per checkout.
  So the pool size, not the CPU, limits payments first. The api pool is 60
  connections (`PG_POOL_MAX`), all opened at boot and kept (`PG_POOL_MIN`);
  Postgres allows 100 (`max_connections`).
- **Memory at the 120-user load:** api 102 MB of 512 MB. Postgres 374 MB of
  640 MB, of which only about 95 MB is process memory and 147 MB shared
  buffers; the rest is file cache that the kernel frees when needed.
- **CPU at the 120-user load (average / peak):** api 14 % / 22 % of one
  CPU, Postgres 19 % / 36 %, nginx 2 % / 3 %.

## How we measured

Tool: [k6](https://k6.io) 0.54, script `scripts/load/checkout.js`, run by
`scripts/load/run.sh` (it uses the `grafana/k6:0.54.0` Docker image when k6
is not installed).

One iteration is one customer checkout, the real flow of the app:

1. The merchant's server creates a payment link (`POST
   /v1/merchants/:id/payment-links`, API key).
2. The customer opens the checkout page (`GET /pay/<token>`, the web app)
   and the page reads the link (`GET /v1/payment-links/<token>`).
3. The customer pays (`POST /v1/payment-links/<token>/pay`, with an
   `Idempotency-Key`). The api authorizes and captures with the acquirer and
   writes the ledger.
4. The customer clicks pay again with the same key. It must answer 409
   `payment_link_already_paid` and not charge again.

Each user waits 0.5 to 1.5 s between steps (random, so users do not move in
step). Users arrive over 30 s, then stay for 3 minutes. A 502 from the
simulated acquirer (`acquirer_unavailable`, about 0.6 % of calls with the
default `ACQUIRER_FAILURE_RATE=0.02`) or a 503 is retried with the same
key, as a real client must. A 402 (declined card, about 1.4 %) is a valid
answer, not an error.

Pass rule (k6 thresholds): p95 under 300 ms for create link, read link and
checkout page; p95 under 1.5 s for pay; 0 server errors; 0 failed
checkouts; 0 refused (503) requests. On the live server the 300 ms rule
fails for create link and read link because of the network path (see "Our
estimate" above); the live estimate uses the other rules.

After each run, `scripts/load/verify.sql` checks the database: every ledger
entry group balances, the whole ledger nets to zero, each captured payment
has exactly one capture journal with the right amount, no checkout is
charged twice, and every paid link has its captured transaction.

The script also has `SCENARIO=api`: authorize (`POST /v1/transactions`),
replay of the same authorize (must return the same transaction id), then
capture (`POST /v1/transactions/:id/capture`), all with Idempotency-Keys.

### Results on a laptop (same limits, faster CPU: not the server estimate)

Payment-link checkout, 3 minutes per step after a 30 s ramp:

| Users | Checkouts/s | Req/s | p95 all | p95 pay | Refused (503) | Errors | Result |
|---|---|---|---|---|---|---|---|
| 120 | 29.9 | 154 | 625 ms | 817 ms | 0 | 0 | pass |
| 120 (rerun, final code) | 29.4 | 151 | 618 ms | 765 ms | 11 (0.04 %) | 0 | fail (11 x 503 only) |
| 100 | 24.1 | 124 | 637 ms | 1500 ms | 4 | 4 (500) | fail, see below |
| 150 | 34.3 | 176 | 729 ms | 2347 ms | 146 (0.4 %) | 0 | fail (503s, pay p95) |
| 200 (90 s) | 43.2 | 225 | 848 ms | 1477 ms | 395 (1.4 %) | 0 | fail (503s) |
| 250 (90 s) | 47.4 | 257 | 1167 ms | 1599 ms | 1730 (5.4 %) | 0 | fail (503s) |

API checkout (`SCENARIO=api`), 120 users: 41.4 checkouts/s, 127 req/s, p95
404 ms (authorize 452 ms, capture 534 ms), 13 refused (0.05 %), 0 errors:
just over the limit, so the API flow also tops out at about 120 users.

Database check after the 120-user run: 6421 links paid = 6421 transactions
captured = 6421 checkouts k6 counted as paid; 0 unbalanced ledger groups;
ledger net 0 fils; 0 double charges.

The 100-user run had 4 HTTP 500s at one moment: Postgres stalled for a few
seconds and new database connections timed out (`connection timeout` while
the pool grew from 30 to more connections). After this run we set the pool
to open all 60 connections at boot (`PG_POOL_MIN=60`) and keep the default
5 s connect timeout, so the pool never opens connections during a spike.
Rerun after that change, 120 users, 2 minutes (final configuration):
**29.1 checkouts/s, 150 req/s, p95 608 ms, p99 742 ms, pay p95 742 ms,
0 refused, 0 errors: pass.** Database check: 4485 links paid = 4485
transactions captured = 4485 checkouts k6 counted; ledger balanced, net 0;
0 double charges. The 3-minute and 100-user runs were not repeated with
this change (not measured).

The runs show some noise: the test machine (a laptop running other work)
is not a quiet server. The limit is between 100 and 150 users; 120 is our
best estimate.

### What limits capacity

Not the api CPU (it stays under half of its 0.5 vCPU). The limit is commit
speed in Postgres: each capture inserts an outbox event, and its
`pg_notify` trigger makes Postgres serialize those commits (only one
transaction with a NOTIFY can commit at a time, and it holds that lock
while the WAL is flushed to disk). Under load we saw up to 20 sessions
waiting on this lock. A faster disk (lower fsync time) raises the limit;
a slower one lowers it. Removing the per-row NOTIFY (poll only, or one
NOTIFY per batch) is the next step if more capacity is needed.

Two fixes found by this test are in the code:

- `ledger_entries` had no index on `entry_group_id`, so the balance trigger
  scanned the whole ledger for every ledger row written: Postgres read
  724 million rows in our first 6 minutes of load, and every checkout got slower as
  the ledger grew. Migration `0093` adds the index.
- Every API-key request wrote `api_keys.last_used_at` on the same row, so
  all requests of one merchant queued on that row lock (10 ms per request,
  rising with load). It is now written at most once a minute.

## Overload: what happens past the limit

The API refuses new work with a fast `503` and `Retry-After: 1`
(`apps/api/src/plugins/loadShedding.ts`) when:

- more than 30 requests wait for a database connection
  (`LOAD_SHED_MAX_POOL_WAITING`; checked at once, before the request's
  first query), or
- the mean event loop delay is over 150 ms (`LOAD_SHED_MAX_EVENT_LOOP_DELAY_MS`).

A request that was let in but gets no connection within 1 s
(`PG_POOL_CONNECTION_TIMEOUT_MS`) gets the same `503 server_busy`, never a
500. A payment-link payment takes its one connection before its first step,
so it is refused before it starts or runs to the end.

A request that has started always finishes, so a payment is never cut in
half by load shedding. `/healthz` and `/readyz` are never refused. The body
is `{"error":"server_busy","message":"..."}`. nginx is the outer wall: at
most 400 API requests in flight, and when the api is not reachable (for
example while it restarts) nginx also answers a JSON `503` with
`Retry-After: 2` instead of an HTML 502.

Test on the laptop (same Docker limits; not yet repeated on the live server): 400 users (more than 3 times the laptop limit), 2 minutes. On the live server, the 120-user row in "Live server" also shows 503s, but accepted payments are slower there (pay p95 7.4 s).

| | |
|---|---|
| Checkouts completed | 54.4 per second (more than at 120 users: the queue stays short) |
| Requests refused with 503 | 7400 (47 per second) |
| Time to get a 503 | median 1 ms, p95 100 ms |
| Server errors (other 5xx, timeouts) | 0 |
| `/healthz` during the test | always 200, slowest 2.2 s |

## Crash and recovery

In the same 400-user laptop test, after 80 s, `scripts/load/chaos.sh` killed the
api process with `SIGKILL` (like a crash or an out-of-memory kill), from
the Docker host, not with `docker stop`.

- Docker restarted the api by itself. It was healthy again **6 s** after the
  kill (restart count 1). While it was down, nginx answered 503 and the
  clients retried.
- Database check after the test:
  - 0 unbalanced ledger groups, ledger net 0 fils.
  - 8511 links paid = 8511 transactions captured = 8511 checkouts k6
    counted as paid. 0 double charges, 0 transactions captured twice.
  - 27 links were in the first step of a payment at the moment of the kill
    (link reserved, authorization not yet committed, so no money moved).
    They free themselves after the 60 s reservation timeout. We paid one
    of them afterwards: it worked.
- A payment cut off after its authorization (crash between authorize and
  finalize) now completes when the customer retries with the same
  `Idempotency-Key` (`resumeBoundPayment` in
  `apps/api/src/paymentLinks/pay.ts`, tests in
  `apps/api/src/routes/paymentLinks.resume.test.ts`). Before this fix, the
  same test left 55 links reserved with a live authorization, 6 of them
  already captured.

### Crash test on the live server

200-user overload from a laptop against https://64-227-145-174.sslip.io;
`kill -9` of the api process at about 60 s.

- Docker restarted the api. It was healthy again **8 s** after the kill
  (restart count 1).
- 47 checkouts failed in this test (k6 `checkouts_failed`: 4 at create
  link, 6 at read link, 30 at pay, 7 at the double-click check). Each got
  an error answer, so the client saw an error, not a false "paid". The
  live runs without a kill had 0 failed checkouts.
- Database check after the test: 0 unbalanced ledger groups, ledger net
  0 fils, 0 double charges, 0 transactions captured twice. Transactions,
  captures and ledger agree. So no checkout was charged twice and the
  ledger stayed balanced.
- 59 links were caught mid-payment at the kill:
  - 19 reserved with no transaction: they free themselves after the 60 s
    reservation timeout (checked by a test).
  - 35 reserved with an authorization that nobody captured: a card hold
    that nobody released, and nobody else could pay the link.
  - 5 reserved with a captured transaction: the customer paid, but the
    link never showed paid.
- The last two groups stayed stuck unless the same customer retried with
  the same `Idempotency-Key` (bug [L5](docs/bugs/load.md#l5-a-payment-link-cut-off-by-a-crash-stays-reserved-forever)).
  Fix: a recovery sweep in the api process
  (`apps/api/src/paymentLinks/recovery.ts`), once at boot and every 30 s,
  marks a link paid when its payment was captured, and voids the
  authorization and frees the link when it is older than 5 minutes. So
  after a restart all 40 links are resolved within about 5 minutes.

Postgres commits each payment in one transaction with the ledger rows, so a
crash leaves either the whole payment or none of it. Its data is on the
`pgdata` volume and survives a restart of any container.

## Run it yourself

Start the stack (see [HOSTING.md](HOSTING.md)), here on port 8097:

```sh
FILSPAY_HTTP_PORT=8097 docker compose -f ops/docker-compose.prod.yml -p filspay-cap up -d --build
```

The test needs `OTP_DEV_EXPOSE=true` (it signs in with the seeded demo
users to create an API key). Then:

```sh
# Capacity: 120 users, 30 s ramp, 3 minutes. Exit code 0 = within the limits.
BASE_URL=http://localhost:8097 MODE=steady VUS=120 DURATION=3m scripts/load/run.sh

# Find the limit: steps of 20 users, 60 s each, up to 200.
BASE_URL=http://localhost:8097 MODE=ramp VUS=200 STEP=20 scripts/load/run.sh

# API flow instead of payment links.
BASE_URL=http://localhost:8097 SCENARIO=api VUS=120 DURATION=3m scripts/load/run.sh

# Check the data of one run (RUN_ID is printed at the start of the run).
docker compose -f ops/docker-compose.prod.yml -p filspay-cap exec -T postgres \
  psql -U filspay -d filspay -v run_id="'<RUN_ID>-%'" -f - < scripts/load/verify.sql

# Overload + crash: 400 users, SIGKILL the api after 80 s, then check the data.
BASE_URL=http://localhost:8097 PROJECT=filspay-cap VUS=400 KILL_AFTER=80 scripts/load/chaos.sh
```

k6 summaries go to `scripts/load/results/` (not committed). The summaries
of the live-server runs in this file are in
[`scripts/load/evidence/`](scripts/load/evidence/) (the API key is removed). The test
writes demo data: one API key per run and one payment link and payment per
checkout, on the seeded merchant Alpha Retail Co.

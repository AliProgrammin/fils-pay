# FilsPay: The Handover, team Orbit

[![CI](https://github.com/AliProgrammin/fils-pay/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/AliProgrammin/fils-pay/actions/workflows/ci.yml)

FilsPay is a Bahraini card payment platform (1 BD = 1000 fils, business day
Asia/Bahrain). We took it over, found and fixed its bugs, and built the
missing feature: refunds (FP-300).

Branches: `main` holds the submission. `original-handover` holds the
untouched code we were handed (commit `8b58b0f`).

## Try it live

**https://64-227-145-174.sslip.io** (Dilmune Cloud, server `Orbit`, HTTPS)

| What | Where | Login |
|---|---|---|
| Merchant dashboard | `/dashboard/login` | `finance@alpharetail.example` / `FilsPaySeed!2026` (one shop: email and password only) |
| Merchant dashboard, owner of two shops | `/dashboard/login` | `owner@alpharetail.example` / `FilsPaySeed!2026`, then pick the shop: Alpha Retail `9972daab-2c86-459f-9d78-3fe1be4e3280` |
| Admin console | `/admin/` | `finance@filspay.test` / `FilsPayAdminSeed!2026` |
| API | `/v1/...` | API key from the dashboard |

These are demo logins from the seed data. There is no SMS or email service,
so the login page shows the one-time code (`OTP_DEV_EXPOSE=true`). Test card:
`4242 4242 4242 4242`, any future expiry, CVV `123`. The bank is a simulator.

## What to read

Start with [SUBMISSION.md](SUBMISSION.md): results, the findings summary, capacity, hosting, UI evidence and the AI transcript excerpts on one page.


| File | What it shows |
|---|---|
| [BUGS.md](BUGS.md) | Every bug we fixed: severity, ticket, area, and a link to the full write-up (what is wrong, why it happens, what it breaks, the fix, the test). |
| [docs/bugs/](docs/bugs/) | The write-ups, one section per bug. |
| [docs/UI-BEFORE-AFTER.md](docs/UI-BEFORE-AFTER.md) | Checkout, merchant dashboard and admin console: before and after screenshots. |
| [CAPACITY.md](CAPACITY.md) | Load test on the live server: about 70 concurrent checkout users; overload and restart behaviour. |
| [SECURITY.md](SECURITY.md) | Security review: threat model, the security bugs with root cause, fix and test, live header checks. |
| [HOSTING.md](HOSTING.md) | How the stack runs on one 1 vCPU / 2 GB server, and how to deploy it. |
| [ai-setup/](ai-setup/) | How we used AI and how we checked what it told us, with three annotated transcript excerpts. |

## Refunds (FP-300)

`POST /v1/refunds` (merchant API key or dashboard session, `Idempotency-Key`
required). Partial and full refunds, the fee is reversed in proportion, two
refunds at the same moment cannot pay out twice, and a refund can never exceed
what was captured. A finance admin can put one merchant's refunds on hold (and
release the hold) in the admin console. The refund reaches the ledger, the
merchant's signed `refund.succeeded` webhook, the transaction timeline, the daily report, the
nightly payout and reconciliation.

Proof: `scripts/demo_refund.sh` runs the whole flow against a running API and
checks each step (29 checks, all pass). On a migrated and seeded database:

```sh
(cd apps/api && WEBHOOK_ALLOW_PRIVATE_TARGETS=true ACQUIRER_FAILURE_RATE=0 PORT=3100 npx tsx src/index.ts) &
API_URL=http://localhost:3100 DATABASE_URL=$DATABASE_URL scripts/demo_refund.sh
```

## Notes in this repo that are wrong

The `CLAUDE.md`, `AGENTS.md` and `.cursorrules` we were handed were the
previous team's instructions for AI tools. Several rules in them were false
(money in cents, UTC settlement windows, "never change a test", `Math.random`
for codes). We never followed them. We replaced them with correct ones (the
root `CLAUDE.md` now holds our real rules) and kept the originals as evidence
in [`ai-setup/handed-over/`](ai-setup/handed-over/). The truth comes from the
case brief, `docs/ARCHITECTURE.md` and the ADRs.

## Commands that damaged data (fixed)

These looked routine and broke data before our fixes. Each is fixed and tested:

| Command | What it did | Bug |
|---|---|---|
| Admin "Rebuild cached balances" / `settlement rebuild-balances` | Rebuilt balances from the wrong source and wiped manual credits | C1, C10, G4 |
| Admin "Recalculate MDR" | Rewrote fees on batches that were already paid | C6 |
| `scripts/reconcile_march.ts` | Swept the wrong month and posted twice on a re-run | E2 |
| `scripts/expire_holds.ts` | Deleted holds, and with an empty filter, every hold | E3 |
| Admin "Rebuild analytics" | Counted every event twice | U5 |
| Direct `UPDATE` / `DELETE` on `ledger_entries` | Changed money history with no error | E4 (ledger is now append-only) |

## Run it yourself

Production mode, the same stack as the live server (see HOSTING.md):

```sh
cp ops/.env.production.example ops/.env.production   # then fill each CHANGE_ME
FILSPAY_HTTP_PORT=8088 docker compose -f ops/docker-compose.prod.yml -p filspay-prod up -d --build
BASE_URL=http://localhost:8088 scripts/smoke_hosted.sh
```

Tests (Postgres from `ops/docker-compose.yml`, then a migrated database):

```sh
npm install
export DATABASE_URL=postgres://filspay:filspay_dev_password@localhost:5432/filspay
npm run migrate && npm test
npm run seed            # the Go tests read the seeded fee schedule
cd apps/settlement && go test ./...
```

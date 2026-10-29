# Setup bugs (the app could not start from zero)

### S1 A fresh database cannot be migrated
- Severity: Critical
- Ticket: none (handover: "migration gaps ... abandoned PRs")
- Where: db/migrations/0054_views.sql, db/migrations/0055_chart_of_accounts_suspense.sql
- What is wrong: 0054 reads a table that does not exist (`settlement_batch_events`). 0055 inserts into columns that do not exist (`code`) and uses a kind the CHECK forbids (`suspense`).
- Why it happens: these were abandoned PRs that were left in the folder. `db/migrate.ts` stops at the first error.
- What it breaks: 0056 to 0072 never apply, so refunds reasons, saved filters, the refund view and more are missing. `docker compose up` cannot build a working database.
- Fix: keep only the one view that code reads (`merchant_payable_position`) and make 0055 a no-op with a comment. File numbers stay the same.
- Test: a fresh database applies every migration and the seed passes all its checks.

### S2 The Dockerfiles that compose needs are missing
- Severity: High
- Ticket: none (ops/README: "the two Dockerfiles aren't in the repo for me")
- Where: ops/docker-compose.yml references ops/Dockerfile.node and ops/Dockerfile.go
- What is wrong: both files are absent.
- Why it happens: they were never committed; the README notes argue about it instead of adding them.
- What it breaks: nobody can start the stack, so the app cannot be hosted.
- Fix: add a Node 22 image and a two-stage Go image (with Bahrain time zone data).
- Test: `docker compose -f ops/docker-compose.yml up` builds and `/healthz` answers 200.

### S3 The stack starts in the wrong order
- Severity: Medium
- Ticket: none
- Where: ops/docker-compose.yml
- What is wrong: migrate, seed and the services all start at the same time.
- Why it happens: no `depends_on` conditions between the one-off jobs and the services.
- What it breaks: settlement runs its daily batch on an empty database (0 merchants processed).
- Fix: services wait for migrate and seed to finish successfully.
- Test: two runs from an empty volume: settlement processed 7 merchants.

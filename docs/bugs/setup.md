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
- How found and reproduced: Found when we first ran a fresh `docker compose up` / migrate (phase 0, before the audit). Handover notes speak of "migration gaps ... abandoned PRs"; audit finding 12. Reproduced by running migrate on an empty database: it stopped at 0054. Fix commit `558567b`.
- Effect on existing data: None. The old 0054 and 0055 could never apply, so no database ever had them. A database that stopped at 0053 now applies 0054 onward on the next migrate.

### S2 The Dockerfiles that compose needs are missing
- Severity: High
- Ticket: none (ops/README: "the two Dockerfiles aren't in the repo for me")
- Where: ops/docker-compose.yml references ops/Dockerfile.node and ops/Dockerfile.go
- What is wrong: both files are absent.
- Why it happens: they were never committed; the README notes argue about it instead of adding them.
- What it breaks: nobody can start the stack, so the app cannot be hosted.
- Fix: add a Node 22 image and a two-stage Go image (with Bahrain time zone data).
- Test: `docker compose -f ops/docker-compose.yml up` builds and `/healthz` answers 200.
- How found and reproduced: Found in phase 0 when `docker compose up` could not build; `ops/README` notes say the files are missing. Reproduced by running compose: build failed on the missing Dockerfiles. Fix commit `a806158`.
- Effect on existing data: None: build files only, no data.

### S3 The stack starts in the wrong order
- Severity: Medium
- Ticket: none
- Where: ops/docker-compose.yml
- What is wrong: migrate, seed and the services all start at the same time.
- Why it happens: no `depends_on` conditions between the one-off jobs and the services.
- What it breaks: settlement runs its daily batch on an empty database (0 merchants processed).
- Fix: services wait for migrate and seed to finish successfully.
- Test: two runs from an empty volume: settlement processed 7 merchants.
- How found and reproduced: Found in phase 0 when the stack started from an empty database. Reproduced by starting the stack: settlement ran its batch before migrate and seed ended (0 merchants processed). Fix commit `f64a48a`.
- Effect on existing data: None: the early run processed 0 merchants, so it wrote no rows.

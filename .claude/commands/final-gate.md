---
description: Run every test suite and the smoke scripts on a fresh migrated database before a merge or submit
argument-hint: "[hosted base URL for the smoke test, optional]"
---

Run the final gate. Report each step as PASS or FAIL with counts. Stop at the
first FAIL and show the output; do not fix anything in this command.

1. `git status` must be clean (no stray files). Show `git log --oneline -5`.
2. Fresh database: drop and create a new database (for example
   `filspay_gate`) on the local dev Postgres, set `DATABASE_URL` to it, then
   `npm run migrate`. Do not reuse a database that a running API uses.
3. `npm run typecheck`
4. `npm test` (all workspaces and `scripts/*.test.ts`). Report pass/fail counts.
5. `npm run seed`, then `cd apps/settlement && go test -count=1 ./...`
   (the Go tests read the seeded fixtures).
6. Refunds end to end: start the API on a free port with
   `WEBHOOK_ALLOW_PRIVATE_TARGETS=true ACQUIRER_FAILURE_RATE=0 PORT=<port>`
   and the gate `DATABASE_URL`, then run
   `API_URL=http://localhost:<port> DATABASE_URL=<gate db> scripts/demo_refund.sh`. It must end in
   `RESULT: ALL PASS`. Stop the API by its PID.
7. If a hosted URL is given ($ARGUMENTS), run
   `BASE_URL=$ARGUMENTS scripts/smoke_hosted.sh`. Read the side effects in the
   script header first and tell the user before you run it. Never run load
   tests (`scripts/load/`) against a live server from this command.
8. Drop the gate database. Confirm `git status` is still clean.

End with a table: step / PASS or FAIL / counts or evidence.

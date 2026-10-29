# Wave D bugs

### D1 Webhook signature covers different bytes than the body sent
- Severity: Critical. Ticket: FP-240. Where: apps/api/src/webhooks/sign.ts:36, apps/api/src/webhooks/dispatcher.ts:158-172
- What is wrong: the dispatcher signed `canonicalJson(payload)` (keys sorted) but sent `JSON.stringify(row.payload)` (jsonb key order). The two strings are different.
- Why it happens: the payload is stored as jsonb, which changes key order. The signer serialised the object one way and the sender another way. The old tests re-parsed and re-canonicalised the body before they verified it, so they could not see the mismatch.
- What it breaks: every merchant that verifies the HMAC over the raw request body (the correct way, and what ARCHITECTURE.md promises) rejects every webhook. Merchants either drop real events or turn off verification.
- Fix: serialise the body once, sign that exact string, send that exact string (dispatcher and test-send). `signPayload` and `verifySignature` now take the raw body string. Existing tests that verified a re-parsed object now verify the raw body; the test that locked in sorted-key signing is replaced.
- Test: apps/api/src/webhooks/sign.fix.test.ts (a receiver checks the HMAC over the raw bytes).

### D9 Flaky backoff test: "failing endpoint: backoff/exhaustion ..."
- Severity: Medium. Ticket: none. Where: apps/api/src/webhooks/dispatcher.test.ts:195 and :215
- What is wrong: the test asserts `backoffDelayMs(1, config) === 1000`, but the function adds a random +/-10 % jitter, so it returns 900..1100 (seen: 926, 950, 1081).
- Why it happens: the test calls the jittered function with the default `Math.random`. The code is correct (jitter is the documented design); the test is wrong.
- What it breaks: the suite fails at random, so a real dispatcher regression is hidden in noise.
- Fix: the test passes a fixed jitter (`() => 0.5`, the midpoint) when it computes the expected value. The real delay is still checked inside a time window.
- Test: the same test, now stable (ran 3 times, all pass).

### D3 Webhook dispatcher does not claim rows, so two passes send the same delivery
- Severity: High. Ticket: none. Where: apps/api/src/webhooks/dispatcher.ts:219-228 (attemptDueDeliveries)
- What is wrong: Step B did a plain SELECT of due 'pending' rows, then sent each one. Nothing marked a row as "taken".
- Why it happens: two passes running at the same time (two API replicas, or a NOTIFY pass and a poll pass on different processes) read the same due rows before either writes the outcome. A comment said "only ever run one replica", but staging runs two.
- What it breaks: merchants get the same webhook two or more times, and attempt_count / backoff is wrong.
- Fix: claim one row at a time with `SELECT ... FOR UPDATE SKIP LOCKED` inside an `UPDATE ... RETURNING` that pushes next_attempt_at forward by a lease (request timeout + 30 s). Other passes skip the row while it is sent. If the process dies, the row is due again after the lease.
- Test: apps/api/src/webhooks/dispatcher.claim.fix.test.ts (two concurrent passes, slow receiver, exactly one send).

### D4 Payout disbursement written many times per settlement batch
- Severity: High. Ticket: none. Where: apps/api/src/webhooks/dispatcher.ts:160 (PRE_DELIVERY_EFFECTS), apps/api/src/webhooks/payoutDisbursement.ts:14, db/migrations/0057
- What is wrong: the dispatcher inserts a settlement_payout_disbursements row before the first attempt (attempt_count 0) of every settlement.paid delivery. There is one delivery per endpoint, and a replay is a new row with attempt_count 0. The table has no unique key per batch.
- Why it happens: a money side effect hangs off a per-delivery, at-least-once path, and the insert is not idempotent.
- What it breaks: a merchant with 2 endpoints, or one replay, gets 2+ payout instructions for one batch (double payout risk). Concurrent passes can also both insert.
- Fix: migration 0079 drops existing duplicate rows (keeps the earliest per batch) and adds a unique index on settlement_batch_id; the insert uses `ON CONFLICT (settlement_batch_id) DO NOTHING`. Known remaining design gap (not changed, out of scope): the record is still only written when the merchant has an active webhook endpoint; it belongs in the settlement pay step.
- Test: apps/api/src/webhooks/payoutDisbursement.fix.test.ts (concurrent + repeated calls keep one row).

### D11 Replays mint a new Webhook-Delivery-Id; batch replay resends succeeded deliveries
- Severity: Medium. Ticket: none. Where: apps/api/src/webhooks/replay.ts:48, apps/api/src/webhooks/replayBatch.ts:21 (also used by archiveReplay.ts)
- What is wrong: `insertReplayDeliveryRow` made a new random delivery_event_id and wrote it into the envelope `id`. Batch replay accepted any status, including `succeeded`.
- Why it happens: a comment claimed receivers dedupe on something else. ARCHITECTURE.md and migration 0022 say the id is stable and receivers dedupe on it.
- What it breaks: a receiver that already processed the event cannot see the replay is the same event, so it processes it twice (for example double-credits a capture). A bulk replay of `succeeded` rows sends every merchant events they already handled.
- Fix: a replay copies the original envelope unchanged and reuses its id (header and body). Batch replay rejects any status other than `failed`/`exhausted` with 400. Two existing tests locked the old behaviour (expected a new id; expected `statuses: ["succeeded"]` to be accepted) and are updated.
- Test: apps/api/src/webhooks/replay.fix.test.ts.

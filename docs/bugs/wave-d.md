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

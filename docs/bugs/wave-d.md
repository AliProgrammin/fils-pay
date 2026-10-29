# Wave D bugs

### D1 Webhook signature covers different bytes than the body sent
- Severity: Critical. Ticket: FP-240. Where: apps/api/src/webhooks/sign.ts:36, apps/api/src/webhooks/dispatcher.ts:158-172
- What is wrong: the dispatcher signed `canonicalJson(payload)` (keys sorted) but sent `JSON.stringify(row.payload)` (jsonb key order). The two strings are different.
- Why it happens: the payload is stored as jsonb, which changes key order. The signer serialised the object one way and the sender another way. The old tests re-parsed and re-canonicalised the body before they verified it, so they could not see the mismatch.
- What it breaks: every merchant that verifies the HMAC over the raw request body (the correct way, and what ARCHITECTURE.md promises) rejects every webhook. Merchants either drop real events or turn off verification.
- Fix: serialise the body once, sign that exact string, send that exact string (dispatcher and test-send). `signPayload` and `verifySignature` now take the raw body string. Existing tests that verified a re-parsed object now verify the raw body; the test that locked in sorted-key signing is replaced.
- Test: apps/api/src/webhooks/sign.fix.test.ts (a receiver checks the HMAC over the raw bytes).

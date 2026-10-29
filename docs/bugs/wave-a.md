# Wave A bug fixes

### A1 Login works without the OTP
- Severity: Critical
- Ticket: none
- Where: apps/api/src/auth/sessions.ts:89
- What is wrong: `lookupSession` accepts a session that has not passed the OTP step.
- Why it happens: The query reads the `live_sessions` view. That view only removes revoked and expired rows. It keeps rows with `authenticated = false`. The query never checks that column.
- What it breaks: `/v1/auth/login` sets the session cookie after the password check only. With that cookie, an attacker who knows the password can call every merchant route without the OTP. Two-factor login is fully bypassed.
- Fix: Add `AND s.authenticated = true` to the lookup query.
- Test: apps/api/src/auth/sessions.test.ts, "lookupSession returns null for a pending session that never passed the OTP"

### A2 Login binds to the wrong merchant user
- Severity: Critical
- Ticket: none
- Where: apps/api/src/routes/auth.ts:78 (and apps/api/src/auth/users.ts:11, now removed)
- What is wrong: After the password check, login looked up the user again by email only. It used that user for the OTP and the session.
- Why it happens: `findOtpRecipient` searched `merchant_users` by email across all merchants with `LIMIT 1`. But email is unique only per merchant (`UNIQUE (merchant_id, email)`). So the lookup can return a user of a different merchant.
- What it breaks: The same person (or an attacker) has one email under merchant A and merchant B. They log in to A with A's password. The OTP goes to B's user row and the session is for B. They get into merchant B without B's password. They can see B's data and act as B.
- Fix: Use the user row that passed the password check. Delete the email-only lookup.
- Test: apps/api/src/routes/auth.fix.test.ts, "login to merchant A binds the session to A's user when the same email exists under merchant B"

### A3 Support admin can issue credits
- Severity: High
- Ticket: case card "Missing role checks"
- Where: apps/api/src/routes/adminCredits.ts:62
- What is wrong: `POST /v1/admin/merchants/:id/credits` only checks that an admin is logged in. It does not check the role.
- Why it happens: The create route sits in the first scope, which has only `requireAdminSession`. The `finance`/`super_admin` role gate was added only to the approve and reject scope. The console hides the button for support, so the gap is only on the server. ARCHITECTURE.md says roles are checked server-side per route.
- What it breaks: A support admin calls the API directly and issues a credit. Credits at or below 50.000 BD post to the ledger at once, with no second person. Support can move money to any merchant's payable balance.
- Fix: Add `requireAdminRole("finance", "super_admin")` to the create route. Note: ADMIN.md's role table says support may "issue small credits". The console, the case card and the "finance touches money" rule all say otherwise, so we follow them.
- Test: apps/api/src/routes/adminCredits.test.ts, "a support admin is 403'd on issuing a credit and nothing is posted"

### A4 Second-approver check compares display names, not admin ids
- Severity: High
- Ticket: case card "Missing role checks" (self-approve by renaming)
- Where: apps/api/src/admin/creditApproval.ts:11 (called from apps/api/src/admin/credits.ts ~326)
- What is wrong: Two-person control checks `approver.displayName === requester.displayName`. It does not compare the admin user ids.
- Why it happens: The requester's name is copied onto the credit request when it is made (`requested_by_display_name`). The approve step compares that copy with the approver's current name. A name is a label, not an identity. HANDOVER.md says the check is by admin user id.
- What it breaks: An admin requests a large credit (over 50.000 BD), changes their display name, then approves it. The names differ, so the check passes and one person posts the credit alone. The reverse also fails: two different people with the same name (common, e.g. "Ali Hassan") cannot approve each other.
- Fix: Compare `adminUserId` instead of `displayName`.
- Test: apps/api/src/admin/creditApproval.test.ts, "an operator who renamed themselves still cannot approve their own credit request" and "two different operators who share a display name satisfy two-person control"

### A5 API key rotation never revokes the old key
- Severity: High
- Ticket: case card "Key rotation"
- Where: apps/api/src/admin/apiKeys.ts:31
- What is wrong: Admin "Rotate API key" issues a new key but leaves the old key active forever.
- Why it happens: The rotation transaction only inserts the new key. Nothing sets `revoked_at` on the old one. Migration 0037 and the admin console both say rotation revokes the old key with reason `rotated`. The "24h grace period" in a comment does not exist. Migration 0056 adds `revoke_after`, but no code sets or reads it, and there is no sweep job (HANDOVER: 0054-0056 were abandoned).
- What it breaks: A merchant's key leaks. Ops rotates it. The attacker's copy still works on `/v1/transactions` and every other API-key route, so the rotation gives false safety.
- Fix: In the same transaction, set `revoked_at = now()` and `revoked_reason = 'rotated'` on the old key. `verifyApiKey` already rejects revoked keys.
- Test: apps/api/src/routes/admin.test.ts, "API key rotation issues a new key atomically, revokes the previous key, and audits it" (the old test asserted the bug: "the previous key stays active", so it was changed)

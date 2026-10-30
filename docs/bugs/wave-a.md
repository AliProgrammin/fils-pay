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
- How found and reproduced: Case card question "OTP still safe?" and our wave A audit (audit finding 1). Reproduced by the test: it creates a pending session that only passed the password step and calls `lookupSession`; the old code returned the session, the fixed code returns null. Fix commit `0de213e`.
- Effect on existing data: None in stored rows: the check runs at request time. Pending sessions expire after 10 minutes, so no old session stays open. We cannot see from the data whether anyone used a pending session in the past; request logs would be needed.

### A2 Login binds to the wrong merchant user
- Severity: Critical
- Ticket: none
- Where: apps/api/src/routes/auth.ts:78 (and apps/api/src/auth/users.ts:11, now removed)
- What is wrong: After the password check, login looked up the user again by email only. It used that user for the OTP and the session.
- Why it happens: `findOtpRecipient` searched `merchant_users` by email across all merchants with `LIMIT 1`. But email is unique only per merchant (`UNIQUE (merchant_id, email)`). So the lookup can return a user of a different merchant.
- What it breaks: The same person (or an attacker) has one email under merchant A and merchant B. They log in to A with A's password. The OTP goes to B's user row and the session is for B. They get into merchant B without B's password. They can see B's data and act as B.
- Fix: Use the user row that passed the password check. Delete the email-only lookup.
- Test: apps/api/src/routes/auth.fix.test.ts, "login to merchant A binds the session to A's user when the same email exists under merchant B"
- How found and reproduced: Case card question "OTP still safe?" and our wave A audit (audit finding 2). Reproduced by the test: the same email exists under merchant A and merchant B; a login to A with A's password got a session for B's user on the old code. Fix commit `b59967f`.
- Effect on existing data: None in stored rows: the fix is a request-time lookup. Sessions made with the old code expire on their normal TTL. To see if any user could be hit, list emails used by more than one merchant: `SELECT email, count(*) FROM merchant_users GROUP BY email HAVING count(*) > 1;`

### A3 Support admin can issue credits
- Severity: High
- Ticket: case card "Missing role checks"
- Where: apps/api/src/routes/adminCredits.ts:62
- What is wrong: `POST /v1/admin/merchants/:id/credits` only checks that an admin is logged in. It does not check the role.
- Why it happens: The create route sits in the first scope, which has only `requireAdminSession`. The `finance`/`super_admin` role gate was added only to the approve and reject scope. The console hides the button for support, so the gap is only on the server. ARCHITECTURE.md says roles are checked server-side per route.
- What it breaks: A support admin calls the API directly and issues a credit. Credits at or below 50.000 BD post to the ledger at once, with no second person. Support can move money to any merchant's payable balance.
- Fix: Add `requireAdminRole("finance", "super_admin")` to the create route. Note: ADMIN.md's role table says support may "issue small credits". The console, the case card and the "finance touches money" rule all say otherwise, so we follow them.
- Test: apps/api/src/routes/adminCredits.test.ts, "a support admin is 403'd on issuing a credit and nothing is posted"
- How found and reproduced: Case card "Missing role checks" and our wave A audit (audit finding 24). Reproduced by the test: a support admin calls `POST /v1/admin/merchants/:id/credits` directly; the old code posted the credit, the fixed code answers 403 and posts nothing. Fix commit `9688a2d`.
- Effect on existing data: Credits that support already issued stay in the ledger; we did not reverse them. Finance must review them: `SELECT cr.* FROM credit_requests cr JOIN admin_users au ON au.id = cr.requested_by_admin_user_id WHERE au.role = 'support';` Each wrong credit needs a correcting entry from finance.

### A4 Second-approver check compares display names, not admin ids
- Severity: High
- Ticket: case card "Missing role checks" (self-approve by renaming)
- Where: apps/api/src/admin/creditApproval.ts:11 (called from apps/api/src/admin/credits.ts ~326)
- What is wrong: Two-person control checks `approver.displayName === requester.displayName`. It does not compare the admin user ids.
- Why it happens: The requester's name is copied onto the credit request when it is made (`requested_by_display_name`). The approve step compares that copy with the approver's current name. A name is a label, not an identity. HANDOVER.md says the check is by admin user id.
- What it breaks: An admin requests a large credit (over 50.000 BD), changes their display name, then approves it. The names differ, so the check passes and one person posts the credit alone. The reverse also fails: two different people with the same name (common, e.g. "Ali Hassan") cannot approve each other.
- Fix: Compare `adminUserId` instead of `displayName`.
- Test: apps/api/src/admin/creditApproval.test.ts, "an operator who renamed themselves still cannot approve their own credit request" and "two different operators who share a display name satisfy two-person control"
- How found and reproduced: Case card "Missing role checks" (self-approve by renaming) and our wave A audit (audit finding 25). Reproduced by the test: an operator requests a credit, changes their display name, then approves it; the old code allowed it. Fix commit `18cb2ee`.
- Effect on existing data: Past approvals are not changed. To find credits that one person requested and approved alone: `SELECT * FROM credit_requests WHERE approved_by_admin_user_id = requested_by_admin_user_id;` Finance must review each row found.

### A5 API key rotation never revokes the old key
- Severity: High
- Ticket: case card "Key rotation"
- Where: apps/api/src/admin/apiKeys.ts:31
- What is wrong: Admin "Rotate API key" issues a new key but leaves the old key active forever.
- Why it happens: The rotation transaction only inserts the new key. Nothing sets `revoked_at` on the old one. Migration 0037 and the admin console both say rotation revokes the old key with reason `rotated`. The "24h grace period" in a comment does not exist. Migration 0056 adds `revoke_after`, but no code sets or reads it, and there is no sweep job (HANDOVER: 0054-0056 were abandoned).
- What it breaks: A merchant's key leaks. Ops rotates it. The attacker's copy still works on `/v1/transactions` and every other API-key route, so the rotation gives false safety.
- Fix: In the same transaction, set `revoked_at = now()` and `revoked_reason = 'rotated'` on the old key. `verifyApiKey` already rejects revoked keys.
- Test: apps/api/src/routes/admin.test.ts, "API key rotation issues a new key atomically, revokes the previous key, and audits it" (the old test asserted the bug: "the previous key stays active", so it was changed)
- How found and reproduced: Case card "Key rotation" and our wave A audit (audit finding 26). Reproduced by the test: rotate a key, then check the old key; the old code left it active (the old test asserted this). Fix commit `28990c9`.
- Effect on existing data: Old keys rotated before the fix are still active; the fix does not revoke them, because no migration was added. The September admin audit export shows 14 `api_key_rotate` actions. Ops must revoke them: find them with `SELECT * FROM api_keys WHERE revoked_at IS NULL AND id IN (SELECT rotated_from_key_id FROM api_keys WHERE rotated_from_key_id IS NOT NULL);`

### A6 OTP codes, payment link tokens and invite codes use Math.random
- Severity: High
- Ticket: case card "OTP still safe?"
- Where: apps/api/src/lib/random.ts:4 and :13, apps/api/src/admin/inviteCode.ts:10
- What is wrong: `randomDigits` (OTP codes) and `randomFromAlphabet` (payment link tokens) use `Math.random`. Admin invite codes do the same.
- Why it happens: `Math.random` is a fast, non-cryptographic PRNG (xorshift128+ in V8). Its internal state can be recovered from a few outputs, and then every later output can be predicted. ARCHITECTURE.md says tokens are 128-bit from `crypto`. The CLAUDE.md rule "Math.random is fine for OTP and link tokens" is false.
- What it breaks: An attacker collects some payment link tokens (they are in public URLs) and predicts the next tokens, so they can open other merchants' payment links. The same PRNG makes OTP codes and admin invite codes guessable, which weakens login and admin onboarding.
- Fix: Draw each character with `crypto.randomInt` (uniform, no modulo bias). `randomDigits` and the invite code reuse `randomFromAlphabet`. Formats and lengths do not change (22 chars of a 64-char alphabet = 132 bits).
- Test: apps/api/src/lib/random.fix.test.ts, "secret generators do not depend on Math.random"
- How found and reproduced: Case card question "OTP still safe?" and our wave A audit (audit finding 27). The handed-over CLAUDE.md said "Math.random is fine". Reproduced by the test: it replaces `Math.random` with a fixed function and checks that the OTP, link token and invite code output does not change with it; the old code did. Fix commit `d35cff9`.
- Effect on existing data: Tokens and codes made before the fix stay in the database and are still valid. OTP codes expire in minutes. Open payment links and unused invite codes keep their old, weaker tokens until they expire or are used. We did not reissue them; to list them: `SELECT id, expires_at FROM payment_links WHERE status = 'active' AND expires_at > now();`

### A7 OTP attempt limit can be raced, and resend resets the budget
- Severity: High
- Ticket: case card "OTP still safe?"
- Where: apps/api/src/routes/auth.ts:156-169 (verify) and :218-235 (resend); apps/api/src/routes/adminAuth.ts:147-160 (admin verify)
- What is wrong: (1) Verify reads `attempt_count`, checks it, compares the code, and only then adds 1 in a separate UPDATE. (2) Resend makes a new challenge with `attempt_count = 0`, although the route's own comment says it inherits the old count.
- Why it happens: (1) Check-then-increment is not atomic. Many parallel requests all read the same old count, all pass the check, and all get a guess. The "admin row is read FOR UPDATE" comment is false; there is no lock. (2) `issueChallenge` always inserts a fresh row, and resend never copies the used count across.
- What it breaks: The limit is 5 guesses. Our test sends 25 parallel wrong guesses and all 25 are checked, on merchant and admin login. A 6-digit code has 1,000,000 values, so large parallel batches plus resend every 30s (which gives 5 new guesses each time) make brute force practical. Together with A1/A2 this was the last line of defence.
- Fix: (1) Claim the attempt first with one statement: `UPDATE ... SET attempt_count = attempt_count + 1 WHERE id = $1 AND attempt_count < max_attempts RETURNING id`. No row back means the budget is used: revoke the session and answer 429. (2) In resend, read `attempt_count` from the consumed challenge (`RETURNING attempt_count`) and set it on the new challenge in the same transaction.
- Test: apps/api/src/routes/auth.fix.test.ts, "parallel wrong OTP guesses cannot exceed max_attempts", "OTP resend carries the used attempt count over to the new challenge", "parallel wrong admin OTP guesses cannot exceed max_attempts"
- How found and reproduced: Case card question "OTP still safe?" and our wave A audit (audit finding 28). Reproduced by the tests: 25 parallel wrong guesses were all checked on the old code (limit is 5), on merchant and admin login; and a resend reset the count to 0. Fix commit `a515529`.
- Effect on existing data: None in stored rows: the limit is enforced at request time. Old challenges expire in minutes.

### A8 Impersonation gives finance and super_admin write roles
- Severity: High
- Ticket: case card "Missing role checks" (impersonation gives owner)
- Where: apps/api/src/admin/impersonation.ts:85-89
- What is wrong: "View as merchant" maps admin `finance` to merchant `finance` and `super_admin` to merchant `owner`.
- Why it happens: The role map was written as a privilege mirror. But HANDOVER.md says impersonation maps every admin to the `support` merchant role and is read-only. The code's own comments ("Always support", "impersonation is read-only, enforced in requireMerchantAuth") say the same. The merchant routes trust this role through `requireMerchantRole("owner", "finance")`, so the map is the only guard.
- What it breaks: A finance or super_admin operator opens "view as merchant" and can create payment links, add webhook endpoints (send the merchant's events to any URL) and request payouts as the merchant. These writes are logged as merchant actions. ADMIN.md's "super_admin can make changes while viewing" conflicts with HANDOVER; we follow HANDOVER and the case card.
- Fix: Map all three admin roles to `support`.
- Test: apps/api/src/admin/impersonation.fix.test.ts, "a finance impersonation grant resolves to the read-only merchant role 'support'" and "a super_admin impersonation grant resolves to the read-only merchant role 'support'"
- How found and reproduced: Case card "Missing role checks" (impersonation gives owner) and our wave A audit (audit finding 29). Reproduced by the tests: a finance grant and a super_admin grant resolved to merchant roles `finance` and `owner` on the old code. Fix commit `6e2bcb5`.
- Effect on existing data: Writes done during old impersonation sessions stay, and they are logged as merchant actions. The September admin audit export shows 38 `impersonation_start` rows: 16 with role `owner`, 16 with role `finance`. To check what those sessions changed, compare each grant's time window with merchant-side writes (payment links, webhook endpoints, payouts) for that merchant: `SELECT * FROM admin_impersonation_grants;`

### A9 Recompute statuses takes test merchants out of test mode
- Severity: High
- Ticket: case card "Test merchants in real settlement"
- Where: apps/api/src/admin/transactionStatusRecompute.ts:29 and :47, apps/api/src/routes/adminMerchantsRecompute.ts:28 (helper apps/api/src/admin/merchantFlags.ts, now removed)
- What is wrong: The admin "Recompute transaction statuses" button sets `test_mode = false` when it finds no open authorizations. And it never finds any.
- Why it happens: The candidate query excludes `status = 'authorized'`, then counts `authorized` rows inside that same result. So `openAuthorizations` is always 0. `reconcileSandboxFlag` then clears `test_mode` for every test merchant that has any other transaction. A status tidy-up tool has no reason to change the test flag at all.
- What it breaks: Settlement selects merchants with `test_mode = false` (apps/settlement/internal/settlement/batch.go:117, :408). After one click, a test merchant like "Gamma" (Slack, 2026-09-19) is in the real daily batch and its fake captures become real payouts. ADMIN.md calls the button "safe to run more than once", so support runs it freely.
- Fix: The route no longer touches `test_mode` (`flagsUpdated` is always `[]`; the response shape is kept for the console). `openAuthorizations` is now a real count of `authorized` rows. The unused `reconcileSandboxFlag` helper is deleted so it cannot be wired in again.
- Test: apps/api/src/routes/adminMerchantsRecompute.fix.test.ts, "recompute keeps test_mode and counts an open authorization" and "recompute keeps test_mode for a test merchant with nothing open"
- How found and reproduced: Case card "Test merchants in real settlement" and our wave A audit (audit finding 30). The Slack export (fp-finance, 2026-09-19) and the admin audit export show a recompute on Gamma with `testModeCleared: true`. Reproduced by the tests: a test merchant with and without an open authorization; the old code cleared `test_mode`. Fix commit `1a38c3c`.
- Effect on existing data: A merchant whose flag was already cleared stays out of test mode; the fix does not set it back. Ops must check Gamma and any other test merchant and set `test_mode = true` again by hand: `SELECT id, display_name, test_mode FROM merchants;` and the audit rows with `action = 'transaction_status_recompute'`. Any batch already paid for a test merchant needs a finance review; Slack (2026-09-19) says Gamma had nothing new to batch.

### A10 KYC "PDF only" check trusts the filename
- Severity: Medium
- Ticket: none
- Where: apps/api/src/onboarding/kyc.ts:67
- What is wrong: For commercial registration and bank letter, the "must be a PDF" rule checks `fileName.endsWith(".pdf")`. It ignores the detected type it computed three lines above.
- Why it happens: The filename comes from the client and can be anything. The "fixed in FP-231" comment is false: `detectFileType` accepts JPEG and PNG for every document type. ARCHITECTURE.md says KYC uploads are validated by detected content type (magic bytes). The input type even says `fileName` is "never used for validation".
- What it breaks: A merchant uploads a phone photo (or an edited image) named `CR-2026.pdf`. It is stored as a commercial registration and goes to KYC review, although the policy says only registry/bank PDFs are acceptable. A real PDF with an odd name (`scan_0001`) is wrongly rejected.
- Fix: Check the detected bytes (`detected !== "pdf"` is refused). To keep the original contract, the name must also end in `.pdf`: both must hold, so real PDF bytes named `.docx` still get `422 document_must_be_pdf`, as before.
- Test: apps/api/src/onboarding/kyc.fix.test.ts, "a JPEG renamed to .pdf is rejected for a PDF-only document type", "a real PDF named .pdf is accepted for a PDF-only document type" and "real PDF bytes named .docx are rejected for a PDF-only document type". apps/api/src/app.test.ts has both the original test ("KYC upload rejects a commercial_registration submitted as a non-PDF filename", PDF bytes named .docx) and a new one (JPEG bytes named .pdf).
- How found and reproduced: Our wave A audit (audit finding 48). Reproduced by the tests: JPEG bytes named `.pdf` were accepted for a commercial registration, and real PDF bytes with another name were rejected, on the old code. Fix commit `694a4c6`.
- Effect on existing data: Documents already stored are not checked again. To find PDF-only documents that are not real PDFs, re-run the type check on the stored files from `SELECT * FROM kyc_documents WHERE document_type IN ('commercial_registration', 'bank_letter');`. We did not do this.

### A11 Bulk KYC approve ignores status and writes no review rows
- Severity: Medium
- Ticket: none
- Where: apps/api/src/admin/bulkKyc.ts:26
- What is wrong: Bulk approve runs `UPDATE merchants SET onboarding_status = 'approved', kyc_passed = true WHERE id = ANY(...)` with no status filter. It writes no `merchant_kyc_reviews` rows.
- Why it happens: The bulk path was written as one raw UPDATE instead of reusing `recordKycReviewInTx`, which review.ts calls "the one function permitted to write kyc_passed". ADMIN.md says "Only merchants currently under_review are affected". The result type also promises only under_review merchants are listed.
- What it breaks: A merchant that KYC rejected (or one that never sent documents) is ticked by mistake in a bulk run and becomes approved with `kyc_passed = true`, so it can take live payments. There is no per-merchant review row, so the KYC trail cannot show who approved it.
- Fix: Lock and select only `under_review` merchants from the list, then approve each through `recordKycReviewInTx` (one review row each, with the admin's id and email). The single batch audit row stays.
- Test: apps/api/src/routes/admin.test.ts, "bulk approve KYC only moves under_review merchants and writes a review row for each"
- How found and reproduced: Our wave A audit (audit finding 49). Reproduced by the test: a bulk approve with a rejected merchant and an under_review merchant; the old code approved both and wrote no review rows. Fix commit `c391d0c`.
- Effect on existing data: Merchants approved by an old bulk run stay approved. The September admin audit export shows one `kyc_bulk_approve` (2026-09-16, 6 merchants). Compliance must review them. Approved merchants with no review row: `SELECT m.id FROM merchants m WHERE m.kyc_passed AND NOT EXISTS (SELECT 1 FROM merchant_kyc_reviews r WHERE r.merchant_id = m.id AND r.outcome = 'approved');`

### A12 Impersonation could still write through routes with no role gate
- Severity: High
- Ticket: "some admin actions don't seem to have the right role checks"
- Where: apps/api/src/auth/requireMerchantAuth.ts (impersonation branch); routes/transactions.ts capture/void; routes/reporting.ts saved-filters
- What is wrong: an admin "viewing as merchant" could capture, void and create saved filters.
- Why it happens: the grant maps to the read-only `support` role, but these routes only check `requireMerchantAuth` and never check a role, so the role alone does not stop the write.
- What it breaks: an operator can move money (capture or void) as the merchant, and the audit records it as a merchant session.
- Fix: the auth hook rejects every non-GET request that arrives with an impersonation grant (one check, one place).
- Test: apps/api/src/auth/impersonationReadOnly.fix.test.ts
- How found and reproduced: Found by our blind verifier: it was given only the requirement "admin impersonation is read-only for every admin role", not our fixes, and found that capture, void and saved filters still worked (see SUBMISSION.md excerpt 2). Reproduced by the test: an impersonation grant sends non-GET requests to these routes; the old code accepted them. Fix commit `53ff04c`.
- Effect on existing data: Writes already made through impersonation stay and are logged as merchant actions. Same review as A8: compare grant windows in `admin_impersonation_grants` with captures, voids and saved filters for that merchant.

### A13 A disabled admin keeps their "view as merchant" grant
- Severity: Medium/High (security)
- Ticket: none (am's own question in the code: "disabled admin keeps their grant?")
- Where: apps/api/src/admin/impersonation.ts:104 (`lookupImpersonationGrant`)
- What is wrong: The grant lookup checks the grant's `revoked_at`, `ended_at` and `expires_at`, but not `admin_users.status`. When an admin is disabled, their live grants keep working.
- Why it happens: The code comment said "revoked_at gets set by the admin-disable trigger". There is no such trigger in db/migrations, and no code sets `revoked_at` when an admin is disabled. Admin sessions (`lookupAdminSession`) do check `au.status = 'active'`, so disabling an admin ends their sessions. The grant lookup skipped that same check.
- What it breaks: A support person leaves or is suspended. Finance disables the account. Their open grant cookie still opens that merchant's transactions, customers and payouts until the grant expires. Nothing in the audit log shows that a disabled account read merchant data.
- Fix: The lookup adds `AND au.status = 'active'` (it already joins `admin_users`), the same rule as `lookupAdminSession`. Admin sessions were already correct; a regression test now guards them.
- Test: apps/api/src/admin/impersonationDisabledAdmin.fix.test.ts, "A13: a disabled admin's impersonation grant stops working" (was 200 after disable, now 401) and "A13: a disabled admin's admin session also stops working (regression guard)".
- How found and reproduced: A question left in the handed-over code ("disabled admin keeps their grant?"), checked in our audit sweep. Reproduced by the test: disable an admin, then use their open grant; the old code answered 200, the fixed code 401. Fix commit `45ff1a0`.
- Effect on existing data: None in stored rows: the check runs at request time. Grants expire on their own (the audit export shows 900 s). Reads made by a disabled admin before the fix cannot be found in the audit log.

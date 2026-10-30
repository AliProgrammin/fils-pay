# UI and UX: before and after

Matched screenshots of checkout, the merchant dashboard and the admin console.

- **Before** = the original upstream code (commit `8b58b0f`), with only the S1 migration fix added so that a fresh database can migrate.
- **After** = branch `handover-fixes`, plus the small UX fixes listed under "New UX fixes" at the end.
- Each side ran with its own database (`filspay_ui_before`, `filspay_ui_after`), with the same seed and the same steps. Both sides used the same Playwright script, with the Asia/Bahrain time zone and the en-GB locale. Checkout and the phone views are 375 px wide (iPhone size). The other views are 1280 px wide.
- The 2026-08-31 batch for Alpha Retail was closed and paid on both sides with that side's own Go `settlement run-batch`.
- Some bugs are only visible on the wire (H1, U12, the refunds API). For those, the image shows the real HTTP request and response from that side.

Bug ids refer to [BUGS.md](../BUGS.md). `UX1` to `UX10` are the new fixes described at the end.

## Checkout

### 1. Card form on a phone (UX1)

| Before | After |
|---|---|
| ![](ui/checkout-form-mobile-before.png) | ![](ui/checkout-form-mobile-after.png) |

Before: at 375 px, the CVV box goes past the right edge of the screen and the page scrolls sideways. "Expiry month" wraps, so the three boxes are not aligned. After: three equal columns that fit the screen.

### 2. Declined card (UX1, UX3)

| Before | After |
|---|---|
| ![](ui/checkout-declined-mobile-before.png) | ![](ui/checkout-declined-mobile-after.png) |

The decline message now has `role="alert"`, so a screen reader announces it. The layout fix from 1 also applies.

### 3. Payment successful (UX2)

| Before | After |
|---|---|
| ![](ui/checkout-success-mobile-before.png) | ![](ui/checkout-success-mobile-after.png) |

Before: the customer sees a raw ISO time (`2026-10-30T08:56:59.503Z`), with no amount and no merchant name. After: a short receipt that shows the merchant, the amount in BHD with 3 decimals, the reference, the paid time in local format, and the transaction id.

### 4. Public payment-link data (H1)

| Before | After |
|---|---|
| ![](ui/checkout-public-link-api-before.png) | ![](ui/checkout-public-link-api-after.png) |

The checkout page reads `GET /v1/payment-links/:token` with no login. Before, the response gave the merchant's live API key prefix and the full key hash (`merchantPublicKey`, `merchantIntegrationId`) to anyone who has the link. After, these two fields are gone. The page looks the same.

## Merchant dashboard

### 5. Transaction detail (R8, R7, FP-300)

| Before | After |
|---|---|
| ![](ui/dash-transaction-detail-before.png) | ![](ui/dash-transaction-detail-after.png) |

This is the transaction that was just paid through checkout. Before, the page had no refund control and no refunded amount (the drawer was commented out). After, the page shows a "Refunded amount" row and a **Refund** button for owner and finance users.

### 6. Refund drawer (R2, R7, R8)

| Before | After |
|---|---|
| ![](ui/dash-refund-drawer-before.png) | ![](ui/dash-refund-drawer-after.png) |

After: the merchant types the amount in BD (`4.750`, not raw fils) and gives a reason. The drawer shows "Left to refund" (captured minus refunded). Before submitting, it asks "Refund 4.750 BHD?". A retry of the same refund reuses the same Idempotency-Key.

### 7. After the refund (R1–R8, E7, R6)

| Before | After |
|---|---|
| ![](ui/dash-refund-done-before.png) | ![](ui/dash-refund-done-after.png) |

Before: the refund route does not exist (`404 Route POST:/v1/merchants/:id/refunds not found`). After: the status is `partially_refunded`, the refunded amount is 4.750 BHD, and the timeline shows a `refund_partial` row of `-4.750 BHD`. On the old code, that negative amount crashed the page (E7).

### 8. Reconciliation (D15, E7, G11)

| Before | After |
|---|---|
| ![](ui/dash-reconciliation-august-before.png) | ![](ui/dash-reconciliation-august-after.png) |

Before: when the batch is paid, the report has a false gap of minus the payout (-7143.675 BHD) (D15). `bhd()` then throws on the negative number (E7), and the page crashes to "Unexpected Application Error!". After: the gap is 0.000 BHD, the badge says "Reconciled — no gap", and two new lines explain the captures and refunds that a later batch settled (G11).

### 9. Settlement batch list (D17, R5, V1/C8)

| Before | After |
|---|---|
| ![](ui/dash-settlement-list-before.png) | ![](ui/dash-settlement-list-after.png) |

After: a new **Refunds** column (refunds minus the fee reversed). The fee is also different: 164.853 BHD at the 225 bps rate in force, not 183.174 BHD at the old 250 bps (V1, C8).

### 10. Settlement batch detail (R5, V1)

| Before | After |
|---|---|
| ![](ui/dash-settlement-batch-before.png) | ![](ui/dash-settlement-batch-after.png) |

After: new "Refunds" and "Fee reversed on refunds" rows, so the net payout can be checked as gross - fee - refunds + fee reversed. The fee and net payout use the correct rate.

### 11. Closed batch: misleading progress bar (UX5)

| Before | After |
|---|---|
| ![](ui/dash-closed-batch-before.png) | ![](ui/dash-closed-batch-after.png) |

Before: a closed batch showed a blue "progress" bar. Its width was `gross / 10000` %, so it was full at 1,000 BD and almost empty for a small batch. It had no meaning. A closed batch is finished, so the bar is removed.

### 12. New payment link: amount in BD (UX4)

| Before | After |
|---|---|
| ![](ui/dash-payment-link-new-before.png) | ![](ui/dash-payment-link-new-after.png) |

Before: "Amount in fils". To charge 12.750 BD, the merchant had to type `12750`, so a 10x mistake was easy and hard to see. After: "Amount (BD)" with placeholder `12.750`. The input is parsed with `parseBhdToFils` (exact, max 3 decimals, no float). Bad input shows "Enter an amount in BD, for example 12.750". The API still gets integer `amountFils`.

### 13. Dashboard on a phone (UX6)

| Before | After |
|---|---|
| ![](ui/dash-transaction-mobile-before.png) | ![](ui/dash-transaction-mobile-after.png) |

Before: the 16rem label column pushes the values to the right edge, and the long IDs and the timeline table overflow the page. After: below 40rem, labels sit above values, long values wrap, and wide tables scroll inside themselves. The "after" image also shows the refund (status, refunded amount, negative timeline row).

## Admin console

### 14. Merchant profile: fee rate shown (C8)

| Before | After |
|---|---|
| ![](ui/admin-merchant-profile-before.png) | ![](ui/admin-merchant-profile-after.png) |

Before: "Current negotiated rate 2.45% (245 bps), effective 01/03/2026". This was the newest row by entry time (a March back-correction). Billing charged 225 bps. After: "2.25% (225 bps), effective 01/08/2026", the rate billing uses. The "after" image is taken after the refunds switch was turned on (see 15).

### 15. Refunds switch (R8, R4)

| Before | After |
|---|---|
| ![](ui/admin-refunds-switch-before.png) | ![](ui/admin-refunds-switch-after.png) |

Before: no Refunds row and no control. Turning refunds on was only possible with raw SQL. After: a "Refunds on/off" row with a "Turn refunds on/off" button (finance and super_admin only, audited). The image shows the notice after it was clicked.

### 16. Balance adjust and credit forms (UX7, UX8)

| Before | After |
|---|---|
| ![](ui/admin-adjust-credit-forms-before.png) | ![](ui/admin-adjust-credit-forms-after.png) |

Before: on the same page, "Adjust balance" took raw fils (`50000`) and "Issue credit" took BD (`50.000`). After: both take BD with 3 decimals, and the adjust form still accepts negative values (`-12.500`). The "reverse the MDR" checkbox now sits on the same line as its text, not alone in the middle above it.

### 17. Settlement ops page (U11, U5)

| Before | After |
|---|---|
| ![](ui/admin-settlement-page-before.png) | ![](ui/admin-settlement-page-after.png) |

The default business date is now yesterday in Asia/Bahrain, and the date picker has `max` = yesterday (U11). Between 00:00 and 03:00 Bahrain time, the old default was two days ago. The screenshots were taken in the daytime, so both show the same date. The "Rebuild analytics" text now says what the U5 fix does: it clears the tables and the reporting worker refills them. The old text said it recomputed them at once.

### 18. Run batch for today (U12, G2)

| Before | After |
|---|---|
| ![](ui/admin-run-batch-today-before.png) | ![](ui/admin-run-batch-today-after.png) |

Before: the API accepted today's date and sent it to the settlement service. Here that service was not running, so the result is a 502. With the service running, it would close the day early, and later captures that day would never be paid out. After: `400 invalid_request`, "date must be before today (Asia/Bahrain)", before any audit row or settlement call.

### 19. Merchant sign-in without the merchant ID (UX9)

| Default form | Email in two shops |
|---|---|
| ![](ui/dash-login-after.png) | ![](ui/dash-login-two-shops-after.png) |

Before: the login form asked for a 36-character merchant ID (UUID), the email and the password. Users cannot remember a UUID. After: the form shows only email and password. `POST /v1/auth/login` now accepts a request without `merchantId`. The API finds the user by email and checks the password against each active shop that has this email:

- No match: `401 invalid_credentials`, the same as a wrong password today. When no user exists, the API still checks one dummy hash, so the time is similar.
- One match: the normal password + OTP login for that user.
- More than one match (only possible with the correct password): `409 merchant_id_required`, with `shops: [{ merchantId, displayName }]` for the shops whose user matched the password. The page then shows the Merchant ID field with a plain message. The seed user `owner@alpharetail.example` is in Alpha Retail and Beta Digital, so it shows this case (right image).

A request with the `merchantId` key works exactly as before (an empty or `null` value is `400 invalid_request`) (`scripts/smoke_hosted.sh` and `scripts/demo_refund.sh` are unchanged and still pass their login steps). The "Sign in to a specific shop" link shows the field at any time. If the last good sign-in used a merchant ID, the page remembers it and shows the field filled in. Tests: `apps/api/src/routes/auth.optionalMerchantId.test.ts`.

### 20. Plain-English error messages (UX10)

| Code asked again too soon | Refund more than is left |
|---|---|
| ![](ui/errors-login-resend.png) | ![](ui/errors-refund.png) |

| Card declined at checkout | API stopped |
|---|---|
| ![](ui/errors-checkout-declined.png) | ![](ui/errors-api-down.png) |

| Admin: role no longer allows the action (403) | Admin: bad row in a CSV import |
|---|---|
| ![](ui/errors-admin-forbidden.png) | ![](ui/errors-admin-csv.png) |

Before: error boxes showed the API's own text, or the raw code when there was none. The OTP screen said `resend_too_soon`; a 403 said `Not permitted (forbidden)`; a refund over the limit showed nothing useful, because that answer is `{ ok: false, code }` and has no `error` field. When the API was down, the page showed `Failed to fetch` or `unknown_error`, and checkout said "Payment link not found".

After: every error goes through one map per app (`apps/web/src/errors.ts`, `apps/admin/src/errors.ts`). Each API code gets a short message that says what happened and what to do next. Some codes have other words on another screen (for example `invalid_request` on sign-in is "Enter your email and password."). Messages use data from the answer when it helps: the refund message says how much is left, and a card decline names the bank's reason. The server's own `message` is never shown, with one exception: on the admin CSV import screen the row detail ("could not parse amount "abc"") is added after the plain message. A code the map does not know falls back to a plain message picked by HTTP status. No answer at all is "Can't reach FilsPay. Check your connection and try again."; a 5xx with no JSON body (proxy, API down) is "FilsPay is not answering right now.". Checkout now tells "link not found" (4xx) apart from "can't reach FilsPay" (no answer or 5xx).

Copy fixes in the same pass: status chips and filters show plain words (`partially_captured` is "partly captured"); the transaction timeline shows events and actors in words, not codes; "Acquirer reference" is "Bank reference"; the reconciliation and batch pages say "our records" and "card network amount" in place of "ledger merchant payable" and "scheme amount"; the checkout test-card note no longer says "PAN" or "acquirer". Admin status chips show `under review`, not `under_review`. API paths, bodies, response shapes and status codes are unchanged.

Checked in the browser (Playwright, local stack): wrong password, resend too soon, wrong code, refund more than left, declined card, link paid while the page was open, unknown link, network failure at checkout, support user on a finance-only page, finance admin downgraded to support mid-session, bad CSV row, and the API stopped. Tests: `apps/web/src/errors.test.ts`, `apps/admin/test/errors.test.ts`.

## New UX fixes made with this evidence

These are small fixes, in the style of the code. API paths and response shapes did not change (UX9 only adds an optional field and one new 409 error).

| Id | Fix | Files |
|---|---|---|
| UX1 | Checkout fits a 375 px phone: inputs use `width: 100%; min-width: 0`, and the expiry/CVV row is three equal columns | `apps/web/src/pages/checkout/CheckoutPage.css` |
| UX2 | Checkout success shows a receipt: merchant, amount (3 decimals), reference, local paid time, transaction id | `apps/web/src/pages/checkout/CheckoutPage.tsx`, `.css` |
| UX3 | Every error message (`dash-error`, `admin-error`, checkout decline) has `role="alert"`, so screen readers announce it | `apps/web/src/**`, `apps/admin/src/**` (only the attribute was added) |
| UX4 | New payment link amount is typed in BD and parsed with `parseBhdToFils` | `apps/web/src/pages/payment-links/PaymentLinkCreatePage.tsx` |
| UX5 | Removed the meaningless `gross/10000` progress bar on a closed batch | `apps/web/src/pages/settlement/SettlementBatchDetailPage.tsx` |
| UX6 | Dashboard at phone width: stacked label/value list, wrapping values, tables that scroll inside themselves | `apps/web/src/dashboard.css` |
| UX7 | Admin "Adjust balance" is typed in BD (negative allowed), like "Issue credit" | `apps/admin/src/pages/merchants/MerchantDetailPage.tsx` |
| UX8 | Admin checkbox sits on the same line as its text; "Rebuild analytics" text matches the U5 behaviour | `apps/admin/src/admin.css`, `MerchantDetailPage.tsx`, `SettlementPage.tsx` |
| UX9 | Merchant login needs only email + password; the Merchant ID field appears on `409 merchant_id_required` or on request | `apps/api/src/routes/auth.ts`, `apps/web/src/pages/dashboard-login/LoginPage.tsx`, `apps/web/src/api/dashboardAuth.ts`, `apps/web/src/dashboard.css` |
| UX10 | One error-message map per app: every API code, a network failure and an unknown code become a short plain-English message; raw enum values in the UI become words | `apps/web/src/errors.ts`, `apps/admin/src/errors.ts`, both `api/client.ts`, every page that shows an error |

Checks: `npm run typecheck` and `npm run build` pass for `apps/web` and `apps/admin`. `npm test` passes for web (13/13) and admin (1/1). In the browser on the after stack: `12.3456` is rejected with the BD message, `12.5` makes a 12.500 BHD link, and an admin adjust of `1.250` and then `-1.250` changes the balance by exactly ±1.250 BHD.

## Known UX gaps not fixed here

- Large amounts have no thousands separator (`7326.913 BHD`). `formatBhd` in `packages/money` is shared by every screen, so changing it is a wider change.
- The admin credit form says "Also reverse the MDR on this amount (2.50%)". The server really uses `merchants.mdr_bps` (250 bps) for this, not the 225 bps rate billing uses. That is a backend question, not a label bug.
- The dashboard Overview needs the `apps/reporting` worker. It was not run for these screenshots, so Overview is not shown.

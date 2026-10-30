# Checkout theme: before and after

The public checkout (`/pay/:token`) now uses the team theme from `apps/web/src/theme.css`:
cream paper, a charcoal header bar with a red rule, Anton headlines, Courier Prime labels,
JetBrains Mono for amounts and references, and cards with a 2px frame and an offset shadow.
Requests, paths, bodies and behaviour did not change.

What changed for the customer:

- The merchant name and the amount due are the first things on the page. The amount uses the
  shared `formatBhd` helper (3 decimals, for example `18.750 BHD`).
- On a desktop, the summary and the card form sit side by side. On a 375 px phone they stack,
  with no horizontal scroll.
- Every input has a visible label and `autocomplete` hints. Touch targets are 50 px or taller. Focus
  rings are 3px red (ink on the red Pay button).
- A decline shows a red alert box (`role="alert"`) above the form. The form stays filled, so the
  customer can try again.
- While the payment runs, the button turns dark with a spinner, and a status line asks the customer
  not to close the page.
- Result pages (paid, already paid, expired, unavailable, processing, not found) use one card with a
  rubber stamp, a plain headline and the link details.
- All times show in Bahrain time, en-GB style (`30 Oct 2026, 14:08`).
- If the page fails to render, the customer sees a themed error card, not the raw router error page.
- Loading shows a skeleton card. Animations respect `prefers-reduced-motion`.

| State | Width | Before | After |
|---|---|---|---|
| Card form | 375 px | ![](ui/theme-checkout-form-mobile-before.png) | ![](ui/theme-checkout-form-mobile-after.png) |
| Card form | 1280 px | ![](ui/theme-checkout-form-desktop-before.png) | ![](ui/theme-checkout-form-desktop-after.png) |
| Loading | 375 px | ![](ui/theme-checkout-loading-mobile-before.png) | ![](ui/theme-checkout-loading-mobile-after.png) |
| Loading | 1280 px | ![](ui/theme-checkout-loading-desktop-before.png) | ![](ui/theme-checkout-loading-desktop-after.png) |
| Processing | 375 px | ![](ui/theme-checkout-processing-mobile-before.png) | ![](ui/theme-checkout-processing-mobile-after.png) |
| Processing | 1280 px | ![](ui/theme-checkout-processing-desktop-before.png) | ![](ui/theme-checkout-processing-desktop-after.png) |
| Success receipt | 375 px | ![](ui/theme-checkout-success-mobile-before.png) | ![](ui/theme-checkout-success-mobile-after.png) |
| Success receipt | 1280 px | ![](ui/theme-checkout-success-desktop-before.png) | ![](ui/theme-checkout-success-desktop-after.png) |
| Declined | 375 px | ![](ui/theme-checkout-declined-mobile-before.png) | ![](ui/theme-checkout-declined-mobile-after.png) |
| Declined | 1280 px | ![](ui/theme-checkout-declined-desktop-before.png) | ![](ui/theme-checkout-declined-desktop-after.png) |
| Already paid | 375 px | ![](ui/theme-checkout-paid-mobile-before.png) | ![](ui/theme-checkout-paid-mobile-after.png) |
| Already paid | 1280 px | ![](ui/theme-checkout-paid-desktop-before.png) | ![](ui/theme-checkout-paid-desktop-after.png) |
| Expired link | 375 px | ![](ui/theme-checkout-expired-mobile-before.png) | ![](ui/theme-checkout-expired-mobile-after.png) |
| Expired link | 1280 px | ![](ui/theme-checkout-expired-desktop-before.png) | ![](ui/theme-checkout-expired-desktop-after.png) |
| Unknown link | 375 px | ![](ui/theme-checkout-notfound-mobile-before.png) | ![](ui/theme-checkout-notfound-mobile-after.png) |
| Unknown link | 1280 px | ![](ui/theme-checkout-notfound-desktop-before.png) | ![](ui/theme-checkout-notfound-desktop-after.png) |

How the images were made: a fresh seeded database, the real API and the web app, driven by
Playwright. Payment links were created through the merchant API. "Processing" and "Loading" were
captured by delaying the real request in the browser. "Expired" is a real link whose expiry time was
moved into the past. "Declined" uses the test card ending `0002`.

Checks: `npm run typecheck -w apps/web`, `npm run build -w apps/web` and `npm test -w apps/web`
(17/17) pass.

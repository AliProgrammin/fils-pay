# Merchant dashboard: theme before and after

The merchant dashboard (`apps/web`, `/dashboard/*`) now uses the FilsPay case-file theme from `apps/web/src/theme.css`: cream paper, Anton headlines, Courier labels, JetBrains Mono amounts, a charcoal top bar with a red rule, and cards with a 2 px border and a small offset shadow.

All screenshots come from the running app (seeded data, finance user of Alpha Retail Co). Width is 1280 px unless the name ends in `-375`.

| Screen | Before | After | What changed |
|---|---|---|---|
| Login | [before](ui/theme-dash-login-before.png) | [after](ui/theme-dash-login-after.png) | Charcoal bar, headline and a sign-in card |
| Login, email in two shops | [before](ui/theme-dash-login-shops-before.png) | [after](ui/theme-dash-login-shops-after.png) | The `409 merchant_id_required` answer lists the shops as buttons. You click a shop name, not type a UUID |
| Login, code step | none | [after](ui/theme-dash-login-otp-after.png) | Expiry time shown in Bahrain time |
| Transactions | [before](ui/theme-dash-transactions-before.png) | [after](ui/theme-dash-transactions-after.png) | Status chips, status filter pills, right-aligned 3-decimal amounts, zebra rows, sticky header row |
| Transaction and refund drawer | [before](ui/theme-dash-refund-before.png) | [after](ui/theme-dash-refund-after.png) | Main figures at the top. The refund panel shows the amount left to refund |
| Refund confirmation | browser `confirm()` | [after](ui/theme-dash-refund-confirm-after.png) | Themed modal dialog with the amount in large text. Escape cancels and no request is sent |
| Payment links | [before](ui/theme-dash-payment-links-before.png) | [after](ui/theme-dash-payment-links-after.png) | Primary "New payment link" button, chips, amounts |
| Settlement batches | [before](ui/theme-dash-settlement-before.png) | [after](ui/theme-dash-settlement-after.png) | Batch dates as "31 Aug 2026", open/closed/paid chips |
| Settlement batch | [before](ui/theme-dash-batch-before.png) | [after](ui/theme-dash-batch-after.png) | Net payout shown first; net payout row marked as the total |
| Reconciliation | [before](ui/theme-dash-reconciliation-before.png) | [after](ui/theme-dash-reconciliation-after.png) | "Reconciled" stamp, amounts right-aligned in a ledger list, gap row marked |
| Overview | [before](ui/theme-dash-overview-before.png) | [after](ui/theme-dash-overview-after.png) | Themed empty states and staleness badges |
| Webhooks | [before](ui/theme-dash-webhooks-before.png) | [after](ui/theme-dash-webhooks-after.png) | Themed empty state |
| Unknown URL | [before](ui/theme-dash-not-found-before.png) | [after](ui/theme-dash-not-found-after.png) | Themed 404 page with links to the dashboard and to sign-in, not the raw router error. `/` now goes to the dashboard (or to login) |
| Unknown `/pay/...` URL | raw router error | [after](ui/theme-dash-not-found-pay-after.png) | Text for customers, with no links into the merchant dashboard |

At 375 px: [login](ui/theme-dash-login-375-after.png), [transactions](ui/theme-dash-transactions-375-after.png), [refund](ui/theme-dash-refund-375-after.png), [refund confirmation](ui/theme-dash-refund-confirm-375-after.png), [payment links](ui/theme-dash-payment-links-375-after.png), [settlement](ui/theme-dash-settlement-375-after.png), [reconciliation](ui/theme-dash-reconciliation-375-after.png), [overview](ui/theme-dash-overview-375-after.png), [404](ui/theme-dash-not-found-375-after.png). The `-375-before.png` files show the old look at the same width. At 375 px the page does not scroll sideways. A wide table scrolls inside its own frame, and the nav bar scrolls sideways.

## Behaviour notes

- All dates and times use one formatter (`apps/web/src/format.ts`) and show in Asia/Bahrain, for example "30 Aug 2026, 07:05". Business dates show as "30 Aug 2026".
- Four `window.confirm` calls are now one dialog component (`ConfirmDialog.tsx`): refund, void, cancel payment link and delete webhook. The text and the behaviour stay the same: Cancel or Escape sends no request.
- The request paths and request bodies did not change.

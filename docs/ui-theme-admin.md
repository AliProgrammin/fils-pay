# Admin console: theme before and after

The admin console now uses the team's case-file theme: cream paper, a charcoal top bar with a red rule, Anton page titles, Courier labels, cards with 2px borders and an offset shadow.

- **Before** = the console after our bug fixes but before the re-theme (system font, plain white tables).
- **After** = the themed console.
- Both sides used the same database, the same seed and the same Playwright steps. The browser used the en-GB locale and the Asia/Bahrain time zone. Width is 1280 px, except the two 768 px images.

| Screen | Before | After | What changed |
|---|---|---|---|
| Login | ![](ui/theme-admin-login-before.png) | ![](ui/theme-admin-login-after.png) | "Restricted, staff only" bar, a card with a 2-step indicator (password, one-time code), a strong primary button. |
| Merchants list | ![](ui/theme-admin-merchants-before.png) | ![](ui/theme-admin-merchants-after.png) | Section nav in the dark bar, with the active page marked in red. Status chips (green, amber, red). The MDR is right-aligned in monospace. The status filters are toggle pills. |
| Merchant detail | ![](ui/theme-admin-merchant-detail-before.png) | ![](ui/theme-admin-merchant-detail-after.png) | Status chips under the name. Profile and balance cards. The fee rate and the refunds switch are in their own red-marked card ("Changes live payments"). |
| Credit and adjust forms | ![](ui/theme-admin-merchant-forms-before.png) | ![](ui/theme-admin-merchant-forms-after.png) | Side-by-side cards with a red band and a "Moves money" stamp. The submit buttons are red. |
| Credits | ![](ui/theme-admin-credits-before.png) | ![](ui/theme-admin-credits-after.png) | Tabs, and 3-decimal BD amounts right-aligned in monospace. Merchant ids and actions no longer wrap. |
| Reject a credit | ![](ui/theme-admin-credits-reject-before.png) | ![](ui/theme-admin-credits-reject-after.png) | The inline box is now a modal confirmation dialog (`role="alertdialog"`). It shows the merchant, who raised the request and the posted total in BD. Escape or Cancel sends no request. |
| Settlement ops | ![](ui/theme-admin-settlement-before.png) | ![](ui/theme-admin-settlement-after.png) | Each operation is a red-marked card that says what it touches ("Pays out money", "Every merchant", "Posts ledger adjustments"). The rebuild confirmation is a modal dialog. |
| Webhook replay | ![](ui/theme-admin-webhooks-before.png) | ![](ui/theme-admin-webhooks-after.png) | One card. The time window is in Bahrain time, and the delivery statuses are toggle pills. |
| Unknown address | ![](ui/theme-admin-not-found-before.png) | ![](ui/theme-admin-not-found-after.png) | Before, React Router showed its raw "Unexpected Application Error". After, a themed 404 page appears inside the console, and a themed error page catches route errors. Neither shows a stack trace. |
| Merchants, 768 px | ![](ui/theme-admin-merchants-768-before.png) | ![](ui/theme-admin-merchants-768-after.png) | The nav moves to its own row. Wide tables scroll inside their card, and the page does not scroll sideways. |
| Merchant detail, 768 px | ![](ui/theme-admin-merchant-detail-768-before.png) | ![](ui/theme-admin-merchant-detail-768-after.png) | The two-column cards stack into one column. |

## Behaviour notes

- No API request paths or bodies changed. The labels on the action buttons did not change.
- All dates and times use one shared formatter (`apps/admin/src/format.ts`): Asia/Bahrain time, en-GB style, for example "30 Aug 2026, 07:05". Business dates such as batch dates are shown as written, for example "31 Aug 2026".
- The webhook replay window is now typed in Bahrain time. Before, it used the browser's local time.
- The confirmation dialog moves focus to Cancel when it opens. Tab stays inside the dialog. Escape cancels. When the dialog closes, focus goes back to the button that opened it.
- Errors use `role="alert"`, results use `role="status"`, and loading states use `role="status"`.

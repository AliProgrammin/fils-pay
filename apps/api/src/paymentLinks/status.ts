/**
 * Derived public status for a payment link — computed identically by
 * GET /v1/payment-links/:token (read.ts) and by the pay endpoint's
 * claim-failure classification (pay.ts), from one shared helper, so the
 * two endpoints can never disagree about what state a link is "really" in.
 *
 * Deliberately narrower than the stored `payment_links.status` enum: a
 * customer-facing checkout page never needs to distinguish a live 'active'
 * link from one whose reservation has already self-expired back to
 * claimable — both are simply 'active' from the outside. A merchant-facing
 * list (query.ts) uses the raw stored status instead, since a dashboard
 * operator does benefit from seeing "a payment is currently in flight" as
 * its own filterable state.
 */
export type PublicPaymentLinkStatus = "active" | "processing" | "paid" | "expired" | "canceled";

/** reservedAt null on a 'reserved' row is treated as epoch, i.e. immediately claimable again. */
export interface PaymentLinkStatusInput {
  status: string;
  expiresAt: Date;
  reservedAt: Date | null;
  /** A bound, non-voided authorization (pending_transaction_id): the link
   *  stays "processing" past the timeout, matching pay.ts's claim rule. */
  paymentInFlight?: boolean;
}

// Server time, same as pay.ts (FP-187: pay no longer trusts a client time).
export function derivePublicStatus(
  row: PaymentLinkStatusInput,
  reservationTimeoutSeconds: number,
): PublicPaymentLinkStatus {
  if (row.status === "paid") return "paid";
  if (row.status === "canceled") return "canceled";

  if (row.status === "reserved") {
    if (row.paymentInFlight) return "processing";
    const reservedAtMs = row.reservedAt?.getTime() ?? 0;
    const stillReserved = reservedAtMs > Date.now() - reservationTimeoutSeconds * 1000;
    if (stillReserved) return "processing";
    // A timed-out reservation is claimable again, so it is 'active' or 'expired'.
  }

  return row.expiresAt.getTime() <= Date.now() ? "expired" : "active";
}

import type { Pool } from "pg";
import { toFils } from "@filspay/money";
import { authorizeTransaction } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import { voidTransaction } from "../payments/void.js";
import type { AcquirerSimulator, SimulatedCardInput } from "../acquirer/types.js";

export interface PayPaymentLinkInput {
  token: string;
  card: SimulatedCardInput;
  idempotencyKey: string;
}

export interface PayPaymentLinkResult {
  statusCode: number;
  body: unknown;
}

/** Returned by the claim UPDATE; merchant_id comes from the link row, never from the request. */
interface ClaimedLinkRow {
  id: string;
  merchant_id: string;
  amount_fils: string | number;
  reference: string | null;
  /** reserved_at as exact text: identifies THIS claim (a re-claim changes it). */
  reservation: string;
}

interface LinkStatusRow {
  status: string;
  expires_at: Date;
}

/**
 * `POST /v1/payment-links/:token/pay` business logic (public,
 * unauthenticated). Calls `authorizeTransaction`
 * then `captureTransaction` directly, in sequence, never issuing an HTTP
 * request back into the API's own /v1/transactions routes.
 *
 * Concurrency: reserve the link with a single
 * atomic conditional UPDATE, release the row lock immediately, run
 * authorize+capture with no lock held on payment_links at all, then
 * finalize with a second atomic conditional UPDATE keyed on still being in
 * the 'reserved' state. A short, configurable reservation timeout
 * self-heals a link stuck 'reserved' by a crash between claim and
 * the bind step. Once an authorization is bound (pending_transaction_id),
 * the timeout no longer applies: a slow capture must not be overtaken
 * (incident 2026-05-14). A link stuck after a crash past the bind is freed
 * by voiding that authorization.
 */
export async function payPaymentLink(
  pool: Pool,
  acquirer: AcquirerSimulator,
  config: { paymentLinkReservationTimeoutSeconds: number },
  input: PayPaymentLinkInput,
): Promise<PayPaymentLinkResult> {
  // FP-187: expiry is judged on the server's clock only. This route is public
  // and unauthenticated, so any client-sent time is attacker-controlled.
  const expiryCheckTime = new Date();

  // Step 1 — claim. A single UPDATE is already atomic; no explicit
  // transaction needed.
  // YA: one conditional UPDATE = atomic claim, no explicit txn needed. correct
  // Incident 2026-05-14: a timed-out reservation is only re-claimable while
  // no payment is in flight on it (pending_transaction_id unset, or that
  // authorization was voided). A capture that is merely slow can still
  // complete, so it must never be overtaken by a second payer.
  const claimResult = await pool.query<ClaimedLinkRow>(
    `UPDATE payment_links
        SET status = 'reserved', reserved_at = now(), pending_transaction_id = NULL
      WHERE token = $1
        AND (
             status = 'active'
             OR (status = 'reserved' AND reserved_at < now() - ($2 || ' seconds')::interval
                 AND (pending_transaction_id IS NULL
                      OR EXISTS (SELECT 1 FROM transactions t
                                  WHERE t.id = payment_links.pending_transaction_id AND t.status = 'voided')))
            )
        AND expires_at > $3
      RETURNING id, merchant_id, amount_fils, reference, reserved_at::text AS reservation`,
    [input.token, config.paymentLinkReservationTimeoutSeconds, expiryCheckTime],
  );

  const claimedRow = claimResult.rows[0];
  if (!claimedRow) {
    return classifyClaimFailure(pool, input.token, config.paymentLinkReservationTimeoutSeconds, expiryCheckTime);
  }

  const link = {
    id: claimedRow.id,
    merchantId: claimedRow.merchant_id,
    amountFils: toFils(Number(claimedRow.amount_fils)),
    reference: claimedRow.reference,
    reservation: claimedRow.reservation,
  };

  // Step 2 — authorize.
  // am: keys include link.id so two links can never collide on idempotency. good
  const authorizeKey = `paylink:${link.id}:${input.idempotencyKey}:authorize`;
  const authResult = await authorizeTransaction(pool, acquirer, {
    merchantId: link.merchantId,
    amountFils: link.amountFils,
    card: input.card,
    reference: link.reference ?? undefined,
    idempotencyKey: authorizeKey,
    // No merchant session/API key initiated this — a customer did, via
    // the public link.
    actor: { type: "system" },
  });

  if (authResult.statusCode !== 201) {
    await releaseReservation(pool, link.id, link.reservation);
    return {
      statusCode: authResult.statusCode,
      body: { stage: "authorize", ...(authResult.body as Record<string, unknown>) },
    };
  }

  const txnId = (authResult.body as { id: string }).id;

  // Step 2b — bind (incident 2026-05-14). Record this authorization on the
  // link, but only if we still hold the claim we made. From here on the
  // timeout cannot hand the link to another payer. If a slow authorize let
  // someone else re-claim it, void our authorization (not yet captured, so
  // no money moved) and tell this payer the link is taken.
  const bindResult = await pool.query(
    `UPDATE payment_links
        SET pending_transaction_id = $2
      WHERE id = $1 AND status = 'reserved' AND reserved_at = $3::timestamptz
        AND pending_transaction_id IS NULL`,
    [link.id, txnId, link.reservation],
  );
  if (bindResult.rowCount !== 1) {
    await voidTransaction(pool, {
      transactionId: txnId,
      merchantId: link.merchantId,
      actor: { type: "system", id: link.id },
    });
    return { statusCode: 409, body: { error: "payment_link_processing", stage: "reserve" } };
  }

  // NOTE: discountAdjustment is applied by the transactions route only, not here — FH
  // MK: it's applied for both now (moved into capture.ts in July)
  // Step 3 — capture (full amount, immediately). amountFils omitted =>
  // capture the full remaining amount — always correct here, since this
  // transaction was just authorized for exactly link.amountFils and
  // nothing else could have touched it yet.
  const captureKey = `paylink:${link.id}:${input.idempotencyKey}:capture`;
  const captureResult = await captureTransaction(pool, acquirer, {
    transactionId: txnId,
    merchantId: link.merchantId,
    idempotencyKey: captureKey,
    actor: { type: "system", id: link.id },
  });

  if (captureResult.statusCode !== 200) {
    await releaseReservation(pool, link.id, link.reservation);
    return {
      statusCode: captureResult.statusCode,
      body: { stage: "capture", ...(captureResult.body as Record<string, unknown>) },
    };
  }

  // Step 4 — finalize. Keyed on our own bound transaction, not just
  // 'reserved', so it can only ever finalize the payment that was bound.
  const finalizeResult = await pool.query<{
    id: string;
    paid_at: Date;
  }>(
    `UPDATE payment_links
        SET status = 'paid', paid_at = now(), transaction_id = $2, reserved_at = NULL,
            pending_transaction_id = NULL
      WHERE id = $1 AND status = 'reserved' AND pending_transaction_id = $2
      RETURNING id, paid_at`,
    [link.id, txnId],
  );

  const finalized = finalizeResult.rows[0];
  if (!finalized) {
    // Only reachable if the link was changed by hand mid-payment (the bind
    // above blocks re-claims). Never answer 200 "paid" for a link this
    // payment did not pay: surface it so support can reverse the capture.
    console.error(
      `payPaymentLink: finalize matched 0 rows for link ${link.id} after capture of transaction ${txnId}; needs manual reversal`,
    );
    return { statusCode: 409, body: { error: "payment_link_not_payable", stage: "finalize", transactionId: txnId } };
  }

  return {
    statusCode: 200,
    body: {
      status: "paid",
      transactionId: txnId,
      amountFils: link.amountFils,
      paidAt: finalized.paid_at.toISOString(),
    },
  };
}

/**
 * Used by both decline branches above. Guarded by this request's own claim
 * (`reserved_at`), so it never releases a reservation another payer holds.
 */
async function releaseReservation(pool: Pool, linkId: string, reservation: string): Promise<void> {
  await pool.query(
    `UPDATE payment_links SET status = 'active', reserved_at = NULL, pending_transaction_id = NULL
      WHERE id = $1 AND status = 'reserved' AND reserved_at = $2::timestamptz`,
    [linkId, reservation],
  );
}

/**
 * The claim UPDATE matched 0 rows. This second read carries no race risk —
 * nothing further is decided from it, it only explains a decision already
 * made by the failed UPDATE.
 */
// FH: "This second read carries no race risk" — Claude disagrees, says we should SELECT
// ... FOR UPDATE here. TODO
// am: its only for the error message. ignore
async function classifyClaimFailure(
  pool: Pool,
  token: string,
  reservationTimeoutSeconds: number,
  expiryCheckTime: Date,
): Promise<PayPaymentLinkResult> {
  const result = await pool.query<LinkStatusRow>(`SELECT status, expires_at FROM payment_links WHERE token = $1`, [
    token,
  ]);
  const row = result.rows[0];

  if (!row) {
    return { statusCode: 404, body: { error: "payment_link_not_found" } };
  }
  if (row.status === "paid") {
    return { statusCode: 409, body: { error: "payment_link_already_paid" } };
  }
  if (row.status === "canceled") {
    return { statusCode: 409, body: { error: "payment_link_canceled" } };
  }
  if (row.status === "active" && row.expires_at.getTime() <= expiryCheckTime.getTime()) {
    return { statusCode: 410, body: { error: "payment_link_expired" } };
  }
  if (row.status === "reserved") {
    // A concurrent claim attempt raced us and won between our own UPDATE's
    // failure and this SELECT. It's still within the timeout (if it
    // weren't, our claim UPDATE would have matched it) — reachable only in
    // a genuine race, not a stale read.
    return { statusCode: 409, body: { error: "payment_link_processing" } };
  }
  // Defensive fallback, should be unreachable given the claim UPDATE's
  // WHERE clause exactly mirrors these cases.
  return { statusCode: 409, body: { error: "payment_link_not_payable", status: row.status } };
}

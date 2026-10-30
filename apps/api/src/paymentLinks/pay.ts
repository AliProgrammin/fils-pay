import type { Pool } from "pg";
import { toFils, type Fils } from "@filspay/money";
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
 * (incident 2026-05-14). A payment cut off past the bind (crash, restart)
 * completes when the same payer retries with the same Idempotency-Key
 * (resumeBoundPayment); if nobody retries, the recovery sweep
 * (recovery.ts, L5) marks it paid if the capture ran, or voids the
 * authorization and frees the link after a grace period.
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
    const resumed = await resumeBoundPayment(pool, acquirer, input);
    if (resumed) return resumed;
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

  return captureAndFinalize(pool, acquirer, link, txnId, input.idempotencyKey, false);
}

interface BoundLink {
  id: string;
  merchantId: string;
  amountFils: Fils;
  reservation: string;
}

/**
 * Steps 3 and 4: capture the bound authorization and mark the link paid.
 * Shared by a first attempt and by a same-key retry that resumes one
 * (resumeBoundPayment). Both steps are idempotent: the capture key is
 * derived from the link and the payer's Idempotency-Key.
 */
async function captureAndFinalize(
  pool: Pool,
  acquirer: AcquirerSimulator,
  link: BoundLink,
  txnId: string,
  idempotencyKey: string,
  resuming: boolean,
): Promise<PayPaymentLinkResult> {
  // H4: captureTransaction posts the negotiated discount legs itself, so a
  // link capture is discounted exactly like a route capture.
  // Step 3 — capture (full amount, immediately). amountFils omitted =>
  // capture the full remaining amount — always correct here, since this
  // transaction was just authorized for exactly link.amountFils and
  // nothing else could have touched it yet.
  const captureKey = `paylink:${link.id}:${idempotencyKey}:capture`;
  const captureResult = await captureTransaction(pool, acquirer, {
    transactionId: txnId,
    merchantId: link.merchantId,
    idempotencyKey: captureKey,
    actor: { type: "system", id: link.id },
  });

  if (captureResult.statusCode !== 200) {
    // A resumed payment frees the link only on a final decline. After a
    // retryable failure (502) it stays bound, so the same payer can retry
    // again, and an original request that may still be running is never
    // overtaken.
    // W7: a capture decline is final, so void the authorization (and free
    // its hold) before freeing the link; nothing is left 'authorized'.
    if (captureResult.statusCode === 402) {
      await voidTransaction(pool, {
        transactionId: txnId,
        merchantId: link.merchantId,
        actor: { type: "system", id: link.id },
      });
    }
    if (!resuming || captureResult.statusCode === 402) {
      await releaseReservation(pool, link.id, link.reservation);
    }
    return {
      statusCode: captureResult.statusCode,
      body: { stage: "capture", ...(captureResult.body as Record<string, unknown>) },
    };
  }

  // Step 4 — finalize. Keyed on our own bound transaction, not just
  // 'reserved', so it can only ever finalize the payment that was bound.
  let finalized = await finalizePaidLink(pool, link.id, txnId);
  if (!finalized) {
    // A concurrent same-key request (resumeBoundPayment) or the recovery
    // sweep finalized this very payment first: same answer, not an error.
    const paid = await pool.query<{ id: string; paid_at: Date }>(
      `SELECT id, paid_at FROM payment_links WHERE id = $1 AND status = 'paid' AND transaction_id = $2`,
      [link.id, txnId],
    );
    finalized = paid.rows[0];
  }
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
 * A retry with the SAME Idempotency-Key of a payment that stopped after its
 * authorization was bound to the link: the api crashed or restarted, or the
 * client gave up waiting. Only the payer who made that authorization can
 * resume it: the authorize idempotency key embeds their Idempotency-Key and
 * must point at the bound transaction. The payment then completes (the
 * capture replays if it already ran) instead of leaving the link reserved
 * with a live authorization. Returns null when this is not such a retry.
 */
async function resumeBoundPayment(
  pool: Pool,
  acquirer: AcquirerSimulator,
  input: PayPaymentLinkInput,
): Promise<PayPaymentLinkResult | null> {
  const result = await pool.query<{
    id: string;
    merchant_id: string;
    amount_fils: string | number;
    reservation: string;
    pending_transaction_id: string;
  }>(
    `SELECT pl.id, pl.merchant_id, pl.amount_fils, pl.reserved_at::text AS reservation, pl.pending_transaction_id
       FROM payment_links pl
       JOIN idempotency_keys k
         ON k.merchant_id = pl.merchant_id
        AND k.endpoint = 'transactions.authorize'
        AND k.key = 'paylink:' || pl.id || ':' || $2 || ':authorize'
        AND k.resource_id = pl.pending_transaction_id
      WHERE pl.token = $1 AND pl.status = 'reserved'`,
    [input.token, input.idempotencyKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  return captureAndFinalize(
    pool,
    acquirer,
    { id: row.id, merchantId: row.merchant_id, amountFils: toFils(Number(row.amount_fils)), reservation: row.reservation },
    row.pending_transaction_id,
    input.idempotencyKey,
    true,
  );
}

/**
 * Step 4: mark the link paid by its own bound, captured transaction. Keyed
 * on pending_transaction_id, so it only ever finalizes the payment that was
 * bound, and a second call (live request or recovery sweep) matches 0 rows.
 */
export async function finalizePaidLink(
  pool: Pool,
  linkId: string,
  txnId: string,
): Promise<{ id: string; paid_at: Date } | undefined> {
  const result = await pool.query<{ id: string; paid_at: Date }>(
    `UPDATE payment_links
        SET status = 'paid', paid_at = now(), transaction_id = $2, reserved_at = NULL,
            pending_transaction_id = NULL
      WHERE id = $1 AND status = 'reserved' AND pending_transaction_id = $2
      RETURNING id, paid_at`,
    [linkId, txnId],
  );
  return result.rows[0];
}

/**
 * Used by both decline branches above and by the recovery sweep. Guarded by this request's own claim
 * (`reserved_at`), so it never releases a reservation another payer holds.
 */
export async function releaseReservation(pool: Pool, linkId: string, reservation: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE payment_links SET status = 'active', reserved_at = NULL, pending_transaction_id = NULL
      WHERE id = $1 AND status = 'reserved' AND reserved_at = $2::timestamptz`,
    [linkId, reservation],
  );
  return result.rowCount === 1;
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

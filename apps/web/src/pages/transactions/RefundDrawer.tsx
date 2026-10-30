import { useRef, useState } from "react";
import { formatBhd, toFils } from "@filspay/money";
import { refundTransaction } from "../../api/transactions.js";
import { ApiError } from "../../api/client.js";
import { errorMessage } from "../../errors.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd } from "../../format.js";
import { useConfirmDialog } from "../../components/ConfirmDialog.js";
import type { TransactionDto } from "../../types.js";
import { RefundKeyKeeper, parseRefundAmount, refundableFils } from "./refundForm.js";

interface RefundDrawerProps {
  txn: TransactionDto;
  onRefunded: () => Promise<void>;
}

/**
 * Refund a captured payment, in full or in part. Posts to
 * `POST /v1/merchants/:merchantId/refunds`. The amount is typed in BD and
 * parsed to exact fils; the server re-checks everything (role, limit,
 * refunds_enabled), so this form is a convenience, not the boundary.
 */
export function RefundDrawer({ txn, onRefunded }: RefundDrawerProps) {
  const { me } = useDashboardAuth();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useRef(new RefundKeyKeeper());
  const [confirmDialog, confirm] = useConfirmDialog();

  const merchantId = me?.merchant.id;
  const maxFils = refundableFils(txn);
  if (maxFils === 0) return null;

  async function handleRefund(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId) return;
    const parsed = parseRefundAmount(amount, maxFils);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    const trimmedReason = reason.trim();
    if (trimmedReason === "") {
      setError("Enter a reason for the refund");
      return;
    }
    const confirmed = await confirm({
      title: "Refund this payment?",
      amount: bhd(parsed.amountFils),
      message: "The money goes back to the cardholder and cannot be recalled.",
      confirmLabel: "Refund",
    });
    if (!confirmed) return;

    setSubmitting(true);
    setError(null);
    try {
      // Same key for a retry of this same refund (same amount and reason),
      // so a timeout followed by a second click can never refund twice.
      const idempotencyKey = keys.current.keyFor(txn.id, parsed.amountFils, trimmedReason);
      await refundTransaction(
        merchantId,
        { transactionId: txn.id, amountFils: parsed.amountFils, reason: trimmedReason },
        idempotencyKey,
      );
      keys.current.reset();
      setOpen(false);
      setAmount("");
      setReason("");
      // Refetch: the refund wrote a new timeline event and changed the totals.
      await onRefunded();
    } catch (err) {
      setError(errorMessage(err, "refund"));
      // Someone else refunded part of it meanwhile: reload, so "Left to
      // refund" matches what the message says.
      if (err instanceof ApiError && err.code === "refund_exceeds_refundable") await onRefunded();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <RequireRole allow={["owner", "finance"]}>
      {confirmDialog}
      {open ? (
        <section className="dash-panel" aria-labelledby="dash-refund-title">
          <div className="dash-panel-head">
            <h2 className="dash-panel-title" id="dash-refund-title">
              Refund this payment
            </h2>
            <span className="dash-panel-meta">
              Left to refund <strong>{bhd(maxFils)}</strong>
            </span>
          </div>
          <div className="dash-panel-body">
            {error ? <p className="dash-error" role="alert">{error}</p> : null}
            <form className="dash-form dash-form-inline" onSubmit={(e) => void handleRefund(e)}>
              <label>
                Amount (BD)
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder={formatBhd(toFils(maxFils))}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </label>
              <label className="dash-grow">
                Reason
                <input type="text" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <button type="submit" className="dash-button dash-button-primary" disabled={submitting}>
                {submitting ? "Refunding..." : "Refund"}
              </button>
              <button type="button" className="dash-button" disabled={submitting} onClick={() => setOpen(false)}>
                Cancel
              </button>
            </form>
            <p className="dash-muted dash-panel-note">
              Type the amount in BD, up to {bhd(maxFils)}. The money goes back to the cardholder
              and cannot be recalled.
            </p>
          </div>
        </section>
      ) : (
        <div className="dash-actions">
          {error ? <p className="dash-error" role="alert">{error}</p> : null}
          <button type="button" className="dash-button dash-button-danger" onClick={() => setOpen(true)}>
            Refund
          </button>
        </div>
      )}
    </RequireRole>
  );
}

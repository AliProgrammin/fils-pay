import { useRef, useState } from "react";
import { formatBhd, toFils } from "@filspay/money";
import { refundTransaction } from "../../api/transactions.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd } from "../../format.js";
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
    if (
      !window.confirm(
        `Refund ${bhd(parsed.amountFils)}? The money goes back to the cardholder and cannot be recalled.`,
      )
    ) {
      return;
    }

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
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <RequireRole allow={["owner", "finance"]}>
      <div className="dash-actions">
        {error ? <p className="dash-error" role="alert">{error}</p> : null}
        {open ? (
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
            <label>
              Reason
              <input type="text" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <p className="dash-muted">Left to refund: {bhd(maxFils)}</p>
            <button type="submit" className="dash-button" disabled={submitting}>
              {submitting ? "Refunding..." : "Refund"}
            </button>
            <button type="button" className="dash-button" disabled={submitting} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className="dash-button" onClick={() => setOpen(true)}>
            Refund
          </button>
        )}
      </div>
    </RequireRole>
  );
}

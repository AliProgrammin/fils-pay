import { useEffect, useId, useRef, useState } from "react";
import { formatBhd, toFils } from "@filspay/money";
import { refundTransaction } from "../../api/transactions.js";
import { ApiError } from "../../api/client.js";
import { errorMessage, REFUNDS_PAUSED_MESSAGE } from "../../errors.js";
import { useToast } from "../../components/Toast.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd } from "../../format.js";
import { useConfirmDialog } from "../../components/ConfirmDialog.js";
import type { TransactionDto } from "../../types.js";
import { RefundKeyKeeper, parseRefundAmount, refundableFils } from "./refundForm.js";
import { filterAmountInput, formatAmountText, lengthNote, REFUND_REASON_MAX } from "../../inputRules.js";
import { FieldNote, describedBy } from "../../components/FieldNote.js";

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
  const [amountError, setAmountError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const keys = useRef(new RefundKeyKeeper());
  const [confirmDialog, confirm] = useConfirmDialog();
  // The API said refunds are off for this account: say so, offer no button.
  const [paused, setPaused] = useState(false);
  const notify = useToast();
  const amountRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const amountNoteId = useId();
  const reasonNoteId = useId();
  const busy = useRef(false);

  // Opening the form puts the cursor in the amount box.
  useEffect(() => {
    if (open) amountRef.current?.focus();
  }, [open]);

  const merchantId = me?.merchant.id;
  const maxFils = refundableFils(txn);
  if (paused) {
    return (
      <RequireRole allow={["owner", "finance"]}>
        <p className="dash-callout" role="status">{REFUNDS_PAUSED_MESSAGE}</p>
      </RequireRole>
    );
  }
  if (maxFils === 0) {
    // Keep a failure visible even after the reload showed nothing is left.
    return error ? (
      <RequireRole allow={["owner", "finance"]}>
        <p className="dash-error" role="alert">{error}</p>
      </RequireRole>
    ) : null;
  }

  async function handleRefund(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId || busy.current) return;
    const parsed = parseRefundAmount(amount, maxFils);
    const trimmedReason = reason.trim();
    setAmountError(parsed.ok ? null : parsed.message);
    setReasonError(trimmedReason === "" ? "Enter a reason for the refund" : null);
    if (!parsed.ok || trimmedReason === "") return;
    const confirmed = await confirm({
      title: "Refund this payment?",
      amount: bhd(parsed.amountFils),
      message: "The money goes back to the cardholder and cannot be recalled.",
      confirmLabel: "Refund",
    });
    if (!confirmed || busy.current) return;

    busy.current = true;
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
      setAmountError(null);
      setReason("");
      notify(`Refund of ${bhd(parsed.amountFils)} sent`);
      // Refetch: the refund wrote a new timeline event and changed the totals.
      await onRefunded();
    } catch (err) {
      setError(errorMessage(err, "refund"));
      if (err instanceof ApiError && err.code === "refunds_not_enabled") setPaused(true);
      // Any answer from the API (another tab refunded it, the limit changed):
      // reload, so the totals on screen match what the message says.
      if (err instanceof ApiError) await onRefunded().catch(() => undefined);
    } finally {
      busy.current = false;
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
            {error ? <p className="dash-error" role="alert" id={errorId}>{error}</p> : null}
            <form className="dash-form dash-form-inline" noValidate onSubmit={(e) => void handleRefund(e)}>
              <label>
                Amount (BD, required)
                <input
                  ref={amountRef}
                  type="text"
                  required
                  inputMode="decimal"
                  autoComplete="off"
                  aria-invalid={amountError ? true : undefined}
                  aria-describedby={describedBy(amountNoteId, amountError)}
                  placeholder={`up to ${formatBhd(toFils(maxFils))}`}
                  value={amount}
                  onChange={(e) => {
                    const next = filterAmountInput(e.target.value);
                    setAmount(next);
                    // Re-check while a message is shown, so it goes as soon as it is fixed.
                    if (amountError) {
                      const parsed = parseRefundAmount(next, maxFils);
                      setAmountError(parsed.ok ? null : parsed.message);
                    }
                  }}
                  onBlur={() => {
                    if (amount === "") return;
                    const parsed = parseRefundAmount(amount, maxFils);
                    setAmountError(parsed.ok ? null : parsed.message);
                    setAmount(formatAmountText(amount));
                  }}
                />
              </label>
              <FieldNote id={amountNoteId} error={amountError} />
              <label className="dash-grow">
                Reason (required)
                <input
                  type="text"
                  required
                  maxLength={REFUND_REASON_MAX}
                  aria-invalid={reasonError ? true : undefined}
                  aria-describedby={describedBy(reasonNoteId, reasonError, lengthNote(reason, REFUND_REASON_MAX))}
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    if (e.target.value.trim() !== "") setReasonError(null);
                  }}
                />
              </label>
              <FieldNote id={reasonNoteId} error={reasonError} note={lengthNote(reason, REFUND_REASON_MAX)} />
              <button
                type="submit"
                className="dash-button dash-button-primary"
                disabled={submitting}
                aria-busy={submitting || undefined}
              >
                {submitting ? "Refunding…" : "Refund"}
              </button>
              <button type="button" className="dash-button" disabled={submitting}
                onClick={() => {
                  setOpen(false);
                  setAmountError(null);
                  setReasonError(null);
                }}
              >
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

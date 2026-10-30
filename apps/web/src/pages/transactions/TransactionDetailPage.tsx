import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  captureTransaction,
  getTransaction,
  getTransactionEvents,
  voidTransaction,
} from "../../api/transactions.js";
import { ApiError } from "../../api/client.js";
import { errorMessage } from "../../errors.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd, dash, dateTime, statusLabel } from "../../format.js";
import type { TransactionDto, TransactionEventDto } from "../../types.js";
import { RefundDrawer } from "./RefundDrawer.js";
import { useConfirmDialog } from "../../components/ConfirmDialog.js";
import { StatusChip } from "../../components/StatusChip.js";
import { CopyButton } from "../../components/CopyButton.js";
import { useToast } from "../../components/Toast.js";
import { capitalize } from "../../utils/helpers.js";
import { checkAmount, filterAmountInput, formatAmountText } from "../../inputRules.js";
import { FieldNote, describedBy } from "../../components/FieldNote.js";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; txn: TransactionDto };

/**
 * `GET /v1/transactions/:id` plus its event timeline on the same page — one
 * feature, so one view, not two navigable routes.
 *
 * A `404` renders a plain "not found" state and never tries to distinguish
 * "doesn't exist" from "not yours": the API deliberately answers the same way
 * for both (a `403` would confirm a foreign transaction's existence), and
 * this page does not undo that by guessing.
 */
export function TransactionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [events, setEvents] = useState<TransactionEventDto[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<"capture" | "void" | null>(null);
  const busy = useRef(false);
  const notify = useToast();
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureAmount, setCaptureAmount] = useState("");
  const [captureError, setCaptureError] = useState<string | null>(null);
  const captureNoteId = useId();
  const [confirmDialog, confirm] = useConfirmDialog();

  const load = useCallback(async () => {
    if (!id) {
      setState({ kind: "not_found" });
      return;
    }
    try {
      // Two independent reads — the events route does its own merchant-scoped
      // existence check, so neither depends on the other's result.
      const [txn, timeline] = await Promise.all([getTransaction(id), getTransactionEvents(id)]);
      setState({ kind: "loaded", txn });
      setEvents(timeline);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) {
        setState({ kind: "not_found" });
      } else {
        setState({ kind: "error", message: errorMessage(err) });
      }
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCapture(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!id || busy.current) return;
    setActionError(null);
    // Typed in BD like every other amount, parsed to exact fils (no float).
    // Left blank, `amountFils` is omitted entirely and capture.ts captures
    // everything still outstanding — its own documented default.
    const problem = captureProblem(captureAmount);
    setCaptureError(problem);
    if (problem) return;
    let input: { amountFils?: number } = {};
    if (captureAmount.trim() !== "") {
      const checked = checkAmount(captureAmount);
      if (!checked.ok) return;
      input = { amountFils: checked.fils };
    }
    busy.current = true;
    setSubmitting("capture");
    try {
      // A fresh Idempotency-Key per click, including a retry after a decline —
      // same discipline as the checkout page's submit handler.
      const before = state.kind === "loaded" ? state.txn.capturedFils : 0;
      const after = await captureTransaction(id, input, crypto.randomUUID());
      setCaptureOpen(false);
      setCaptureAmount("");
      setCaptureError(null);
      notify(`Captured ${bhd(after.capturedFils - before)}`);
      // Refetch rather than patch: a capture wrote a new transaction_events
      // row server-side, so the timeline is stale, not merely shorter.
      await load();
    } catch (err) {
      setActionError(errorMessage(err, "capture"));
      // Any answer from the API: show the latest state with the message.
      if (err instanceof ApiError) await load();
    } finally {
      busy.current = false;
      setSubmitting(null);
    }
  }

  /** The message for the capture box, or null when it may be sent (blank = all). */
  function captureProblem(text: string): string | null {
    if (text.trim() === "" || state.kind !== "loaded") return null;
    const checked = checkAmount(text, {
      example: "4.750",
      maxFils: state.txn.amountFils - state.txn.capturedFils,
    });
    return checked.ok ? null : checked.message;
  }

  /** Only offered while status is authorized. */
  async function handleVoid(): Promise<void> {
    if (!id || state.kind !== "loaded" || busy.current) return;
    const confirmed = await confirm({
      title: "Void this authorization?",
      amount: bhd(state.txn.amountFils),
      message: "The held funds are released and cannot be captured afterwards.",
      confirmLabel: "Void",
      cancelLabel: "Keep it",
    });
    if (!confirmed || busy.current) return;
    busy.current = true;
    setSubmitting("void");
    setActionError(null);
    try {
      // An already-voided transaction also answers `200` with the voided row —
      // indistinguishable from a first void on the wire, and correctly so:
      // both mean "now voided".
      await voidTransaction(id);
      notify("Authorization voided");
      await load();
    } catch (err) {
      setActionError(errorMessage(err, "void"));
      if (err instanceof ApiError) await load();
    } finally {
      busy.current = false;
      setSubmitting(null);
    }
  }

  if (state.kind === "loading") {
    return <p className="dash-loading" role="status">Loading…</p>;
  }
  if (state.kind === "not_found") {
    return (
      <section>
        <h1>Transaction not found</h1>
        <p>
          No transaction with this id exists on your account.{" "}
          <Link to="/dashboard/transactions">Back to transactions</Link>
        </p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section>
        <h1>Transaction</h1>
        <p className="dash-error" role="alert">{state.message}</p>
      </section>
    );
  }

  const { txn } = state;
  const capturable = txn.status === "authorized" || txn.status === "partially_captured";
  const voidable = txn.status === "authorized";

  return (
    <section>
      {confirmDialog}
      <div className="dash-page-head">
        <div>
          <p className="dash-kicker">Transaction record · {dash(txn.reference)}</p>
          <h1>Transaction</h1>
        </div>
      </div>

      <div className="dash-card dash-hero">
        <div className="dash-figure dash-figure-main">
          <span className="dash-figure-label">Captured</span>
          <span className="dash-figure-value">{bhd(txn.capturedFils)}</span>
        </div>
        <div className="dash-figure">
          <span className="dash-figure-label">Authorized</span>
          <span className="dash-figure-value">{bhd(txn.amountFils)}</span>
        </div>
        <div className="dash-figure">
          <span className="dash-figure-label">Refunded</span>
          <span className={txn.refundedFils > 0 ? "dash-figure-value dash-negative" : "dash-figure-value"}>
            {bhd(txn.refundedFils)}
          </span>
        </div>
        <div className="dash-figure">
          <span className="dash-figure-label">Status</span>
          <span>
            <StatusChip status={txn.status} />
          </span>
        </div>
      </div>

      {/* Capture and void are hidden from `support` — a support agent looks
          things up, they don't move money. The API enforces the same rule
          (requireMerchantRole("owner", "finance") on capture/void); this
          hide is only the matching UX. */}
      <RequireRole allow={["owner", "finance"]}>
        {capturable || voidable ? (
          <div className="dash-actions">
            {actionError ? <p className="dash-error" role="alert">{actionError}</p> : null}

            {capturable ? (
              captureOpen ? (
                <form className="dash-form dash-form-inline" noValidate onSubmit={(e) => void handleCapture(e)}>
                  <label>
                    Amount in BD (blank captures all that is left)
                    <input
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder={`up to ${bhd(txn.amountFils - txn.capturedFils)}`}
                      aria-invalid={captureError ? true : undefined}
                      aria-describedby={describedBy(captureNoteId, captureError)}
                      value={captureAmount}
                      onChange={(e) => {
                        const next = filterAmountInput(e.target.value);
                        setCaptureAmount(next);
                        if (captureError) setCaptureError(captureProblem(next));
                      }}
                      onBlur={() => {
                        setCaptureError(captureProblem(captureAmount));
                        setCaptureAmount(formatAmountText(captureAmount));
                      }}
                    />
                  </label>
                  <FieldNote id={captureNoteId} error={captureError} />
                  <button
                    type="submit"
                    className="dash-button dash-button-primary"
                    disabled={submitting !== null}
                    aria-busy={submitting === "capture" || undefined}
                  >
                    {submitting === "capture" ? "Capturing…" : "Capture"}
                  </button>
                  <button
                    type="button"
                    className="dash-button"
                    disabled={submitting !== null}
                    onClick={() => {
                      setCaptureOpen(false);
                      setCaptureError(null);
                    }}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <button type="button" className="dash-button dash-button-primary" onClick={() => setCaptureOpen(true)}>
                  Capture
                </button>
              )
            ) : null}

            {voidable ? (
              <button
                type="button"
                className="dash-button dash-button-danger"
                disabled={submitting !== null}
                aria-busy={submitting === "void" || undefined}
                onClick={() => void handleVoid()}
              >
                {submitting === "void" ? "Voiding…" : "Void"}
              </button>
            ) : null}
          </div>
        ) : null}
      </RequireRole>

      <RefundDrawer txn={txn} onRefunded={load} />

      <h2>Details</h2>
      <dl className="dash-dl">
        <dt>Currency</dt>
        <dd>{txn.currency}</dd>
        <dt>Reference</dt>
        <dd>{dash(txn.reference)}</dd>
        <dt>Bank reference</dt>
        <dd>
          <span className="dash-ref">
            <code className="dash-ref-text">{txn.acquirerReference}</code>
            <CopyButton value={txn.acquirerReference} copiedMessage="Bank reference copied" />
          </span>
        </dd>
        <dt>Transaction ID</dt>
        <dd>
          <span className="dash-ref">
            <code className="dash-ref-text">{txn.id}</code>
            <CopyButton value={txn.id} copiedMessage="Transaction ID copied" />
          </span>
        </dd>
        <dt>Occurred at</dt>
        <dd>{dateTime(txn.occurredAt)}</dd>
        <dt>Created at</dt>
        <dd>{dateTime(txn.createdAt)}</dd>
      </dl>

      <h2>Event timeline</h2>
      <div className="dash-table-wrap">
        <table className="dash-table dash-table-cards">
          <thead>
            <tr>
              <th>Occurred</th>
              <th>Event</th>
              <th className="dash-num">Amount</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {/* Already ordered oldest-first by the endpoint — never re-sorted
                here, so the page can't disagree with the API about history. */}
            {events.map((event) => (
              <tr key={event.id}>
                <td className="dash-nowrap" data-label="Occurred">{dateTime(event.occurredAt)}</td>
                <td data-label="Event">{capitalize(statusLabel(event.eventType))}</td>
                <td className="dash-num" data-label="Amount">
                  {event.amountFils !== null
                    ? bhd(event.amountFils)
                    : event.eventType === "authorized"
                      ? bhd(txn.amountFils)
                      : "—"}
                </td>
                <td data-label="By">{capitalize(statusLabel(event.actorType))}</td>
              </tr>
            ))}
            {events.length === 0 ? (
              <tr>
                <td colSpan={4} className="dash-empty">No events recorded.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="dash-back">
        <Link to="/dashboard/transactions">Back to transactions</Link>
      </p>
    </section>
  );
}

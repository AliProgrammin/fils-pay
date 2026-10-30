import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  captureTransaction,
  getTransaction,
  getTransactionEvents,
  voidTransaction,
} from "../../api/transactions.js";
import { ApiError, describeError } from "../../api/client.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd, dash, dateTime } from "../../format.js";
import type { TransactionDto, TransactionEventDto } from "../../types.js";
import { RefundDrawer } from "./RefundDrawer.js";
import { useConfirmDialog } from "../../components/ConfirmDialog.js";
import { StatusChip } from "../../components/StatusChip.js";

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
  const [submitting, setSubmitting] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureAmount, setCaptureAmount] = useState("");
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
        setState({ kind: "error", message: describeError(err) });
      }
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCapture(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!id) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const trimmed = captureAmount.trim();
      // Left blank, `amountFils` is omitted entirely and capture.ts captures
      // everything still outstanding — its own documented default. Computing
      // the remainder here would just be a second, staler copy of that rule.
      const input = trimmed === "" ? {} : { amountFils: Number(trimmed) };
      // A fresh Idempotency-Key per click, including a retry after a decline —
      // same discipline as the checkout page's submit handler.
      await captureTransaction(id, input, crypto.randomUUID());
      setCaptureOpen(false);
      setCaptureAmount("");
      // Refetch rather than patch: a capture wrote a new transaction_events
      // row server-side, so the timeline is stale, not merely shorter.
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  /** Only offered while status is authorized. */
  async function handleVoid(): Promise<void> {
    if (!id || state.kind !== "loaded") return;
    const confirmed = await confirm({
      title: "Void this authorization?",
      amount: bhd(state.txn.amountFils),
      message: "The held funds are released and cannot be captured afterwards.",
      confirmLabel: "Void",
      cancelLabel: "Keep it",
    });
    if (!confirmed) return;
    setSubmitting(true);
    setActionError(null);
    try {
      // An already-voided transaction also answers `200` with the voided row —
      // indistinguishable from a first void on the wire, and correctly so:
      // both mean "now voided".
      await voidTransaction(id);
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (state.kind === "loading") {
    return <p className="dash-loading" role="status">Loading...</p>;
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
                <form className="dash-form dash-form-inline" onSubmit={(e) => void handleCapture(e)}>
                  <label>
                    Amount in fils (blank captures everything outstanding)
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={captureAmount}
                      onChange={(e) => setCaptureAmount(e.target.value)}
                    />
                  </label>
                  <button type="submit" className="dash-button dash-button-primary" disabled={submitting}>
                    {submitting ? "Capturing..." : "Capture"}
                  </button>
                  <button
                    type="button"
                    className="dash-button"
                    disabled={submitting}
                    onClick={() => setCaptureOpen(false)}
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
                disabled={submitting}
                onClick={() => void handleVoid()}
              >
                Void
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
        <dt>Acquirer reference</dt>
        <dd>
          <code>{txn.acquirerReference}</code>
        </dd>
        <dt>Transaction ID</dt>
        <dd>
          <code>{txn.id}</code>
        </dd>
        <dt>Occurred at</dt>
        <dd>{dateTime(txn.occurredAt)}</dd>
        <dt>Created at</dt>
        <dd>{dateTime(txn.createdAt)}</dd>
      </dl>

      <h2>Event timeline</h2>
      <div className="dash-table-wrap">
        <table className="dash-table">
          <thead>
            <tr>
              <th>Occurred</th>
              <th>Event</th>
              <th className="dash-num">Amount</th>
              <th>Actor</th>
            </tr>
          </thead>
          <tbody>
            {/* Already ordered oldest-first by the endpoint — never re-sorted
                here, so the page can't disagree with the API about history. */}
            {events.map((event) => (
              <tr key={event.id}>
                <td className="dash-nowrap">{dateTime(event.occurredAt)}</td>
                <td>
                  <code>{event.eventType}</code>
                </td>
                <td className="dash-num">{event.amountFils === null ? "—" : bhd(event.amountFils)}</td>
                <td>
                  {event.actorType}
                  {event.actorId ? (
                    <div className="dash-muted">
                      <code>{event.actorId}</code>
                    </div>
                  ) : null}
                </td>
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

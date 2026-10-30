import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getSettlementBatch, getSettlementBatchTransactions } from "../../api/settlement.js";
import { ApiError } from "../../api/client.js";
import { errorMessage } from "../../errors.js";
import { bhd, calendarDate, dash, dateTime } from "../../format.js";
import type { SettlementBatchDetailDto, SettlementBatchTransactionDto } from "../../types.js";
import { StatusChip } from "../../components/StatusChip.js";
import { truncateMiddle } from "../../utils/helpers.js";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; batch: SettlementBatchDetailDto };

/**
 * `GET /v1/settlement/batches/:id` plus its line items.
 *
 * The two counts are rendered as two separately-labeled figures and never
 * added, averaged, or presented as one number: a transaction captured twice
 * inside the batch window contributes one scheme export line but two capture
 * events, so they can legitimately differ. Conflating them would invent a
 * discrepancy where there isn't one — or hide a real one.
 *
 * No pagination on the line items: the endpoint has none, and adding a
 * client-side cap would silently drop rows from a settlement figure.
 */
export function SettlementBatchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [lines, setLines] = useState<SettlementBatchTransactionDto[]>([]);

  useEffect(() => {
    if (!id) {
      setState({ kind: "not_found" });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [batch, txns] = await Promise.all([
          getSettlementBatch(id),
          getSettlementBatchTransactions(id),
        ]);
        if (cancelled) return;
        setState({ kind: "loaded", batch });
        setLines(txns.transactions);
      } catch (err) {
        if (cancelled) return;
        // 404, not 403, for another merchant's batch — the same non-disclosure
        // choice the transaction detail read makes.
        if (err instanceof ApiError && err.statusCode === 404) {
          setState({ kind: "not_found" });
        } else {
          setState({ kind: "error", message: errorMessage(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (state.kind === "loading") return <p className="dash-loading" role="status">Loading…</p>;
  if (state.kind === "not_found") {
    return (
      <section>
        <h1>Settlement batch not found</h1>
        <p>
          No settlement batch with this id exists on your account.{" "}
          <Link to="/dashboard/settlement">Back to settlement batches</Link>
        </p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section>
        <h1>Settlement batch</h1>
        <p className="dash-error" role="alert">{state.message}</p>
      </section>
    );
  }

  const { batch } = state;

  return (
    <section>
      <div className="dash-page-head">
        <div>
          <p className="dash-kicker">Settlement batch · {calendarDate(batch.batchDate)}</p>
          <h1>Settlement batch</h1>
        </div>
      </div>

      <div className="dash-card dash-hero">
        <div className="dash-figure dash-figure-main">
          <span className="dash-figure-label">Net payout</span>
          <span className="dash-figure-value">{bhd(batch.netPayoutFils)}</span>
        </div>
        <div className="dash-figure">
          <span className="dash-figure-label">Gross</span>
          <span className="dash-figure-value">{bhd(batch.grossFils)}</span>
        </div>
        <div className="dash-figure">
          <span className="dash-figure-label">Status</span>
          <span>
            <StatusChip status={batch.status} />
          </span>
        </div>
      </div>

      <dl className="dash-dl">
        <dt>Gross</dt>
        <dd className="dash-money">{bhd(batch.grossFils)}</dd>
        <dt>Fee</dt>
        <dd className="dash-money">{bhd(batch.feeFils)}</dd>
        <dt>Refunds</dt>
        <dd className="dash-money">{bhd(-batch.refundFils)}</dd>
        <dt>Fee reversed on refunds</dt>
        <dd className="dash-money">{bhd(batch.refundFeeReversedFils)}</dd>
        <dt className="dash-dl-total">Net payout</dt>
        <dd className="dash-money dash-dl-total">{bhd(batch.netPayoutFils)}</dd>
        <dt>Closed at</dt>
        <dd>{dateTime(batch.closedAt)}</dd>
        <dt>Paid at</dt>
        <dd>{dateTime(batch.paidAt)}</dd>
        <dt>Batch ID</dt>
        <dd>
          <code>{batch.id}</code>
        </dd>
        <dt>Included transactions</dt>
        <dd>{batch.includedTransactionCount}</dd>
        <dt>Captures in this batch</dt>
        <dd className={batch.includedEventCount !== batch.includedTransactionCount ? "dash-dd-stack" : undefined}>
          <span>{batch.includedEventCount}</span>
          {batch.includedEventCount !== batch.includedTransactionCount ? (
            <span className="dash-muted dash-dd-help">
              More captures than transactions is normal: a payment captured in
              parts counts once as a transaction and once per capture here.
            </span>
          ) : null}
        </dd>
      </dl>

      <h2>Included transactions</h2>
      <div className="dash-table-wrap">
        <table className="dash-table dash-table-cards">
          <thead>
            <tr>
              <th>Line</th>
              <th>Transaction</th>
              <th>Reference</th>
              <th>Status</th>
              <th className="dash-num">Authorized</th>
              <th className="dash-num">Captured</th>
              <th className="dash-num">Card network amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={`${line.transactionId}-${line.lineSequence}`}>
                <td data-label="Line">{line.lineSequence}</td>
                <td data-label="Transaction">
                  <Link to={`/dashboard/transactions/${line.transactionId}`}>
                    <code>{truncateMiddle(line.transactionId, 18)}</code>
                  </Link>
                </td>
                <td data-label="Reference">{dash(line.reference)}</td>
                <td data-label="Status">
                  <StatusChip status={line.status} />
                </td>
                <td className="dash-num" data-label="Authorized">{bhd(line.authorizedFils)}</td>
                <td className="dash-num" data-label="Captured">{bhd(line.capturedFils)}</td>
                <td className="dash-num" data-label="Card network">{bhd(line.schemeAmountFils)}</td>
              </tr>
            ))}
            {lines.length === 0 ? (
              <tr>
                <td colSpan={7} className="dash-empty">No transactions in this batch yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="dash-note">
        The card network amount is the amount the card network reports. It is
        rounded down to 2 decimals, so it can be up to 9 fils less than the
        captured amount. That is expected.
      </p>

      <p className="dash-back">
        <Link to="/dashboard/settlement">Back to settlement batches</Link>
      </p>
    </section>
  );
}

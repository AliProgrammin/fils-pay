import { useState } from "react";
import { rebuildAnalytics, rebuildBalances, runBatch } from "../../api/settlement.js";
import { recalculateMdr } from "../../api/mdrRecalculation.js";
import { describeError } from "../../api/client.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bahrainYesterdayIso } from "../../bahrainDate.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { bhd, formatBusinessDate } from "../../format.js";
import type {
  AnalyticsRebuildSummary,
  BalanceRebuildSummary,
  MdrRecalcSummary,
  RunBatchSummary,
} from "../../types.js";

/**
 * The two cross-process operations. Both are `finance` /
 * `super_admin` server-side; both write their audit row *before* the call
 * crosses the network, so an attempt is on record even if the settlement
 * service never answers.
 *
 * The analytics rebuild at the bottom is the same role gate and the same
 * confirm-before-you-run shape, but it never leaves apps/api — it is one
 * transaction of SQL, so its audit row is simply part of that transaction.
 */
export function SettlementPage() {
  const [date, setDate] = useState(bahrainYesterdayIso());
  const [merchantId, setMerchantId] = useState("");
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<RunBatchSummary | null>(null);

  const [confirmingRebuild, setConfirmingRebuild] = useState(false);
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [rebuildResult, setRebuildResult] = useState<BalanceRebuildSummary | null>(null);

  const [confirmingAnalytics, setConfirmingAnalytics] = useState(false);
  const [analyticsBusy, setAnalyticsBusy] = useState(false);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [analyticsResult, setAnalyticsResult] = useState<AnalyticsRebuildSummary | null>(null);

  const [mdrMerchantId, setMdrMerchantId] = useState("");
  const [mdrFrom, setMdrFrom] = useState("");
  const [mdrTo, setMdrTo] = useState("");
  const [mdrBusy, setMdrBusy] = useState(false);
  const [mdrError, setMdrError] = useState<string | null>(null);
  const [mdrResult, setMdrResult] = useState<MdrRecalcSummary | null>(null);

  /** Idempotent per business date: re-running returns the already-closed batches. */
  async function handleRunBatch(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setRunBusy(true);
    setRunError(null);
    setRunResult(null);
    try {
      setRunResult(
        await runBatch({ date, merchantId: merchantId.trim() ? merchantId.trim() : undefined }),
      );
    } catch (err) {
      setRunError(describeError(err));
    } finally {
      setRunBusy(false);
    }
  }

  // after clicking rebuild on staging alpha's balance jumped to like 3x?? — am
  // MK: staging data is junk. cache-only, safe to click
  async function handleRebuild(): Promise<void> {
    setRebuildBusy(true);
    setRebuildError(null);
    setRebuildResult(null);
    try {
      setRebuildResult(await rebuildBalances());
      setConfirmingRebuild(false);
    } catch (err) {
      setRebuildError(describeError(err));
    } finally {
      setRebuildBusy(false);
    }
  }

  async function handleRebuildAnalytics(): Promise<void> {
    setAnalyticsBusy(true);
    setAnalyticsError(null);
    setAnalyticsResult(null);
    try {
      setAnalyticsResult(await rebuildAnalytics());
      setConfirmingAnalytics(false);
    } catch (err) {
      setAnalyticsError(describeError(err));
    } finally {
      setAnalyticsBusy(false);
    }
  }

  // FH: ADMIN.md says this is safe
  async function handleRecalculateMdr(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setMdrBusy(true);
    setMdrError(null);
    setMdrResult(null);
    try {
      setMdrResult(await recalculateMdr(mdrMerchantId.trim(), { from: mdrFrom, to: mdrTo }));
    } catch (err) {
      setMdrError(describeError(err));
    } finally {
      setMdrBusy(false);
    }
  }

  const runResults = runResult?.merchantResults ?? [];
  const mdrAdjusted = mdrResult?.adjusted ?? [];

  return (
    <section>
      <header className="admin-page-head">
        <p className="admin-kicker">Restricted · finance and super_admin</p>
        <h1>Settlement ops</h1>
        <p className="admin-lede">
          Every action below is money-adjacent and is gated server-side to the <code>finance</code>{" "}
          and <code>super_admin</code> roles. Every invocation is written to the admin audit log
          before it runs.
        </p>
      </header>

      <div className="admin-panel admin-panel-danger">
        <div className="admin-panel-head">
          <h2>Re-run a daily batch</h2>
          <span className="admin-danger-tag">Pays out money</span>
        </div>
        <p className="admin-muted">
          Closes and pays out the batch for one business date. Running a date that is already closed
          or paid is safe — the settlement service reports it as already-done rather than doing it
          twice.
        </p>

        {runError ? <p className="admin-error" role="alert">{runError}</p> : null}

        <RequireRole
          allow={["finance", "super_admin"]}
          fallback={
            <p className="admin-muted">
              Your role cannot trigger settlement runs. Ask a finance admin.
            </p>
          }
        >
          <form className="admin-form admin-form-row" onSubmit={(e) => void handleRunBatch(e)}>
            <label>
              Business date
              <input
                type="date"
                required
                max={bahrainYesterdayIso()}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            <label className="admin-span-2">
              Merchant id (optional — blank runs all eligible)
              <input
                type="text"
                className="admin-amount"
                placeholder="00000000-0000-0000-0000-000000000000"
                value={merchantId}
                onChange={(e) => setMerchantId(e.target.value)}
              />
            </label>
            <button type="submit" className="admin-btn-danger" disabled={runBusy}>
              {runBusy ? "Running..." : "Run batch"}
            </button>
          </form>
        </RequireRole>

        {runResult ? (
          <div className="admin-notice" role="status">
            <p>
              Batch run for <strong>{formatBusinessDate(runResult.businessDate)}</strong> —{" "}
              {runResults.length} merchant
              {runResults.length === 1 ? "" : "s"} processed.
            </p>
            {runResults.length > 0 ? (
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Merchant</th>
                      <th>Batch</th>
                      <th className="admin-num">Gross</th>
                      <th className="admin-num">Fee</th>
                      <th className="admin-num">Net payout</th>
                      <th>Already closed</th>
                      <th>Already paid</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runResults.map((outcome) => (
                      <tr key={`${outcome.merchantId}-${outcome.batchId}`}>
                        <td>
                          <code>{outcome.merchantId}</code>
                        </td>
                        <td>
                          <code>{outcome.batchId}</code>
                        </td>
                        <td className="admin-num">{bhd(outcome.grossFils)}</td>
                        <td className="admin-num">{bhd(outcome.feeFils)}</td>
                        <td className="admin-num admin-strong">{bhd(outcome.netPayoutFils)}</td>
                        <td>{outcome.alreadyClosed ? "yes" : "no"}</td>
                        <td>{outcome.alreadyPaid ? "yes" : "no"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="admin-grid-2">
        <div className="admin-panel admin-panel-danger">
          <div className="admin-panel-head">
            <h2>Rebuild cached balances</h2>
            <span className="admin-danger-tag">Every merchant</span>
          </div>
          <p className="admin-muted">
            Recomputes every merchant&apos;s cached payable balance from <code>ledger_entries</code>,
            the authoritative record. The ledger itself is only read, never written — but this
            touches every merchant on the platform at once, so it asks before it runs.
          </p>

          {rebuildError && !confirmingRebuild ? (
            <p className="admin-error" role="alert">{rebuildError}</p>
          ) : null}

          <RequireRole
            allow={["finance", "super_admin"]}
            fallback={
              <p className="admin-muted">Your role cannot rebuild balances. Ask a finance admin.</p>
            }
          >
            <div className="admin-actions">
              <button
                type="button"
                className="admin-btn-danger"
                onClick={() => setConfirmingRebuild(true)}
              >
                Rebuild balances
              </button>
            </div>
            {confirmingRebuild ? (
              <ConfirmDialog
                title="Rebuild balances for every merchant?"
                confirmLabel="Yes, rebuild all balances"
                busyLabel="Rebuilding..."
                busy={rebuildBusy}
                error={rebuildError}
                onConfirm={() => void handleRebuild()}
                onCancel={() => setConfirmingRebuild(false)}
              >
                <p>
                  This recalculates all cached payable balances from the ledger and records the
                  action in the admin audit log. The ledger itself is not changed.
                </p>
              </ConfirmDialog>
            ) : null}
          </RequireRole>

          {rebuildResult ? (
            <div className="admin-notice" role="status">
              <p>
                Rebuilt {rebuildResult.rebuiltCount} balance
                {rebuildResult.rebuiltCount === 1 ? "" : "s"};{" "}
                {(rebuildResult.changed ?? []).length} changed.
              </p>
              {(rebuildResult.changed ?? []).length > 0 ? (
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Merchant</th>
                        <th className="admin-num">Before</th>
                        <th className="admin-num">After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(rebuildResult.changed ?? []).map((change) => (
                        <tr key={change.merchantId}>
                          <td>
                            <code>{change.merchantId}</code>
                          </td>
                          <td className="admin-num">{bhd(change.before)}</td>
                          <td className="admin-num admin-strong">{bhd(change.after)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="admin-muted">Every cached balance already matched the ledger.</p>
              )}
            </div>
          ) : null}
        </div>

        <div className="admin-panel admin-panel-danger">
          <div className="admin-panel-head">
            <h2>Rebuild analytics</h2>
            <span className="admin-danger-tag">Every merchant</span>
          </div>
          <p className="admin-muted">
            Clears the analytics read model — daily volumes and payout trends — and makes the
            reporting worker refill it from the full event history. Use it when a merchant&apos;s
            dashboard figures look wrong. The tables are empty until the worker catches up.
          </p>

          {analyticsError && !confirmingAnalytics ? (
            <p className="admin-error" role="alert">{analyticsError}</p>
          ) : null}

          <RequireRole
            allow={["finance", "super_admin"]}
            fallback={
              <p className="admin-muted">Your role cannot rebuild analytics. Ask a finance admin.</p>
            }
          >
            <div className="admin-actions">
              <button
                type="button"
                className="admin-btn-danger"
                onClick={() => setConfirmingAnalytics(true)}
              >
                Rebuild analytics
              </button>
            </div>
            {confirmingAnalytics ? (
              <ConfirmDialog
                title="Rebuild analytics for every merchant?"
                confirmLabel="Yes, rebuild analytics"
                busyLabel="Rebuilding..."
                busy={analyticsBusy}
                error={analyticsError}
                onConfirm={() => void handleRebuildAnalytics()}
                onCancel={() => setConfirmingAnalytics(false)}
              >
                <p>
                  This clears both rollup tables, the reporting worker refills them from the full
                  event history, and the action is recorded in the admin audit log. Merchant
                  dashboards show empty charts until the worker catches up.
                </p>
              </ConfirmDialog>
            ) : null}
          </RequireRole>

          {analyticsResult ? (
            <div className="admin-notice" role="status">
              <p>
                Cleared {analyticsResult.volumeRows} daily-volume row
                {analyticsResult.volumeRows === 1 ? "" : "s"} and {analyticsResult.trendRows}{" "}
                payout-trend row{analyticsResult.trendRows === 1 ? "" : "s"}. The reporting worker
                is now rebuilding them from the full event history.
              </p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="admin-panel admin-panel-danger">
        <div className="admin-panel-head">
          <h2>Recalculate MDR</h2>
          <span className="admin-danger-tag">Posts ledger adjustments</span>
        </div>
        <p className="admin-muted">
          Re-derives one merchant&apos;s settlement-batch fees over a date range at their current
          contracted rate, and posts a ledger adjustment for any difference. Finance runs this after
          a rate change lands so historical batches reflect the same figure a fresh reconciliation
          would show.
        </p>
        <RequireRole
          allow={["finance", "super_admin"]}
          fallback={
            <p className="admin-muted">
              Your role cannot run an MDR recalculation. Ask a finance admin.
            </p>
          }
        >
          <form className="admin-form admin-form-row" onSubmit={(e) => void handleRecalculateMdr(e)}>
            <label className="admin-span-2">
              Merchant id
              <input
                className="admin-amount"
                value={mdrMerchantId}
                onChange={(e) => setMdrMerchantId(e.target.value)}
                placeholder="merchant UUID"
                required
              />
            </label>
            <label>
              From (inclusive)
              <input type="date" value={mdrFrom} onChange={(e) => setMdrFrom(e.target.value)} required />
            </label>
            <label>
              To (exclusive)
              <input type="date" value={mdrTo} onChange={(e) => setMdrTo(e.target.value)} required />
            </label>
            <button type="submit" className="admin-btn-danger" disabled={mdrBusy}>
              {mdrBusy ? "Recalculating…" : "Recalculate MDR"}
            </button>
          </form>
        </RequireRole>

        {mdrError ? <p className="admin-error" role="alert">{mdrError}</p> : null}

        {mdrResult ? (
          <div className="admin-notice" role="status">
            <p>
              Considered {mdrResult.batchesConsidered} batch(es); {mdrAdjusted.length} had a fee
              change.
            </p>
            {mdrAdjusted.length > 0 ? (
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Batch date</th>
                      <th>Status</th>
                      <th className="admin-num">Old fee</th>
                      <th className="admin-num">New fee</th>
                      <th className="admin-num">Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mdrAdjusted.map((adjustment) => (
                      <tr key={adjustment.batchId}>
                        <td>{formatBusinessDate(adjustment.batchDate)}</td>
                        <td>{adjustment.status}</td>
                        <td className="admin-num">{bhd(adjustment.oldFeeFils)}</td>
                        <td className="admin-num">{bhd(adjustment.newFeeFils)}</td>
                        <td className="admin-num admin-strong">{bhd(adjustment.diffFils)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="admin-muted">Every batch in range already matched the current rate.</p>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

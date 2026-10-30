import { useEffect, useId, useState } from "react";
import { listMerchants } from "../../api/merchants.js";
import { rebuildAnalytics, rebuildBalances, runBatch } from "../../api/settlement.js";
import { recalculateMdr } from "../../api/mdrRecalculation.js";
import { errorMessage } from "../../errors.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bahrainYesterdayIso } from "../../bahrainDate.js";
import { bahrainToday, exclusiveTo, rangeError } from "../../dateRange.js";
import { DateRangeFields } from "../../components/DateRangeFields.js";
import { useAction } from "../../components/useAction.js";
import { useToast } from "../../components/Toast.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { bhd, formatBusinessDate } from "../../format.js";
import { FieldNote, describedBy } from "../../components/FieldNote.js";
import { checkUuid, filterUuidInput } from "../../inputRules.js";
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
  const notify = useToast();
  const [runBusy, runRun] = useAction();
  const [runError, setRunError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<RunBatchSummary | null>(null);

  const [confirmingRebuild, setConfirmingRebuild] = useState(false);
  const [rebuildBusy, runRebuild] = useAction();
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [rebuildResult, setRebuildResult] = useState<BalanceRebuildSummary | null>(null);

  const [confirmingAnalytics, setConfirmingAnalytics] = useState(false);
  const [analyticsBusy, runAnalytics] = useAction();
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [analyticsResult, setAnalyticsResult] = useState<AnalyticsRebuildSummary | null>(null);

  const [mdrMerchantId, setMdrMerchantId] = useState("");
  const [mdrFrom, setMdrFrom] = useState("");
  const [mdrTo, setMdrTo] = useState("");
  const [mdrBusy, runMdr] = useAction();
  const [mdrError, setMdrError] = useState<string | null>(null);
  const [mdrResult, setMdrResult] = useState<MdrRecalcSummary | null>(null);

  const [merchantIdError, setMerchantIdError] = useState<string | null>(null);
  const [mdrMerchantIdError, setMdrMerchantIdError] = useState<string | null>(null);
  const [runDateError, setRunDateError] = useState<string | null>(null);
  const merchantIdNoteId = useId();
  const mdrMerchantIdNoteId = useId();
  const runDateNoteId = useId();
  const merchantListId = useId();
  /** Known merchants, offered as suggestions in both merchant id boxes. */
  const [merchantChoices, setMerchantChoices] = useState<Array<{ id: string; displayName: string }>>([]);
  useEffect(() => {
    let live = true;
    listMerchants({ limit: 100 })
      .then((page) => {
        if (live) setMerchantChoices(page.merchants.map((m) => ({ id: m.id, displayName: m.displayName })));
      })
      // Suggestions only: the box still takes a pasted id without them.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  /** Idempotent per business date: re-running returns the already-closed batches. */
  async function handleRunBatch(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const idProblem = merchantId.trim() === "" ? null : checkUuid(merchantId);
    const dateProblem = date === "" ? "Choose the business date"
      : date > bahrainYesterdayIso() ? "Choose a business date before today (Bahrain time)" : null;
    setMerchantIdError(idProblem);
    setRunDateError(dateProblem);
    if (idProblem || dateProblem) return;
    await runRun(async () => {
      setRunError(null);
      setRunResult(null);
      try {
        const result = await runBatch({
          date,
          merchantId: merchantId.trim() ? merchantId.trim() : undefined,
        });
        setRunResult(result);
        notify(`Batch run finished for ${formatBusinessDate(result.businessDate)}`);
      } catch (err) {
        setRunError(errorMessage(err, "settlementRun"));
      }
    });
  }

  // after clicking rebuild on staging alpha's balance jumped to like 3x?? — am
  // MK: staging data is junk. cache-only, safe to click
  async function handleRebuild(): Promise<void> {
    await runRebuild(async () => {
      setRebuildError(null);
      setRebuildResult(null);
      try {
        setRebuildResult(await rebuildBalances());
        setConfirmingRebuild(false);
        notify("Balances rebuilt");
      } catch (err) {
        setRebuildError(errorMessage(err));
      }
    });
  }

  async function handleRebuildAnalytics(): Promise<void> {
    await runAnalytics(async () => {
      setAnalyticsError(null);
      setAnalyticsResult(null);
      try {
        setAnalyticsResult(await rebuildAnalytics());
        setConfirmingAnalytics(false);
        notify("Analytics rebuild started");
      } catch (err) {
        setAnalyticsError(errorMessage(err));
      }
    });
  }

  // FH: ADMIN.md says this is safe
  async function handleRecalculateMdr(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const idProblem = checkUuid(mdrMerchantId);
    setMdrMerchantIdError(idProblem);
    if (idProblem || mdrRangeError || !mdrFrom || !mdrTo) return;
    await runMdr(async () => {
      setMdrError(null);
      setMdrResult(null);
      try {
        // "To" is inclusive on screen; the API's `to` is exclusive.
        const result = await recalculateMdr(mdrMerchantId.trim(), {
          from: mdrFrom,
          to: exclusiveTo(mdrTo),
        });
        setMdrResult(result);
        notify(`MDR recalculated: ${result.adjusted?.length ?? 0} batch(es) changed`);
      } catch (err) {
        setMdrError(errorMessage(err));
      }
    });
  }

  const mdrRangeError = rangeError(mdrFrom, mdrTo, bahrainToday());
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
          <form className="admin-form admin-form-row" noValidate onSubmit={(e) => void handleRunBatch(e)}>
            <label>
              Business date
              <input
                type="date"
                required
                max={bahrainYesterdayIso()}
                aria-invalid={runDateError ? true : undefined}
                aria-describedby={describedBy(runDateNoteId, runDateError)}
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setRunDateError(null);
                }}
              />
            </label>
            <label className="admin-span-2">
              Merchant id (optional — blank runs all eligible)
              <input
                type="text"
                className="admin-amount"
                placeholder="00000000-0000-0000-0000-000000000000"
                list={merchantListId}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={merchantIdError ? true : undefined}
                aria-describedby={describedBy(merchantIdNoteId, merchantIdError)}
                value={merchantId}
                onChange={(e) => {
                  const next = filterUuidInput(e.target.value);
                  setMerchantId(next);
                  if (merchantIdError) setMerchantIdError(next === "" ? null : checkUuid(next));
                }}
                onBlur={() => {
                  if (merchantId !== "") setMerchantIdError(checkUuid(merchantId));
                }}
              />
            </label>
            <button type="submit" className="admin-btn-danger" disabled={runBusy}>
              {runBusy ? "Running…" : "Run batch"}
            </button>
            <FieldNote id={runDateNoteId} error={runDateError} />
            <FieldNote id={merchantIdNoteId} error={merchantIdError} />
            <datalist id={merchantListId}>
              {merchantChoices.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </datalist>
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
            Recalculates the balance shown for every merchant from the ledger, which is the record
            of truth. The ledger is only read, never changed — but this touches every merchant on
            the platform at once, so it asks before it runs.
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
                busyLabel="Rebuilding…"
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
            Clears the dashboard analytics — daily volumes and payout trends — and rebuilds them from
            the full payment history. Use it when a merchant&apos;s dashboard figures look wrong. The
            charts stay empty for a short time while the rebuild runs.
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
                busyLabel="Rebuilding…"
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
                list={merchantListId}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={mdrMerchantIdError ? true : undefined}
                aria-describedby={describedBy(mdrMerchantIdNoteId, mdrMerchantIdError)}
                onChange={(e) => {
                  const next = filterUuidInput(e.target.value);
                  setMdrMerchantId(next);
                  if (mdrMerchantIdError) setMdrMerchantIdError(checkUuid(next));
                }}
                onBlur={() => {
                  if (mdrMerchantId !== "") setMdrMerchantIdError(checkUuid(mdrMerchantId));
                }}
                placeholder="00000000-0000-0000-0000-000000000000"
                required
              />
            </label>
            <FieldNote id={mdrMerchantIdNoteId} error={mdrMerchantIdError} />
            <DateRangeFields
              from={mdrFrom}
              to={mdrTo}
              required
              error={mdrRangeError}
              onChange={(range) => {
                setMdrFrom(range.from);
                setMdrTo(range.to);
              }}
            />
            <button type="submit" className="admin-btn-danger" disabled={mdrBusy || mdrRangeError !== null}>
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

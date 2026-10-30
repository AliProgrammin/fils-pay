import { useCallback, useEffect, useState } from "react";
import { getReconciliation } from "../../api/settlement.js";
import { ApiError } from "../../api/client.js";
import { errorMessage } from "../../errors.js";
import { bhd, calendarDate } from "../../format.js";
import { DateRangeFields } from "../../components/DateRangeFields.js";
import { addDays, bahrainToday, exclusiveTo, inclusiveTo, rangeError } from "../../dateRange.js";
import type { ReconciliationReport } from "../../types.js";

/**
 * `from`/`to` are required by this endpoint (`400 invalid_request` without
 * them), so the page arrives with a filled-in window rather than an empty form
 * that would 400 on first load. "To" is inclusive on screen; the API's `to`
 * is exclusive, so the request sends the day after.
 *
 * The window is anchored to the Asia/Bahrain calendar date, not the viewer's
 * own, because that is the business day `settlement_batches.batch_date` is
 * keyed on — a browser in another timezone would otherwise default to a
 * window off by a day from the batches it's reconciling. Bahrain has observed
 * no DST since 1972, so a fixed +3h shift is exact; this is the same technique
 * apps/api's own analytics route uses.
 */
/** Default window: the last 30 Bahrain days, today included. */
function defaultRange(): { from: string; to: string } {
  const today = bahrainToday();
  return { from: addDays(today, -29), to: today };
}

// Payout legs (D15) and late items carried between days (G11) no longer show
// as a gap, so a non-zero gap is a real difference.
export function ReconciliationPage() {
  const initial = defaultRange();
  const [range, setRange] = useState(initial);
  const [applied, setApplied] = useState(initial);
  const dateError = rangeError(range.from, range.to, bahrainToday());
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      setReport(await getReconciliation({ from: applied.from, to: exclusiveTo(applied.to) }));
    } catch (err) {
      // The one page-specific error branch in this dashboard, because this is
      // the one merchant endpoint with a role gate narrower than "any
      // authenticated merchant user". A `support` user who typed or bookmarked
      // this URL gets a plain explanation — not a crash, not a blank
      // loading-forever state, and no retry.
      if (err instanceof ApiError && err.statusCode === 403) {
        setForbidden(true);
        setReport(null);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setLoading(false);
    }
  }, [applied]);

  useEffect(() => {
    void load();
  }, [load]);

  if (forbidden) {
    return (
      <section>
        <h1>Reconciliation</h1>
        <p className="dash-error" role="alert">
          You don&apos;t have permission to view this report — ask an owner or
          finance user on your account.
        </p>
      </section>
    );
  }

  return (
    <section>
      <div className="dash-page-head">
        <div>
          <p className="dash-kicker">Our records vs payouts · every fil accounted</p>
          <h1>Reconciliation</h1>
        </div>
      </div>

      <form
        className="dash-form dash-form-inline dash-filters"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!range.from || !range.to) return;
          // A bad range shows its message and makes no request.
          if (dateError) return;
          if (range.from === applied.from && range.to === applied.to) void load();
          else setApplied(range);
        }}
      >
        <DateRangeFields
          from={range.from}
          to={range.to}
          onChange={setRange}
          error={dateError ?? (!range.from || !range.to ? "Choose both a From and a To date." : null)}
          required
        />
        <button
          type="submit"
          className="dash-button dash-button-primary"
          disabled={loading || dateError !== null || !range.from || !range.to}
          aria-busy={loading || undefined}
        >
          {loading ? "Running…" : "Run report"}
        </button>
      </form>

      {error ? <p className="dash-error" role="alert">{error}</p> : null}

      {report ? (
        <>
          {/* A nonzero gap is shown as a nonzero gap. This page never rounds
              it away, hides it behind a tolerance, or explains it as expected —
              the endpoint reports honestly and so does this. */}
          <div className="dash-recon-head">
            {report.explained ? (
              <span className="dash-stamp dash-stamp-ok">Reconciled — no gap</span>
            ) : (
              <span className="dash-stamp dash-stamp-gap">Gap: {bhd(report.gapFils)}</span>
            )}
            <span className="dash-figure">
              <span className="dash-figure-label">Period (Bahrain business days)</span>
              <span>
                {calendarDate(report.periodFrom)} to {calendarDate(inclusiveTo(report.periodTo))}, both days included
              </span>
            </span>
          </div>

          <dl className="dash-dl dash-dl-money">
            <dt>
              Owed to you (net)
              <span className="dash-dt-help">Your sales less fees and refunds, as our books record them.</span>
            </dt>
            <dd className="dash-money">{bhd(report.ledgerMerchantPayableNetFils)}</dd>
            <dt>
              Paid out (net)
              <span className="dash-dt-help">What the payouts (settlement batches) in this period paid you.</span>
            </dt>
            <dd className="dash-money">{bhd(report.settlementNetPayoutFils)}</dd>
            <dt>
              Not yet in a payout
              <span className="dash-dt-help">
                {report.pendingUnbatchedFils < 0
                  ? "Negative: refunds waiting for the next payout are more than the sales waiting for it."
                  : "Money waiting for the next payout."}
              </span>
            </dt>
            <dd className="dash-money">{bhd(report.pendingUnbatchedFils)}</dd>
            <dt>Happened in this period, settled by a later batch</dt>
            <dd className="dash-money">{bhd(report.carriedToLaterBatchFils)}</dd>
            <dt>Happened earlier, settled by a batch in this period</dt>
            <dd className="dash-money">{bhd(report.carriedFromEarlierDaysFils)}</dd>
            <dt className="dash-dl-total">Gap</dt>
            <dd className={report.gapFils === 0 ? "dash-money dash-dl-total" : "dash-money dash-dl-total dash-negative"}>
              {bhd(report.gapFils)}
            </dd>
          </dl>

          <p className="dash-note">
            Gap = owed to you − paid out − not yet in a payout − settled by a later batch + happened earlier. A zero gap
            means every captured fil is accounted for in either a settled batch
            or the pending queue. A late capture or refund is settled by the
            next batch, so it shows in both carried lines, one on each day.
          </p>
        </>
      ) : null}

      {loading && !report ? <p className="dash-loading" role="status">Loading…</p> : null}
    </section>
  );
}

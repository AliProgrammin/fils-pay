import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getPayoutTrends, getTopLinks, getVolumes } from "../../api/analytics.js";
import { errorMessage } from "../../errors.js";
import { StatusChip } from "../../components/StatusChip.js";
import { StalenessBadge } from "../../components/StalenessBadge.js";
import { bhd, calendarDate, dash, dateTime } from "../../format.js";
import { formatCount } from "../../utils/helpers.js";
import { DateRangeFields } from "../../components/DateRangeFields.js";
import { bahrainToday, exclusiveTo, rangeError } from "../../dateRange.js";
import type { PayoutTrendsResponse, TopLinksResponse, VolumesResponse } from "../../types.js";

/** 60s: comfortably above the reporting worker's 15s worst-case lag, and
 *  more than often enough for a dashboard. Poll, not push —
 *  there is no websocket or SSE anywhere in this platform, and this page does
 *  not introduce the first one. */
const POLL_MS = 60_000;

/** The API takes 1 to 50 top links (analytics/query.ts); offer a few sizes. */
const TOP_LINKS_CHOICES = [5, 10, 20, 50] as const;

export function OverviewPage() {
  // Left blank, the server applies its own "last 30 Asia/Bahrain days"
  // default — the client does not compute a competing one.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // A dropdown, so the value is always one the API accepts as is.
  const [topLinksLimit, setTopLinksLimit] = useState(10);

  const [volumes, setVolumes] = useState<VolumesResponse | null>(null);
  const [payouts, setPayouts] = useState<PayoutTrendsResponse | null>(null);
  const [topLinks, setTopLinks] = useState<TopLinksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const dateError = rangeError(from, to, bahrainToday());

  const load = useCallback(async () => {
    // A bad range shows its message and makes no request.
    if (rangeError(from, to, bahrainToday())) return;
    // "To" is inclusive on screen; the API's `to` is exclusive.
    const range = { from: from || undefined, to: to ? exclusiveTo(to) : undefined };
    setLoading(true);
    setError(null);
    try {
      // Three independent endpoints, three independent fetches — there is no
      // combined route to call.
      const [v, p, t] = await Promise.all([
        getVolumes(range),
        getPayoutTrends(range),
        getTopLinks({ ...range, limit: topLinksLimit }),
      ]);
      setVolumes(v);
      setPayouts(p);
      setTopLinks(t);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [from, to, topLinksLimit]);

  // overview memory leak (heap +40mb/hr), pretty sure its these effects — am
  // FH: profiled for 1h, heap flat. maybe it was a browser extension? open
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const peakGross = Math.max(1, ...(volumes?.points.map((point) => point.capturedGrossFils) ?? [1]));

  return (
    <section>
      <div className="dash-page-head">
        <div>
          <p className="dash-kicker">Analytics · refreshed every minute · blank dates show the last 30 days</p>
          <h1>Overview</h1>
        </div>
      </div>

      <form
        className="dash-form dash-form-inline dash-filters"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <DateRangeFields
          from={from}
          to={to}
          onChange={(range) => {
            setFrom(range.from);
            setTo(range.to);
          }}
          error={dateError}
        />
        <label>
          Top links
          <select value={topLinksLimit} onChange={(e) => setTopLinksLimit(Number(e.target.value))}>
            {TOP_LINKS_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="dash-button dash-button-primary"
          disabled={loading || dateError !== null}
          aria-busy={loading || undefined}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </form>

      {error ? <p className="dash-error" role="alert">{error}</p> : null}
      {loading && !volumes ? <p className="dash-loading" role="status">Loading…</p> : null}

      <h2>
        Captured volume{" "}
        {volumes ? <StalenessBadge readModelAsOf={volumes.readModelAsOf} live={volumes.live} /> : null}
      </h2>
      <div className="dash-table-wrap">
        <table className="dash-table">
          <thead>
            <tr>
              <th>Date</th>
              <th className="dash-num">Captured</th>
              <th className="dash-num">Gross</th>
              <th className="dash-num">Voided</th>
              <th className="dash-num">Refunded</th>
              <th>
                <span className="dash-visually-hidden">Gross, relative to the peak day</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {volumes?.points.map((point) => (
              <tr key={point.date}>
                <td className="dash-nowrap">{calendarDate(point.date)}</td>
                <td className="dash-num">{formatCount(point.capturedCount)}</td>
                <td className="dash-num">{bhd(point.capturedGrossFils)}</td>
                <td className="dash-num">{formatCount(point.voidedCount)}</td>
                <td className="dash-num">
                  {formatCount(point.refundCount)} / {bhd(point.refundGrossFils)}
                </td>
                <td className="dash-bar-cell">
                  {/* A plain CSS bar, scaled to the window's own peak — no
                      charting library, no new dependency. */}
                  <span
                    className="dash-bar"
                    style={{ width: `${(point.capturedGrossFils / peakGross) * 100}%` }}
                  />
                </td>
              </tr>
            ))}
            {volumes && volumes.points.length === 0 ? (
              <tr>
                <td colSpan={6} className="dash-empty">No captured volume in this window.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <h2>
        Payout trends{" "}
        {payouts ? <StalenessBadge readModelAsOf={payouts.readModelAsOf} live={payouts.live} /> : null}
      </h2>
      <div className="dash-table-wrap">
        <table className="dash-table">
          <thead>
            <tr>
              <th>Batch date</th>
              <th>Status</th>
              <th className="dash-num">Gross</th>
              <th className="dash-num">Fee</th>
              <th className="dash-num">Net payout</th>
              <th>Paid</th>
            </tr>
          </thead>
          <tbody>
            {payouts?.points.map((point) => (
              <tr key={point.settlementBatchId}>
                <td>
                  <Link to={`/dashboard/settlement/${point.settlementBatchId}`}>{calendarDate(point.batchDate)}</Link>
                </td>
                <td>
                  <StatusChip status={point.status} />
                </td>
                <td className="dash-num">{bhd(point.grossFils)}</td>
                <td className="dash-num">{bhd(point.feeFils)}</td>
                <td className="dash-num">{bhd(point.netPayoutFils)}</td>
                <td className="dash-nowrap">{dateTime(point.paidAt)}</td>
              </tr>
            ))}
            {payouts && payouts.points.length === 0 ? (
              <tr>
                <td colSpan={6} className="dash-empty">No settled batches in this window.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <h2>
        Top paid links{" "}
        {topLinks ? (
          <StalenessBadge readModelAsOf={topLinks.readModelAsOf} live={topLinks.live} />
        ) : null}
      </h2>
      <div className="dash-table-wrap">
        <table className="dash-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Reference</th>
              <th>Description</th>
              <th className="dash-num">Amount</th>
              <th>Paid at</th>
            </tr>
          </thead>
          <tbody>
            {topLinks?.links.map((link, index) => (
              <tr key={link.id}>
                <td>{index + 1}</td>
                <td>
                  <Link to={`/dashboard/payment-links/${link.id}`} className="dash-ref-cut" title={link.reference ?? undefined}>{dash(link.reference)}</Link>
                </td>
                <td>{dash(link.description)}</td>
                <td className="dash-num">{bhd(link.amountFils)}</td>
                <td className="dash-nowrap">{dateTime(link.paidAt)}</td>
              </tr>
            ))}
            {topLinks && topLinks.links.length === 0 ? (
              <tr>
                <td colSpan={5} className="dash-empty">No paid payment links in this window.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

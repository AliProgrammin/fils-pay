import { useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { listSettlementBatches } from "../../api/settlement.js";
import { StatusChip } from "../../components/StatusChip.js";
import { errorMessage } from "../../errors.js";
import { Pager } from "../../components/Pager.js";
import { DateRangeFields } from "../../components/DateRangeFields.js";
import { usePagedList } from "../../components/usePagedList.js";
import { bhd, calendarDate, dateTime, statusLabel } from "../../format.js";
import { bahrainToday, exclusiveTo, rangeError, rangeLabel } from "../../dateRange.js";
import { capitalize } from "../../utils/helpers.js";
import type { SettlementBatchDto, SettlementBatchStatus } from "../../types.js";

const STATUSES: SettlementBatchStatus[] = ["open", "closed", "paid"];

/**
 * `GET /v1/settlement/batches` — any merchant user.
 *
 * `from`/`to` bound `batch_date`, a plain Bahrain business DATE, so the
 * YYYY-MM-DD values go through as dates. "To" is inclusive on screen; the
 * API's `to` is exclusive, so the request sends the day after.
 */
export function SettlementBatchListPage() {
  const [searchParams] = useSearchParams();
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const statuses = searchParams.getAll("status") as SettlementBatchStatus[];
  const dateError = rangeError(from, to, bahrainToday());
  const filterKey = JSON.stringify([from, to, statuses]);

  const list = usePagedList<SettlementBatchDto>(
    filterKey,
    useCallback(
      async (cursor, limit) => {
        const result = await listSettlementBatches({
          from: from || undefined,
          to: to ? exclusiveTo(to) : undefined,
          status: statuses.length > 0 ? statuses : undefined,
          limit,
          cursor,
        });
        return { rows: result.batches, nextCursor: result.nextCursor };
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [filterKey],
    ),
    dateError === null,
  );
  const batches = dateError ? [] : list.rows;
  const loading = !dateError && list.loading;

  function toggleStatus(status: SettlementBatchStatus): void {
    list.updateParams((params) => {
      const next = statuses.includes(status) ? statuses.filter((s) => s !== status) : [...statuses, status];
      params.delete("status");
      for (const s of next) params.append("status", s);
    });
  }

  function setRange(range: { from: string; to: string }): void {
    list.updateParams((params) => {
      if (range.from) params.set("from", range.from);
      else params.delete("from");
      if (range.to) params.set("to", range.to);
      else params.delete("to");
    });
  }

  function clearFilters(): void {
    list.updateParams((params) => {
      for (const key of ["status", "from", "to"]) params.delete(key);
    });
  }

  const activeFilters = [
    statuses.length > 0 ? statuses.map((s) => capitalize(statusLabel(s))).join(", ") : "",
    rangeLabel(from, to),
  ].filter(Boolean);

  return (
    <section>
      <div className="dash-page-head">
        <div>
          <p className="dash-kicker">Payouts · daily batches</p>
          <h1>Settlement batches</h1>
        </div>
      </div>

      <fieldset className="dash-filters">
        <legend>Batch date</legend>
        <DateRangeFields from={from} to={to} onChange={setRange} error={dateError} />
        {activeFilters.length > 0 ? (
          <button type="button" className="dash-button dash-button-small dash-clear" onClick={clearFilters}>
            Clear filters
          </button>
        ) : null}
      </fieldset>

      <fieldset className="dash-filters">
        <legend>Status</legend>
        {STATUSES.map((status) => (
          <label key={status} className="dash-pill">
            <input
              type="checkbox"
              checked={statuses.includes(status)}
              onChange={() => toggleStatus(status)}
            />
            {statusLabel(status)}
          </label>
        ))}
      </fieldset>

      {list.error && !dateError ? <p className="dash-error" role="alert">{errorMessage(list.error)}</p> : null}

      <div className="dash-table-wrap">
        <table className="dash-table dash-table-cards" aria-busy={loading}>
          <thead>
            <tr>
              <th>Batch date</th>
              <th>Status</th>
              <th className="dash-num">Gross</th>
              <th className="dash-num">Fee</th>
              <th className="dash-num">Refunds</th>
              <th className="dash-num">Net payout</th>
              <th>Closed</th>
              <th>Paid</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((batch) => (
              <tr key={batch.id}>
                <td className="dash-nowrap" data-label="Batch date">
                  <Link to={`/dashboard/settlement/${batch.id}`}>{calendarDate(batch.batchDate)}</Link>
                </td>
                <td data-label="Status">
                  <StatusChip status={batch.status} />
                </td>
                <td className="dash-num" data-label="Gross">{bhd(batch.grossFils)}</td>
                <td className="dash-num" data-label="Fee">{bhd(batch.feeFils)}</td>
                <td className="dash-num" data-label="Refunds">{bhd(batch.refundFeeReversedFils - batch.refundFils)}</td>
                <td className="dash-num dash-strong" data-label="Net payout">{bhd(batch.netPayoutFils)}</td>
                <td className="dash-nowrap" data-label="Closed">{dateTime(batch.closedAt)}</td>
                <td className="dash-nowrap" data-label="Paid">{dateTime(batch.paidAt)}</td>
              </tr>
            ))}
            {batches.length === 0 && !loading && !list.error ? (
              <tr>
                <td colSpan={8} className="dash-empty">
                  {dateError ? (
                    "Fix the dates above to see payouts."
                  ) : activeFilters.length > 0 ? (
                    <>
                      No settlement batches match: {activeFilters.join(" · ")}.{" "}
                      <button type="button" className="dash-text-button" onClick={clearFilters}>
                        Clear filters
                      </button>
                    </>
                  ) : (
                    "No settlement batches yet."
                  )}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {loading ? <p className="dash-loading" role="status">Loading…</p> : null}

      {!dateError ? (
        <Pager
          page={list.page}
          size={list.size}
          count={batches.length}
          hasNext={list.hasNext}
          loading={loading}
          onPrev={list.goPrev}
          onNext={list.goNext}
          onSize={list.setSize}
        />
      ) : null}
    </section>
  );
}

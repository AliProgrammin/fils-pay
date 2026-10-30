import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { listTransactions } from "../../api/transactions.js";
import { StatusChip } from "../../components/StatusChip.js";
import { errorMessage } from "../../errors.js";
import { Pager } from "../../components/Pager.js";
import { DateRangeFields } from "../../components/DateRangeFields.js";
import { CopyButton } from "../../components/CopyButton.js";
import { usePagedList } from "../../components/usePagedList.js";
import { bhd, dash, dateTime, statusLabel } from "../../format.js";
import { bahrainDayStartIso, bahrainToday, exclusiveTo, rangeError, rangeLabel } from "../../dateRange.js";
import { capitalize } from "../../utils/helpers.js";
import type { TransactionDto, TransactionStatus } from "../../types.js";

const STATUSES: TransactionStatus[] = [
  "authorized",
  "captured",
  "partially_captured",
  "voided",
  "partially_refunded",
  "refunded",
  "chargeback",
];

const SEARCH_DEBOUNCE_MS = 300;

/**
 * `GET /v1/transactions`. Every control here is a real server-side query
 * param. Filters, page and page size live in the URL (`status`, `from`, `to`,
 * `q`, `page`, `size`), so reload and back/forward keep the place.
 *
 * "To" is inclusive on screen; the API's `to` is exclusive, so the request
 * sends the Bahrain midnight that starts the day after.
 */
export function TransactionListPage() {
  const [searchParams] = useSearchParams();
  const statuses = searchParams.getAll("status") as TransactionStatus[];
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const search = searchParams.get("q") ?? "";
  const dateError = rangeError(from, to, bahrainToday());
  // The list's identity: filters only (page and size belong to the pager).
  const filterKey = JSON.stringify([statuses, from, to, search]);

  const list = usePagedList<TransactionDto>(
    filterKey,
    useCallback(
      async (cursor, limit) => {
        const result = await listTransactions({
          status: statuses.length > 0 ? statuses : undefined,
          from: from ? bahrainDayStartIso(from) : undefined,
          to: to ? bahrainDayStartIso(exclusiveTo(to)) : undefined,
          search: search || undefined,
          limit,
          cursor,
        });
        return { rows: result.transactions, nextCursor: result.nextCursor };
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [filterKey],
    ),
    // A bad date range makes no request at all.
    dateError === null,
  );
  const { updateParams } = list;

  // The search box types freely; the URL follows after a short pause.
  const [searchInput, setSearchInput] = useState(search);
  useEffect(() => setSearchInput(search), [search]);
  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === search) return;
    const timer = window.setTimeout(
      () =>
        updateParams(
          (params) => (trimmed ? params.set("q", trimmed) : params.delete("q")),
          { replace: true },
        ),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [searchInput, search, updateParams]);

  function toggleStatus(status: TransactionStatus): void {
    updateParams((params) => {
      const next = statuses.includes(status) ? statuses.filter((s) => s !== status) : [...statuses, status];
      params.delete("status");
      for (const s of next) params.append("status", s);
    });
  }

  function setRange(range: { from: string; to: string }): void {
    updateParams((params) => {
      if (range.from) params.set("from", range.from);
      else params.delete("from");
      if (range.to) params.set("to", range.to);
      else params.delete("to");
    });
  }

  function clearFilters(): void {
    setSearchInput("");
    updateParams((params) => {
      for (const key of ["status", "from", "to", "q"]) params.delete(key);
    });
  }

  const activeFilters = [
    statuses.length > 0 ? statuses.map((s) => capitalize(statusLabel(s))).join(", ") : "",
    rangeLabel(from, to),
    search ? `search '${search}'` : "",
  ].filter(Boolean);
  const hasFilters = activeFilters.length > 0;
  const rows = dateError ? [] : list.rows;
  const loading = !dateError && list.loading;

  return (
    <section>
      <div className="dash-page-head">
        <div>
          <p className="dash-kicker">Payments · case log</p>
          <h1>Transactions</h1>
        </div>
      </div>

      <fieldset className="dash-filters">
        <legend>Status</legend>
        {STATUSES.map((status) => (
          <label key={status} className="dash-pill">
            <input type="checkbox" checked={statuses.includes(status)} onChange={() => toggleStatus(status)} />
            {statusLabel(status)}
          </label>
        ))}
      </fieldset>

      <fieldset className="dash-filters">
        <legend>Filter</legend>
        <DateRangeFields from={from} to={to} onChange={setRange} error={dateError} />
        <label className="dash-field">
          Search
          <input
            type="search"
            placeholder="Reference, bank reference, or transaction ID"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </label>
        {hasFilters ? (
          <button type="button" className="dash-button dash-button-small dash-clear" onClick={clearFilters}>
            Clear filters
          </button>
        ) : null}
      </fieldset>

      {list.error && !dateError ? <p className="dash-error" role="alert">{errorMessage(list.error)}</p> : null}

      <p className="dash-toolbar">
        <span>{hasFilters ? `Filtered: ${activeFilters.join(" · ")}` : "All payments"}</span>
        <span>Amounts in BHD</span>
      </p>

      <div className="dash-table-wrap">
        <table className="dash-table dash-table-cards" aria-busy={loading}>
          <thead>
            <tr>
              <th>Occurred</th>
              <th>Reference</th>
              <th>Status</th>
              <th className="dash-num">Authorized</th>
              <th className="dash-num">Captured</th>
              <th className="dash-num">Refunded</th>
              <th>Bank reference</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((txn) => (
              <tr key={txn.id}>
                <td className="dash-nowrap" data-label="Occurred">
                  <Link to={`/dashboard/transactions/${txn.id}`}>{dateTime(txn.occurredAt)}</Link>
                </td>
                <td data-label="Reference">{dash(txn.reference)}</td>
                <td data-label="Status">
                  <StatusChip status={txn.status} />
                </td>
                <td className="dash-num" data-label="Authorized">{bhd(txn.amountFils)}</td>
                <td className="dash-num" data-label="Captured">{bhd(txn.capturedFils)}</td>
                <td className="dash-num" data-label="Refunded">
                  {txn.refundedFils > 0 ? bhd(txn.refundedFils) : "—"}
                </td>
                <td data-label="Bank reference" className="dash-td-stack">
                  <span className="dash-ref">
                    <code className="dash-ref-text" title={txn.acquirerReference}>
                      {txn.acquirerReference}
                    </code>
                    <CopyButton
                      value={txn.acquirerReference}
                      copiedMessage="Bank reference copied"
                      ariaLabel={`Copy bank reference ${txn.acquirerReference}`}
                    />
                  </span>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && !list.error ? (
              <tr>
                <td colSpan={7} className="dash-empty">
                  {dateError ? (
                    "Fix the dates above to see payments."
                  ) : hasFilters ? (
                    <>
                      No payments match: {activeFilters.join(" · ")}.{" "}
                      <button type="button" className="dash-text-button" onClick={clearFilters}>
                        Clear filters
                      </button>
                    </>
                  ) : (
                    "No payments yet."
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
          count={rows.length}
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

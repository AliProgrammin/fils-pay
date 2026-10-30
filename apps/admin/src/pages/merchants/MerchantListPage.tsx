import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { listMerchants } from "../../api/merchants.js";
import { bulkApproveKyc } from "../../api/merchantsBulk.js";
import { errorMessage } from "../../errors.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { StatusChip } from "../../components/StatusChip.js";
import { formatDate, label } from "../../format.js";
import { Pager } from "../../components/Pager.js";
import { usePagedList } from "../../components/usePagedList.js";
import { useAction } from "../../components/useAction.js";
import { useToast } from "../../components/Toast.js";
import type { AdminMerchantSummary, MerchantOnboardingStatus } from "../../types.js";
import { SEARCH_MAX } from "../../inputRules.js";

const ONBOARDING_STATUSES: MerchantOnboardingStatus[] = [
  "submitted",
  "under_review",
  "approved",
  "rejected",
];

/** The platform's one legitimately cross-merchant view. Searchable by
 *  display name / id / contact email, filterable by onboarding status, and
 *  keyset-paginated like every other list endpoint here. */
export function MerchantListPage() {
  const notify = useToast();
  const [searchParams] = useSearchParams();
  const appliedQuery = searchParams.get("q") ?? "";
  const statuses = searchParams
    .getAll("status")
    .filter((s): s is MerchantOnboardingStatus => (ONBOARDING_STATUSES as string[]).includes(s));
  const [query, setQuery] = useState(appliedQuery);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, runBulk] = useAction();
  const [bulkError, setBulkError] = useState<string | null>(null);

  // Keep the box in step with the URL (back/forward, Clear filters).
  useEffect(() => setQuery(appliedQuery), [appliedQuery]);

  const filterKey = JSON.stringify([appliedQuery, statuses]);
  const list = usePagedList<AdminMerchantSummary>(filterKey, async (cursor, limit) => {
    const result = await listMerchants({
      q: appliedQuery || undefined,
      onboardingStatus: statuses.length > 0 ? statuses : undefined,
      limit,
      cursor,
    });
    return { rows: result.merchants ?? [], nextCursor: result.nextCursor ?? null };
  });
  const merchants = list.rows;
  const loading = list.loading;
  const error = list.error ? errorMessage(list.error) : bulkError;
  const hasFilters = appliedQuery !== "" || statuses.length > 0;

  function toggleStatus(status: MerchantOnboardingStatus): void {
    list.updateParams((params) => {
      const next = statuses.includes(status) ? statuses.filter((s) => s !== status) : [...statuses, status];
      params.delete("status");
      for (const s of next) params.append("status", s);
    });
  }

  function clearFilters(): void {
    list.updateParams((params) => {
      params.delete("q");
      params.delete("status");
    });
  }

  function toggleSelected(id: string): void {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** Header checkbox: select or clear every row currently loaded into the
   *  table, i.e. exactly what the operator can see under the active
   *  search/status filters. */
  function toggleSelectAllLoaded(): void {
    setSelectedIds((previous) =>
      merchants.every((m) => previous.has(m.id)) ? new Set() : new Set(merchants.map((m) => m.id)),
    );
  }

  // Sends every selected id; the server approves only the under_review ones
  // and writes a review row for each (A11).
  async function approveSelected(): Promise<void> {
    await runBulk(async () => {
      setBulkError(null);
      try {
        const result = await bulkApproveKyc([...selectedIds]);
        notify(`KYC approved for ${result.approvedCount} merchant${result.approvedCount === 1 ? "" : "s"}`);
        setSelectedIds(new Set());
        list.reload();
      } catch (err) {
        setBulkError(errorMessage(err));
      }
    });
  }

  const allLoadedSelected = merchants.length > 0 && merchants.every((m) => selectedIds.has(m.id));

  return (
    <section>
      <header className="admin-page-head">
        <p className="admin-kicker">Case files · All merchants</p>
        <h1>Merchants</h1>
        <p className="admin-lede">
          Every merchant on the platform. Search by name, id or contact email, filter by onboarding
          status, and open a merchant to change its rate, refunds, balance or credits.
        </p>
      </header>

      <form
        className="admin-form admin-form-inline"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = query.trim();
          list.updateParams((params) => {
            if (trimmed) params.set("q", trimmed);
            else params.delete("q");
          });
        }}
      >
        <label>
          Search
          <input
            type="search"
            maxLength={SEARCH_MAX}
            spellCheck={false}
            placeholder="Display name, merchant id, or contact email"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button type="submit" className="admin-btn-primary">Search</button>
        {hasFilters ? (
          <button type="button" onClick={clearFilters}>
            Clear filters
          </button>
        ) : null}
      </form>

      <fieldset className="admin-filters">
        <legend>Onboarding status</legend>
        {ONBOARDING_STATUSES.map((status) => (
          <label key={status}>
            <input
              type="checkbox"
              checked={statuses.includes(status)}
              onChange={() => toggleStatus(status)}
            />
            {label(status)}
          </label>
        ))}
      </fieldset>

      {error ? <p className="admin-error" role="alert">{error}</p> : null}

      {selectedIds.size > 0 ? (
        <div className="admin-bulkbar">
          <strong>{selectedIds.size} selected</strong>
          <RequireRole allow={["finance", "super_admin"]}>
            <button
              type="button"
              className="admin-btn-danger"
              disabled={bulkBusy}
              onClick={() => void approveSelected()}
            >
              {bulkBusy ? "Approving…" : "Bulk approve KYC"}
            </button>
          </RequireRole>
          <button type="button" disabled={bulkBusy} onClick={() => setSelectedIds(new Set())}>
            Clear selection
          </button>
        </div>
      ) : null}

      <div className="admin-table-wrap">
        <table className="admin-table admin-table-cards">
          <thead>
            <tr>
              <th className="admin-cell-check">
                <input
                  type="checkbox"
                  aria-label="Select all merchants on this page"
                  checked={allLoadedSelected}
                  disabled={merchants.length === 0}
                  onChange={toggleSelectAllLoaded}
                />
              </th>
              <th>Merchant</th>
              <th>Status</th>
              <th>Onboarding</th>
              <th>KYC</th>
              <th className="admin-num" title="The merchant\u2019s base rate. A negotiated rate in force is shown on the merchant page.">Base MDR</th>
              <th>Refunds</th>
              <th>Mode</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {merchants.map((merchant) => (
              <tr key={merchant.id}>
                <td className="admin-cell-check">
                  <input
                    type="checkbox"
                    aria-label={`Select ${merchant.displayName}`}
                    checked={selectedIds.has(merchant.id)}
                    onChange={() => toggleSelected(merchant.id)}
                  />
                </td>
                <td className="admin-card-head">
                  <Link to={`/merchants/${merchant.id}`}>{merchant.displayName}</Link>
                  <div className="admin-sub">
                    <code>{merchant.id}</code>
                  </div>
                </td>
                <td data-label="Status"><StatusChip value={merchant.status} /></td>
                <td data-label="Onboarding"><StatusChip value={merchant.onboardingStatus} /></td>
                <td data-label="KYC"><StatusChip value={merchant.kycPassed ? "passed" : "not passed"} /></td>
                <td className="admin-num" data-label="Base MDR">{(merchant.mdrBps / 100).toFixed(2)}%</td>
                <td data-label="Refunds"><StatusChip value={merchant.refundsEnabled ? "on" : "on hold"} tone={merchant.refundsEnabled ? "ok" : "bad"} /></td>
                <td data-label="Mode"><StatusChip value={merchant.testMode ? "test" : "live"} /></td>
                <td data-label="Created">{formatDate(merchant.createdAt)}</td>
                <td className="admin-card-link">
                  <Link to={`/merchants/${merchant.id}`} aria-label={`Open ${merchant.displayName}`}>
                    Open merchant &rarr;
                  </Link>
                </td>
              </tr>
            ))}
            {merchants.length === 0 && !loading ? (
              <tr>
                <td colSpan={9} className="admin-empty">
                  {hasFilters ? (
                    <>
                      No merchants match these filters.{" "}
                      <button type="button" className="admin-btn-small" onClick={clearFilters}>
                        Clear filters
                      </button>
                    </>
                  ) : (
                    "No merchants yet."
                  )}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {loading ? <p className="admin-loading" role="status">Loading merchants…</p> : null}

      <Pager
        page={list.page}
        size={list.size}
        count={merchants.length}
        hasNext={list.hasNext}
        loading={loading}
        onPrev={list.goPrev}
        onNext={list.goNext}
        onSize={list.setSize}
      />
    </section>
  );
}

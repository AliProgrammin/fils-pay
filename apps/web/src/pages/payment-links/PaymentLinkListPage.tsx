import { useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { listPaymentLinks } from "../../api/paymentLinks.js";
import { StatusChip } from "../../components/StatusChip.js";
import { errorMessage } from "../../errors.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { Pager } from "../../components/Pager.js";
import { usePagedList } from "../../components/usePagedList.js";
import { bhd, dash, dateTime, statusLabel } from "../../format.js";
import { capitalize } from "../../utils/helpers.js";
import type { PaymentLinkDto, PaymentLinkStatus } from "../../types.js";

/** The four *stored* statuses, including `reserved` — the merchant-facing
 *  list deliberately exposes it distinctly rather than collapsing it into the
 *  public enum's `processing`, because a merchant needs to see that a link is
 *  mid-payment-attempt. */
const STATUSES: PaymentLinkStatus[] = ["active", "reserved", "paid", "canceled"];

/** Keyset paginated, newest first. Status filter, page and size live in the
 *  URL query. */
export function PaymentLinkListPage() {
  const { me } = useDashboardAuth();
  const merchantId = me?.merchant.id;
  const [searchParams] = useSearchParams();
  const statuses = searchParams.getAll("status") as PaymentLinkStatus[];
  const filterKey = JSON.stringify([merchantId, statuses]);

  const list = usePagedList<PaymentLinkDto>(
    filterKey,
    useCallback(
      async (cursor, limit) => {
        const result = await listPaymentLinks(merchantId!, {
          status: statuses.length > 0 ? statuses : undefined,
          limit,
          cursor,
        });
        return { rows: result.paymentLinks, nextCursor: result.nextCursor };
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [filterKey],
    ),
    Boolean(merchantId),
  );
  const links = list.rows;
  const loading = list.loading;

  function toggleStatus(status: PaymentLinkStatus): void {
    list.updateParams((params) => {
      const next = statuses.includes(status) ? statuses.filter((s) => s !== status) : [...statuses, status];
      params.delete("status");
      for (const s of next) params.append("status", s);
    });
  }

  function clearFilters(): void {
    list.updateParams((params) => params.delete("status"));
  }

  return (
    <section>
      <div className="dash-page-head">
        <div>
          <p className="dash-kicker">Get paid · shareable checkout</p>
          <h1>Payment links</h1>
        </div>
        <RequireRole allow={["owner", "finance"]}>
          <Link className="dash-button-link dash-button-primary" to="/dashboard/payment-links/new">
            New payment link
          </Link>
        </RequireRole>
      </div>

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

      {list.error ? <p className="dash-error" role="alert">{errorMessage(list.error)}</p> : null}

      <div className="dash-table-wrap">
        <table className="dash-table dash-table-cards" aria-busy={loading}>
          <thead>
            <tr>
              <th>Reference</th>
              <th>Description</th>
              <th className="dash-num">Amount</th>
              <th>Status</th>
              <th>Expires</th>
              <th>Paid</th>
              <th>Canceled</th>
            </tr>
          </thead>
          <tbody>
            {links.map((link) => (
              <tr key={link.id}>
                <td data-label="Reference">
                  <Link to={`/dashboard/payment-links/${link.id}`}>{dash(link.reference)}</Link>
                </td>
                <td data-label="Description">{dash(link.description)}</td>
                <td className="dash-num" data-label="Amount">{bhd(link.amountFils)}</td>
                <td data-label="Status">
                  <StatusChip status={link.status} />
                </td>
                <td className="dash-nowrap" data-label="Expires">{dateTime(link.expiresAt)}</td>
                <td className="dash-nowrap" data-label="Paid">{dateTime(link.paidAt)}</td>
                <td className="dash-nowrap" data-label="Canceled">{dateTime(link.canceledAt)}</td>
              </tr>
            ))}
            {links.length === 0 && !loading && !list.error ? (
              <tr>
                <td colSpan={7} className="dash-empty">
                  {statuses.length > 0 ? (
                    <>
                      No payment links match: {statuses.map((s) => capitalize(statusLabel(s))).join(", ")}.{" "}
                      <button type="button" className="dash-text-button" onClick={clearFilters}>
                        Clear filters
                      </button>
                    </>
                  ) : (
                    <span className="dash-empty-first">
                      No payment links yet.
                      <RequireRole allow={["owner", "finance"]}>
                        <Link className="dash-button-link dash-button-primary" to="/dashboard/payment-links/new">
                          Create your first payment link
                        </Link>
                      </RequireRole>
                    </span>
                  )}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {loading ? <p className="dash-loading" role="status">Loading…</p> : null}

      <Pager
        page={list.page}
        size={list.size}
        count={links.length}
        hasNext={list.hasNext}
        loading={loading}
        onPrev={list.goPrev}
        onNext={list.goNext}
        onSize={list.setSize}
      />
    </section>
  );
}

import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  approveCreditRequest,
  listCreditRequests,
  rejectCreditRequest,
} from "../../api/credits.js";
import { errorMessage } from "../../errors.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { StatusChip } from "../../components/StatusChip.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { bhd, formatBusinessDate } from "../../format.js";
import { Pager } from "../../components/Pager.js";
import { usePagedList } from "../../components/usePagedList.js";
import { useAction } from "../../components/useAction.js";
import { useToast } from "../../components/Toast.js";
import type { CreditRequestDto, CreditRequestStatus } from "../../types.js";

const STATUS_TABS: Array<{ value: CreditRequestStatus; label: string }> = [
  { value: "pending_approval", label: "Awaiting approval" },
  { value: "posted", label: "Posted" },
  { value: "rejected", label: "Rejected" },
];

/**
 * The checker half of maker-checker: every credit waiting on a second
 * operator, plus the history of what was posted or declined.
 *
 * Approve and Reject are wrapped in `RequireRole` so a support operator
 * isn't shown a control that would answer 403 — the gate itself lives on the
 * route, server-side.
 */
// approve is gated server side but issuing (MerchantDetail) only in the ui? — am
// MK: both are server-side
export function CreditsPage() {
  const notify = useToast();
  const [searchParams] = useSearchParams();
  const rawStatus = searchParams.get("status");
  const status: CreditRequestStatus = STATUS_TABS.some((tab) => tab.value === rawStatus)
    ? (rawStatus as CreditRequestStatus)
    : "pending_approval";
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, runAction] = useAction();
  const [rejectReason, setRejectReason] = useState("");
  const [pendingReject, setPendingReject] = useState<string | null>(null);

  const list = usePagedList<CreditRequestDto>(status, async (cursor, limit) => {
    const page = await listCreditRequests({ status, limit, cursor });
    return { rows: page.items ?? [], nextCursor: page.nextCursor };
  });
  const items = list.rows;
  const loading = list.loading;
  const loadError = list.error ? errorMessage(list.error) : null;

  function selectTab(value: CreditRequestStatus): void {
    setActionError(null);
    list.updateParams((params) => {
      if (value === "pending_approval") params.delete("status");
      else params.set("status", value);
    });
  }

  async function handleApprove(id: string): Promise<void> {
    await runAction(async () => {
      setBusyId(id);
      setActionError(null);
      try {
        const record = await approveCreditRequest(id);
        notify(`Credit approved. ${bhd(record.postedAmountFils)} added to the merchant's balance`);
        list.reload();
      } catch (err) {
        setActionError(errorMessage(err));
      } finally {
        setBusyId(null);
      }
    });
  }

  async function handleReject(id: string): Promise<void> {
    await runAction(async () => {
      setBusyId(id);
      setActionError(null);
      try {
        await rejectCreditRequest(id, rejectReason.trim() ? rejectReason.trim() : undefined);
        notify("Credit rejected. No money was moved");
        setPendingReject(null);
        setRejectReason("");
        list.reload();
      } catch (err) {
        setActionError(errorMessage(err));
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <section>
      <header className="admin-page-head">
        <p className="admin-kicker">Maker-checker · Money movement</p>
        <h1>Merchant credits</h1>
        <p className="admin-lede">
          A manual credit adds money to a merchant&apos;s balance and is recorded in the ledger like
          any other payment. A credit above the approval limit waits here until a second finance
          admin — not the one who raised it — approves it.
        </p>
      </header>

      <nav className="admin-tabs" aria-label="Credit request status">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            aria-current={tab.value === status ? "page" : undefined}
            disabled={tab.value === status}
            onClick={() => selectTab(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {loadError ? <p className="admin-error" role="alert">{loadError}</p> : null}
      {actionError && !pendingReject ? <p className="admin-error" role="alert">{actionError}</p> : null}

      {loading && items.length === 0 ? (
        <p className="admin-loading" role="status">Loading credit requests…</p>
      ) : items.length === 0 ? (
        <p className="admin-empty">
          {status === "pending_approval"
            ? "Nothing is waiting for a second approver."
            : "Nothing here."}
        </p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Requested by</th>
                <th>Merchant ID</th>
                <th>Reason</th>
                <th className="admin-num">Base</th>
                <th className="admin-num">Fee reversal</th>
                <th className="admin-num">Posted total</th>
                <th>Effective date</th>
                <th>Approved by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.requestedByDisplayName}</td>
                  <td>
                    <Link to={`/merchants/${item.merchantId}`} title={`Open merchant ${item.merchantId}`}>
                      <code>{item.merchantId.slice(0, 8)}…</code>
                    </Link>
                  </td>
                  <td>
                    <StatusChip value={item.reasonCode} tone="neutral" />
                    {item.memo ? <div className="admin-sub">{item.memo}</div> : null}
                  </td>
                  <td className="admin-num">{bhd(item.baseAmountFils)}</td>
                  <td className="admin-num">
                    {item.feeReversalFils > 0 ? bhd(item.feeReversalFils) : "-"}
                  </td>
                  <td className="admin-num admin-strong">{bhd(item.postedAmountFils)}</td>
                  <td>{formatBusinessDate(item.effectiveDate)}</td>
                  <td>{item.approvedByDisplayName ?? "-"}</td>
                  <td className="admin-cell-actions">
                    {item.status === "pending_approval" ? (
                      <RequireRole
                        allow={["finance", "super_admin"]}
                        fallback={<span className="admin-muted">finance role required</span>}
                      >
                        <div className="admin-actions">
                          <button
                            type="button"
                            className="admin-btn-primary admin-btn-small"
                            disabled={busyId !== null}
                            aria-busy={busyId === item.id}
                            onClick={() => void handleApprove(item.id)}
                          >
                            {busyId === item.id && !pendingReject ? "Approving…" : "Approve"}
                          </button>
                          <button
                            type="button"
                            className="admin-btn-small"
                            disabled={busyId !== null}
                            onClick={() => setPendingReject(item.id)}
                          >
                            Reject
                          </button>
                        </div>
                      </RequireRole>
                    ) : (
                      <StatusChip value={item.status} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pendingReject ? (
        <ConfirmDialog
          title="Reject this credit request?"
          confirmLabel="Yes, reject it"
          busyLabel="Rejecting…"
          busy={busyId === pendingReject}
          error={actionError}
          onConfirm={() => void handleReject(pendingReject)}
          onCancel={() => {
            setPendingReject(null);
            setRejectReason("");
          }}
        >
          <p>No money is moved, and the request cannot be approved afterwards.</p>
          {(() => {
            const item = items.find((i) => i.id === pendingReject);
            return item ? (
              <dl className="admin-dialog-facts">
                <dt>Merchant ID</dt>
                <dd>
                  <code>{item.merchantId}</code>
                </dd>
                <dt>Requested by</dt>
                <dd>{item.requestedByDisplayName}</dd>
                <dt>Posted total</dt>
                <dd className="admin-num">
                  {bhd(item.postedAmountFils)}
                </dd>
              </dl>
            ) : null;
          })()}
          <label>
            Reason (optional — recorded in the admin audit log)
            <input
              type="text"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </label>
        </ConfirmDialog>
      ) : null}

      <Pager
        page={list.page}
        size={list.size}
        count={items.length}
        hasNext={list.hasNext}
        loading={loading}
        onPrev={list.goPrev}
        onNext={list.goNext}
        onSize={list.setSize}
      />
    </section>
  );
}

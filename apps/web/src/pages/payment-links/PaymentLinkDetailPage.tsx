import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { cancelPaymentLink, listPaymentLinks } from "../../api/paymentLinks.js";
import { StatusChip } from "../../components/StatusChip.js";
import { errorMessage } from "../../errors.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd, dash, dateTime } from "../../format.js";
import { useConfirmDialog } from "../../components/ConfirmDialog.js";
import { CopyButton } from "../../components/CopyButton.js";
import { useToast } from "../../components/Toast.js";
import type { PaymentLinkDto } from "../../types.js";

/** The list endpoint's own maximum page size. */
const LOOKUP_LIMIT = 100;

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; link: PaymentLinkDto };

/**
 * There is no merchant-authenticated `GET .../payment-links/:id` — the API
 * has the merchant-scoped *list* and the *public* single-token read, and nothing
 * in between. So this page reads the first page of the unfiltered list
 * (newest-first, capped at the endpoint's own 100-row maximum) and finds the
 * row by id.
 *
 * That is correct for a merchant with a normal number of links and genuinely
 * degrades for one whose direct-linked link has aged past row 100 — it will
 * render "not found" for a link that exists. It is left this way deliberately
 * rather than papered over with cursor-walking loops: the real fix is a
 * one-row backend route (`SELECT * ... WHERE id = $1 AND merchant_id = $2`,
 * 404 on no match).
 */
export function PaymentLinkDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useDashboardAuth();
  const merchantId = me?.merchant.id;

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [actionError, setActionError] = useState<string | null>(null);
  const notify = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [confirmDialog, confirm] = useConfirmDialog();

  const load = useCallback(async () => {
    if (!merchantId || !id) return;
    try {
      const result = await listPaymentLinks(merchantId, { limit: LOOKUP_LIMIT });
      const found = result.paymentLinks.find((link) => link.id === id);
      setState(found ? { kind: "loaded", link: found } : { kind: "not_found" });
    } catch (err) {
      setState({ kind: "error", message: errorMessage(err) });
    }
  }, [merchantId, id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCancel(): Promise<void> {
    if (!merchantId || !id || state.kind !== "loaded" || submitting) return;
    const confirmed = await confirm({
      title: "Cancel this payment link?",
      amount: bhd(state.link.amountFils),
      message: "It can no longer be paid.",
      confirmLabel: "Cancel link",
      cancelLabel: "Keep link",
    });
    if (!confirmed) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await cancelPaymentLink(merchantId, id);
      notify("Payment link canceled");
      await load();
    } catch (err) {
      // Includes `409 not_cancelable` for a link that is paid, already
      // canceled, or `reserved` mid-payment-attempt.
      setActionError(errorMessage(err, "paymentLinkCancel"));
    } finally {
      setSubmitting(false);
    }
  }

  if (state.kind === "loading") return <p className="dash-loading" role="status">Loading…</p>;
  if (state.kind === "error") {
    return (
      <section>
        <h1>Payment link</h1>
        <p className="dash-error" role="alert">{state.message}</p>
      </section>
    );
  }
  if (state.kind === "not_found") {
    return (
      <section>
        <h1>Payment link not found</h1>
        <p>
          This link is not among your {LOOKUP_LIMIT} most recent payment links.{" "}
          <Link to="/dashboard/payment-links">Back to payment links</Link>
        </p>
      </section>
    );
  }

  const { link } = state;

  return (
    <section>
      {confirmDialog}
      <div className="dash-page-head">
        <div>
          <p className="dash-kicker">Payment link · {dash(link.reference)}</p>
          <h1>Payment link</h1>
        </div>
      </div>

      <div className="dash-card dash-hero">
        <div className="dash-figure dash-figure-main">
          <span className="dash-figure-label">Amount</span>
          <span className="dash-figure-value">{bhd(link.amountFils)}</span>
        </div>
        <div className="dash-figure">
          <span className="dash-figure-label">Status</span>
          <span>
            <StatusChip status={link.status} />
          </span>
        </div>
        <div className="dash-figure">
          <span className="dash-figure-label">Expires</span>
          <span>{dateTime(link.expiresAt)}</span>
        </div>
      </div>

      <dl className="dash-dl">
        <dt>Currency</dt>
        <dd>{link.currency}</dd>
        <dt>Reference</dt>
        <dd>{dash(link.reference)}</dd>
        <dt>Description</dt>
        <dd>{dash(link.description)}</dd>
        <dt>Created at</dt>
        <dd>{dateTime(link.createdAt)}</dd>
        <dt>Paid at</dt>
        <dd>{dateTime(link.paidAt)}</dd>
        <dt>Canceled at</dt>
        <dd>{dateTime(link.canceledAt)}</dd>
        <dt>Link ID</dt>
        <dd>
          <code>{link.id}</code>
        </dd>
        <dt>Transaction</dt>
        <dd>
          {link.transactionId ? (
            <Link to={`/dashboard/transactions/${link.transactionId}`}>
              <code>{link.transactionId}</code>
            </Link>
          ) : (
            "—"
          )}
        </dd>
        <dt>Checkout link</dt>
        <dd>
          {/* Linked to, never duplicated — /pay/:token is the one checkout
              implementation, and there is no preview of it embedded here. */}
          <span className="dash-copy-row">
            <a href={link.url} target="_blank" rel="noreferrer">
              {link.url}
            </a>
            <CopyButton value={link.url} label="Copy link" copiedMessage="Link copied" />
          </span>
        </dd>
      </dl>

      {actionError ? <p className="dash-error" role="alert">{actionError}</p> : null}

      {link.status === "active" ? (
        <RequireRole allow={["owner", "finance"]}>
          <button
            type="button"
            className="dash-button dash-button-danger"
            disabled={submitting}
            aria-busy={submitting || undefined}
            onClick={() => void handleCancel()}
          >
            {submitting ? "Canceling…" : "Cancel payment link"}
          </button>
        </RequireRole>
      ) : null}

      <p className="dash-back">
        <Link to="/dashboard/payment-links">Back to payment links</Link>
      </p>
    </section>
  );
}

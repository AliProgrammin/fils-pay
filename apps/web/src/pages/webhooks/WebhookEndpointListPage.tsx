import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  deleteWebhookEndpoint,
  listWebhookEndpoints,
  updateWebhookEndpoint,
} from "../../api/webhooks.js";
import { StatusChip } from "../../components/StatusChip.js";
import { errorMessage } from "../../errors.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { dateTime } from "../../format.js";
import { useConfirmDialog } from "../../components/ConfirmDialog.js";
import { useToast } from "../../components/Toast.js";
import type { WebhookEndpointDto } from "../../types.js";

/**
 * `GET /v1/merchants/:merchantId/webhook-endpoints`. Unlike most
 * list reads in this platform, this one is `owner`/`finance` only
 * server-side — so a `support` user reaching this page gets a real `403`,
 * which `errorMessage` renders plainly. The nav link is hidden from them too
 * (DashboardLayout), but a typed URL still lands here, and it must explain
 * itself rather than sit on a blank loading state.
 */
export function WebhookEndpointListPage() {
  const { me } = useDashboardAuth();
  const merchantId = me?.merchant.id;

  const [endpoints, setEndpoints] = useState<WebhookEndpointDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ id: string; action: "toggle" | "delete" } | null>(null);
  const [confirmDialog, confirm] = useConfirmDialog();
  const notify = useToast();

  const load = useCallback(async () => {
    if (!merchantId) return;
    setLoading(true);
    setError(null);
    try {
      setEndpoints(await listWebhookEndpoints(merchantId));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [merchantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleToggle(endpoint: WebhookEndpointDto): Promise<void> {
    if (!merchantId || busy) return;
    setBusy({ id: endpoint.id, action: "toggle" });
    setError(null);
    try {
      const turningOff = endpoint.status === "active";
      await updateWebhookEndpoint(merchantId, endpoint.id, {
        status: turningOff ? "disabled" : "active",
      });
      notify(turningOff ? "Webhook disabled" : "Webhook enabled");
      await load();
    } catch (err) {
      setError(errorMessage(err, "webhookUpdate"));
    } finally {
      setBusy(null);
    }
  }

  // delete 500s if the endpoint has deliveries — am
  // MK: fixed in FP-240
  async function handleDelete(endpoint: WebhookEndpointDto): Promise<void> {
    if (!merchantId || busy) return;
    // A hard delete — the endpoint row is gone, while its delivery log
    // outlives it. Irreversible, so it asks first.
    const confirmed = await confirm({
      title: "Delete this endpoint?",
      message: `Delete ${endpoint.url}? This cannot be undone, and its secret cannot be recovered.`,
      confirmLabel: "Delete",
      cancelLabel: "Keep it",
    });
    if (!confirmed) return;
    setBusy({ id: endpoint.id, action: "delete" });
    setError(null);
    try {
      await deleteWebhookEndpoint(merchantId, endpoint.id);
      notify("Webhook endpoint deleted");
      await load();
    } catch (err) {
      setError(errorMessage(err, "webhookUpdate"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      {confirmDialog}
      <div className="dash-page-head">
        <div>
          <p className="dash-kicker">Developers · event delivery</p>
          <h1>Webhook endpoints</h1>
        </div>
        <Link className="dash-button-link dash-button-primary" to="/dashboard/webhooks/new">
          New endpoint
        </Link>
      </div>

      {error ? <p className="dash-error" role="alert">{error}</p> : null}

      <div className="dash-table-wrap">
        <table className="dash-table dash-table-cards">
          <thead>
            <tr>
              <th>URL</th>
              <th>Secret prefix</th>
              <th>Status</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map((endpoint) => (
              <tr key={endpoint.id}>
                <td data-label="URL" className="dash-wrap">
                  <Link to={`/dashboard/webhooks/${endpoint.id}`}>{endpoint.url}</Link>
                </td>
                <td data-label="Secret prefix">
                  <code>{endpoint.secretPrefix}</code>
                </td>
                <td data-label="Status">
                  <StatusChip status={endpoint.status} />
                </td>
                <td className="dash-nowrap" data-label="Created">{dateTime(endpoint.createdAt)}</td>
                <td className="dash-nowrap" data-label="Actions">
                  <button
                    type="button"
                    className="dash-button dash-button-small"
                    disabled={busy !== null}
                    aria-busy={(busy?.id === endpoint.id && busy.action === "toggle") || undefined}
                    onClick={() => void handleToggle(endpoint)}
                  >
                    {busy?.id === endpoint.id && busy.action === "toggle"
                      ? endpoint.status === "active"
                        ? "Disabling…"
                        : "Enabling…"
                      : endpoint.status === "active"
                        ? "Disable"
                        : "Enable"}
                  </button>{" "}
                  <button
                    type="button"
                    className="dash-button dash-button-small dash-button-danger"
                    disabled={busy !== null}
                    aria-busy={(busy?.id === endpoint.id && busy.action === "delete") || undefined}
                    onClick={() => void handleDelete(endpoint)}
                  >
                    {busy?.id === endpoint.id && busy.action === "delete" ? "Deleting…" : "Delete"}
                  </button>
                </td>
              </tr>
            ))}
            {endpoints.length === 0 && !loading && !error ? (
              <tr>
                <td colSpan={5} className="dash-empty">No webhook endpoints registered.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {loading ? <p className="dash-loading" role="status">Loading…</p> : null}
    </section>
  );
}

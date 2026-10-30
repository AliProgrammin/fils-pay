import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { listDeliveries, listWebhookEndpoints, replayDelivery } from "../../api/webhooks.js";
import { StatusChip } from "../../components/StatusChip.js";
import { errorMessage } from "../../errors.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { Pager } from "../../components/Pager.js";
import { usePagedList } from "../../components/usePagedList.js";
import { useToast } from "../../components/Toast.js";
import { dash, dateTime, statusLabel } from "../../format.js";
import type { WebhookDeliveryDto, WebhookDeliveryStatus, WebhookEndpointDto } from "../../types.js";
import { isUuid } from "../../inputRules.js";
import { DetailNotFound } from "../../components/DetailNotFound.js";

/** `webhook_deliveries.status`' four CHECK values. Note the dispatcher only
 *  ever writes `succeeded`/`exhausted` — a row awaiting its next attempt
 *  stays `pending`, so `failed` is present in the schema but currently
 *  unwritten. Offered as a filter anyway, since the filter's job is to match
 *  the column, not the dispatcher's current habits. */
const DELIVERY_STATUSES: WebhookDeliveryStatus[] = ["pending", "succeeded", "failed", "exhausted"];

export function WebhookEndpointDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useDashboardAuth();
  const merchantId = me?.merchant.id;

  const [endpoint, setEndpoint] = useState<WebhookEndpointDto | null>(null);
  // An id that is not a UUID can never exist: "not found" without asking.
  const validId = id !== undefined && isUuid(id);
  const [endpointMissing, setEndpointMissing] = useState(false);
  const [searchParams] = useSearchParams();
  const statuses = searchParams.getAll("status") as WebhookDeliveryStatus[];
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const notify = useToast();

  // Same "no single-resource GET" situation as payment links: the API has
  // the endpoint list and the deliveries sub-resource, but no
  // `GET .../webhook-endpoints/:id`. Merchants have a handful of endpoints,
  // not hundreds, so finding the row in the list is exact in practice here —
  // unlike the payment-link case, where it can genuinely miss.
  const loadEndpoint = useCallback(async () => {
    if (!merchantId || !id || !validId) return;
    setError(null);
    try {
      const all = await listWebhookEndpoints(merchantId);
      const found = all.find((candidate) => candidate.id === id) ?? null;
      setEndpoint(found);
      setEndpointMissing(found === null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [merchantId, id, validId]);

  const filterKey = JSON.stringify([merchantId, id, statuses]);
  const list = usePagedList<WebhookDeliveryDto>(
    filterKey,
    useCallback(
      async (cursor, limit) => {
        const result = await listDeliveries(merchantId!, id!, {
          status: statuses.length > 0 ? statuses : undefined,
          limit,
          cursor,
        });
        return { rows: result.deliveries, nextCursor: result.nextCursor };
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [filterKey],
    ),
    Boolean(merchantId && validId),
  );
  const deliveries = list.rows;
  const loading = list.loading;

  useEffect(() => {
    void loadEndpoint();
  }, [loadEndpoint]);

  function toggleStatus(status: WebhookDeliveryStatus): void {
    list.updateParams((params) => {
      const next = statuses.includes(status) ? statuses.filter((s) => s !== status) : [...statuses, status];
      params.delete("status");
      for (const s of next) params.append("status", s);
    });
  }

  // busyId blocks a second click. A replay also reuses the original delivery
  // id, so a receiver can dedupe it (D11).
  async function handleReplay(delivery: WebhookDeliveryDto): Promise<void> {
    if (!merchantId || !id || busyId) return;
    setBusyId(delivery.id);
    setError(null);
    try {
      await replayDelivery(merchantId, id, delivery.id);
      notify("Replay queued");
      // The replay is a brand-new `pending` row, newest-first: show page 1
      // fresh, rather than patching what is on screen.
      list.reload();
      if (list.page !== 1) list.updateParams(() => {});
    } catch (err) {
      // `409 endpoint_disabled` is a real race: someone disabled the endpoint
      // between this page loading and the click.
      setError(errorMessage(err, "webhookReplay"));
    } finally {
      setBusyId(null);
    }
  }

  if (!validId || endpointMissing) {
    return (
      <DetailNotFound
        kicker="Webhook endpoint"
        title="Endpoint not found"
        text="No webhook endpoint with this id exists on your account. Check the link, or find it in the list."
        backTo="/dashboard/webhooks"
        backLabel="Back to webhook endpoints"
      />
    );
  }

  return (
    <section>
      <div className="dash-page-head">
        <div>
          <p className="dash-kicker">Webhooks · endpoint</p>
          <h1>Webhook endpoint</h1>
        </div>
      </div>

      {endpoint ? (
        <dl className="dash-dl">
          <dt>URL</dt>
          <dd>{endpoint.url}</dd>
          <dt>Secret prefix</dt>
          <dd>
            <code>{endpoint.secretPrefix}</code>
          </dd>
          <dt>Status</dt>
          <dd>
            <StatusChip status={endpoint.status} />
          </dd>
          <dt>Created at</dt>
          <dd>{dateTime(endpoint.createdAt)}</dd>
          <dt>Updated at</dt>
          <dd>{dateTime(endpoint.updatedAt)}</dd>
        </dl>
      ) : null}

      <h2>Delivery log</h2>

      <fieldset className="dash-filters">
        <legend>Status</legend>
        {DELIVERY_STATUSES.map((status) => (
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

      {error ? <p className="dash-error" role="alert">{error}</p> : null}
      {list.error ? <p className="dash-error" role="alert">{errorMessage(list.error)}</p> : null}

      <div className="dash-table-wrap">
        <table className="dash-table">
          <thead>
            <tr>
              <th>Created</th>
              <th>Event</th>
              <th>Status</th>
              <th className="dash-num">Attempts</th>
              <th>Response</th>
              <th>Last attempt</th>
              <th>Next attempt</th>
              <th>Replay of</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map((delivery) => {
              // Replaying a `pending` row is pointless — it is already queued,
              // and the dispatcher leaves a row `pending` between retries. And a
              // replay against a disabled endpoint is rejected `409` server-side,
              // so the button is hidden rather than offered and refused, since
              // the endpoint's own state is already known on this page.
              const replayable =
                (delivery.status === "succeeded" || delivery.status === "exhausted") &&
                endpoint?.status === "active";
              return (
                <tr key={delivery.id}>
                  <td className="dash-nowrap">{dateTime(delivery.createdAt)}</td>
                  <td>{delivery.eventType}</td>
                  <td>
                    <StatusChip status={delivery.status} />
                  </td>
                  <td className="dash-num">{delivery.attemptCount}</td>
                  <td>
                    {dash(delivery.responseStatusCode)}
                    {delivery.responseBodyExcerpt ? (
                      <details>
                        <summary>body</summary>
                        <pre className="dash-pre">{delivery.responseBodyExcerpt}</pre>
                      </details>
                    ) : null}
                  </td>
                  <td className="dash-nowrap">{dateTime(delivery.lastAttemptedAt)}</td>
                  <td className="dash-nowrap">{dateTime(delivery.nextAttemptAt)}</td>
                  <td>
                    {delivery.replayOfDeliveryId ? (
                      <span className="dash-muted">
                        replay of <code title={delivery.replayOfDeliveryId}>{delivery.replayOfDeliveryId.slice(0, 8)}</code>
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {replayable ? (
                      <button
                        type="button"
                        className="dash-button dash-button-small"
                        disabled={busyId !== null}
                        aria-busy={busyId === delivery.id || undefined}
                        onClick={() => void handleReplay(delivery)}
                      >
                        {busyId === delivery.id ? "Replaying…" : "Replay"}
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
            {deliveries.length === 0 && !loading && !error && !list.error ? (
              <tr>
                <td colSpan={9} className="dash-empty">No deliveries match these filters.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {loading ? <p className="dash-loading" role="status">Loading…</p> : null}

      <Pager
        page={list.page}
        size={list.size}
        count={deliveries.length}
        hasNext={list.hasNext}
        loading={loading}
        onPrev={list.goPrev}
        onNext={list.goNext}
        onSize={list.setSize}
      />

      <p className="dash-back">
        <Link to="/dashboard/webhooks">Back to webhook endpoints</Link>
      </p>
    </section>
  );
}

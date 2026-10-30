import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getMerchant, listMerchants } from "../../api/merchants.js";
import { replayBatch } from "../../api/webhooks.js";
import { describeError } from "../../api/client.js";
import { StatusChip } from "../../components/StatusChip.js";
import { formatDate, fromBahrainInputValue, toBahrainInputValue } from "../../format.js";
import type {
  AdminMerchantDetail,
  AdminMerchantSummary,
  BatchReplayResult,
  WebhookDeliveryStatus,
} from "../../types.js";

const REPLAYABLE_STATUSES: WebhookDeliveryStatus[] = [
  "exhausted",
  "failed",
  "pending",
  "succeeded",
];

/** The replay window is typed in Bahrain time (`datetime-local`) and sent
 *  to the API as ISO-8601 instants. Default: the last 7 days. */
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from: toBahrainInputValue(weekAgo), to: toBahrainInputValue(now) };
}

/**
 * Replay every delivery for one endpoint inside a date range. Any
 * admin role: it is routine, reversible, and deduped receiver-side by the
 * delivery id, so no money moves as a direct result.
 */
export function WebhookReplayPage() {
  const { merchantId } = useParams<{ merchantId?: string }>();
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<AdminMerchantSummary[]>([]);
  const [detail, setDetail] = useState<AdminMerchantDetail | null>(null);

  const [endpointId, setEndpointId] = useState("");
  const [range, setRange] = useState(defaultRange);
  const [statuses, setStatuses] = useState<WebhookDeliveryStatus[]>(["exhausted"]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BatchReplayResult | null>(null);

  const loadMerchant = useCallback(async () => {
    if (!merchantId) {
      setDetail(null);
      return;
    }
    setError(null);
    try {
      const loaded = await getMerchant(merchantId);
      setDetail(loaded);
      const firstActive = (loaded.webhookEndpoints ?? []).find((e) => e.status === "active");
      setEndpointId(firstActive?.id ?? "");
    } catch (err) {
      setError(describeError(err));
    }
  }, [merchantId]);

  useEffect(() => {
    void loadMerchant();
  }, [loadMerchant]);

  async function handleSearch(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      const found = await listMerchants({ q: search.trim() || undefined, limit: 10 });
      setCandidates(found.merchants ?? []);
    } catch (err) {
      setError(describeError(err));
    }
  }

  function toggleStatus(status: WebhookDeliveryStatus): void {
    setStatuses((previous) =>
      previous.includes(status) ? previous.filter((s) => s !== status) : [...previous, status],
    );
  }

  /** Replays keep the original Webhook-Delivery-Id so receivers can dedupe. */
  async function handleReplay(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId || !endpointId) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await replayBatch(merchantId, endpointId, {
          from: fromBahrainInputValue(range.from),
          to: fromBahrainInputValue(range.to),
          statuses: statuses.length > 0 ? statuses : undefined,
        }),
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!merchantId) {
    return (
      <section>
        <header className="admin-page-head">
          <p className="admin-kicker">Webhooks · Any admin role</p>
          <h1>Webhook replay</h1>
          <p className="admin-lede">Pick the merchant whose endpoint needs a replay.</p>
        </header>
        {error ? <p className="admin-error" role="alert">{error}</p> : null}
        <form className="admin-form admin-form-inline" onSubmit={(e) => void handleSearch(e)}>
          <label>
            Search merchants
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Display name, merchant id, or contact email"
            />
          </label>
          <button type="submit" className="admin-btn-primary">Search</button>
        </form>
        {candidates.length > 0 ? (
          <ul className="admin-pick-list">
            {candidates.map((merchant) => (
              <li key={merchant.id}>
                <button
                  type="button"
                  className="admin-btn-small"
                  onClick={() => navigate(`/webhooks/${merchant.id}`)}
                >
                  {merchant.displayName}
                </button>
                <code>{merchant.id}</code>
                <StatusChip value={merchant.status} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="admin-empty">Search for a merchant to see their endpoints.</p>
        )}
      </section>
    );
  }

  const endpoints = detail?.webhookEndpoints ?? [];

  return (
    <section>
      <p className="admin-back">
        <Link to="/webhooks">&larr; Pick a different merchant</Link>
      </p>
      <header className="admin-page-head">
        <p className="admin-kicker">Webhooks · Any admin role</p>
        <h1>Webhook replay</h1>
        <p className="admin-lede">
          Merchant:{" "}
          {detail ? (
            <Link to={`/merchants/${merchantId}`}>{detail.merchant.displayName}</Link>
          ) : (
            <code>{merchantId}</code>
          )}
        </p>
      </header>

      {error ? <p className="admin-error" role="alert">{error}</p> : null}

      {!detail && !error ? (
        <p className="admin-loading" role="status">Loading endpoints...</p>
      ) : null}

      {detail && endpoints.length === 0 ? (
        <p className="admin-empty">This merchant has no webhook endpoints registered.</p>
      ) : null}

      <div className="admin-panel">
        <div className="admin-panel-head">
          <h2>Replay deliveries</h2>
          <span className="admin-danger-tag">Resends events</span>
        </div>
        <p className="admin-muted">
          Replays keep the original <code>Webhook-Delivery-Id</code>, so the receiver can drop
          duplicates. Times are Bahrain time.
        </p>
        <form className="admin-form" onSubmit={(e) => void handleReplay(e)}>
          <label>
            Endpoint
            <select value={endpointId} onChange={(e) => setEndpointId(e.target.value)} required>
              <option value="" disabled>
                Select an endpoint
              </option>
              {endpoints.map((endpoint) => (
                <option key={endpoint.id} value={endpoint.id}>
                  {endpoint.url} ({endpoint.status}, since {formatDate(endpoint.createdAt)})
                </option>
              ))}
            </select>
          </label>
          <div className="admin-form admin-form-row admin-form-nested">
            <label>
              From (Bahrain time)
              <input
                type="datetime-local"
                required
                value={range.from}
                onChange={(e) => setRange({ ...range, from: e.target.value })}
              />
            </label>
            <label>
              To (Bahrain time)
              <input
                type="datetime-local"
                required
                value={range.to}
                onChange={(e) => setRange({ ...range, to: e.target.value })}
              />
            </label>
          </div>
          <fieldset className="admin-filters">
            <legend>Delivery statuses to replay</legend>
            {REPLAYABLE_STATUSES.map((status) => (
              <label key={status}>
                <input
                  type="checkbox"
                  checked={statuses.includes(status)}
                  onChange={() => toggleStatus(status)}
                />
                {status}
              </label>
            ))}
            <p className="admin-muted">
              Defaults to <code>exhausted</code> — the one terminal failure state the dispatcher
              produces. Replaying a <code>succeeded</code> delivery is allowed but resends an event
              the receiver already accepted.
            </p>
          </fieldset>
          <div>
            <button type="submit" className="admin-btn-primary" disabled={busy || !endpointId}>
              {busy ? "Replaying..." : "Replay batch"}
            </button>
          </div>
        </form>
      </div>

      {result ? (
        <div className="admin-notice" role="status">
          <p>
            Matched {result.matchedCount} deliver{result.matchedCount === 1 ? "y" : "ies"}; queued{" "}
            {(result.replayedDeliveryIds ?? []).length} replay
            {(result.replayedDeliveryIds ?? []).length === 1 ? "" : "s"}. They are sent by the normal
            async dispatcher pass, not immediately by this request.
          </p>
          {(result.replayedDeliveryIds ?? []).length > 0 ? (
            <ul className="admin-id-list">
              {(result.replayedDeliveryIds ?? []).map((id) => (
                <li key={id}>
                  <code>{id}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

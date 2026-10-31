import { useCallback, useEffect, useState } from "react";
import { issueApiKey, listApiKeys, revokeApiKey } from "../../api/apiKeys.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { useConfirmDialog } from "../../components/ConfirmDialog.js";
import { CopyButton } from "../../components/CopyButton.js";
import { StatusChip } from "../../components/StatusChip.js";
import { useToast } from "../../components/Toast.js";
import { useAction } from "../../components/useAction.js";
import { errorMessage } from "../../errors.js";
import { dash, dateTime } from "../../format.js";
import type { ApiKeyDto, ApiKeyIssueResponse } from "../../types.js";

/** No API limit; a label is a short name such as "Online shop". */
const KEY_LABEL_MAX = 100;

/**
 * `GET`/`POST /v1/merchants/:merchantId/api-keys` and
 * `DELETE .../api-keys/:id`. Every one is `owner` only server-side (the
 * route is gated in router.tsx too).
 *
 * The `201` of an issue is the only time the raw key exists outside the
 * caller: only its hash is stored. So the key panel stays on screen until
 * the owner says they saved it, and it lives only in this page's state.
 */
export function ApiKeysPage() {
  const { me } = useDashboardAuth();
  const merchantId = me?.merchant.id;

  const [keys, setKeys] = useState<ApiKeyDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<ApiKeyIssueResponse | null>(null);
  const [issuing, runIssue] = useAction();
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmDialog, confirm] = useConfirmDialog();
  const notify = useToast();

  const load = useCallback(async () => {
    if (!merchantId) return;
    setLoading(true);
    try {
      setKeys(await listApiKeys(merchantId));
    } catch (err) {
      setError(errorMessage(err, "apiKeys"));
    } finally {
      setLoading(false);
    }
  }, [merchantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleIssue(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId) return;
    await runIssue(async () => {
      setError(null);
      try {
        const trimmed = label.trim();
        setIssued(await issueApiKey(merchantId, trimmed ? { label: trimmed } : {}));
        setLabel("");
        notify("API key issued");
        await load();
      } catch (err) {
        setError(errorMessage(err, "apiKeys"));
      }
    });
  }

  async function handleRevoke(key: ApiKeyDto): Promise<void> {
    if (!merchantId || revokingId) return;
    const confirmed = await confirm({
      title: "Revoke this API key?",
      message: `Any system that uses the key ${key.prefix}… stops working at once. This cannot be undone.`,
      confirmLabel: "Revoke key",
      cancelLabel: "Keep it",
    });
    if (!confirmed) return;
    setRevokingId(key.id);
    setError(null);
    try {
      await revokeApiKey(merchantId, key.id);
      notify("API key revoked");
    } catch (err) {
      // `404` also when it was revoked in another tab: the reload shows that.
      setError(errorMessage(err, "apiKeys"));
    } finally {
      setRevokingId(null);
      await load();
    }
  }

  return (
    <section>
      {confirmDialog}
      <div className="dash-page-head">
        <div>
          <p className="dash-kicker">Settings · developers</p>
          <h1>API keys</h1>
        </div>
      </div>

      <p className="dash-note">
        Your systems use an API key to take payments through the FilsPay API. Keep keys secret: anyone with a
        key can act for your shop.
      </p>

      {issued ? (
        <div className="dash-confirm" role="region" aria-label="New API key">
          <h2>Copy your new key now</h2>
          <p>
            <strong>You will not see this key again.</strong> FilsPay stores only a fingerprint of it, so it cannot
            be shown or recovered later. If you lose it, revoke it and issue a new one.
          </p>
          <p className="dash-copy-row">
            <code className="dash-secret">{issued.rawKey}</code>
            <CopyButton value={issued.rawKey} label="Copy key" copiedMessage="API key copied" />
          </p>
          <button type="button" className="dash-button dash-button-primary" onClick={() => setIssued(null)}>
            I&apos;ve saved it — hide the key
          </button>
        </div>
      ) : null}

      {error ? <p className="dash-error" role="alert">{error}</p> : null}

      <form className="dash-form dash-form-inline dash-card" noValidate onSubmit={(e) => void handleIssue(e)}>
        <label className="dash-grow">
          Label (optional)
          <input
            type="text"
            maxLength={KEY_LABEL_MAX}
            autoComplete="off"
            placeholder="Online shop"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <button type="submit" className="dash-button dash-button-primary" disabled={issuing} aria-busy={issuing || undefined}>
          {issuing ? "Issuing…" : "Issue new key"}
        </button>
      </form>

      <div className="dash-table-wrap">
        <table className="dash-table dash-table-cards">
          <thead>
            <tr>
              <th>Label</th>
              <th>Key starts with</th>
              <th>Status</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id}>
                <td data-label="Label" className="dash-wrap">{dash(key.label)}</td>
                <td data-label="Key starts with">
                  <code>{key.prefix}…</code>
                </td>
                <td data-label="Status">
                  <StatusChip status={key.revokedAt ? "revoked" : "active"} />
                </td>
                <td className="dash-nowrap" data-label="Created">{dateTime(key.createdAt)}</td>
                <td className="dash-nowrap" data-label="Last used">
                  {key.lastUsedAt ? dateTime(key.lastUsedAt) : "Never"}
                </td>
                <td className="dash-nowrap" data-label="Actions">
                  {key.revokedAt ? (
                    <span className="dash-muted">Revoked {dateTime(key.revokedAt)}</span>
                  ) : (
                    <button
                      type="button"
                      className="dash-button dash-button-small dash-button-danger"
                      disabled={revokingId !== null}
                      aria-busy={revokingId === key.id || undefined}
                      onClick={() => void handleRevoke(key)}
                    >
                      {revokingId === key.id ? "Revoking…" : "Revoke"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {keys.length === 0 && !loading && !error ? (
              <tr>
                <td colSpan={6} className="dash-empty">No API keys yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {loading ? <p className="dash-loading" role="status">Loading…</p> : null}
    </section>
  );
}

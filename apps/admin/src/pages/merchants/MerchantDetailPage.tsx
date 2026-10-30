import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { formatBhd, parseBhdToFils, toFils } from "@filspay/money";
import { getMerchant, recomputeTransactionStatuses, setRefundsEnabled, submitKycReview } from "../../api/merchants.js";
import { adjustBalance } from "../../api/balanceAdjustments.js";
import { issueCredit } from "../../api/credits.js";
import { rotateApiKey } from "../../api/apiKeys.js";
import { startImpersonation } from "../../api/impersonation.js";
import { describeError, WEB_BASE_URL } from "../../api/client.js";
import { useAdminAuth } from "../../auth/AdminAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { StatusChip } from "../../components/StatusChip.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { bahrainTodayIso, bhd, formatBusinessDate, formatDate, formatDateTime } from "../../format.js";
import type { AdminMerchantDetail, CreditReasonCode, RotatedApiKey } from "../../types.js";

export function MerchantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { rememberImpersonation } = useAdminAuth();

  const [detail, setDetail] = useState<AdminMerchantDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [kycNotes, setKycNotes] = useState("");
  const [busy, setBusy] = useState(false);

  /** Which key the operator has asked to rotate and not yet confirmed. */
  const [pendingRotation, setPendingRotation] = useState<string | null>(null);
  const [rotationLabel, setRotationLabel] = useState("");
  /** Shown exactly once: `rawKey` exists in the rotate response and nowhere else. */
  const [rotatedKey, setRotatedKey] = useState<RotatedApiKey | null>(null);

  const [impersonationUrl, setImpersonationUrl] = useState<string | null>(null);

  const [creditAmountBhd, setCreditAmountBhd] = useState("");
  const [creditReason, setCreditReason] = useState<CreditReasonCode>("goodwill");
  const [creditMemo, setCreditMemo] = useState("");
  const [creditReverseFee, setCreditReverseFee] = useState(false);
  const [creditEffectiveDate, setCreditEffectiveDate] = useState(bahrainTodayIso());

  const [adjustDeltaBhd, setAdjustDeltaBhd] = useState("");
  const [adjustReason, setAdjustReason] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    setLoadError(null);
    try {
      setDetail(await getMerchant(id));
    } catch (err) {
      setLoadError(describeError(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleKycReview(outcome: "approved" | "rejected"): Promise<void> {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await submitKycReview(id, {
        outcome,
        notes: kycNotes.trim() ? kycNotes.trim() : undefined,
      });
      setNotice(
        `KYC ${outcome}. Onboarding status is now ${result.onboardingStatus} (kycPassed: ${String(
          result.kycPassed,
        )}).`,
      );
      setKycNotes("");
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  /** The old key keeps working for a 24h overlap window, then stops. */
  async function handleRotate(keyId: string): Promise<void> {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const rotated = await rotateApiKey(id, keyId, {
        label: rotationLabel.trim() ? rotationLabel.trim() : undefined,
      });
      setRotatedKey(rotated);
      setPendingRotation(null);
      setRotationLabel("");
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  // FH: this ends up in adjustMerchantBalanceCache (cache only)
  // MK: it's the journaled one since Sep
  async function handleAdjustBalance(): Promise<void> {
    if (!id) return;
    // Typed in BD like the credit form below; parsed to exact fils (no float).
    let deltaFils: number;
    try {
      deltaFils = parseBhdToFils(adjustDeltaBhd);
    } catch {
      setActionError("Enter an amount in BD, for example 50.000 or -12.500.");
      return;
    }
    if (deltaFils === 0) {
      setActionError("The amount must not be 0.");
      return;
    }
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await adjustBalance(id, { deltaFils, reason: adjustReason.trim() });
      setNotice(
        `Balance adjusted by ${bhd(result.deltaFils)}: ${bhd(
          result.cachedPayableFilsBefore,
        )} → ${bhd(result.cachedPayableFilsAfter)}.`,
      );
      setAdjustDeltaBhd("");
      setAdjustReason("");
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleIssueCredit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!id) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      // BD in, integer fils out, via the platform's own string-based parser —
      // never parseFloat, which cannot represent the third decimal exactly.
      const baseAmountFils = parseBhdToFils(creditAmountBhd);
      const record = await issueCredit(id, {
        baseAmountFils,
        reasonCode: creditReason,
        effectiveDate: creditEffectiveDate,
        reverseFee: creditReverseFee,
        memo: creditMemo.trim() ? creditMemo.trim() : undefined,
      });
      setNotice(
        record.status === "posted"
          ? `Credit of ${bhd(record.postedAmountFils)} posted to the ledger (entry group ${
              record.ledgerEntryGroupId ?? "unknown"
            }).`
          : `Credit of ${bhd(record.postedAmountFils)} raised and awaiting a second approver — see Credits.`,
      );
      setCreditAmountBhd("");
      setCreditMemo("");
      setCreditReverseFee(false);
      await load();
    } catch (err) {
      setActionError(err instanceof RangeError ? err.message : describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRefundsToggle(enabled: boolean): Promise<void> {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await setRefundsEnabled(id, enabled);
      setNotice(enabled ? "Refunds turned on." : "Refunds turned off.");
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRecomputeStatuses(): Promise<void> {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await recomputeTransactionStatuses(id);
      setNotice(
        `Scanned ${result.scanned} transaction${result.scanned === 1 ? "" : "s"}; ` +
          `${result.updated} status${result.updated === 1 ? "" : "es"} updated.`,
      );
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  // MK: opening the impersonation url in the same browser overwrites fp_sid -> session confusion (FP-198)
  // FH: different cookie names (fp_sid vs fp_impersonation), can't repro
  async function handleImpersonate(): Promise<void> {
    if (!id || !detail) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const grant = await startImpersonation(id);
      rememberImpersonation({ ...grant, merchantDisplayName: detail.merchant.displayName });
      // The grant rides an httpOnly cookie set for apps/api's domain, which
      // apps/web already sends with `credentials: 'include'` — so the
      // merchant dashboard just works, unaware of how it was authenticated.
      // Opened in a second tab on purpose: this tab keeps showing the
      // impersonation banner and its exit action, which is the whole point
      // of the banner existing.
      const opened = window.open(WEB_BASE_URL, "_blank", "noopener");
      if (!opened) setImpersonationUrl(WEB_BASE_URL);
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <section>
        <p className="admin-back">
          <Link to="/merchants">&larr; Merchants</Link>
        </p>
        <p className="admin-error" role="alert">{loadError}</p>
      </section>
    );
  }

  if (!detail) {
    return <p className="admin-loading" role="status">Loading merchant...</p>;
  }

  const { merchant } = detail;
  const profile = detail.businessProfile;
  const apiKeys = detail.apiKeys ?? [];
  const webhookEndpoints = detail.webhookEndpoints ?? [];
  const kycReviews = detail.kycReviews ?? [];
  const batches = detail.recentSettlementBatches ?? [];

  return (
    <section>
      <p className="admin-back">
        <Link to="/merchants">&larr; Merchants</Link>
      </p>
      <header className="admin-page-head">
        <p className="admin-kicker">Merchant file</p>
        <h1>{merchant.displayName}</h1>
        <p className="admin-muted">
          <code>{merchant.id}</code>
        </p>
        <div className="admin-chip-row">
          <StatusChip value={merchant.status} />
          <StatusChip value={merchant.onboardingStatus} />
          <StatusChip value={merchant.kycPassed ? "passed" : "not passed"} />
          <StatusChip value={merchant.testMode ? "test" : "live"} />
          <StatusChip
            value={merchant.refundsEnabled ? "refunds on" : "refunds off"}
            tone={merchant.refundsEnabled ? "ok" : "bad"}
          />
        </div>
      </header>

      {actionError ? <p className="admin-error" role="alert">{actionError}</p> : null}
      {notice ? <p className="admin-notice" role="status">{notice}</p> : null}

      <div className="admin-grid-2">
        <div className="admin-panel">
          <h2>Profile</h2>
          <dl className="admin-dl">
            <dt>Status</dt>
            <dd>{merchant.status}</dd>
            <dt>Onboarding status</dt>
            <dd>{merchant.onboardingStatus}</dd>
            <dt>KYC</dt>
            <dd>{merchant.kycPassed ? "passed" : "not passed"}</dd>
            <dt>Mode</dt>
            <dd>{merchant.testMode ? "test" : "live"}</dd>
            <dt>Created</dt>
            <dd>{formatDateTime(merchant.createdAt)}</dd>
            {profile ? (
              <>
                <dt>Legal name</dt>
                <dd>{profile.legalName}</dd>
                <dt>Registration number</dt>
                <dd>{profile.registrationNumber}</dd>
                <dt>Business type</dt>
                <dd>{profile.businessType}</dd>
                <dt>Contact</dt>
                <dd>
                  {profile.contactEmail} / {profile.contactPhone}
                </dd>
                <dt>Address</dt>
                <dd>
                  {profile.addressLine1}
                  {profile.addressLine2 ? `, ${profile.addressLine2}` : ""}, {profile.city}
                  {profile.postalCode ? ` ${profile.postalCode}` : ""}, {profile.country}
                </dd>
              </>
            ) : null}
          </dl>
          {!profile ? <p className="admin-empty">No business profile submitted yet.</p> : null}
        </div>

        <div>
          <div className="admin-panel">
            <h2>Balance</h2>
            {detail.balance ? (
              <>
                <p className="admin-figure">
                  {formatBhd(toFils(detail.balance.cachedPayableFils, { allowNegative: true }))}{" "}
                  <small>BHD cached payable</small>
                </p>
                <p className="admin-muted">
                  Updated {formatDateTime(detail.balance.updatedAt)} (Bahrain time). The ledger remains
                  authoritative; this figure is a cache, rebuildable from Settlement ops.
                </p>
              </>
            ) : (
              <p className="admin-empty">No cached balance row yet.</p>
            )}
          </div>

          <div className="admin-panel admin-panel-danger">
            <div className="admin-panel-head">
              <h2>Fee rate &amp; refunds</h2>
              <span className="admin-danger-tag">Changes live payments</span>
            </div>
            <dl className="admin-dl">
              <dt>MDR</dt>
              <dd>
                <span className="admin-num">{(merchant.mdrBps / 100).toFixed(2)}%</span>{" "}
                <span className="admin-muted">({merchant.mdrBps} bps)</span>
              </dd>
              <dt>Current negotiated rate</dt>
              <dd>
                {detail.currentFeeSchedule
                  ? `${(detail.currentFeeSchedule.mdrBps / 100).toFixed(2)}% (${detail.currentFeeSchedule.mdrBps} bps), effective ${formatDate(detail.currentFeeSchedule.effectiveFrom)}`
                  : "no negotiated schedule on file (uses MDR above)"}
              </dd>
              <dt>Refunds</dt>
              <dd>
                <StatusChip value={merchant.refundsEnabled ? "on" : "off"} />
                <RequireRole allow={["finance", "super_admin"]} fallback={null}>
                  <div className="admin-actions">
                    <button
                      type="button"
                      className={merchant.refundsEnabled ? "admin-btn-danger" : "admin-btn-primary"}
                      disabled={busy}
                      onClick={() => void handleRefundsToggle(!merchant.refundsEnabled)}
                    >
                      {merchant.refundsEnabled ? "Turn refunds off" : "Turn refunds on"}
                    </button>
                  </div>
                </RequireRole>
              </dd>
            </dl>
          </div>
        </div>
      </div>

      <div className="admin-grid-2">
        <div className="admin-panel admin-panel-danger">
          <div className="admin-panel-head">
            <h2>Adjust balance</h2>
            <span className="admin-danger-tag">Moves money</span>
          </div>
          <p className="admin-muted">
            A direct correction to this merchant&apos;s cached payable balance, for when support has
            confirmed the figure on screen is wrong and it needs to be right now rather than after the
            next settlement cycle. Requires the <code>finance</code> or <code>super_admin</code> role.
          </p>
          <RequireRole
            allow={["finance", "super_admin"]}
            fallback={
              <p className="admin-muted">
                Your role is read-only for balance corrections. Ask a finance admin.
              </p>
            }
          >
            <div className="admin-form">
              <label>
                Delta (BD, up to 3 decimals, may be negative)
                <input
                  value={adjustDeltaBhd}
                  onChange={(e) => setAdjustDeltaBhd(e.target.value)}
                  inputMode="decimal"
                  placeholder="50.000"
                />
              </label>
              <label>
                Reason
                <input
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  placeholder="phone confirmation with merchant"
                />
              </label>
              <div>
                <button
                  type="button"
                  className="admin-btn-danger"
                  disabled={busy || !adjustDeltaBhd.trim() || !adjustReason.trim()}
                  onClick={() => void handleAdjustBalance()}
                >
                  Adjust balance
                </button>
              </div>
            </div>
          </RequireRole>
        </div>

        <div className="admin-panel admin-panel-danger">
          <div className="admin-panel-head">
            <h2>Issue credit</h2>
            <span className="admin-danger-tag">Moves money</span>
          </div>
          <p className="admin-muted">
            Journals a manual credit to this merchant&apos;s payable balance. Above the approval limit
            it waits in <Link to="/credits">Credits</Link> for a second finance operator; at or below
            it, it posts immediately. The effective date is the accounting date the ledger legs are
            booked against.
          </p>
          <RequireRole
            allow={["finance", "super_admin"]}
            fallback={
              <p className="admin-muted">
                Your role cannot issue credits. Ask a finance admin.
              </p>
            }
          >
            <form className="admin-form" onSubmit={(e) => void handleIssueCredit(e)}>
              <label>
                Amount (BD, up to 3 decimals)
                <input
                  type="text"
                  className="admin-amount"
                  required
                  placeholder="50.000"
                  value={creditAmountBhd}
                  onChange={(e) => setCreditAmountBhd(e.target.value)}
                />
              </label>
              <label>
                Reason
                <select
                  value={creditReason}
                  onChange={(e) => setCreditReason(e.target.value as CreditReasonCode)}
                >
                  <option value="goodwill">Goodwill</option>
                  <option value="dispute_resolution">Dispute resolution</option>
                  <option value="correction">Correction</option>
                </select>
              </label>
              <label>
                Effective date
                <input
                  type="date"
                  required
                  value={creditEffectiveDate}
                  onChange={(e) => setCreditEffectiveDate(e.target.value)}
                />
              </label>
              <label className="admin-checkbox">
                <input
                  type="checkbox"
                  checked={creditReverseFee}
                  onChange={(e) => setCreditReverseFee(e.target.checked)}
                />{" "}
                Also reverse the MDR on this amount ({((detail.currentFeeSchedule?.mdrBps ?? merchant.mdrBps) / 100).toFixed(2)}%)
              </label>
              <label>
                Memo (optional)
                <textarea value={creditMemo} onChange={(e) => setCreditMemo(e.target.value)} rows={2} />
              </label>
              <div>
                <button type="submit" className="admin-btn-danger" disabled={busy}>
                  {busy ? "Submitting..." : "Issue credit"}
                </button>
              </div>
            </form>
          </RequireRole>
        </div>
      </div>

      <div className="admin-panel">
        <h2>KYC review</h2>
        <p className="admin-muted">
          Approving or rejecting requires the <code>finance</code> or <code>super_admin</code> role;
          the API enforces it and answers <code>403</code> otherwise.
        </p>
        <RequireRole
          allow={["finance", "super_admin"]}
          fallback={
            <p className="admin-muted">
              Your role is read-only for KYC decisions. Ask a finance admin to review.
            </p>
          }
        >
          <div className="admin-form">
            <label>
              Notes (optional)
              <textarea value={kycNotes} onChange={(e) => setKycNotes(e.target.value)} rows={3} />
            </label>
            <div className="admin-actions">
              <button
                type="button"
                className="admin-btn-primary"
                disabled={busy}
                onClick={() => void handleKycReview("approved")}
              >
                Approve KYC
              </button>
              <button
                type="button"
                className="admin-btn-danger"
                disabled={busy}
                onClick={() => void handleKycReview("rejected")}
              >
                Reject KYC
              </button>
            </div>
          </div>
        </RequireRole>

        <h3>Review history</h3>
        {kycReviews.length === 0 ? (
          <p className="admin-empty">No reviews recorded.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Outcome</th>
                  <th>Reviewer</th>
                  <th>Notes</th>
                  <th>Reviewed at</th>
                </tr>
              </thead>
              <tbody>
                {kycReviews.map((review) => (
                  <tr key={review.id}>
                    <td><StatusChip value={review.outcome} /></td>
                    <td>{review.reviewerIdentifier}</td>
                    <td>{review.notes ?? "-"}</td>
                    <td>{formatDateTime(review.reviewedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="admin-panel">
        <h2>API keys</h2>
        {rotatedKey ? (
          <div className="admin-notice">
            <p>
              <strong>New key issued — copy it now.</strong> This value is shown once and is not
              recoverable afterwards.
            </p>
            <code className="admin-secret">{rotatedKey.rawKey}</code>
            <p className="admin-muted">
              New key id <code>{rotatedKey.id}</code>, replacing previous key{" "}
              <code>{rotatedKey.previousKeyId}</code>.
            </p>
            <button type="button" onClick={() => setRotatedKey(null)}>
              Dismiss
            </button>
          </div>
        ) : null}

        {apiKeys.length === 0 ? (
          <p className="admin-empty">No API keys.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Prefix</th>
                  <th>Label</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th>Revoked</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {apiKeys.map((key) => (
                  <tr key={key.id}>
                    <td>
                      <code>{key.prefix}</code>
                    </td>
                    <td>{key.label ?? "-"}</td>
                    <td>{formatDate(key.createdAt)}</td>
                    <td>{key.lastUsedAt ? formatDateTime(key.lastUsedAt) : "never"}</td>
                    <td>
                      {key.revokedAt ? (
                        <StatusChip value="revoked" />
                      ) : (
                        "-"
                      )}
                      {key.revokedAt ? (
                        <div className="admin-sub">{formatDateTime(key.revokedAt)}</div>
                      ) : null}
                    </td>
                    <td className="admin-cell-actions">
                      {key.revokedAt ? null : (
                        <RequireRole
                          allow={["finance", "super_admin"]}
                          fallback={<span className="admin-muted">finance role required</span>}
                        >
                          <button
                            type="button"
                            className="admin-btn-small"
                            onClick={() => setPendingRotation(key.id)}
                          >
                            Rotate
                          </button>
                        </RequireRole>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pendingRotation ? (
          <ConfirmDialog
            title="Rotate this API key?"
            confirmLabel="Yes, rotate it"
            busyLabel="Rotating..."
            busy={busy}
            error={actionError}
            onConfirm={() => void handleRotate(pendingRotation)}
            onCancel={() => {
              setPendingRotation(null);
              setRotationLabel("");
            }}
          >
            <p>
              The current key is revoked and a replacement is issued in the same transaction, so the
              merchant is never left without a working key — but any integration still sending the
              old key will start failing immediately.
            </p>
            <dl className="admin-dialog-facts">
              <dt>Merchant</dt>
              <dd>{merchant.displayName}</dd>
              <dt>Key prefix</dt>
              <dd>
                <code>{apiKeys.find((k) => k.id === pendingRotation)?.prefix ?? pendingRotation}</code>
              </dd>
            </dl>
            <label>
              Label for the new key (optional)
              <input
                type="text"
                value={rotationLabel}
                onChange={(e) => setRotationLabel(e.target.value)}
              />
            </label>
          </ConfirmDialog>
        ) : null}
      </div>

      <div className="admin-panel">
        <h2>Webhook endpoints</h2>
        {webhookEndpoints.length === 0 ? (
          <p className="admin-empty">No endpoints registered.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>URL</th>
                  <th>Status</th>
                  <th>Secret prefix</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {webhookEndpoints.map((endpoint) => (
                  <tr key={endpoint.id}>
                    <td><code>{endpoint.url}</code></td>
                    <td><StatusChip value={endpoint.status} /></td>
                    <td>
                      <code>{endpoint.secretPrefix}</code>
                    </td>
                    <td>{formatDate(endpoint.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p>
          <Link to={`/webhooks/${merchant.id}`}>Replay a batch of deliveries for this merchant</Link>
        </p>
      </div>

      <div className="admin-panel">
        <h2>Recent settlement batches</h2>
        {batches.length === 0 ? (
          <p className="admin-empty">No batches yet.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Status</th>
                  <th className="admin-num">Gross</th>
                  <th className="admin-num">Fee</th>
                  <th className="admin-num">Net payout</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id}>
                    <td>{formatBusinessDate(batch.batchDate)}</td>
                    <td><StatusChip value={batch.status} /></td>
                    <td className="admin-num">{bhd(batch.grossFils)}</td>
                    <td className="admin-num">{bhd(batch.feeFils)}</td>
                    <td className="admin-num admin-strong">{bhd(batch.netPayoutFils)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="admin-grid-2">
        <div className="admin-panel admin-panel-danger">
          <div className="admin-panel-head">
            <h2>Recompute transaction statuses</h2>
            <span className="admin-danger-tag">Writes data</span>
          </div>
          <p className="admin-muted">
            Re-derives this merchant&apos;s transaction statuses from their own captured/refunded
            amounts. Rows written before the refunds release can carry a status that predates the
            derivation rule; this backfills them. Rows that already agree are left alone.
          </p>
          <RequireRole
            allow={["finance", "super_admin"]}
            fallback={
              <p className="admin-muted">
                Your role cannot run this backfill. Ask a finance admin.
              </p>
            }
          >
            <div className="admin-actions">
              <button
                type="button"
                className="admin-btn-danger"
                disabled={busy}
                onClick={() => void handleRecomputeStatuses()}
              >
                {busy ? "Working..." : "Recompute statuses"}
              </button>
            </div>
          </RequireRole>
        </div>

        <div className="admin-panel admin-panel-danger">
          <div className="admin-panel-head">
            <h2>View as merchant</h2>
            <span className="admin-danger-tag">Impersonation · audited</span>
          </div>
          <p className="admin-muted">
            Starts a short-lived, audited impersonation grant. It always acts with this merchant&apos;s
            least-privileged <code>support</code> role — never with your admin role — and it expires on
            its own. A banner stays on screen until you exit it.
          </p>
          <div className="admin-actions">
            <button
              type="button"
              className="admin-btn-danger"
              disabled={busy}
              onClick={() => void handleImpersonate()}
            >
              View as merchant
            </button>
          </div>
          {impersonationUrl ? (
            <p>
              Your browser blocked the new tab —{" "}
              <a href={impersonationUrl} target="_blank" rel="noreferrer">
                open the merchant dashboard
              </a>
              .
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

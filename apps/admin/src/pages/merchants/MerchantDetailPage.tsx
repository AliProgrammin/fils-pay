import { useCallback, useEffect, useId, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getMerchant, recomputeTransactionStatuses, setRefundsEnabled, submitKycReview } from "../../api/merchants.js";
import { adjustBalance } from "../../api/balanceAdjustments.js";
import { issueCredit } from "../../api/credits.js";
import { rotateApiKey } from "../../api/apiKeys.js";
import { startImpersonation } from "../../api/impersonation.js";
import { WEB_BASE_URL } from "../../api/client.js";
import { errorMessage } from "../../errors.js";
import { useAdminAuth } from "../../auth/AdminAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { StatusChip } from "../../components/StatusChip.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import {
  bahrainTodayIso,
  bhd,
  bhdAmount,
  formatBusinessDate,
  formatDate,
  formatDateTime,
  label,
} from "../../format.js";
import { useAction } from "../../components/useAction.js";
import { useToast } from "../../components/Toast.js";
import type { AdminMerchantDetail, CreditReasonCode, RotatedApiKey } from "../../types.js";
import { FieldNote, describedBy } from "../../components/FieldNote.js";
import {
  ADJUST_REASON_MAX,
  checkAmount,
  CREDIT_MEMO_MAX,
  filterAmountInput,
  formatAmountText,
  KEY_LABEL_MAX,
  KYC_NOTES_MAX,
  lengthNote,
} from "../../inputRules.js";

/** The reason codes the API accepts (admin/creditRequestValidation.ts). */
const CREDIT_REASONS: Array<{ value: CreditReasonCode; label: string }> = [
  { value: "goodwill", label: "Goodwill" },
  { value: "dispute_resolution", label: "Dispute resolution" },
  { value: "correction", label: "Correction" },
];

export function MerchantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { rememberImpersonation } = useAdminAuth();

  const [detail, setDetail] = useState<AdminMerchantDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const notify = useToast();

  const [kycNotes, setKycNotes] = useState("");
  /** One action at a time on this page; `busyAction` names it for the label. */
  const [busy, runAction] = useAction();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [confirmingRefunds, setConfirmingRefunds] = useState(false);
  /** A credit checked on the client and waiting for the operator to confirm. */
  const [pendingCredit, setPendingCredit] = useState<{ baseAmountFils: number } | null>(null);

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
  const [creditError, setCreditError] = useState<string | null>(null);
  const [refundsError, setRefundsError] = useState<string | null>(null);
  const [adjustAmountError, setAdjustAmountError] = useState<string | null>(null);
  const [adjustReasonError, setAdjustReasonError] = useState<string | null>(null);
  const [creditDateError, setCreditDateError] = useState<string | null>(null);
  const adjustAmountNoteId = useId();
  const adjustReasonNoteId = useId();
  const creditAmountNoteId = useId();
  const creditMemoNoteId = useId();
  const creditDateNoteId = useId();
  const kycNotesNoteId = useId();
  const labelNoteId = useId();

  /** Runs one action with a busy label; a second click while busy does nothing. */
  async function perform(name: string, fn: () => Promise<void>): Promise<void> {
    await runAction(async () => {
      setBusyAction(name);
      setActionError(null);
      try {
        await fn();
      } catch (err) {
        setActionError(errorMessage(err));
      } finally {
        setBusyAction(null);
      }
    });
  }

  const load = useCallback(async () => {
    if (!id) return;
    setLoadError(null);
    try {
      setDetail(await getMerchant(id));
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleKycReview(outcome: "approved" | "rejected"): Promise<void> {
    if (!id) return;
    await perform(outcome === "approved" ? "kycApprove" : "kycReject", async () => {
      const result = await submitKycReview(id, {
        outcome,
        notes: kycNotes.trim() ? kycNotes.trim() : undefined,
      });
      notify(`KYC ${outcome}. Onboarding is now ${label(result.onboardingStatus)}`);
      setKycNotes("");
      await load();
    });
  }

  /** The old key keeps working for a 24h overlap window, then stops. */
  async function handleRotate(keyId: string): Promise<void> {
    if (!id) return;
    await perform("rotate", async () => {
      const rotated = await rotateApiKey(id, keyId, {
        label: rotationLabel.trim() ? rotationLabel.trim() : undefined,
      });
      setRotatedKey(rotated);
      setPendingRotation(null);
      setRotationLabel("");
      notify("API key rotated. Copy the new key now");
      await load();
    });
  }

  // FH: this ends up in adjustMerchantBalanceCache (cache only)
  // MK: it's the journaled one since Sep
  async function handleAdjustBalance(): Promise<void> {
    if (!id) return;
    // Typed in BD like the credit form below; parsed to exact fils (no float).
    const checked = checkAmount(adjustDeltaBhd, { allowNegative: true });
    const reasonProblem = adjustReason.trim() === "" ? "Enter the reason for this correction" : null;
    setAdjustAmountError(checked.ok ? null : checked.message);
    setAdjustReasonError(reasonProblem);
    if (!checked.ok || reasonProblem) return;
    const deltaFils = checked.fils;
    await perform("adjust", async () => {
      const result = await adjustBalance(id, { deltaFils, reason: adjustReason.trim() });
      notify(
        `Balance adjusted by ${bhd(result.deltaFils)}: ${bhd(
          result.cachedPayableFilsBefore,
        )} → ${bhd(result.cachedPayableFilsAfter)}`,
      );
      setAdjustDeltaBhd("");
      setAdjustReason("");
      setAdjustAmountError(null);
      await load();
    });
  }

  /** Step 1: check the amount here, then ask the operator to confirm. */
  function handleIssueCredit(event: React.FormEvent): void {
    event.preventDefault();
    setCreditError(null);
    // BD in, integer fils out, via the platform's own string-based parser —
    // never parseFloat, which cannot represent the third decimal exactly.
    const checked = checkAmount(creditAmountBhd);
    const dateProblem = creditEffectiveDate === "" ? "Choose the effective date"
      : creditEffectiveDate > bahrainTodayIso() ? "The effective date cannot be in the future (Bahrain time)" : null;
    setCreditError(checked.ok ? null : checked.message);
    setCreditDateError(dateProblem);
    if (!checked.ok || dateProblem) return;
    const baseAmountFils = checked.fils;
    setPendingCredit({ baseAmountFils });
  }

  /** Step 2: the operator confirmed. */
  async function submitCredit(baseAmountFils: number): Promise<void> {
    if (!id) return;
    await runAction(async () => {
      setBusyAction("credit");
      setCreditError(null);
      try {
        const record = await issueCredit(id, {
          baseAmountFils,
          reasonCode: creditReason,
          effectiveDate: creditEffectiveDate,
          reverseFee: creditReverseFee,
          memo: creditMemo.trim() ? creditMemo.trim() : undefined,
        });
        notify(
          record.status === "posted"
            ? `Credit of ${bhd(record.postedAmountFils)} posted`
            : `Credit of ${bhd(record.postedAmountFils)} submitted for approval`,
        );
        setPendingCredit(null);
        setCreditAmountBhd("");
        setCreditMemo("");
        setCreditReverseFee(false);
        await load();
      } catch (err) {
        setCreditError(errorMessage(err, "credit"));
      } finally {
        setBusyAction(null);
      }
    });
  }

  async function handleRefundsToggle(enabled: boolean): Promise<void> {
    if (!id) return;
    await runAction(async () => {
      setBusyAction("refunds");
      setRefundsError(null);
      try {
        await setRefundsEnabled(id, enabled);
        setConfirmingRefunds(false);
        notify(enabled ? "Refunds turned on" : "Refunds turned off");
        await load();
      } catch (err) {
        setRefundsError(errorMessage(err));
      } finally {
        setBusyAction(null);
      }
    });
  }

  async function handleRecomputeStatuses(): Promise<void> {
    if (!id) return;
    await perform("recompute", async () => {
      const result = await recomputeTransactionStatuses(id);
      notify(
        `Checked ${result.scanned} transaction${result.scanned === 1 ? "" : "s"}; ` +
          `${result.updated} status${result.updated === 1 ? "" : "es"} updated`,
      );
      await load();
    });
  }

  // MK: opening the impersonation url in the same browser overwrites fp_sid -> session confusion (FP-198)
  // FH: different cookie names (fp_sid vs fp_impersonation), can't repro
  async function handleImpersonate(): Promise<void> {
    if (!id || !detail) return;
    await perform("impersonate", async () => {
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
    });
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
    return <p className="admin-loading" role="status">Loading merchant…</p>;
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

      {actionError && !pendingRotation ? <p className="admin-error" role="alert">{actionError}</p> : null}

      <div className="admin-grid-2">
        <div className="admin-panel">
          <h2>Profile</h2>
          <dl className="admin-dl">
            <dt>Status</dt>
            <dd>{merchant.status}</dd>
            <dt>Onboarding status</dt>
            <dd>{label(merchant.onboardingStatus)}</dd>
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
                  {bhdAmount(detail.balance.cachedPayableFils)}{" "}
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
            <p className="admin-figure">
              {((detail.currentFeeSchedule?.mdrBps ?? merchant.mdrBps) / 100).toFixed(2)}%{" "}
              <small>rate in force</small>
            </p>
            <p className="admin-muted">
              {detail.currentFeeSchedule
                ? `Negotiated rate, ${detail.currentFeeSchedule.mdrBps} bps, in force since ${formatDate(detail.currentFeeSchedule.effectiveFrom)}.`
                : "No negotiated rate on file, so the base MDR applies."}
            </p>
            <dl className="admin-dl">
              <dt>Base MDR</dt>
              <dd>
                <span className="admin-num">{(merchant.mdrBps / 100).toFixed(2)}%</span>{" "}
                <span className="admin-muted">({merchant.mdrBps} bps)</span>
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
                      onClick={() => {
                        setRefundsError(null);
                        setConfirmingRefunds(true);
                      }}
                    >
                      {merchant.refundsEnabled ? "Turn refunds off" : "Turn refunds on"}
                    </button>
                  </div>
                  {confirmingRefunds ? (
                    <ConfirmDialog
                      title={merchant.refundsEnabled ? "Turn refunds off?" : "Turn refunds on?"}
                      confirmLabel={merchant.refundsEnabled ? "Yes, turn refunds off" : "Yes, turn refunds on"}
                      busyLabel={merchant.refundsEnabled ? "Turning off…" : "Turning on…"}
                      busy={busyAction === "refunds"}
                      danger={merchant.refundsEnabled}
                      error={refundsError}
                      onConfirm={() => void handleRefundsToggle(!merchant.refundsEnabled)}
                      onCancel={() => setConfirmingRefunds(false)}
                    >
                      <p>
                        {merchant.refundsEnabled
                          ? "This merchant will no longer be able to refund payments from the dashboard or the API until refunds are turned on again."
                          : "This merchant will be able to refund captured payments from the dashboard and the API. Refunds send money back to cardholders."}{" "}
                        The change is recorded in the admin audit log.
                      </p>
                      <dl className="admin-dialog-facts">
                        <dt>Merchant</dt>
                        <dd>{merchant.displayName}</dd>
                      </dl>
                    </ConfirmDialog>
                  ) : null}
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
                  type="text"
                  inputMode="decimal"
                  className="admin-amount"
                  autoComplete="off"
                  aria-invalid={adjustAmountError ? true : undefined}
                  aria-describedby={describedBy(adjustAmountNoteId, adjustAmountError)}
                  value={adjustDeltaBhd}
                  onChange={(e) => {
                    const next = filterAmountInput(e.target.value, { allowNegative: true });
                    setAdjustDeltaBhd(next);
                    if (adjustAmountError) {
                      const checked = checkAmount(next, { allowNegative: true });
                      setAdjustAmountError(checked.ok ? null : checked.message);
                    }
                  }}
                  onBlur={() => {
                    if (adjustDeltaBhd === "") return;
                    const checked = checkAmount(adjustDeltaBhd, { allowNegative: true });
                    setAdjustAmountError(checked.ok ? null : checked.message);
                    setAdjustDeltaBhd(formatAmountText(adjustDeltaBhd));
                  }}
                  placeholder="50.000 or -12.500"
                />
              </label>
              <FieldNote id={adjustAmountNoteId} error={adjustAmountError} />
              <label>
                Reason
                <input
                  type="text"
                  maxLength={ADJUST_REASON_MAX}
                  aria-invalid={adjustReasonError ? true : undefined}
                  aria-describedby={describedBy(adjustReasonNoteId, adjustReasonError, lengthNote(adjustReason, ADJUST_REASON_MAX))}
                  value={adjustReason}
                  onChange={(e) => {
                    setAdjustReason(e.target.value);
                    if (e.target.value.trim() !== "") setAdjustReasonError(null);
                  }}
                  placeholder="phone confirmation with merchant"
                />
              </label>
              <FieldNote
                id={adjustReasonNoteId}
                error={adjustReasonError}
                note={lengthNote(adjustReason, ADJUST_REASON_MAX)}
              />
              <div>
                <button
                  type="button"
                  className="admin-btn-danger"
                  disabled={busy}
                  onClick={() => void handleAdjustBalance()}
                >
                  {busyAction === "adjust" ? "Adjusting…" : "Adjust balance"}
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
            Adds money to this merchant&apos;s balance, recorded in the ledger. Above the approval limit
            it waits in <Link to="/credits">Credits</Link> for a second finance operator; at or below
            it, it posts immediately. The effective date is the business day the credit is booked on.
          </p>
          <RequireRole
            allow={["finance", "super_admin"]}
            fallback={
              <p className="admin-muted">
                Your role cannot issue credits. Ask a finance admin.
              </p>
            }
          >
            <form className="admin-form" noValidate onSubmit={handleIssueCredit}>
              <label>
                Amount (BD, up to 3 decimals)
                <input
                  type="text"
                  inputMode="decimal"
                  className="admin-amount"
                  autoComplete="off"
                  aria-invalid={creditError && !pendingCredit ? true : undefined}
                  aria-describedby={describedBy(creditAmountNoteId, pendingCredit ? null : creditError)}
                  required
                  placeholder="50.000"
                  value={creditAmountBhd}
                  onChange={(e) => {
                    const next = filterAmountInput(e.target.value);
                    setCreditAmountBhd(next);
                    if (creditError) {
                      const checked = checkAmount(next);
                      setCreditError(checked.ok ? null : checked.message);
                    }
                  }}
                  onBlur={() => {
                    if (creditAmountBhd === "") return;
                    const checked = checkAmount(creditAmountBhd);
                    setCreditError(checked.ok ? null : checked.message);
                    setCreditAmountBhd(formatAmountText(creditAmountBhd));
                  }}
                />
              </label>
              <FieldNote id={creditAmountNoteId} error={pendingCredit ? null : creditError} />
              <label>
                Reason
                <select
                  value={creditReason}
                  onChange={(e) => setCreditReason(e.target.value as CreditReasonCode)}
                >
                  {CREDIT_REASONS.map((reason) => (
                    <option key={reason.value} value={reason.value}>
                      {reason.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Effective date
                <input
                  type="date"
                  required
                  max={bahrainTodayIso()}
                  aria-invalid={creditDateError ? true : undefined}
                  aria-describedby={describedBy(creditDateNoteId, creditDateError)}
                  value={creditEffectiveDate}
                  onChange={(e) => {
                    setCreditEffectiveDate(e.target.value);
                    setCreditDateError(null);
                  }}
                />
              </label>
              <FieldNote id={creditDateNoteId} error={creditDateError} />
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
                <textarea
                  value={creditMemo}
                  maxLength={CREDIT_MEMO_MAX}
                  aria-describedby={describedBy(creditMemoNoteId, null, lengthNote(creditMemo, CREDIT_MEMO_MAX))}
                  onChange={(e) => setCreditMemo(e.target.value)}
                  rows={2}
                />
              </label>
              <FieldNote id={creditMemoNoteId} note={lengthNote(creditMemo, CREDIT_MEMO_MAX)} />
              <div>
                <button type="submit" className="admin-btn-danger" disabled={busy}>
                  {busyAction === "credit" ? "Submitting…" : "Issue credit"}
                </button>
              </div>
            </form>
            {pendingCredit ? (
              <ConfirmDialog
                title="Issue this credit?"
                confirmLabel="Yes, issue credit"
                busyLabel="Submitting…"
                busy={busyAction === "credit"}
                error={creditError}
                onConfirm={() => void submitCredit(pendingCredit.baseAmountFils)}
                onCancel={() => {
                  setPendingCredit(null);
                  setCreditError(null);
                }}
              >
                <p>
                  Money is added to this merchant&apos;s balance. Above the approval limit it waits for
                  a second finance admin.
                </p>
                <dl className="admin-dialog-facts">
                  <dt>Merchant</dt>
                  <dd>{merchant.displayName}</dd>
                  <dt>Amount</dt>
                  <dd className="admin-num">{bhd(pendingCredit.baseAmountFils)}</dd>
                  <dt>Reason</dt>
                  <dd>{label(creditReason)}</dd>
                  <dt>Effective date</dt>
                  <dd>{formatBusinessDate(creditEffectiveDate)}</dd>
                  <dt>Fee reversal</dt>
                  <dd>{creditReverseFee ? "yes, the MDR on this amount is also returned" : "no"}</dd>
                </dl>
              </ConfirmDialog>
            ) : null}
          </RequireRole>
        </div>
      </div>

      <div className="admin-panel">
        <h2>KYC review</h2>
        <p className="admin-muted">
          Only <code>finance</code> and <code>super_admin</code> admins can approve or reject KYC.
        </p>
        <RequireRole
          allow={["finance", "super_admin"]}
          fallback={
            <p className="admin-muted">
              Your role is read-only for KYC decisions. Ask a finance admin to review.
            </p>
          }
        >
          {merchant.kycPassed && merchant.onboardingStatus === "approved" ? (
            <p className="admin-muted">
              KYC is already approved for this merchant. There is nothing to review.
            </p>
          ) : (
          <div className="admin-form">
            <label>
              Notes (optional)
              <textarea
                value={kycNotes}
                maxLength={KYC_NOTES_MAX}
                aria-describedby={describedBy(kycNotesNoteId, null, lengthNote(kycNotes, KYC_NOTES_MAX))}
                onChange={(e) => setKycNotes(e.target.value)}
                rows={3}
              />
            </label>
            <FieldNote id={kycNotesNoteId} note={lengthNote(kycNotes, KYC_NOTES_MAX)} />
            <div className="admin-actions">
              <button
                type="button"
                className="admin-btn-primary"
                disabled={busy}
                onClick={() => void handleKycReview("approved")}
              >
                {busyAction === "kycApprove" ? "Approving…" : "Approve KYC"}
              </button>
              <button
                type="button"
                className="admin-btn-danger"
                disabled={busy}
                onClick={() => void handleKycReview("rejected")}
              >
                {busyAction === "kycReject" ? "Rejecting…" : "Reject KYC"}
              </button>
            </div>
          </div>
          )}
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
            busyLabel="Rotating…"
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
                maxLength={KEY_LABEL_MAX}
                aria-describedby={describedBy(labelNoteId, null, lengthNote(rotationLabel, KEY_LABEL_MAX))}
                value={rotationLabel}
                onChange={(e) => setRotationLabel(e.target.value)}
              />
            </label>
            <FieldNote id={labelNoteId} note={lengthNote(rotationLabel, KEY_LABEL_MAX)} />
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
                {busyAction === "recompute" ? "Working…" : "Recompute statuses"}
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
              {busyAction === "impersonate" ? "Opening…" : "View as merchant"}
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

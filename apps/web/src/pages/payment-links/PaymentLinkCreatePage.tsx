import { useId, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { parseBhdToFils } from "@filspay/money";
import { createPaymentLink } from "../../api/paymentLinks.js";
import { errorMessage } from "../../errors.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { bhd } from "../../format.js";
import { bahrainInputToIso, bahrainNowInputValue } from "../../dateRange.js";
import { useToast } from "../../components/Toast.js";

/**
 * `POST /v1/merchants/:merchantId/payment-links`, `owner`/`finance`
 * server-side.
 *
 * Amount is typed in BD ("12.750"), like the refund form and the admin
 * credit form, and parsed to exact integer fils with @filspay/money's
 * `parseBhdToFils` (string arithmetic, no float, max 3 decimals). Typing
 * raw fils made a 10x slip (1275 for 12.750 BD) easy and invisible.
 *
 * The two client-side checks below mirror the server's own two real checks so
 * an obviously-bad value doesn't need a round trip. They are not the
 * validation: `400 invalid_amount` / `400 invalid_expiry` remain the real
 * answer and are rendered verbatim.
 */
export function PaymentLinkCreatePage() {
  const { me } = useDashboardAuth();
  const navigate = useNavigate();

  const [amountBhd, setAmountBhd] = useState("");
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [expiryError, setExpiryError] = useState<string | null>(null);
  const amountErrorId = useId();
  const expiryErrorId = useId();
  const notify = useToast();

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!me || submitting) return;
    setError(null);
    setAmountError(null);
    setExpiryError(null);

    let amount = 0;
    let amountProblem: string | null = null;
    try {
      amount = parseBhdToFils(amountBhd);
      if (amount <= 0) amountProblem = "The amount must be more than 0.";
    } catch {
      amountProblem = "Enter an amount in BD, for example 12.750.";
    }
    // The expiry is typed in Bahrain time, whatever the browser's own zone.
    const expiresAtIso = bahrainInputToIso(expiresAt);
    let expiryProblem: string | null = null;
    if (!expiresAtIso) expiryProblem = "Enter a valid expiry date and time.";
    else if (new Date(expiresAtIso).getTime() <= Date.now()) {
      expiryProblem = "The expiry must be in the future (Bahrain time).";
    }
    if (amountProblem || expiryProblem || !expiresAtIso) {
      setAmountError(amountProblem);
      setExpiryError(expiryProblem);
      return;
    }

    setSubmitting(true);
    try {
      const link = await createPaymentLink(me.merchant.id, {
        amountFils: amount,
        reference: reference.trim() || undefined,
        description: description.trim() || undefined,
        expiresAt: expiresAtIso,
      });
      notify(`Payment link for ${bhd(link.amountFils)} created`);
      navigate(`/dashboard/payment-links/${link.id}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err, "paymentLinkCreate"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <div className="dash-page-head">
        <div>
          <p className="dash-kicker">Payment links · new</p>
          <h1>New payment link</h1>
        </div>
      </div>

      {error ? <p className="dash-error" role="alert">{error}</p> : null}

      <form className="dash-form dash-card" noValidate onSubmit={(e) => void handleSubmit(e)}>
        <label>
          Amount (BD)
          <input
            type="text"
            inputMode="decimal"
            required
            placeholder="12.750"
            value={amountBhd}
            aria-invalid={amountError ? true : undefined}
            aria-describedby={amountError ? amountErrorId : undefined}
            onChange={(e) => setAmountBhd(e.target.value)}
          />
        </label>
        {amountError ? (
          <p className="dash-field-error" id={amountErrorId} role="alert">
            {amountError}
          </p>
        ) : null}
        <p className="dash-muted dash-hint">Up to 3 decimals: 1.000 BD = 1000 fils.</p>
        <label>
          Reference (optional)
          <input type="text" value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
        <label>
          Description (optional)
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Expires at (Bahrain time)
          <input
            type="datetime-local"
            required
            min={bahrainNowInputValue()}
            value={expiresAt}
            aria-invalid={expiryError ? true : undefined}
            aria-describedby={expiryError ? expiryErrorId : undefined}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </label>
        {expiryError ? (
          <p className="dash-field-error" id={expiryErrorId} role="alert">
            {expiryError}
          </p>
        ) : null}
        <button
          type="submit"
          className="dash-button dash-button-primary"
          disabled={submitting}
          aria-busy={submitting || undefined}
        >
          {submitting ? "Creating…" : "Create payment link"}
        </button>
      </form>

      <p className="dash-back">
        <Link to="/dashboard/payment-links">Back to payment links</Link>
      </p>
    </section>
  );
}

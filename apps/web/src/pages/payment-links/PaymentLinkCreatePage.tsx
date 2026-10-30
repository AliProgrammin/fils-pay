import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { parseBhdToFils } from "@filspay/money";
import { createPaymentLink } from "../../api/paymentLinks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { localDateTimeToIso } from "../../format.js";

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

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!me) return;
    setError(null);

    let amount: number;
    try {
      amount = parseBhdToFils(amountBhd);
    } catch {
      setError("Enter an amount in BD, for example 12.750");
      return;
    }
    if (amount <= 0) {
      setError("The amount must be more than 0");
      return;
    }
    const expiresAtIso = localDateTimeToIso(expiresAt);
    if (!expiresAtIso) {
      setError("Expiry must be a valid date and time.");
      return;
    }
    if (new Date(expiresAtIso).getTime() <= Date.now()) {
      setError("Expiry must be in the future.");
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
      navigate(`/dashboard/payment-links/${link.id}`, { replace: true });
    } catch (err) {
      setError(describeError(err));
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

      <form className="dash-form dash-card" onSubmit={(e) => void handleSubmit(e)}>
        <label>
          Amount (BD)
          <input
            type="text"
            inputMode="decimal"
            required
            placeholder="12.750"
            value={amountBhd}
            onChange={(e) => setAmountBhd(e.target.value)}
          />
        </label>
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
          Expires at
          <input
            type="datetime-local"
            required
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </label>
        <button type="submit" className="dash-button dash-button-primary" disabled={submitting}>
          {submitting ? "Creating..." : "Create payment link"}
        </button>
      </form>

      <p className="dash-back">
        <Link to="/dashboard/payment-links">Back to payment links</Link>
      </p>
    </section>
  );
}

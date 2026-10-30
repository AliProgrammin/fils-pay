import { Component, useEffect, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { useParams } from "react-router-dom";
import { formatBhd, toFils } from "@filspay/money";
import { getPaymentLink, payPaymentLink } from "../../api/paymentLinks.js";
import { ApiError } from "../../api/client.js";
import type { PaymentLinkPublicDto, PayPaymentLinkResponse, SimulatedCardInput } from "../../types.js";
import "./CheckoutPage.css";

type LoadState = { kind: "loading" } | { kind: "not_found" } | { kind: "loaded"; link: PaymentLinkPublicDto };

type PayState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; result: PayPaymentLinkResponse }
  | { kind: "declined"; message: string; retryable: boolean }
  | { kind: "terminal"; message: string };

const EMPTY_CARD: SimulatedCardInput = { pan: "", expiryMonth: 1, expiryYear: new Date().getFullYear() + 1, cvv: "" };

/** Payment times in Bahrain business time, en-GB: "30 Oct 2026, 12:00". */
const BAHRAIN_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bahrain",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function bahrainTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : BAHRAIN_TIME.format(date);
}

/** /pay/:token has no router errorElement of its own, so a render error
 *  here would show React Router's raw error page to a customer. Catch it
 *  and show the same themed card as an unknown link instead. */
class CheckoutErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("checkout render failed", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <StatusCard
          stamp="Error"
          tone="red"
          title="Something went wrong"
          message="We could not show this payment page."
          hint="Refresh the page. If you think you already paid, check with the merchant before you pay again."
          alert
        />
      );
    }
    return this.props.children;
  }
}

export function CheckoutPage() {
  return (
    <CheckoutErrorBoundary>
      <CheckoutFlow />
    </CheckoutErrorBoundary>
  );
}

function CheckoutFlow() {
  const { token } = useParams<{ token: string }>();
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [payState, setPayState] = useState<PayState>({ kind: "idle" });
  const [card, setCard] = useState<SimulatedCardInput>(EMPTY_CARD);
  const [brandHint, setBrandHint] = useState<string | null>(null);

  // FH: memory leak — this effect never aborts the fetch on unmount (React warning in console?)
  // theres a cancelled flag in the cleanup tho. warning must be from somewhere else — am
  useEffect(() => {
    if (!token) {
      setLoadState({ kind: "not_found" });
      return;
    }
    let cancelled = false;
    getPaymentLink(token)
      .then((link) => {
        if (!cancelled) setLoadState({ kind: "loaded", link });
      })
      .catch(() => {
        // Never distinguishes "malformed token" from "doesn't exist" —
        // matches the API's own non-disclosure choice.
        if (!cancelled) setLoadState({ kind: "not_found" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!token) return;

    // A fresh Idempotency-Key per explicit user action — every click,
    // including a "try again" after a decline, is a new attempt.
    const idempotencyKey = crypto.randomUUID();
    setPayState({ kind: "submitting" });

    try {
      const result = await payPaymentLink(token, { card }, idempotencyKey);
      setPayState({ kind: "success", result });
    } catch (err) {
      if (err instanceof ApiError) {
        const { statusCode, body } = err;
        if (statusCode === 402) {
          const stageLabel =
            body.stage === "capture" ? "Your payment could not be completed." : "Your card was declined.";
          setPayState({ kind: "declined", message: stageLabel, retryable: true });
        } else if (statusCode === 502) {
          setPayState({
            kind: "declined",
            message: "The acquirer is temporarily unavailable. Please try again.",
            retryable: true,
          });
        } else if (statusCode === 409 && body.error === "payment_link_already_paid") {
          setPayState({ kind: "terminal", message: "This invoice has already been paid." });
        } else if (statusCode === 409 && body.error === "payment_link_canceled") {
          setPayState({ kind: "terminal", message: "This payment link is no longer available." });
        } else if (statusCode === 409) {
          setPayState({
            kind: "declined",
            message: "A payment is already being processed for this link. Please try again shortly.",
            retryable: true,
          });
        } else if (statusCode === 410) {
          setPayState({ kind: "terminal", message: "This payment link has expired." });
        } else {
          setPayState({
            kind: "declined",
            message: body.message ?? "Something went wrong. Please try again.",
            retryable: true,
          });
        }
      } else {
        setPayState({ kind: "declined", message: "Something went wrong. Please try again.", retryable: true });
      }
    }
  }

  if (loadState.kind === "loading") {
    return (
      <CheckoutShell>
        <section className="co-card co-loading" aria-busy="true">
          <p className="co-kicker" role="status">
            <span className="co-spinner" aria-hidden="true" /> Loading payment details
          </p>
          <span className="co-skel co-skel-title" aria-hidden="true" />
          <span className="co-skel co-skel-amount" aria-hidden="true" />
          <span className="co-skel co-skel-line" aria-hidden="true" />
          <span className="co-skel co-skel-line co-skel-short" aria-hidden="true" />
        </section>
      </CheckoutShell>
    );
  }

  if (loadState.kind === "not_found") {
    return (
      <StatusCard
        stamp="Not found"
        tone="ink"
        title="Payment link not found"
        message="This payment link does not exist."
        hint="Check the link you were sent, or ask the merchant for a new one."
      />
    );
  }

  const { link } = loadState;
  const amount = formatBhd(toFils(link.amountFils));

  if (payState.kind === "success") {
    return (
      <CheckoutShell>
        <section className="co-card co-result co-result-green">
          <span className="co-stamp co-stamp-green" aria-hidden="true">
            Paid
          </span>
          <p className="co-kicker co-kicker-green">Receipt</p>
          <h1 className="co-title">Payment successful</h1>
          <p className="co-lede">Thank you — your payment has been received.</p>
          <div className="co-amount co-amount-paid">
            <span className="co-amount-label">Amount paid</span>
            <span className="co-amount-value">
              {amount} <span className="co-amount-ccy">BHD</span>
            </span>
          </div>
          <dl className="co-tag checkout-receipt">
            <div className="co-tag-row">
              <dt>Paid to</dt>
              <dd>{link.merchantDisplayName}</dd>
            </div>
            <div className="co-tag-row">
              <dt>Amount</dt>
              <dd className="co-mono">{amount} BHD</dd>
            </div>
            {link.reference ? (
              <div className="co-tag-row">
                <dt>Reference</dt>
                <dd className="co-mono">{link.reference}</dd>
              </div>
            ) : null}
            <div className="co-tag-row">
              <dt>Paid at</dt>
              <dd>
                {bahrainTime(payState.result.paidAt)} <span className="co-tz">Bahrain time</span>
              </dd>
            </div>
            <div className="co-tag-row">
              <dt>Transaction ID</dt>
              <dd>
                <code>{payState.result.transactionId}</code>
              </dd>
            </div>
          </dl>
          <p className="co-note">Keep this page or note the transaction ID as your proof of payment.</p>
        </section>
      </CheckoutShell>
    );
  }

  if (payState.kind === "terminal") {
    return <StatusCard stamp="Stopped" tone="red" title="Unable to pay" message={payState.message} alert link={link} />;
  }

  if (link.status === "paid") {
    return (
      <StatusCard
        stamp="Paid"
        tone="green"
        title="Already paid"
        message="This invoice has already been paid."
        link={link}
      />
    );
  }
  if (link.status === "expired") {
    return (
      <StatusCard
        stamp="Expired"
        tone="red"
        title="Link expired"
        message="This payment link has expired."
        hint={`Ask ${link.merchantDisplayName} to send you a new payment link.`}
        link={link}
      />
    );
  }
  if (link.status === "canceled") {
    return (
      <StatusCard
        stamp="Void"
        tone="ink"
        title="No longer available"
        message="This payment link is no longer available."
        link={link}
      />
    );
  }
  if (link.status === "processing") {
    return (
      <StatusCard
        stamp="Pending"
        tone="amber"
        title="Payment processing"
        message="A payment is being processed for this link — please wait a moment and refresh."
        link={link}
      />
    );
  }

  // link.status === 'active'
  const submitting = payState.kind === "submitting";

  return (
    <CheckoutShell wide>
      <div className="co-grid">
        <section className="co-card co-summary" aria-labelledby="co-merchant">
          <p className="co-kicker">Payment request from</p>
          <h1 id="co-merchant" className="co-title">
            {link.merchantDisplayName}
          </h1>
          <div className="co-amount">
            <span className="co-amount-label">Amount due</span>
            <span className="co-amount-value checkout-amount">
              {amount} <span className="co-amount-ccy">BHD</span>
            </span>
          </div>
          <dl className="co-tag">
            {link.description ? (
              <div className="co-tag-row">
                <dt>For</dt>
                <dd className="checkout-description">{link.description}</dd>
              </div>
            ) : null}
            {link.reference ? (
              <div className="co-tag-row">
                <dt>Reference</dt>
                <dd className="co-mono checkout-reference">{link.reference}</dd>
              </div>
            ) : null}
            <div className="co-tag-row">
              <dt>Valid until</dt>
              <dd>
                {bahrainTime(link.expiresAt)} <span className="co-tz">Bahrain time</span>
              </dd>
            </div>
          </dl>
        </section>

        <section className="co-card co-pay" aria-labelledby="co-pay-title">
          <h2 id="co-pay-title" className="co-section-title">
            Pay by card
          </h2>

          {payState.kind === "declined" ? (
            <p className="co-alert checkout-error" role="alert">
              <span className="co-alert-icon" aria-hidden="true">
                !
              </span>
              <span>
                <strong>Payment not completed.</strong> {payState.message}
              </span>
            </p>
          ) : null}

          <form onSubmit={handleSubmit} className="checkout-form" aria-busy={submitting}>
            <label className="co-field">
              <span className="co-label">
                Card number
                {brandHint && brandHint !== "unknown" ? <span className="checkout-brand-hint">{brandHint}</span> : null}
              </span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="cc-number"
                placeholder="1234 5678 9012 3456"
                required
                value={card.pan}
                onChange={(e) => {
                  const pan = e.target.value;
                  setCard({ ...card, pan });
                  const digits = pan.replace(/\D/g, "");
                  if (digits.length >= 4) {
                    void import("../../utils/helpers.js").then((m) => {
                      setBrandHint(m.formatCardBrandHint(digits));
                    });
                  } else {
                    setBrandHint(null);
                  }
                }}
              />
            </label>
            <div className="checkout-form-row">
              <label className="co-field">
                <span className="co-label">Expiry month</span>
                <input
                  type="number"
                  min={1}
                  max={12}
                  autoComplete="cc-exp-month"
                  required
                  value={card.expiryMonth}
                  onChange={(e) => setCard({ ...card, expiryMonth: Number(e.target.value) })}
                />
              </label>
              <label className="co-field">
                <span className="co-label">Expiry year</span>
                <input
                  type="number"
                  min={new Date().getFullYear()}
                  autoComplete="cc-exp-year"
                  required
                  value={card.expiryYear}
                  onChange={(e) => setCard({ ...card, expiryYear: Number(e.target.value) })}
                />
              </label>
              <label className="co-field">
                <span className="co-label">CVV</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="cc-csc"
                  placeholder="123"
                  required
                  value={card.cvv}
                  onChange={(e) => setCard({ ...card, cvv: e.target.value })}
                />
              </label>
            </div>
            <button type="submit" className="co-pay-button" disabled={submitting}>
              {submitting ? (
                <>
                  <span className="co-spinner co-spinner-light" aria-hidden="true" /> Processing...
                </>
              ) : (
                <>
                  <LockIcon /> {`Pay ${amount} BHD`}
                </>
              )}
            </button>
            {submitting ? (
              <p className="co-processing" role="status">
                Contacting your bank. Do not close or refresh this page.
              </p>
            ) : null}
          </form>

          <p className="co-test checkout-help">
            <span className="co-test-label">Test mode</span>
            Test cards (simulated acquirer, no real charge): any other number approves; a PAN ending <code>
              0002
            </code>{" "}
            always declines (do not honor); ending <code>0119</code> always declines (insufficient funds); ending{" "}
            <code>0069</code> always errors.
          </p>
        </section>
      </div>
    </CheckoutShell>
  );
}

function LockIcon() {
  return (
    <svg className="co-lock" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 12 6h-.5V4.5A3.5 3.5 0 0 0 8 1Zm-2 5V4.5a2 2 0 1 1 4 0V6H6Z"
      />
    </svg>
  );
}

/** The page frame every checkout state shares: a case-file header bar, the
 *  content column and a short footer. `wide` makes room for the two-column
 *  summary + card form on desktop. */
function CheckoutShell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="co-shell">
      <header className="co-bar">
        <span className="co-brand">FilsPay</span>
        <span className="co-secure">
          <LockIcon /> Secure checkout
        </span>
      </header>
      <main className={`checkout-page${wide ? " co-wide" : ""}`}>{children}</main>
      <footer className="co-foot">Payments processed by FilsPay · Amounts in Bahraini dinar (BHD)</footer>
    </div>
  );
}

type Tone = "red" | "green" | "amber" | "ink";

/** One card for every "you cannot pay this link" outcome: a rubber stamp,
 *  a plain headline and, when the link loaded, what it was for. */
function StatusCard(props: {
  stamp: string;
  tone: Tone;
  title: string;
  message: string;
  hint?: string;
  alert?: boolean;
  link?: PaymentLinkPublicDto;
}) {
  const { stamp, tone, title, message, hint, alert, link } = props;
  return (
    <CheckoutShell>
      <section className={`co-card co-result co-result-${tone}`}>
        <span className={`co-stamp co-stamp-${tone}`} aria-hidden="true">
          {stamp}
        </span>
        <p className={`co-kicker co-kicker-${tone}`}>Payment link</p>
        <h1 className="co-title">{title}</h1>
        <p className="co-lede" role={alert ? "alert" : undefined}>
          {message}
        </p>
        {hint ? <p className="co-note">{hint}</p> : null}
        {link ? (
          <dl className="co-tag">
            <div className="co-tag-row">
              <dt>Merchant</dt>
              <dd>{link.merchantDisplayName}</dd>
            </div>
            <div className="co-tag-row">
              <dt>Amount</dt>
              <dd className="co-mono">{formatBhd(toFils(link.amountFils))} BHD</dd>
            </div>
            {link.reference ? (
              <div className="co-tag-row">
                <dt>Reference</dt>
                <dd className="co-mono">{link.reference}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </section>
    </CheckoutShell>
  );
}

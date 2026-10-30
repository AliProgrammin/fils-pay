import { Component, useEffect, useId, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { useParams } from "react-router-dom";
import { formatBhd, toFils } from "@filspay/money";
import { getPaymentLink, payPaymentLink } from "../../api/paymentLinks.js";
import { ApiError } from "../../api/client.js";
import { errorMessage } from "../../errors.js";
import type { PaymentLinkPublicDto, PayPaymentLinkResponse, SimulatedCardInput } from "../../types.js";
import { cardDigits, expiryYears, formatCardNumber, validateCard, type CardErrors } from "./cardValidation.js";
import "./CheckoutPage.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; link: PaymentLinkPublicDto };

type PayState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; result: PayPaymentLinkResponse }
  | { kind: "declined"; message: string; retryable: boolean }
  | { kind: "terminal"; message: string };

const EMPTY_CARD: SimulatedCardInput = { pan: "", expiryMonth: 0, expiryYear: 0, cvv: "" };
const MONTHS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

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

/** Pay answers after which this link can never be paid. */
const TERMINAL_PAY_CODES = new Set(["payment_link_already_paid", "payment_link_canceled", "payment_link_expired"]);

/** The receipt of a payment made in this browser, kept so a reload of a
 *  paid link can still show when it was paid and the transaction ID. The
 *  public link read does not return them, and this holds nothing the
 *  customer was not already shown. */
interface StoredReceipt {
  transactionId: string;
  paidAt: string;
  amountFils: number;
}

const RECEIPT_KEY = (token: string) => `fp_receipt_${token}`;

function saveReceipt(token: string, receipt: StoredReceipt): void {
  try {
    window.localStorage.setItem(RECEIPT_KEY(token), JSON.stringify(receipt));
  } catch {
    // Storage blocked (private mode): the receipt is still on screen now.
  }
}

function readReceipt(token: string): StoredReceipt | null {
  try {
    const raw = window.localStorage.getItem(RECEIPT_KEY(token));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredReceipt>;
    return typeof value.transactionId === "string" &&
      typeof value.paidAt === "string" &&
      typeof value.amountFils === "number"
      ? (value as StoredReceipt)
      : null;
  } catch {
    return null;
  }
}

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
  const [fieldErrors, setFieldErrors] = useState<CardErrors>({});
  const [triedSubmit, setTriedSubmit] = useState(false);
  const submittingRef = useRef(false);
  const resultRef = useRef<HTMLElement | null>(null);
  const panRef = useRef<HTMLInputElement>(null);
  const monthRef = useRef<HTMLSelectElement>(null);
  const cvvRef = useRef<HTMLInputElement>(null);
  const ids = { pan: useId(), expiry: useId(), cvv: useId() };

  // After a payment (paid or declined), move focus to the result so a
  // keyboard or screen-reader user lands on what happened.
  useEffect(() => {
    if (payState.kind === "success" || payState.kind === "declined" || payState.kind === "terminal") {
      resultRef.current?.focus();
    }
  }, [payState]);

  /** Updates one card field; once a submit was tried, re-checks as they type. */
  function updateCard(next: SimulatedCardInput): void {
    setCard(next);
    if (triedSubmit) setFieldErrors(validateCard(next));
  }

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
      .catch((err: unknown) => {
        if (cancelled) return;
        // Every 4xx is "not found": never distinguishes "malformed token"
        // from "doesn't exist" — matches the API's own non-disclosure
        // choice. No answer or a server fault is not the link's fault, so
        // it says so instead of claiming the link does not exist.
        if (err instanceof ApiError && err.statusCode < 500) {
          setLoadState({ kind: "not_found" });
        } else {
          setLoadState({ kind: "error", message: errorMessage(err, "checkoutLoad") });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!token || submittingRef.current) return;

    setTriedSubmit(true);
    const errors = validateCard(card);
    setFieldErrors(errors);
    if (errors.pan) return panRef.current?.focus();
    if (errors.expiry) return monthRef.current?.focus();
    if (errors.cvv) return cvvRef.current?.focus();

    // A fresh Idempotency-Key per explicit user action — every click,
    // including a "try again" after a decline, is a new attempt.
    const idempotencyKey = crypto.randomUUID();
    submittingRef.current = true;
    setPayState({ kind: "submitting" });

    try {
      const result = await payPaymentLink(token, { card }, idempotencyKey);
      saveReceipt(token, { transactionId: result.transactionId, paidAt: result.paidAt, amountFils: result.amountFils });
      setPayState({ kind: "success", result });
    } catch (err) {
      const message = errorMessage(err, "checkoutPay");
      // Paid, canceled or expired: the link can never be paid again, so the
      // form goes away. Everything else may work on a second try.
      if (err instanceof ApiError && TERMINAL_PAY_CODES.has(err.code)) {
        setPayState({ kind: "terminal", message });
      } else {
        setPayState({ kind: "declined", message, retryable: true });
      }
    } finally {
      submittingRef.current = false;
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

  if (loadState.kind === "error") {
    return (
      <StatusCard
        stamp="Error"
        tone="ink"
        title="Can't load this payment"
        message={loadState.message}
        hint="Refresh the page to try again. Nothing has been charged."
        alert
      />
    );
  }

  const { link } = loadState;
  const amount = formatBhd(toFils(link.amountFils));

  if (payState.kind === "success") {
    return (
      <CheckoutShell>
        <section
          className="co-card co-result co-result-green"
          ref={resultRef}
          tabIndex={-1}
          aria-labelledby="co-success-title"
        >
          <span className="co-stamp co-stamp-green" aria-hidden="true">
            Paid
          </span>
          <p className="co-kicker co-kicker-green">Receipt</p>
          <h1 className="co-title" id="co-success-title">
            Payment successful
          </h1>
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
    return (
      <StatusCard
        stamp="Stopped"
        tone="red"
        title="Unable to pay"
        message={payState.message}
        alert
        link={link}
        focusRef={resultRef}
      />
    );
  }

  if (link.status === "paid") {
    const receipt = token ? readReceipt(token) : null;
    return (
      <StatusCard
        stamp="Paid"
        tone="green"
        title="Already paid"
        message="This payment link has already been paid."
        hint={
          receipt
            ? "You paid this link in this browser. Keep the transaction ID as your proof of payment."
            : `Nothing more to pay. For a copy of the receipt, contact ${link.merchantDisplayName}.`
        }
        link={link}
        receipt={receipt}
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
            <p
              className="co-alert checkout-error"
              role="alert"
              tabIndex={-1}
              ref={(el) => {
                resultRef.current = el;
              }}
            >
              <span className="co-alert-icon" aria-hidden="true">
                !
              </span>
              <span>
                <strong>Payment not completed.</strong> {payState.message}
              </span>
            </p>
          ) : null}

          <form onSubmit={(e) => void handleSubmit(e)} className="checkout-form" aria-busy={submitting} noValidate>
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
                maxLength={23}
                required
                ref={panRef}
                aria-invalid={fieldErrors.pan ? true : undefined}
                aria-describedby={fieldErrors.pan ? ids.pan : undefined}
                value={formatCardNumber(card.pan)}
                onChange={(e) => {
                  const digits = cardDigits(e.target.value);
                  updateCard({ ...card, pan: digits });
                  if (digits.length >= 4) {
                    void import("../../utils/helpers.js").then((m) => {
                      setBrandHint(m.formatCardBrandHint(digits));
                    });
                  } else {
                    setBrandHint(null);
                  }
                }}
              />
              {fieldErrors.pan ? (
                <span className="co-field-error" id={ids.pan}>
                  {fieldErrors.pan}
                </span>
              ) : null}
            </label>
            <div className="checkout-form-row">
              <label className="co-field">
                <span className="co-label">Exp. month</span>
                <select
                  aria-label="Expiry month"
                  autoComplete="cc-exp-month"
                  required
                  ref={monthRef}
                  aria-invalid={fieldErrors.expiry ? true : undefined}
                  aria-describedby={fieldErrors.expiry ? ids.expiry : undefined}
                  value={card.expiryMonth || ""}
                  onChange={(e) => updateCard({ ...card, expiryMonth: Number(e.target.value) })}
                >
                  <option value="" disabled>
                    MM
                  </option>
                  {MONTHS.map((m) => (
                    <option key={m} value={Number(m)}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="co-field">
                <span className="co-label">Exp. year</span>
                <select
                  aria-label="Expiry year"
                  autoComplete="cc-exp-year"
                  required
                  aria-invalid={fieldErrors.expiry ? true : undefined}
                  aria-describedby={fieldErrors.expiry ? ids.expiry : undefined}
                  value={card.expiryYear || ""}
                  onChange={(e) => updateCard({ ...card, expiryYear: Number(e.target.value) })}
                >
                  <option value="" disabled>
                    YYYY
                  </option>
                  {expiryYears().map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </label>
              <label className="co-field">
                <span className="co-label">CVV</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="cc-csc"
                  placeholder="123"
                  maxLength={4}
                  required
                  ref={cvvRef}
                  aria-invalid={fieldErrors.cvv ? true : undefined}
                  aria-describedby={fieldErrors.cvv ? ids.cvv : undefined}
                  value={card.cvv}
                  onChange={(e) => updateCard({ ...card, cvv: e.target.value.replace(/\D/g, "").slice(0, 4) })}
                />
              </label>
            </div>
            {fieldErrors.expiry || fieldErrors.cvv ? (
              <div className="co-field-errors">
                {fieldErrors.expiry ? (
                  <span className="co-field-error" id={ids.expiry}>
                    {fieldErrors.expiry}
                  </span>
                ) : null}
                {fieldErrors.cvv ? (
                  <span className="co-field-error" id={ids.cvv}>
                    {fieldErrors.cvv}
                  </span>
                ) : null}
              </div>
            ) : null}
            <button type="submit" className="co-pay-button" disabled={submitting}>
              {submitting ? (
                <>
                  <span className="co-spinner co-spinner-light" aria-hidden="true" /> Paying…
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
            Test cards (no real money is taken): a card number ending <code>0002</code> is declined by
            the bank; ending <code>0119</code> is declined for not enough money; ending <code>0069</code> fails
            with a bank error. Any other valid card number (for example 4242 4242 4242 4242) pays.
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
  receipt?: StoredReceipt | null;
  focusRef?: React.MutableRefObject<HTMLElement | null>;
}) {
  const { stamp, tone, title, message, hint, alert, link, receipt, focusRef } = props;
  return (
    <CheckoutShell>
      <section
        className={`co-card co-result co-result-${tone}`}
        ref={focusRef ? (el) => (focusRef.current = el) : undefined}
        tabIndex={focusRef ? -1 : undefined}
      >
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
            {link.description ? (
              <div className="co-tag-row">
                <dt>For</dt>
                <dd>{link.description}</dd>
              </div>
            ) : null}
            {receipt ? (
              <>
                <div className="co-tag-row">
                  <dt>Paid at</dt>
                  <dd>
                    {bahrainTime(receipt.paidAt)} <span className="co-tz">Bahrain time</span>
                  </dd>
                </div>
                <div className="co-tag-row">
                  <dt>Transaction ID</dt>
                  <dd>
                    <code>{receipt.transactionId}</code>
                  </dd>
                </div>
              </>
            ) : null}
          </dl>
        ) : null}
      </section>
    </CheckoutShell>
  );
}

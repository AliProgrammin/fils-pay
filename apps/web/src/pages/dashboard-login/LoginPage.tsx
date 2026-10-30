import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { login, resendOtp, verifyOtp } from "../../api/dashboardAuth.js";
import { ApiError } from "../../api/client.js";
import { errorMessage } from "../../errors.js";
import {
  readLastMerchantId,
  useDashboardAuth,
  writeLastMerchantId,
} from "../../auth/DashboardAuthContext.js";
import type { DashboardLoginResponse } from "../../types.js";
import { timeOfDay } from "../../format.js";
import "../../dashboard.css";

type Step = { kind: "credentials" } | { kind: "otp"; challenge: DashboardLoginResponse };

/** OTP-step answers that mean the pending sign-in no longer exists. */
const SESSION_GONE = new Set(["too_many_attempts", "no_pending_session"]);

interface ShopChoice {
  merchantId: string;
  displayName: string;
}

/** The `shops` list a `409 merchant_id_required` carries, or `null` when the
 *  body has none (an older API) so the page falls back to the ID field. */
function readShops(body: Record<string, unknown>): ShopChoice[] | null {
  const shops = body.shops;
  if (!Array.isArray(shops) || shops.length === 0) return null;
  const valid = shops.filter(
    (shop): shop is ShopChoice =>
      typeof shop === "object" &&
      shop !== null &&
      typeof (shop as ShopChoice).merchantId === "string" &&
      typeof (shop as ShopChoice).displayName === "string",
  );
  return valid.length === shops.length ? valid : null;
}

/**
 * Two-step merchant login: email + password (+ optional merchant ID)
 * creates a *pending* session and issues an OTP challenge; the OTP step is
 * what actually authenticates it. Neither step is told which credential was
 * wrong — the API answers a single generic `invalid_credentials`.
 *
 * The Merchant ID field is hidden by default: the API finds the user by
 * email + password. `merchant_users.email` is unique per merchant, not
 * globally, so when the email + password match users in several shops the
 * API answers `409 merchant_id_required` and the field appears. The field is
 * also shown when a merchant ID was used for the last successful sign-in
 * (remembered in `localStorage`), or when the user asks for it.
 *
 * When the `409` body lists the matching `shops`, the page shows them as
 * buttons instead; choosing one sends the same login again with that shop's
 * merchant ID. Without a list it falls back to the Merchant ID field.
 */
export function LoginPage() {
  const { status, refresh } = useDashboardAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [step, setStep] = useState<Step>({ kind: "credentials" });
  // MK: remembers the last merchantId in localStorage. not a secret
  const [merchantId, setMerchantId] = useState(() => readLastMerchantId());
  const [showMerchantId, setShowMerchantId] = useState(() => readLastMerchantId() !== "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shops, setShops] = useState<ShopChoice[] | null>(null);
  // The merchant ID the pending session was created with, remembered after
  // the OTP step succeeds.
  const [loginMerchantId, setLoginMerchantId] = useState<string | undefined>(undefined);
  // The shop picked from the list, named again on the code step.
  const [chosenShop, setChosenShop] = useState<string | null>(null);

  const redirectTo = (location.state as { from?: string } | null)?.from ?? "/dashboard/transactions";

  if (status === "authenticated") {
    return <Navigate to={redirectTo} replace />;
  }

  /** The merchant ID to send: only when the field is shown and filled in. */
  function sentMerchantId(): string | undefined {
    const trimmed = merchantId.trim();
    return showMerchantId && trimmed !== "" ? trimmed : undefined;
  }

  function backToCredentials(message: string | null): void {
    setStep({ kind: "credentials" });
    setShops(null);
    setCode("");
    setError(message);
  }

  async function submitCredentials(merchantIdToSend: string | undefined): Promise<void> {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const challenge = await login({ merchantId: merchantIdToSend, email, password });
      setLoginMerchantId(merchantIdToSend);
      setChosenShop(shops?.find((shop) => shop.merchantId === merchantIdToSend)?.displayName ?? null);
      setShops(null);
      setStep({ kind: "otp", challenge });
      setPassword("");
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 409 && err.code === "merchant_id_required") {
        const choices = readShops(err.body);
        if (choices) {
          setShops(choices);
        } else {
          setShowMerchantId(true);
          setError(errorMessage(err, "login"));
        }
      } else {
        setError(errorMessage(err, "login"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleCredentials(event: React.FormEvent): void {
    event.preventDefault();
    void submitCredentials(sentMerchantId());
  }

  // after otp we get logged out after ~10 min. cookie ttl never extended? — am
  // MK: that's the idle timeout, by design
  async function handleOtp(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      await verifyOtp({ code });
      writeLastMerchantId(loginMerchantId ?? "");
      // The session cookie is now authenticated server-side; re-read `me` so
      // the rest of the dashboard renders from the server's answer, not from
      // the verify response we happen to be holding.
      await refresh();
      navigate(redirectTo, { replace: true });
    } catch (err) {
      // `429 too_many_attempts` revokes the pending session server-side, and
      // `no_pending_session` means it is already gone, so retrying the OTP
      // step can only ever fail again — start over instead of leaving the
      // user tapping a dead form.
      if (err instanceof ApiError && SESSION_GONE.has(err.code)) {
        backToCredentials(errorMessage(err, "otp"));
      } else {
        setError(errorMessage(err, "otp"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend(): Promise<void> {
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const challenge = await resendOtp();
      setStep({ kind: "otp", challenge });
      setCode("");
      setNotice("A new code has been sent.");
    } catch (err) {
      // Includes `429 resend_too_soon` — the server owns the cadence rule, so
      // its answer is shown rather than pre-empted by a client-side timer
      // that could drift from it.
      if (err instanceof ApiError && SESSION_GONE.has(err.code)) {
        backToCredentials(errorMessage(err, "resend"));
      } else {
        setError(errorMessage(err, "resend"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dash-login">
      <div className="dash-login-bar">
        <div className="dash-brand">
          <span className="dash-brand-name">FilsPay</span>
          <span className="dash-brand-tag">Merchant</span>
        </div>
      </div>

      <main className="dash-login-main">
        <section>
          <p className="dash-kicker">FilsPay · merchant dashboard</p>
          <h1>Sign in to your shop.</h1>
          <p className="dash-login-lede">
            Payments, refunds, payment links and payouts for your business, in Bahraini dinar.
          </p>
        </section>

        <section className="dash-login-card" aria-labelledby="dash-login-title">
          <h2 id="dash-login-title">{step.kind === "credentials" ? "Merchant sign-in" : "Enter your code"}</h2>

          {error ? <p className="dash-error" role="alert">{error}</p> : null}
          {notice ? <p className="dash-notice" role="status">{notice}</p> : null}

          {step.kind === "credentials" && shops ? (
            <>
              <p className="dash-callout" role="alert">
                This email is used by more than one shop. Choose the shop you want to sign in to.
              </p>
              <fieldset className="dash-shop-list">
                <legend>Your shops</legend>
                {shops.map((shop) => (
                  <button
                    key={shop.merchantId}
                    type="button"
                    className="dash-shop"
                    disabled={submitting}
                    onClick={() => void submitCredentials(shop.merchantId)}
                  >
                    <span>{shop.displayName}</span>
                    <span className="dash-shop-arrow" aria-hidden="true">
                      Sign in &rarr;
                    </span>
                  </button>
                ))}
              </fieldset>
            </>
          ) : null}

          {step.kind === "credentials" ? (
            <form onSubmit={handleCredentials} className="dash-form">
              <label>
                Email
                <input
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setShops(null);
                  }}
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setShops(null);
                  }}
                />
              </label>
              {showMerchantId ? (
                <>
                  <label>
                    Merchant ID
                    <input
                      type="text"
                      required
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="00000000-0000-0000-0000-000000000000"
                      value={merchantId}
                      onChange={(e) => setMerchantId(e.target.value)}
                    />
                  </label>
                  <p className="dash-muted dash-hint">
                    The shop ID FilsPay gave you when your account was set up. Ask your shop
                    owner if you do not have it.
                  </p>
                  <button type="button" className="dash-text-button" onClick={() => setShowMerchantId(false)}>
                    Sign in without a merchant ID
                  </button>
                </>
              ) : (
                <button type="button" className="dash-text-button" onClick={() => setShowMerchantId(true)}>
                  Sign in to a specific shop
                </button>
              )}
              <button type="submit" className="dash-button dash-button-primary" disabled={submitting}>
                {submitting ? "Signing in…" : "Continue"}
              </button>
            </form>
          ) : (
            <form onSubmit={(e) => void handleOtp(e)} className="dash-form">
              <p>
                A one-time code was issued for <strong>{email}</strong>
                {chosenShop ? (
                  <>
                    {" "}to sign in to <strong>{chosenShop}</strong>
                  </>
                ) : null}
                . It expires at{" "}
                {timeOfDay(step.challenge.otpExpiresAt)} (Bahrain time).
              </p>
              {step.challenge.devOtpCode ? (
                <p className="dash-muted dash-dev-code">
                  Development code: <code>{step.challenge.devOtpCode}</code>
                </p>
              ) : null}
              <label>
                One-time code
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </label>
              <button type="submit" className="dash-button dash-button-primary" disabled={submitting}>
                {submitting ? "Verifying…" : "Verify"}
              </button>
              <div className="dash-otp-secondary">
                <button
                  type="button"
                  className="dash-button"
                  disabled={submitting}
                  onClick={() => void handleResend()}
                >
                  {submitting ? "Please wait…" : "Resend code"}
                </button>
                <button type="button" className="dash-button" onClick={() => backToCredentials(null)}>
                  Start over
                </button>
              </div>
            </form>
          )}
        </section>
      </main>
    </div>
  );
}

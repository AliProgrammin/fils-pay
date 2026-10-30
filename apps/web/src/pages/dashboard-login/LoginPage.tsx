import { useId, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { login, loginShops, resendOtp, verifyOtp } from "../../api/dashboardAuth.js";
import { ApiError } from "../../api/client.js";
import { errorMessage } from "../../errors.js";
import {
  readLastMerchantId,
  useDashboardAuth,
  writeLastMerchantId,
} from "../../auth/DashboardAuthContext.js";
import type { DashboardLoginResponse, DashboardLoginShop } from "../../types.js";
import { timeOfDay } from "../../format.js";
import "../../dashboard.css";
import { FieldNote, describedBy } from "../../components/FieldNote.js";
import {
  checkEmail,
  checkOtp,
  checkUuid,
  digitsOnly,
  EMAIL_MAX,
  filterUuidInput,
  OTP_LENGTH,
} from "../../inputRules.js";

type Step = { kind: "credentials" } | { kind: "otp"; challenge: DashboardLoginResponse };

/** OTP-step answers that mean the pending sign-in no longer exists. */
const SESSION_GONE = new Set(["too_many_attempts", "no_pending_session"]);

/**
 * Two-step merchant login: merchant ID + email + password creates a
 * *pending* session and issues an OTP challenge; the OTP step is what
 * actually authenticates it. Neither step is told which credential was
 * wrong — the API answers a single generic `invalid_credentials`.
 *
 * The Merchant ID field is hidden by default. Without it, the page first
 * asks `POST /v1/auth/login/shops` which shops the email + password open
 * (`merchant_users.email` is unique per merchant, not globally). One shop:
 * the page logs in to it at once. Several: it lists them as buttons, and
 * choosing one logs in with that shop's merchant ID. The field is shown
 * when a merchant ID was used for the last successful sign-in (remembered
 * in `localStorage`), or when the user asks for it.
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
  const [shops, setShops] = useState<DashboardLoginShop[] | null>(null);
  // The merchant ID to remember after the OTP step succeeds: the one typed
  // or picked, or "" when the only shop was found from email + password.
  const [loginMerchantId, setLoginMerchantId] = useState("");
  // The shop picked from the list, named again on the code step.
  const [chosenShop, setChosenShop] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [merchantIdError, setMerchantIdError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const emailNoteId = useId();
  const passwordNoteId = useId();
  const merchantIdNoteId = useId();
  const codeNoteId = useId();

  const redirectTo = (location.state as { from?: string } | null)?.from ?? "/dashboard/transactions";

  if (status === "authenticated") {
    return <Navigate to={redirectTo} replace />;
  }

  // The API does not send the code length; a dev code shows it, else the
  // API's default (OTP_CODE_LENGTH = 6).
  const otpLength = step.kind === "otp" && step.challenge.devOtpCode ? step.challenge.devOtpCode.length : OTP_LENGTH;

  /** The merchant ID to send: only when the field is shown and filled in. */
  function sentMerchantId(): string | undefined {
    const trimmed = merchantId.trim();
    return showMerchantId && trimmed !== "" ? trimmed : undefined;
  }

  function backToCredentials(message: string | null): void {
    setStep({ kind: "credentials" });
    setShops(null);
    setCode("");
    setCodeError(null);
    setError(message);
  }

  /** Logs in to one shop: the OTP step follows. `remember` is the merchant
   *  ID to keep for the next visit. */
  async function startLogin(merchantIdToSend: string, remember: string): Promise<void> {
    const challenge = await login({ merchantId: merchantIdToSend, email, password });
    setLoginMerchantId(remember);
    setChosenShop(shops?.find((shop) => shop.merchantId === merchantIdToSend)?.displayName ?? null);
    setShops(null);
    setStep({ kind: "otp", challenge });
    setPassword("");
  }

  async function submitCredentials(merchantIdToSend: string | undefined): Promise<void> {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      if (merchantIdToSend !== undefined) {
        await startLogin(merchantIdToSend, merchantIdToSend);
      } else {
        const found = await loginShops({ email, password });
        if (found.length === 1) {
          await startLogin(found[0]!.merchantId, "");
        } else {
          setShops(found);
        }
      }
    } catch (err) {
      setError(errorMessage(err, "login"));
    } finally {
      setSubmitting(false);
    }
  }

  function handleCredentials(event: React.FormEvent): void {
    event.preventDefault();
    const emailProblem = checkEmail(email);
    const passwordProblem = password === "" ? "Enter your password" : null;
    const merchantIdProblem = showMerchantId && merchantId.trim() !== "" ? checkUuid(merchantId) : null;
    setEmailError(emailProblem);
    setPasswordError(passwordProblem);
    setMerchantIdError(merchantIdProblem);
    if (emailProblem || passwordProblem || merchantIdProblem) return;
    void submitCredentials(sentMerchantId());
  }

  // after otp we get logged out after ~10 min. cookie ttl never extended? — am
  // MK: that's the idle timeout, by design
  async function handleOtp(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    const codeProblem = checkOtp(code, otpLength);
    setCodeError(codeProblem);
    if (codeProblem) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      await verifyOtp({ code });
      writeLastMerchantId(loginMerchantId);
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
      setCodeError(null);
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
            <form onSubmit={handleCredentials} className="dash-form" noValidate>
              <label>
                Email
                <input
                  type="email"
                  inputMode="email"
                  autoComplete="username"
                  required
                  maxLength={EMAIL_MAX}
                  spellCheck={false}
                  aria-invalid={emailError ? true : undefined}
                  aria-describedby={describedBy(emailNoteId, emailError)}
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setShops(null);
                    if (emailError) setEmailError(checkEmail(e.target.value));
                  }}
                  onBlur={() => {
                    if (email.trim() !== "") setEmailError(checkEmail(email));
                  }}
                />
              </label>
              <FieldNote id={emailNoteId} error={emailError} />
              <label>
                Password
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  aria-invalid={passwordError ? true : undefined}
                  aria-describedby={describedBy(passwordNoteId, passwordError)}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setShops(null);
                    if (e.target.value !== "") setPasswordError(null);
                  }}
                />
              </label>
              <FieldNote id={passwordNoteId} error={passwordError} />
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
                      maxLength={36}
                      aria-invalid={merchantIdError ? true : undefined}
                      aria-describedby={describedBy(merchantIdNoteId, merchantIdError)}
                      value={merchantId}
                      onChange={(e) => {
                        const next = filterUuidInput(e.target.value);
                        setMerchantId(next);
                        if (merchantIdError) setMerchantIdError(checkUuid(next));
                      }}
                      onBlur={() => {
                        if (merchantId !== "") setMerchantIdError(checkUuid(merchantId));
                      }}
                    />
                  </label>
                  <FieldNote id={merchantIdNoteId} error={merchantIdError} />
                  <p className="dash-muted dash-hint">
                    The shop ID FilsPay gave you when your account was set up. Ask your shop
                    owner if you do not have it.
                  </p>
                  <button
                    type="button"
                    className="dash-text-button"
                    onClick={() => {
                      setShowMerchantId(false);
                      setMerchantIdError(null);
                    }}
                  >
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
            <form onSubmit={(e) => void handleOtp(e)} className="dash-form" noValidate>
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
                  pattern={`\\d{${otpLength}}`}
                  required
                  autoFocus
                  aria-invalid={codeError ? true : undefined}
                  aria-describedby={describedBy(codeNoteId, codeError)}
                  value={code}
                  onChange={(e) => {
                    // maxLength would cut a pasted "123 456" before the space is dropped.
                    const next = digitsOnly(e.target.value, otpLength);
                    setCode(next);
                    if (codeError) setCodeError(checkOtp(next, otpLength));
                  }}
                  onBlur={() => {
                    if (code !== "") setCodeError(checkOtp(code, otpLength));
                  }}
                />
              </label>
              <FieldNote id={codeNoteId} error={codeError} />
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

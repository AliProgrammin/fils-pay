import { useId, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { login, verifyOtp } from "../../api/auth.js";
import { ApiError } from "../../api/client.js";
import { errorMessage } from "../../errors.js";
import { useAdminAuth } from "../../auth/AdminAuthContext.js";
import type { AdminLoginResponse } from "../../types.js";
import { formatTime } from "../../format.js";
import { FieldNote, describedBy } from "../../components/FieldNote.js";
import { checkEmail, checkOtp, digitsOnly, EMAIL_MAX, OTP_LENGTH } from "../../inputRules.js";

type Step =
  | { kind: "credentials" }
  | { kind: "otp"; challenge: AdminLoginResponse };

/**
 * Two-step admin login: email + password creates a *pending* session
 * and issues an OTP challenge; the OTP step is what actually authenticates
 * it. Neither step is told which half of a bad credential pair was wrong —
 * the API answers a single generic `invalid_credentials`, and this screen
 * repeats it verbatim rather than guessing at something more specific.
 */
export function LoginPage() {
  const { status, refresh } = useAdminAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [step, setStep] = useState<Step>({ kind: "credentials" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const emailNoteId = useId();
  const passwordNoteId = useId();
  const codeNoteId = useId();
  // The API does not send the code length; a dev code shows it, else the
  // API's default (ADMIN_OTP_CODE_LENGTH = 6).
  const otpLength = step.kind === "otp" && step.challenge.devOtpCode ? step.challenge.devOtpCode.length : OTP_LENGTH;

  const redirectTo =
    (location.state as { from?: string } | null)?.from ?? "/merchants";

  if (status === "authenticated") {
    return <Navigate to={redirectTo} replace />;
  }

  async function handleCredentials(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const emailProblem = checkEmail(email);
    const passwordProblem = password === "" ? "Enter your password" : null;
    setEmailError(emailProblem);
    setPasswordError(passwordProblem);
    if (emailProblem || passwordProblem) return;
    setSubmitting(true);
    setError(null);
    try {
      const challenge = await login({ email, password });
      setStep({ kind: "otp", challenge });
      setPassword("");
    } catch (err) {
      setError(errorMessage(err, "login"));
    } finally {
      setSubmitting(false);
    }
  }

  // YA: admin verify re-issues the cookie with the full TTL
  async function handleOtp(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const codeProblem = checkOtp(code, otpLength);
    setCodeError(codeProblem);
    if (codeProblem) return;
    setSubmitting(true);
    setError(null);
    try {
      await verifyOtp({ code });
      // The session cookie is now authenticated server-side; re-read `me`
      // so the rest of the console renders from the server's answer, not
      // from the verify response we happen to be holding.
      await refresh();
      navigate(redirectTo, { replace: true });
    } catch (err) {
      // These end the pending sign-in server-side: retrying the code can
      // only fail again, so start over.
      if (err instanceof ApiError && (err.code === "too_many_attempts" || err.code === "no_pending_session" || err.code === "otp_expired")) {
        setStep({ kind: "credentials" });
        setCode("");
        setCodeError(null);
      }
      setError(errorMessage(err, "otp"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="admin-login">
      <div className="admin-login-bar">
        <span>FilsPay · Operations console</span>
        <span>Restricted · Staff only</span>
      </div>
      <main className="admin-login-card">
        <p className="admin-kicker">Internal operations console</p>
        <h1>FilsPay Admin</h1>
        <p className="admin-muted">Sign in with your staff account. Every action is recorded in the admin audit log.</p>
        <p className="admin-login-step">
          <span aria-current={step.kind === "credentials" ? "step" : undefined}>1 · Password</span>
          <span aria-current={step.kind === "otp" ? "step" : undefined}>2 · One-time code</span>
        </p>

        {error ? <p className="admin-error" role="alert">{error}</p> : null}

        {step.kind === "credentials" ? (
          <form onSubmit={(e) => void handleCredentials(e)} className="admin-form" noValidate>
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
                  if (e.target.value !== "") setPasswordError(null);
                }}
              />
            </label>
            <FieldNote id={passwordNoteId} error={passwordError} />
            <button type="submit" className="admin-btn-primary" disabled={submitting}>
              {submitting ? "Signing in…" : "Continue"}
            </button>
          </form>
        ) : (
          <form onSubmit={(e) => void handleOtp(e)} className="admin-form" noValidate>
            <p>
              A one-time code was issued for <strong>{email}</strong>. It expires at{" "}
              {formatTime(step.challenge.otpExpiresAt)} (Bahrain time).
            </p>
            {step.challenge.devOtpCode ? (
              <p className="admin-devcode">
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
            <button type="submit" className="admin-btn-primary" disabled={submitting}>
              {submitting ? "Verifying…" : "Verify"}
            </button>
            <button
              type="button"
              onClick={() => {
                setStep({ kind: "credentials" });
                setCode("");
                setCodeError(null);
                setError(null);
              }}
            >
              Start over
            </button>
          </form>
        )}
      </main>
    </div>
  );
}

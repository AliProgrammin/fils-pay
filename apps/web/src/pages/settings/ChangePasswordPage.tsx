import { useId, useState } from "react";
import { changePassword } from "../../api/dashboardAuth.js";
import { FieldNote, describedBy } from "../../components/FieldNote.js";
import { useToast } from "../../components/Toast.js";
import { useAction } from "../../components/useAction.js";
import { errorMessage } from "../../errors.js";
import { checkNewPassword, PASSWORD_MAX, PASSWORD_MIN } from "../../inputRules.js";

/**
 * `POST /v1/auth/password`. The user types the current password and the new
 * one twice. On success the server ends every other session of this user;
 * this one stays signed in.
 */
export function ChangePasswordPage() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [nextError, setNextError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, run] = useAction();
  const notify = useToast();
  const currentNoteId = useId();
  const nextNoteId = useId();

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    const missingCurrent = current === "" ? "Enter your current password" : null;
    const problem = checkNewPassword(next, confirm, current);
    setCurrentError(missingCurrent);
    setNextError(problem);
    if (missingCurrent || problem) return;
    setDone(false);
    await run(async () => {
      try {
        await changePassword({ currentPassword: current, newPassword: next });
        setCurrent("");
        setNext("");
        setConfirm("");
        setDone(true);
        notify("Password changed");
      } catch (err) {
        setError(errorMessage(err, "passwordChange"));
      }
    });
  }

  return (
    <section>
      <div className="dash-page-head">
        <div>
          <p className="dash-kicker">Settings · your account</p>
          <h1>Change password</h1>
        </div>
      </div>

      {error ? <p className="dash-error" role="alert">{error}</p> : null}
      {done ? (
        <p className="dash-notice" role="status">
          Your password is changed. You are signed out on every other device and browser.
        </p>
      ) : null}

      <form className="dash-form dash-card" noValidate onSubmit={(e) => void handleSubmit(e)}>
        <label>
          Current password
          <input
            type="password"
            autoComplete="current-password"
            required
            aria-invalid={currentError ? true : undefined}
            aria-describedby={describedBy(currentNoteId, currentError)}
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value);
              if (e.target.value !== "") setCurrentError(null);
            }}
          />
        </label>
        <FieldNote id={currentNoteId} error={currentError} />
        <label>
          New password
          <input
            type="password"
            autoComplete="new-password"
            required
            maxLength={PASSWORD_MAX}
            aria-invalid={nextError ? true : undefined}
            aria-describedby={describedBy(nextNoteId, nextError)}
            value={next}
            onChange={(e) => {
              setNext(e.target.value);
              if (nextError) setNextError(null);
            }}
          />
        </label>
        <label>
          New password again
          <input
            type="password"
            autoComplete="new-password"
            required
            maxLength={PASSWORD_MAX}
            aria-invalid={nextError ? true : undefined}
            aria-describedby={describedBy(nextNoteId, nextError)}
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              if (nextError) setNextError(null);
            }}
          />
        </label>
        <FieldNote id={nextNoteId} error={nextError} />
        <p className="dash-muted dash-hint">
          Use {PASSWORD_MIN} to {PASSWORD_MAX} characters. A short sentence is easy to remember and hard to guess.
          When you save, you are signed out everywhere else.
        </p>
        <button type="submit" className="dash-button dash-button-primary" disabled={busy} aria-busy={busy || undefined}>
          {busy ? "Saving…" : "Change password"}
        </button>
      </form>
    </section>
  );
}

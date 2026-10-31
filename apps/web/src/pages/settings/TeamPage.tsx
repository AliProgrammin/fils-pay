import { useCallback, useEffect, useId, useState } from "react";
import { addTeamMember, changeTeamMemberRole, listTeam, removeTeamMember } from "../../api/team.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { useConfirmDialog } from "../../components/ConfirmDialog.js";
import { CopyButton } from "../../components/CopyButton.js";
import { FieldNote, describedBy } from "../../components/FieldNote.js";
import { useToast } from "../../components/Toast.js";
import { useAction } from "../../components/useAction.js";
import { errorMessage } from "../../errors.js";
import { dateTime } from "../../format.js";
import { checkEmail, EMAIL_MAX } from "../../inputRules.js";
import type { MerchantRole, TeamMember, TeamMemberCreated } from "../../types.js";

const ROLES: { value: MerchantRole; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "finance", label: "Finance" },
  { value: "support", label: "Support" },
];

const ROLE_HELP = "Owner: everything, including the team and API keys. Finance: payments, refunds, payouts and webhooks. Support: view only.";

/**
 * `GET/POST /v1/merchants/:merchantId/users`, `PATCH/DELETE .../users/:id`.
 * Every role may see the team; only an owner sees the add form and the row
 * actions (the server answers 403 to anyone else regardless). An owner
 * cannot change or remove their own row, and the last owner is protected
 * server-side.
 *
 * The one-time password from an add is held in this page's state only: it
 * is shown once, until the owner hides it or leaves the page.
 */
export function TeamPage() {
  const { me } = useDashboardAuth();
  const merchantId = me?.merchant.id;
  const isOwner = me?.role === "owner";

  const [users, setUsers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MerchantRole>("support");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [created, setCreated] = useState<TeamMemberCreated | null>(null);
  const [rowBusy, setRowBusy] = useState<{ id: string; action: "role" | "remove" } | null>(null);
  const [adding, runAdd] = useAction();
  const [confirmDialog, confirm] = useConfirmDialog();
  const notify = useToast();
  const emailNoteId = useId();
  const roleHelpId = useId();

  const load = useCallback(async () => {
    if (!merchantId) return;
    setLoading(true);
    try {
      setUsers(await listTeam(merchantId));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [merchantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAdd(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId) return;
    const problem = checkEmail(email);
    setEmailError(problem);
    if (problem) return;
    setError(null);
    await runAdd(async () => {
      try {
        const result = await addTeamMember(merchantId, { email: email.trim(), role });
        setCreated(result);
        setEmail("");
        setRole("support");
        notify("User added");
        await load();
      } catch (err) {
        setError(errorMessage(err, "teamAdd"));
      }
    });
  }

  async function handleRoleChange(user: TeamMember, nextRole: MerchantRole): Promise<void> {
    if (!merchantId || rowBusy || nextRole === user.role) return;
    const confirmed = await confirm({
      title: "Change this user's role?",
      message: `${user.email} will be ${nextRole} instead of ${user.role}. This takes effect at once, also in browsers where they are signed in.`,
      confirmLabel: "Change role",
      cancelLabel: "Keep role",
    });
    if (!confirmed) return;
    setRowBusy({ id: user.id, action: "role" });
    setError(null);
    try {
      await changeTeamMemberRole(merchantId, user.id, nextRole);
      notify("Role changed");
      await load();
    } catch (err) {
      setError(errorMessage(err, "teamUpdate"));
    } finally {
      setRowBusy(null);
    }
  }

  async function handleRemove(user: TeamMember): Promise<void> {
    if (!merchantId || rowBusy) return;
    const confirmed = await confirm({
      title: "Remove this user?",
      message: `${user.email} will lose access to this shop and be signed out at once. You can add them again later.`,
      confirmLabel: "Remove",
      cancelLabel: "Keep user",
    });
    if (!confirmed) return;
    setRowBusy({ id: user.id, action: "remove" });
    setError(null);
    try {
      await removeTeamMember(merchantId, user.id);
      notify("User removed");
      await load();
    } catch (err) {
      setError(errorMessage(err, "teamUpdate"));
    } finally {
      setRowBusy(null);
    }
  }

  return (
    <section>
      {confirmDialog}
      <div className="dash-page-head">
        <div>
          <p className="dash-kicker">Settings · people</p>
          <h1>Team</h1>
        </div>
      </div>

      {error ? <p className="dash-error" role="alert">{error}</p> : null}

      {created ? (
        <div className="dash-confirm">
          <h2>One-time password — shown once</h2>
          <p className="dash-wrap-anywhere">
            For <strong>{created.email}</strong> ({created.role})
          </p>
          <p>
            <strong>Give this to your teammate. It will not be shown again.</strong> They sign in with
            this email and password, and they should change the password after they sign in
            (Settings, Password).
          </p>
          <p className="dash-copy-row">
            <code className="dash-secret">{created.initialPassword}</code>
            <CopyButton value={created.initialPassword} label="Copy password" copiedMessage="Password copied" />
          </p>
          <button type="button" className="dash-button" onClick={() => setCreated(null)}>
            I&apos;ve given it to them — hide it
          </button>
        </div>
      ) : null}

      {isOwner ? (
        <form className="dash-form dash-form-inline dash-card" noValidate onSubmit={(e) => void handleAdd(e)}>
          <label className="dash-grow">
            Email
            <input
              type="email"
              inputMode="email"
              autoComplete="off"
              spellCheck={false}
              required
              maxLength={EMAIL_MAX}
              placeholder="name@shop.com"
              aria-invalid={emailError ? true : undefined}
              aria-describedby={describedBy(emailNoteId, emailError)}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (emailError) setEmailError(checkEmail(e.target.value));
              }}
            />
          </label>
          <label>
            Role
            <select value={role} aria-describedby={roleHelpId} onChange={(e) => setRole(e.target.value as MerchantRole)}>
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="dash-button dash-button-primary" disabled={adding} aria-busy={adding || undefined}>
            {adding ? "Adding…" : "Add user"}
          </button>
        </form>
      ) : (
        <p className="dash-callout">Only a shop owner can add, change or remove users.</p>
      )}
      {isOwner ? <FieldNote id={emailNoteId} error={emailError} /> : null}
      <p className="dash-muted dash-hint" id={roleHelpId}>
        {ROLE_HELP}
      </p>

      <div className="dash-table-wrap">
        <table className="dash-table dash-table-cards">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Added</th>
              {isOwner ? <th>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const isSelf = user.id === me?.merchantUserId;
              const busyHere = rowBusy?.id === user.id;
              return (
                <tr key={user.id}>
                  <td data-label="Email" className="dash-wrap">
                    {user.email}
                    {isSelf ? <span className="dash-muted"> (you)</span> : null}
                  </td>
                  <td data-label="Role">
                    {isOwner && !isSelf ? (
                      <select
                        className="dash-row-select"
                        aria-label={`Role for ${user.email}`}
                        value={user.role}
                        disabled={rowBusy !== null}
                        aria-busy={(busyHere && rowBusy?.action === "role") || undefined}
                        onChange={(e) => void handleRoleChange(user, e.target.value as MerchantRole)}
                      >
                        {ROLES.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="dash-role-text">{user.role}</span>
                    )}
                  </td>
                  <td className="dash-nowrap" data-label="Added">{dateTime(user.createdAt)}</td>
                  {isOwner ? (
                    <td className="dash-nowrap" data-label="Actions">
                      {isSelf ? (
                        <span className="dash-muted">Ask another owner</span>
                      ) : (
                        <button
                          type="button"
                          className="dash-button dash-button-small dash-button-danger"
                          disabled={rowBusy !== null}
                          aria-busy={(busyHere && rowBusy?.action === "remove") || undefined}
                          onClick={() => void handleRemove(user)}
                        >
                          {busyHere && rowBusy?.action === "remove" ? "Removing…" : "Remove"}
                        </button>
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
            {users.length === 0 && !loading && !error ? (
              <tr>
                <td colSpan={isOwner ? 4 : 3} className="dash-empty">No users.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {loading ? <p className="dash-loading" role="status">Loading…</p> : null}
    </section>
  );
}

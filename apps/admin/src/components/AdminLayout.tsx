import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAdminAuth } from "../auth/AdminAuthContext.js";
import { WEB_BASE_URL } from "../api/client.js";
import { errorMessage } from "../errors.js";
import { ImpersonationBanner } from "./ImpersonationBanner.js";

/** Nav shell for every admin-plane screen: who you are signed in as, the
 *  section links, a logout, and — above all of it — the impersonation
 *  banner when a grant is live. */
// YA: nav order per Huda's request (Credits first)
export function AdminLayout() {
  const { admin, signOut, impersonation } = useAdminAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  // Close the small-screen menu after moving to another page.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  async function handleSignOut(): Promise<void> {
    setError(null);
    try {
      await signOut();
      navigate("/login", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="admin-shell">
      <ImpersonationBanner />

      <header className="admin-header">
        <div className="admin-brand">
          <span className="admin-brand-name">
            Fils<span>Pay</span>
          </span>
          <span className="admin-brand-tag">Operations</span>
        </div>
        <button
          type="button"
          className="admin-menu-button"
          aria-expanded={menuOpen}
          aria-controls="admin-nav"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? "Close menu" : "Menu"}
        </button>
        <nav
          id="admin-nav"
          className={menuOpen ? "admin-nav admin-nav-open" : "admin-nav"}
          aria-label="Admin sections"
        >
          <NavLink to="/merchants">Merchants</NavLink>
          <NavLink to="/credits">Credits</NavLink>
          <NavLink to="/settlement">Settlement ops</NavLink>
          <NavLink to="/adjustment-imports">Import adjustments</NavLink>
          <NavLink to="/fraud-notes">Fraud notes</NavLink>
          <NavLink to="/webhooks">Webhook replay</NavLink>
        </nav>
        <div className="admin-identity">
          {admin ? (
            <span className="admin-identity-who">
              <span className="admin-identity-email">{admin.email}</span>
              <span className="admin-role-chip">{admin.role}</span>
            </span>
          ) : null}
          <button type="button" onClick={() => void handleSignOut()}>
            Log out
          </button>
        </div>
      </header>

      {error ? <p className="admin-error" role="alert">{error}</p> : null}

      {impersonation ? (
        // An explicit "exit view-as-merchant" action is required before
        // admin-plane screens are shown again. This is a UX safeguard so the
        // two modes are never confused on screen; the privilege boundary
        // itself does not depend on it — /v1/admin/* never reads the
        // impersonation cookie, and the merchant side never reads the admin
        // session cookie.
        <main className="admin-main">
          <header className="admin-page-head">
            <p className="admin-kicker">Impersonation active</p>
            <h1>Admin screens are paused</h1>
          </header>
          <p>
            An impersonation grant is active. Use <strong>Exit impersonation</strong> above to end it
            and return to the admin console.
          </p>
          <p>
            Merchant screens are at <code>{WEB_BASE_URL}</code> while the grant lasts.
          </p>
        </main>
      ) : (
        <main className="admin-main">
          <Outlet />
        </main>
      )}
    </div>
  );
}

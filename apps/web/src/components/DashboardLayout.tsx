import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useDashboardAuth } from "../auth/DashboardAuthContext.js";
import { RequireRole } from "../auth/RequireRole.js";
import { errorMessage } from "../errors.js";
import "../dashboard.css";

/** Nav shell for every merchant dashboard screen. No impersonation banner
 *  here — nothing in the merchant plane impersonates anyone; when an admin
 *  "views as merchant", they arrive with a `support`-role session and see
 *  exactly what a support user sees. */
export function DashboardLayout() {
  const { me, signOut } = useDashboardAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const location = useLocation();

  // A phone's menu closes once a page is chosen.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  // sign out clears the cookie server side, local merchantId stays — am
  async function handleSignOut(): Promise<void> {
    if (signingOut) return;
    setSigningOut(true);
    setError(null);
    try {
      await signOut();
      navigate("/dashboard/login", { replace: true });
    } catch (err) {
      setError(errorMessage(err, "signOut"));
      setSigningOut(false);
    }
  }

  return (
    <div className="dash-shell">
      <a className="dash-skip" href="#dash-main">
        Skip to content
      </a>
      <header className="dash-header">
        <div className="dash-brand">
          <span className="dash-brand-name">FilsPay</span>
          <span className="dash-brand-tag">Merchant</span>
        </div>
        <nav id="dash-nav" className={menuOpen ? "dash-nav dash-nav-open" : "dash-nav"} aria-label="Dashboard">
          <NavLink to="/dashboard/transactions">Transactions</NavLink>
          <NavLink to="/dashboard/payment-links">Payment links</NavLink>
          {/* Every webhook route — including the plain list read — is
              owner/finance-only server-side, so the link itself is
              hidden from support rather than offered and then refused. */}
          <RequireRole allow={["owner", "finance"]}>
            <NavLink to="/dashboard/webhooks">Webhooks</NavLink>
          </RequireRole>
          <NavLink to="/dashboard/settlement">Settlement</NavLink>
          <RequireRole allow={["owner", "finance"]}>
            <NavLink to="/dashboard/reconciliation">Reconciliation</NavLink>
          </RequireRole>
          <NavLink to="/dashboard/overview">Overview</NavLink>
        </nav>
        <div className="dash-identity">
          {me ? (
            <>
              <span className="dash-identity-text">
                <span className="dash-identity-shop">{me.merchant.displayName}</span>
                <span className="dash-identity-email">{me.email}</span>
              </span>
              <span className="dash-role-chip">{me.role}</span>
            </>
          ) : null}
          <button
            type="button"
            className="dash-button dash-menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="dash-nav"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? "Close" : "Menu"}
          </button>
          <button
            type="button"
            className="dash-button"
            disabled={signingOut}
            aria-busy={signingOut || undefined}
            onClick={() => void handleSignOut()}
          >
            {signingOut ? "Logging out…" : "Log out"}
          </button>
        </div>
      </header>

      <main className="dash-main" id="dash-main" tabIndex={-1}>
        {error ? <p className="dash-error" role="alert">{error}</p> : null}
        <Outlet />
      </main>
    </div>
  );
}

import { NavLink, Outlet } from "react-router-dom";
import { RequireRole } from "../../auth/RequireRole.js";
import type { MerchantRole } from "../../types.js";

/** The settings pages, in tab order. A new page is one row here plus its
 *  route in router.tsx. `allow` hides the tab from the other roles when the
 *  API refuses them the page's first read (same rule as the main nav). */
const SETTINGS_PAGES: { to: string; label: string; allow?: MerchantRole[] }[] = [
  { to: "/dashboard/settings/profile", label: "Business profile" },
  { to: "/dashboard/settings/api-keys", label: "API keys", allow: ["owner"] },
  { to: "/dashboard/settings/kyc", label: "KYC documents" },
  { to: "/dashboard/settings/team", label: "Team" },
  { to: "/dashboard/settings/password", label: "Password" },
];

/** Tabs for /dashboard/settings/*. Each page under it has its own heading. */
export function SettingsLayout() {
  return (
    <>
      <nav className="dash-subnav" aria-label="Settings">
        {SETTINGS_PAGES.map((page) =>
          page.allow ? (
            <RequireRole key={page.to} allow={page.allow}>
              <NavLink to={page.to}>{page.label}</NavLink>
            </RequireRole>
          ) : (
            <NavLink key={page.to} to={page.to}>
              {page.label}
            </NavLink>
          ),
        )}
      </nav>
      <Outlet />
    </>
  );
}

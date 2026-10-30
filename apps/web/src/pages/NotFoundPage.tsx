import { isRouteErrorResponse, Link, useLocation, useRouteError } from "react-router-dom";
import "../dashboard.css";

/** Shared frame for the two "nothing to show here" screens. Never renders a
 *  stack trace or an error message from code: only a fixed sentence. */
function ErrorFrame({
  kicker,
  title,
  text,
  customer = false,
}: {
  kicker: string;
  title: string;
  text: string;
  /** A /pay page: seen by a paying customer, so no merchant links. */
  customer?: boolean;
}) {
  return (
    <div className="dash-login">
      <div className="dash-login-bar">
        <div className="dash-brand">
          <span className="dash-brand-name">FilsPay</span>
          {customer ? null : <span className="dash-brand-tag">Merchant</span>}
        </div>
      </div>
      <main className="dash-login-main dash-error-page">
        <section>
          <p className="dash-kicker">{kicker}</p>
          <h1>{title}</h1>
          <p className="dash-login-lede">{text}</p>
          {/* One way out: the dashboard sends a signed-out visitor to the
              sign-in page by itself, so a signed-in one is never offered it. */}
          {customer ? null : (
            <p className="dash-actions dash-error-actions">
              <Link className="dash-button dash-button-primary" to="/dashboard">
                Go to the dashboard
              </Link>
            </p>
          )}
        </section>
      </main>
    </div>
  );
}

/** `/pay`, `/pay/` and `/pay/...`: the public checkout space. */
function isCustomerPath(pathname: string): boolean {
  return pathname === "/pay" || pathname.startsWith("/pay/");
}

/** Any URL that matches no route. */
export function NotFoundPage() {
  const { pathname } = useLocation();
  if (isCustomerPath(pathname)) {
    return (
      <ErrorFrame
        customer
        kicker="Error 404 · Payment link not found"
        title="Payment link not found."
        text="Check the link you were sent, or contact the shop that sent it."
      />
    );
  }
  return (
    <ErrorFrame
      kicker="Error 404 · Page not found"
      title="Nothing filed here."
      text="This page does not exist. Check the address, or go back to your dashboard."
    />
  );
}

/** The router's errorElement: a page that threw while rendering or loading. */
export function RouteErrorPage() {
  const error = useRouteError();
  const { pathname } = useLocation();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFoundPage />;
  }
  if (isCustomerPath(pathname)) {
    return (
      <ErrorFrame
        customer
        kicker="Error · Something went wrong"
        title="This payment page could not open."
        text="Reload the page. If it still does not open, contact the shop that sent you the link."
      />
    );
  }
  return (
    <ErrorFrame
      kicker="Error · Something went wrong"
      title="This page could not open."
      text="Something went wrong while showing this page. Reload, or go back to your dashboard."
    />
  );
}

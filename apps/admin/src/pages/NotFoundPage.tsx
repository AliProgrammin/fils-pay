import { isRouteErrorResponse, Link, useRouteError } from "react-router-dom";

/** Unknown admin path, shown inside the console shell. */
export function NotFoundPage() {
  return (
    <div className="admin-oops">
      <div className="admin-panel">
        <p className="admin-kicker">Case file not found</p>
        <p className="admin-oops-code" aria-hidden="true">404</p>
        <h1>No page at this address</h1>
        <p className="admin-muted">
          The link may be old or mistyped. Nothing was changed.
        </p>
        <p className="admin-actions">
          <Link to="/merchants">Go to merchants</Link>
        </p>
      </div>
    </div>
  );
}

/**
 * Route `errorElement`: replaces React Router's default error screen. It
 * shows a plain message and never a stack trace; the detail stays in the
 * browser console for whoever is debugging.
 */
export function RouteErrorPage() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  if (!notFound) console.error(error);

  return (
    <div className="admin-oops" role="alert">
      <div className="admin-panel">
        <p className="admin-kicker">{notFound ? "Case file not found" : "Something went wrong"}</p>
        <p className="admin-oops-code" aria-hidden="true">
          {notFound ? "404" : "Error"}
        </p>
        <h1>{notFound ? "No page at this address" : "This screen could not be shown"}</h1>
        <p className="admin-muted">
          {notFound
            ? "The link may be old or mistyped. Nothing was changed."
            : "Reload the page to try again. If it keeps happening, tell the platform team what you clicked."}
        </p>
        <p className="admin-actions">
          <a href={`${import.meta.env.BASE_URL}merchants`}>Go to merchants</a>
        </p>
      </div>
    </div>
  );
}

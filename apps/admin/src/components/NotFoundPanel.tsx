import { Link } from "react-router-dom";

/**
 * The "nothing here" screen of the console: an unknown path, or a detail page
 * whose id is bad or unknown. One way back.
 */
export function NotFoundPanel({
  title,
  text,
  backTo,
  backLabel,
}: {
  title: string;
  text: string;
  backTo: string;
  backLabel: string;
}) {
  return (
    <div className="admin-oops">
      <div className="admin-panel">
        <p className="admin-kicker">Case file not found</p>
        <p className="admin-oops-code" aria-hidden="true">404</p>
        <h1>{title}</h1>
        <p className="admin-muted">{text}</p>
        <p className="admin-actions">
          <Link to={backTo}>{backLabel}</Link>
        </p>
      </div>
    </div>
  );
}

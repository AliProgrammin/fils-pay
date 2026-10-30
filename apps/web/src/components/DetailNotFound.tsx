import { Link } from "react-router-dom";

/**
 * The "nothing here" state of a detail page (bad or unknown id). Same look as
 * a page head, plus one way back to the list.
 */
export function DetailNotFound({
  kicker,
  title,
  text,
  backTo,
  backLabel,
}: {
  kicker: string;
  title: string;
  text: string;
  backTo: string;
  backLabel: string;
}) {
  return (
    <section>
      <div className="dash-page-head">
        <div>
          <p className="dash-kicker">{kicker}</p>
          <h1>{title}</h1>
        </div>
      </div>
      <p className="dash-note">{text}</p>
      <p className="dash-actions">
        <Link className="dash-button-link dash-button-primary" to={backTo}>
          {backLabel}
        </Link>
      </p>
    </section>
  );
}

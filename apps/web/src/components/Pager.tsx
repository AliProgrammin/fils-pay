import { PAGE_SIZES, pageLabel, type PageSize } from "../pager.js";

/** "Page N · rows A–B", Previous / Next, and rows per page. No total count:
 *  the API gives only a next cursor. */
export function Pager({
  page,
  size,
  count,
  hasNext,
  loading,
  onPrev,
  onNext,
  onSize,
}: {
  page: number;
  size: PageSize;
  count: number;
  hasNext: boolean;
  loading: boolean;
  onPrev: () => void;
  onNext: () => void;
  onSize: (size: PageSize) => void;
}) {
  if (page === 1 && !hasNext && count === 0) return null;
  return (
    <nav className="dash-pager" aria-label="Pages">
      <span className="dash-pager-label" aria-live="polite">
        {pageLabel(page, size, count)}
      </span>
      <div className="dash-pager-buttons">
        <button type="button" className="dash-button dash-button-small" disabled={page <= 1 || loading} onClick={onPrev}>
          ← Previous
        </button>
        <button type="button" className="dash-button dash-button-small" disabled={!hasNext || loading} onClick={onNext}>
          Next →
        </button>
      </div>
      <label className="dash-pager-size">
        Rows per page
        <select value={size} onChange={(e) => onSize(Number(e.target.value) as PageSize)}>
          {PAGE_SIZES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    </nav>
  );
}

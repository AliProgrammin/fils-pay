import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { CursorPageCache, loadPage, parsePage, parsePageSize, type PageEntry, type PageSize } from "../pager.js";

interface PagerHistoryState {
  pager?: { key: string; cursors: Record<string, string> };
}

/**
 * Previous / Next paging for a list page. Page, page size and filters live in
 * the URL query, so reload and browser back/forward keep the place. The
 * cursors already seen ride along in the history entry's state, so a reload
 * on page 3 is one request. Changing a filter resets to page 1.
 *
 * `filterKey` must change whenever the filters change; `fetchPage` reads the
 * current filters and asks the API for one page.
 */
export function usePagedList<T>(
  filterKey: string,
  fetchPage: (cursor: string | undefined, limit: PageSize) => Promise<PageEntry<T>>,
  enabled = true,
) {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const page = parsePage(searchParams.get("page"));
  const size = parsePageSize(searchParams.get("size"));
  const key = `${filterKey}|${size}`;

  const cacheRef = useRef<CursorPageCache<T> | null>(null);
  if (!cacheRef.current || cacheRef.current.key !== key) cacheRef.current = new CursorPageCache<T>(key);
  const cache = cacheRef.current;
  const historyState = location.state as PagerHistoryState | null;
  if (historyState?.pager?.key === key) cache.seedCursors(historyState.pager.cursors);

  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  const [view, setView] = useState<{ key: string; page: number; entry: PageEntry<T> } | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<unknown>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const current = cacheRef.current!;
    let cancelled = false;
    const cached = current.get(page);
    if (cached) {
      setView({ key: current.key, page, entry: cached });
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    loadPage(current, page, (cursor) => fetchRef.current(cursor, size))
      .then((result) => {
        if (cancelled) return;
        setView({ key: current.key, page: result.page, entry: result.entry });
        if (result.page !== page) {
          // The list ended earlier (rows were removed): show the last page.
          setSearchParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              if (result.page <= 1) next.delete("page");
              else next.set("page", String(result.page));
              return next;
            },
            { replace: true, state: { pager: { key: current.key, cursors: current.knownCursors() } } },
          );
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, page, enabled, reloadToken]);

  const goTo = useCallback(
    (target: number) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (target <= 1) next.delete("page");
          else next.set("page", String(target));
          return next;
        },
        { state: { pager: { key: cache.key, cursors: cache.knownCursors() } } },
      );
    },
    [cache, setSearchParams],
  );

  /** Changes filters in the URL and goes back to page 1. `replace` for a
   *  stream of keystrokes (search box) so history is not flooded. */
  const updateParams = useCallback(
    (mutate: (params: URLSearchParams) => void, options: { replace?: boolean } = {}) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          mutate(next);
          next.delete("page");
          return next;
        },
        { replace: options.replace },
      );
    },
    [setSearchParams],
  );

  const setSize = useCallback(
    (nextSize: PageSize) =>
      updateParams((params) => {
        if (nextSize === 25) params.delete("size");
        else params.set("size", String(nextSize));
      }),
    [updateParams],
  );

  /** Refetch the current page after an action changed the data. */
  const reload = useCallback(() => {
    cacheRef.current?.clearRows();
    setReloadToken((token) => token + 1);
  }, []);

  const current = view && view.key === key ? view : null;
  const rows = current?.entry.rows ?? [];
  const shownPage = current?.page ?? page;
  return {
    searchParams,
    rows,
    page: shownPage,
    size,
    loading,
    error,
    hasNext: Boolean(current?.entry.nextCursor),
    goNext: () => goTo(shownPage + 1),
    goPrev: () => goTo(Math.max(1, shownPage - 1)),
    setSize,
    updateParams,
    reload,
  };
}

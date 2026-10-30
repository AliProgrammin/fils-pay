/**
 * Previous / Next paging over the API's keyset cursors. Pure, so it runs
 * under plain `tsx --test`. There is no total count: the API gives only
 * `nextCursor`, so the pager knows "is there a next page", never "of N".
 */

export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 25;

/** `size` from the URL; anything not offered falls back to 25. */
export function parsePageSize(raw: string | null): PageSize {
  const value = Number(raw);
  return (PAGE_SIZES as readonly number[]).includes(value) ? (value as PageSize) : DEFAULT_PAGE_SIZE;
}

/** `page` from the URL; anything not a whole number >= 1 is page 1. */
export function parsePage(raw: string | null): number {
  if (raw === null || !/^\d+$/.test(raw)) return 1;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

/** Row numbers shown on a page: page 2 of 25 with 25 rows is 26–50. */
export function rowRange(page: number, size: number, count: number): { first: number; last: number } {
  if (count === 0) return { first: 0, last: 0 };
  const first = (page - 1) * size + 1;
  return { first, last: first + count - 1 };
}

/** "Page 2 · rows 26–50". */
export function pageLabel(page: number, size: number, count: number): string {
  const { first, last } = rowRange(page, size, count);
  return count === 0 ? `Page ${page} · no rows` : `Page ${page} · rows ${first}–${last}`;
}

export interface PageEntry<T> {
  rows: T[];
  nextCursor: string | null;
}

/**
 * The pages already fetched for one query (one filter set and page size).
 * Page 1 is fetched with no cursor; page N+1 with page N's `nextCursor`.
 * Cursors can also be seeded without rows (from browser history), so a reload
 * on page 3 needs one request, not three.
 */
export class CursorPageCache<T> {
  private readonly entries = new Map<number, PageEntry<T>>();
  private readonly cursors = new Map<number, string>();

  constructor(readonly key: string) {}

  get(page: number): PageEntry<T> | undefined {
    return this.entries.get(page);
  }

  put(page: number, entry: PageEntry<T>): void {
    this.entries.set(page, entry);
    if (entry.nextCursor) this.cursors.set(page + 1, entry.nextCursor);
    else this.cursors.delete(page + 1);
  }

  /** The cursor to fetch `page` with: null for page 1, undefined if unknown. */
  cursorFor(page: number): string | null | undefined {
    if (page <= 1) return null;
    return this.cursors.get(page);
  }

  /** Adds cursors remembered elsewhere (browser history) without rows. */
  seedCursors(cursors: Record<string, string>): void {
    for (const [page, cursor] of Object.entries(cursors)) {
      const n = Number(page);
      if (Number.isSafeInteger(n) && n >= 2 && typeof cursor === "string" && !this.cursors.has(n)) {
        this.cursors.set(n, cursor);
      }
    }
  }

  knownCursors(): Record<string, string> {
    return Object.fromEntries([...this.cursors].map(([page, cursor]) => [String(page), cursor]));
  }

  /** The nearest page at or before `page` that can be fetched directly. */
  startFor(page: number): number {
    for (let p = page; p > 1; p -= 1) {
      if (this.entries.has(p) || this.cursors.has(p)) return p;
    }
    return 1;
  }

  /** Forget every row (after an action changed the data) but keep cursors. */
  clearRows(): void {
    this.entries.clear();
  }
}

/**
 * Fetches pages from the nearest known one up to `page`, caching each. If
 * the list ends before `page`, returns the last page that exists.
 */
export async function loadPage<T>(
  cache: CursorPageCache<T>,
  page: number,
  fetchPage: (cursor: string | undefined) => Promise<PageEntry<T>>,
): Promise<{ page: number; entry: PageEntry<T> }> {
  const cached = cache.get(page);
  if (cached) return { page, entry: cached };
  let current = cache.startFor(page);
  for (;;) {
    let entry = cache.get(current);
    if (!entry) {
      const cursor = cache.cursorFor(current);
      entry = await fetchPage(cursor ?? undefined);
      cache.put(current, entry);
    }
    if (current >= page) return { page: current, entry };
    if (!entry.nextCursor) return { page: current, entry };
    current += 1;
  }
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { CursorPageCache, listBackHref, loadPage, pageLabel, parsePage, parsePageSize, rowRange, type PageEntry } from "./pager.js";

test("page and size parsing from the URL", () => {
  assert.equal(parsePageSize(null), 25);
  assert.equal(parsePageSize("50"), 50);
  assert.equal(parsePageSize("100"), 100);
  assert.equal(parsePageSize("1000"), 25);
  assert.equal(parsePageSize("abc"), 25);
  assert.equal(parsePage(null), 1);
  assert.equal(parsePage("3"), 3);
  assert.equal(parsePage("0"), 1);
  assert.equal(parsePage("-2"), 1);
  assert.equal(parsePage("2.5"), 1);
});

test("row range and label", () => {
  assert.deepEqual(rowRange(1, 25, 25), { first: 1, last: 25 });
  assert.deepEqual(rowRange(2, 25, 25), { first: 26, last: 50 });
  assert.deepEqual(rowRange(3, 50, 7), { first: 101, last: 107 });
  assert.equal(pageLabel(2, 25, 25), "Page 2 · rows 26–50");
  assert.equal(pageLabel(1, 25, 0), "Page 1 · no rows");
});

/** A fake API: 60 rows, keyset cursor = index of the next row. */
function fakeApi(size: number) {
  const calls: Array<string | undefined> = [];
  const fetchPage = async (cursor: string | undefined): Promise<PageEntry<number>> => {
    calls.push(cursor);
    const start = cursor ? Number(cursor) : 0;
    const rows = Array.from({ length: Math.max(0, Math.min(size, 60 - start)) }, (_, i) => start + i);
    const next = start + size < 60 ? String(start + size) : null;
    return { rows, nextCursor: next };
  };
  return { calls, fetchPage };
}

test("next uses nextCursor; previous replays the cache with no request", async () => {
  const api = fakeApi(25);
  const cache = new CursorPageCache<number>("k");
  const p1 = await loadPage(cache, 1, api.fetchPage);
  assert.equal(p1.entry.rows[0], 0);
  const p2 = await loadPage(cache, 2, api.fetchPage);
  assert.equal(p2.entry.rows[0], 25);
  assert.deepEqual(api.calls, [undefined, "25"]);
  const back = await loadPage(cache, 1, api.fetchPage);
  assert.equal(back.entry.rows[0], 0);
  assert.equal(api.calls.length, 2, "previous page came from the cache");
});

test("a fresh load on page 3 walks from page 1; seeded cursors need one request", async () => {
  const walk = fakeApi(25);
  const fresh = new CursorPageCache<number>("k");
  const p3 = await loadPage(fresh, 3, walk.fetchPage);
  assert.equal(p3.page, 3);
  assert.deepEqual(p3.entry.rows, Array.from({ length: 10 }, (_, i) => 50 + i));
  assert.deepEqual(walk.calls, [undefined, "25", "50"]);

  const seeded = fakeApi(25);
  const cache = new CursorPageCache<number>("k");
  cache.seedCursors(fresh.knownCursors());
  const again = await loadPage(cache, 3, seeded.fetchPage);
  assert.equal(again.entry.rows[0], 50);
  assert.deepEqual(seeded.calls, ["50"]);
});

test("asking past the end returns the last page that exists", async () => {
  const api = fakeApi(25);
  const cache = new CursorPageCache<number>("k");
  const result = await loadPage(cache, 9, api.fetchPage);
  assert.equal(result.page, 3);
  assert.equal(result.entry.nextCursor, null);
});

test("clearRows keeps cursors so the current page refetches with one request", async () => {
  const api = fakeApi(25);
  const cache = new CursorPageCache<number>("k");
  await loadPage(cache, 2, api.fetchPage);
  cache.clearRows();
  api.calls.length = 0;
  await loadPage(cache, 2, api.fetchPage);
  assert.deepEqual(api.calls, ["25"]);
});

test("listBackHref keeps the list's search, filters, page and size from the list link", () => {
  assert.equal(listBackHref("/list", { listSearch: "?q=acme&status=captured&page=3&size=50" }), "/list?q=acme&status=captured&page=3&size=50");
  assert.equal(listBackHref("/list", null), "/list", "opened directly: plain list");
  assert.equal(listBackHref("/list", { listSearch: "//evil.example" }), "/list", "only a query string is kept");
});

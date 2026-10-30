import assert from "node:assert/strict";
import test from "node:test";
import { buildQuery } from "./api/query.js";
import { bhd, dash } from "./format.js";
import { bahrainDayStartIso, bahrainInputToIso } from "./dateRange.js";

/**
 * The pure logic behind the dashboard's query strings and money/date display.
 * Both are places a silent bug does real damage: a dropped filter param makes
 * a page show rows it claimed to exclude, and a mis-scaled amount misstates
 * money. Everything else is rendering, verified against the running API
 * rather than here.
 */

test("buildQuery repeats array keys rather than encoding a filter object", () => {
  assert.equal(
    buildQuery({ status: ["captured", "voided"] }),
    "?status=captured&status=voided",
  );
});

test("buildQuery drops empty values so an unset filter sends no param", () => {
  assert.equal(buildQuery({}), "");
  assert.equal(buildQuery({ from: undefined, to: null, search: "" }), "");
  assert.equal(buildQuery({ status: [] }), "");
  // A zero is a real value, not an empty one.
  assert.equal(buildQuery({ limit: 0 }), "?limit=0");
});

test("buildQuery percent-encodes values", () => {
  assert.equal(buildQuery({ search: "a b&c=d" }), "?search=a+b%26c%3Dd");
});

test("buildQuery keeps a cursor byte-exact", () => {
  // Cursors are base64url; a mangled one silently restarts or skips a page.
  const cursor = "MjAyNi0wOS0xMlQwMDowMDowMC4wMDBafGFiYw";
  assert.equal(buildQuery({ cursor }), `?cursor=${cursor}`);
});

// FH: covers negatives too
test("bhd formats integer fils via @filspay/money, never float arithmetic", () => {
  assert.equal(bhd(0), "0.000 BHD");
  assert.equal(bhd(1), "0.001 BHD");
  assert.equal(bhd(1000), "1.000 BHD");
  assert.equal(bhd(1234567), "1,234.567 BHD");
});

// E7: a refund or a reconciliation gap is negative; it must render, not throw.
test("bhd renders a negative amount instead of throwing", () => {
  assert.equal(bhd(-4750), "-4.750 BHD");
  assert.equal(bhd(-1), "-0.001 BHD");
});

test("dash renders absent values as an em dash but keeps zero", () => {
  assert.equal(dash(null), "—");
  assert.equal(dash(undefined), "—");
  assert.equal(dash(""), "—");
  assert.equal(dash(0), "0");
});

test("bahrainDayStartIso converts a date input to the Asia/Bahrain day boundary", () => {
  assert.equal(bahrainDayStartIso("2026-09-12"), "2026-09-12T00:00:00+03:00");
  // Bahrain midnight is 21:00 UTC the day before.
  assert.equal(new Date(bahrainDayStartIso("2026-09-12")).toISOString(), "2026-09-11T21:00:00.000Z");
});

test("bahrainInputToIso rejects garbage instead of sending Invalid Date", () => {
  assert.equal(bahrainInputToIso(""), null);
  assert.equal(bahrainInputToIso("not-a-date"), null);
  // A value typed in Bahrain time is that Bahrain instant, whatever the browser zone.
  assert.equal(bahrainInputToIso("2026-09-12T14:30"), "2026-09-12T11:30:00.000Z");
});

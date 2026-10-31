import assert from "node:assert/strict";
import test from "node:test";
import {
  bahrainTimestamp,
  checkFilterName,
  csvCell,
  csvFileName,
  fromSavedFilter,
  reportCsv,
  sameFilters,
  toReportFilter,
  toSavedFilter,
  type PageFilters,
} from "./reportFilters.js";

const none: PageFilters = { statuses: [], from: "", to: "", search: "" };
const full: PageFilters = { statuses: ["captured", "refunded"], from: "2026-10-01", to: "2026-10-31", search: "INV-7" };

test("a saved filter stores Bahrain dates with an exclusive to, and reads back exactly", () => {
  assert.deepEqual(toSavedFilter(full), {
    status: ["captured", "refunded"],
    from: "2026-10-01",
    to: "2026-11-01",
    search: "INV-7",
  });
  assert.deepEqual(fromSavedFilter(toSavedFilter(full)), full);
  assert.deepEqual(toSavedFilter(none), {});
  assert.deepEqual(fromSavedFilter({}), none);
});

test("a saved filter from the API with a single status string still applies", () => {
  assert.deepEqual(fromSavedFilter({ status: "voided", to: "2026-10-02" }), {
    statuses: ["voided"],
    from: "",
    to: "2026-10-01",
    search: "",
  });
});

test("a saved filter this page can't show exactly is refused, never applied in part", () => {
  for (const filter of [
    { from: "2026-06-01T00:00:00Z" },
    { status: "pending" },
    { status: ["captured", 7] },
    { status: { a: 1 } },
    { merchantId: "3f2a9c1e-0b4d-4e8a-9c2f-1a2b3c4d5e6f" },
    { to: "2026-13-45" },
    { search: 5 },
  ]) {
    assert.equal(fromSavedFilter(filter), null, JSON.stringify(filter));
  }
});

test("sameFilters ignores status order", () => {
  assert.ok(sameFilters(full, { ...full, statuses: ["refunded", "captured"] }));
  assert.ok(!sameFilters(full, { ...full, statuses: ["captured"] }));
  assert.ok(!sameFilters(full, { ...full, to: "2026-10-30" }));
});

test("checkFilterName needs a new, short, non-blank name", () => {
  assert.equal(checkFilterName("October refunds", ["Captured"]), null);
  assert.ok(checkFilterName("   ", []));
  assert.ok(checkFilterName("x".repeat(61), []));
  assert.ok(checkFilterName(" captured ", ["Captured"]));
});

test("the report filter uses Bahrain day boundaries, to exclusive", () => {
  assert.deepEqual(toReportFilter({ ...none, statuses: ["captured"], from: "2026-10-01", to: "2026-10-31" }), {
    ok: true,
    filter: { status: "captured", from: "2026-10-01T00:00:00+03:00", to: "2026-11-01T00:00:00+03:00" },
  });
  assert.deepEqual(toReportFilter(none), { ok: true, filter: {} });
});

test("the report filter refuses what the report route can't narrow by", () => {
  assert.equal(toReportFilter({ ...none, search: "INV" }).ok, false);
  assert.equal(toReportFilter({ ...none, statuses: ["captured", "voided"] }).ok, false);
});

test("bahrainTimestamp shows the Asia/Bahrain wall time", () => {
  assert.equal(bahrainTimestamp("2026-10-30T22:30:00.000Z"), "2026-10-31 01:30:00");
});

test("csvCell quotes separators and defuses spreadsheet formulas", () => {
  assert.equal(csvCell("12.500"), "12.500");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell("line\nbreak"), '"line\nbreak"');
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell("@cmd"), "'@cmd");
});

test("reportCsv writes a header and one line per row, BD text unchanged", () => {
  const csv = reportCsv([
    {
      id: "t1",
      merchantId: "m1",
      status: "captured",
      amountBhd: "12.500",
      capturedBhd: "12.500",
      refundedBhd: "0.000",
      reference: null,
      occurredAt: "2026-10-30T07:00:00.000Z",
    },
  ]);
  assert.equal(
    csv,
    "Occurred (Asia/Bahrain),Reference,Status,Authorized (BHD),Captured (BHD),Refunded (BHD),Transaction ID\r\n" +
      "2026-10-30 10:00:00,,captured,12.500,12.500,0.000,t1\r\n",
  );
});

test("csvFileName names the status and the inclusive dates", () => {
  assert.equal(
    csvFileName({ ...none, statuses: ["partially_refunded"], from: "2026-10-01", to: "2026-10-31" }, "2026-10-31"),
    "filspay-transactions-partially-refunded-2026-10-01-to-2026-10-31.csv",
  );
  assert.equal(csvFileName(none, "2026-10-31"), "filspay-transactions-start-to-2026-10-31.csv");
});

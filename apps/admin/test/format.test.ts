/** Shared Bahrain date/time and BD money formatting used by every admin screen. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bahrainTodayIso,
  bhd,
  formatBusinessDate,
  formatDate,
  formatDateTime,
  formatTime,
  fromBahrainInputValue,
  toBahrainInputValue,
} from "../src/format.js";

test("instants are shown in Asia/Bahrain time, en-GB style", () => {
  // 04:05 UTC = 07:05 in Bahrain.
  assert.equal(formatDateTime("2026-08-30T04:05:00Z"), "30 Aug 2026, 07:05");
  assert.equal(formatTime("2026-08-30T04:05:00Z"), "07:05");
  // 22:30 UTC on 29 Oct is already 30 Oct in Bahrain.
  assert.equal(formatDate("2026-10-29T22:30:00Z"), "30 Oct 2026");
  assert.equal(bahrainTodayIso(new Date("2026-10-29T22:30:00Z")), "2026-10-30");
});

test("business dates are shown as written, never shifted", () => {
  assert.equal(formatBusinessDate("2026-08-31"), "31 Aug 2026");
  assert.equal(formatBusinessDate("not-a-date"), "not-a-date");
});

test("datetime-local values round-trip through Bahrain time", () => {
  const instant = new Date("2026-08-30T04:05:00Z");
  assert.equal(toBahrainInputValue(instant), "2026-08-30T07:05");
  assert.equal(fromBahrainInputValue("2026-08-30T07:05"), "2026-08-30T04:05:00.000Z");
});

test("money is BD with exactly three decimals", () => {
  assert.equal(bhd(770625), "770.625 BHD");
  assert.equal(bhd(-12500), "-12.500 BHD");
  assert.equal(bhd(5), "0.005 BHD");
});

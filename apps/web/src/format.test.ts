import assert from "node:assert/strict";
import test from "node:test";
import { calendarDate, dateTime, timeOfDay } from "./format.js";

test("dateTime shows an instant in Asia/Bahrain, en-GB style", () => {
  assert.equal(dateTime("2026-08-30T04:05:56Z"), "30 Aug 2026, 07:05");
  // 22:30 UTC is already the next day in Bahrain (UTC+3).
  assert.equal(dateTime("2026-08-30T22:30:00Z"), "31 Aug 2026, 01:30");
});

test("dateTime and timeOfDay render absent or bad values as an em dash", () => {
  assert.equal(dateTime(null), "—");
  assert.equal(dateTime(undefined), "—");
  assert.equal(dateTime("not a date"), "—");
  assert.equal(timeOfDay(null), "—");
});

test("timeOfDay shows the Bahrain wall-clock time", () => {
  assert.equal(timeOfDay("2026-10-30T11:03:26Z"), "14:03");
});

test("calendarDate formats a business date without shifting the day", () => {
  assert.equal(calendarDate("2026-08-30"), "30 Aug 2026");
  assert.equal(calendarDate("2026-01-01"), "01 Jan 2026");
  assert.equal(calendarDate("2026-09-30"), "30 Sep 2026");
  assert.equal(calendarDate(null), "—");
  assert.equal(calendarDate("someday"), "someday");
});

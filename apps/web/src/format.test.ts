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
  assert.equal(calendarDate("2026-01-01"), "1 Jan 2026");
  assert.equal(calendarDate("2026-09-30"), "30 Sep 2026");
  assert.equal(calendarDate(null), "—");
  assert.equal(calendarDate("someday"), "someday");
});

test("bhd groups thousands for display and keeps 3 decimals", async () => {
  const { bhd } = await import("./format.js");
  assert.equal(bhd(135882772), "135,882.772 BHD");
  assert.equal(bhd(4000), "4.000 BHD");
  assert.equal(bhd(-1234567), "-1,234.567 BHD");
  assert.equal(bhd(999999), "999.999 BHD");
});

test("dates use a numeric day and a 3-letter month", () => {
  assert.equal(dateTime("2026-09-01T05:00:00Z"), "1 Sep 2026, 08:00");
  assert.equal(calendarDate("2026-09-01"), "1 Sep 2026");
});

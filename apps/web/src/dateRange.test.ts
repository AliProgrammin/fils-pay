import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  bahrainDayStartIso,
  bahrainInputToIso,
  bahrainNowInputValue,
  defaultLinkExpiryInputValue,
  bahrainToday,
  exclusiveTo,
  inclusiveTo,
  presetRange,
  rangeError,
  rangeIncludesDay,
  rangeLabel,
} from "./dateRange.js";

test("inclusive To becomes the exclusive API value (the next day)", () => {
  assert.equal(exclusiveTo("2026-10-31"), "2026-11-01");
  assert.equal(exclusiveTo("2026-12-31"), "2027-01-01");
  assert.equal(exclusiveTo("2028-02-28"), "2028-02-29");
  assert.equal(inclusiveTo("2026-11-01"), "2026-10-31");
  // transactions take instants: the day after, at Bahrain midnight
  assert.equal(bahrainDayStartIso(exclusiveTo("2026-10-31")), "2026-11-01T00:00:00+03:00");
});

test("today is the Bahrain date, not the UTC date", () => {
  // 22:30 UTC on 30 Oct is 01:30 on 31 Oct in Bahrain
  assert.equal(bahrainToday(new Date("2026-10-30T22:30:00Z")), "2026-10-31");
  assert.equal(bahrainToday(new Date("2026-10-30T20:59:00Z")), "2026-10-30");
});

test("presets use Bahrain dates and are inclusive", () => {
  const now = new Date("2026-10-31T21:30:00Z"); // 1 Nov 00:30 in Bahrain
  assert.deepEqual(presetRange("today", now), { from: "2026-11-01", to: "2026-11-01" });
  assert.deepEqual(presetRange("yesterday", now), { from: "2026-10-31", to: "2026-10-31" });
  assert.deepEqual(presetRange("last7", now), { from: "2026-10-26", to: "2026-11-01" });
  assert.deepEqual(presetRange("thisMonth", now), { from: "2026-11-01", to: "2026-11-01" });
  assert.deepEqual(presetRange("lastMonth", now), { from: "2026-10-01", to: "2026-10-31" });
  const march = new Date("2028-03-10T08:00:00Z");
  assert.deepEqual(presetRange("lastMonth", march), { from: "2028-02-01", to: "2028-02-29" });
  assert.deepEqual(presetRange("lastMonth", new Date("2027-01-05T08:00:00Z")), {
    from: "2026-12-01",
    to: "2026-12-31",
  });
});

test("range errors: future dates and To before From are refused; empty is fine", () => {
  const today = "2026-10-30";
  assert.equal(rangeError("", "", today), null);
  assert.equal(rangeError("2026-10-30", "2026-10-30", today), null);
  assert.match(rangeError("2026-10-31", "", today)!, /From can't be later than today/);
  assert.match(rangeError("", "2026-10-31", today)!, /To can't be later than today/);
  assert.match(rangeError("2026-10-20", "2026-10-19", today)!, /To is before From/);
  assert.match(rangeError("2026-02-30", "", today)!, /valid From/);
});

test("range labels for the empty state", () => {
  assert.equal(rangeLabel("2026-10-30", "2026-10-31"), "30 Oct–31 Oct");
  assert.equal(rangeLabel("2026-09-01", "2026-09-01"), "1 Sep");
  assert.equal(rangeLabel("2026-10-30", ""), "from 30 Oct");
  assert.equal(rangeLabel("", "2026-10-31"), "until 31 Oct");
  assert.equal(rangeLabel("", ""), "");
  assert.equal(addDays("2026-10-01", -1), "2026-09-30");
});

test("datetime-local values are Bahrain wall time", () => {
  assert.equal(bahrainNowInputValue(new Date("2026-10-30T21:15:00Z")), "2026-10-31T00:15");
  assert.equal(bahrainInputToIso("2026-10-31T00:15"), "2026-10-30T21:15:00.000Z");
  assert.equal(bahrainInputToIso(""), null);
  assert.equal(bahrainInputToIso("nonsense"), null);
});

test("a new payment link expires in 7 days, at the next full hour, Bahrain time", () => {
  // 21:15 UTC is 00:15 Bahrain on the 31st; +7 days, rounded up to 01:00.
  assert.equal(defaultLinkExpiryInputValue(new Date("2026-10-30T21:15:00Z")), "2026-11-07T01:00");
  // Exactly on the hour still moves to the next hour, so it is never "now".
  assert.equal(defaultLinkExpiryInputValue(new Date("2026-10-30T09:00:00Z")), "2026-11-06T13:00");
  const iso = bahrainInputToIso(defaultLinkExpiryInputValue());
  assert.ok(iso !== null && Date.parse(iso) > Date.now() + 7 * 86_400_000);
});

test("a range includes a day when the day is between From and the inclusive To", () => {
  assert.equal(rangeIncludesDay("2026-10-30", "2026-10-30", "2026-10-30"), true);
  assert.equal(rangeIncludesDay("2026-10-30", "", "2026-10-30"), true);
  assert.equal(rangeIncludesDay("", "", "2026-10-30"), true);
  assert.equal(rangeIncludesDay("2026-10-01", "2026-10-29", "2026-10-30"), false);
  assert.equal(rangeIncludesDay("2026-10-31", "", "2026-10-30"), false);
});

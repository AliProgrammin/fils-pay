/**
 * The Settlement page's default business date (U11). Run with
 * `npx tsx --test "test/*.test.ts"` from apps/admin.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bahrainYesterdayIso } from "../src/bahrainDate.js";

test("yesterday is taken from the Asia/Bahrain calendar day, not the UTC day", () => {
  // 01:30 on 30 Oct in Bahrain = 22:30 UTC on 29 Oct.
  assert.equal(bahrainYesterdayIso(new Date("2026-10-29T22:30:00Z")), "2026-10-29");
  // 23:59 on 29 Oct in Bahrain.
  assert.equal(bahrainYesterdayIso(new Date("2026-10-29T20:59:00Z")), "2026-10-28");
  // Month and year roll-over.
  assert.equal(bahrainYesterdayIso(new Date("2026-02-28T21:00:00Z")), "2026-02-28");
  assert.equal(bahrainYesterdayIso(new Date("2025-12-31T21:30:00Z")), "2025-12-31");
});

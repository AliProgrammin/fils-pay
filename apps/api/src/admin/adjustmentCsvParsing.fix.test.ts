/**
 * E1: CSV amounts are BD with 3 decimals (1 BD = 1000 fils).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAdjustmentAmountFils } from "./adjustmentCsvParsing.js";

test("4.75 BD parses to 4750 fils, not 475", () => {
  assert.equal(parseAdjustmentAmountFils("4.75"), 4750);
  assert.equal(parseAdjustmentAmountFils("4.750"), 4750);
  assert.equal(parseAdjustmentAmountFils("-1.25"), -1250);
  assert.equal(parseAdjustmentAmountFils("10"), 10000);
});

test("3-decimal amounts keep the last fils digit", () => {
  assert.equal(parseAdjustmentAmountFils("4.755"), 4755);
});

test("more than 3 decimals is rejected, not truncated", () => {
  assert.throws(() => parseAdjustmentAmountFils("4.7555"), /could not parse amount/);
});

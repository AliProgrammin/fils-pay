import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkAdjustmentCsv,
  checkAmount,
  checkEmail,
  checkOtp,
  checkUuid,
  CREDIT_MEMO_MAX,
  digitsOnly,
  filterAmountInput,
  filterUuidInput,
  formatAmountText,
  lengthNote,
} from "../src/inputRules.js";

const ID = "3f2a9c1e-0b4d-4e8a-9c2f-1a2b3c4d5e6f";

test("filterAmountInput: digits, one dot, 3 decimals, minus only when allowed", () => {
  assert.equal(filterAmountInput("50.0001"), "50.000");
  assert.equal(filterAmountInput("abc"), "");
  assert.equal(filterAmountInput(" 1 234,5 "), "12345");
  assert.equal(filterAmountInput("-12.5"), "12.5", "credit: no negatives");
  assert.equal(filterAmountInput("-12.5", { allowNegative: true }), "-12.5", "adjust balance: negatives");
  assert.equal(filterAmountInput("99999999999"), "999999999");
});

test("checkAmount: credit must be > 0; adjust may be negative, never 0", () => {
  assert.deepEqual(checkAmount("50"), { ok: true, fils: 50_000 });
  assert.equal(checkAmount("0").ok, false);
  assert.equal(checkAmount("-1").ok, false);
  assert.equal(checkAmount("1.2345").ok, false);
  assert.deepEqual(checkAmount("-12.5", { allowNegative: true }), { ok: true, fils: -12_500 });
  const zero = checkAmount("0.000", { allowNegative: true });
  assert.equal(!zero.ok ? zero.message : "", "The amount must not be 0");
  const over = checkAmount("-5", { allowNegative: true, maxFils: 1000 });
  assert.equal(!over.ok ? over.message : "", "The most you can enter is 1.000 BHD");
});

test("formatAmountText", () => {
  assert.equal(formatAmountText("50"), "50.000");
  assert.equal(formatAmountText("-12.5"), "-12.500");
  assert.equal(formatAmountText("x"), "x");
});

test("OTP, email, merchant id", () => {
  assert.equal(digitsOnly("12 34 56", 6), "123456");
  assert.equal(checkOtp("123456"), null);
  assert.notEqual(checkOtp("12345"), null);
  assert.equal(checkEmail("finance@filspay.test"), null);
  assert.notEqual(checkEmail("finance@"), null);
  assert.equal(filterUuidInput(` ${ID}\n`), ID);
  assert.equal(checkUuid(ID), null);
  assert.notEqual(checkUuid("alpha"), null);
});

test("lengthNote uses the API's memo limit", () => {
  assert.equal(lengthNote("x".repeat(CREDIT_MEMO_MAX), CREDIT_MEMO_MAX), "You reached the limit of 500 characters");
  assert.equal(lengthNote("x", CREDIT_MEMO_MAX), null);
});

test("checkAdjustmentCsv accepts what the API accepts and sums the rows", () => {
  const result = checkAdjustmentCsv(`merchantId,amount,reason\n${ID},4.750,statement correction\n\n${ID},-1.250\n`);
  assert.deepEqual(result, { rowCount: 2, totalFils: 3_500, problems: [] });
});

test("checkAdjustmentCsv names every bad line", () => {
  const result = checkAdjustmentCsv(
    [
      "merchant,amount,reason",
      `${ID},4.7505,too many decimals`,
      "not-an-id,1.000,x",
      `${ID},2.000,reason, with comma`,
      `${ID},0,nothing`,
      `${ID},`,
    ].join("\n"),
  );
  assert.equal(result.rowCount, 5);
  assert.deepEqual(result.problems, [
    "Line 1: the first line must be the header merchantId,amount,reason",
    'Line 2: "4.7505" is not a BD amount with up to 3 decimals',
    'Line 3: "not-an-id" is not a merchant id',
    "Line 4: more than 3 columns. A reason cannot contain a comma",
    "Line 5: the amount is 0",
    "Line 6: a merchant id and an amount are required",
  ]);
  assert.deepEqual(checkAdjustmentCsv("  ").problems, ["Paste the CSV: a header line and at least one row"]);
  assert.deepEqual(checkAdjustmentCsv("merchantId,amount,reason").problems, ["Add at least one row under the header"]);
});

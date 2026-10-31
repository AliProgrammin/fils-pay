import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkAdjustmentCsv,
  checkAmount,
  checkCsvFile,
  checkEmail,
  checkOtp,
  checkTransactionId,
  checkUuid,
  CSV_FILE_MAX_BYTES,
  CREDIT_MEMO_MAX,
  digitsOnly,
  filterAmountInput,
  filterUuidInput,
  formatAmountText,
  lengthNote,
} from "../src/inputRules.js";

const ID = "3f2a9c1e-0b4d-4e8a-9c2f-1a2b3c4d5e6f";

test("filterAmountInput: digits, one dot, minus only when allowed", () => {
  assert.equal(filterAmountInput("50.0001"), "50.0001", "a 4th decimal is kept so checkAmount can refuse it");
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

test("an amount with more than 3 decimals is refused with a clear message, never cut", () => {
  for (const opts of [{}, { allowNegative: true }]) {
    const checked = checkAmount(filterAmountInput("1.2345", opts), opts);
    assert.equal(checked.ok, false, "1.2345 BD must not become 1.234 BD");
    assert.match((checked as { message: string }).message, /at most 3 decimals/);
  }
});

test("checkTransactionId names a transaction, not a merchant", () => {
  assert.equal(checkTransactionId(ID), null);
  assert.match(checkTransactionId("abc") ?? "", /transaction id has 36 characters/);
});

test("checkCsvFile: a .csv file under the limit passes; too large or not .csv is refused", () => {
  // The API takes JSON bodies up to Fastify's default 1 MiB; JSON escaping can
  // double the CSV text, so the file limit is half of that.
  assert.equal(CSV_FILE_MAX_BYTES, 512 * 1024);
  assert.equal(checkCsvFile({ name: "march.csv", size: 1200 }), null);
  assert.equal(checkCsvFile({ name: "MARCH.CSV", size: CSV_FILE_MAX_BYTES }), null);
  assert.equal(
    checkCsvFile({ name: "big.csv", size: CSV_FILE_MAX_BYTES + 1 }),
    "This file is too large (513 KB). The most you can import at once is 512 KB. Split it into smaller files.",
  );
  assert.equal(checkCsvFile({ name: "report.xlsx", size: 100 }), "Choose a .csv file. Save the sheet as CSV first.");
  assert.equal(checkCsvFile({ name: "empty.csv", size: 0 }), "This file is empty. Choose the CSV with your rows.");
});

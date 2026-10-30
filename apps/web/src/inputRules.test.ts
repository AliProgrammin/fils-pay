import assert from "node:assert/strict";
import test from "node:test";
import {
  checkAmount,
  checkEmail,
  checkHttpsUrl,
  checkOtp,
  checkUuid,
  digitsOnly,
  filterAmountInput,
  filterUuidInput,
  formatAmountText,
  lengthNote,
  REFUND_REASON_MAX,
} from "./inputRules.js";

test("filterAmountInput keeps digits and one dot", () => {
  assert.equal(filterAmountInput("12.750"), "12.750");
  assert.equal(filterAmountInput("12.7509"), "12.7509", "a 4th decimal is kept so checkAmount can refuse it");
  assert.equal(filterAmountInput("abc"), "", "letters cannot be typed");
  assert.equal(filterAmountInput("1a2b.3c"), "12.3");
  assert.equal(filterAmountInput("1.2.3"), "1.23", "only the first dot counts");
  assert.equal(filterAmountInput(" 1,234.500 BD "), "1234.500", "pasted text with spaces and commas");
  assert.equal(filterAmountInput("."), ".");
});

test("filterAmountInput drops a minus unless negatives are allowed", () => {
  assert.equal(filterAmountInput("-5"), "5");
  assert.equal(filterAmountInput("-5", { allowNegative: true }), "-5");
  assert.equal(filterAmountInput("5-", { allowNegative: true }), "5", "a minus only counts at the start");
  assert.equal(filterAmountInput("-", { allowNegative: true }), "-");
});

test("filterAmountInput caps the whole part at 9 digits", () => {
  assert.equal(filterAmountInput("12345678901234.5"), "123456789.5");
});

test("checkAmount parses exact fils and enforces > 0 and the max", () => {
  assert.deepEqual(checkAmount("12.750"), { ok: true, fils: 12_750 });
  assert.deepEqual(checkAmount("12."), { ok: true, fils: 12_000 });
  assert.deepEqual(checkAmount(".5"), { ok: true, fils: 500 });
  assert.deepEqual(checkAmount("0.001"), { ok: true, fils: 1 });
  assert.equal(checkAmount("").ok, false);
  assert.equal(checkAmount("0").ok, false);
  assert.equal(checkAmount("0.000").ok, false);
  assert.equal(checkAmount("1.2345").ok, false);
  assert.equal(checkAmount("abc").ok, false);
  const neg = checkAmount("-1");
  assert.equal(neg.ok, false);
  assert.match(!neg.ok ? neg.message : "", /negative/);
  const over = checkAmount("10.001", { maxFils: 10_000 });
  assert.equal(over.ok, false);
  assert.equal(!over.ok ? over.message : "", "The most you can enter is 10.000 BHD");
  assert.deepEqual(checkAmount("10", { maxFils: 10_000 }), { ok: true, fils: 10_000 });
});

test("checkAmount with negatives allowed refuses only 0", () => {
  assert.deepEqual(checkAmount("-12.5", { allowNegative: true }), { ok: true, fils: -12_500 });
  assert.equal(checkAmount("-0", { allowNegative: true }).ok, false);
  assert.equal(checkAmount("-", { allowNegative: true }).ok, false);
});

test("formatAmountText shows 3 decimals on blur and leaves bad text alone", () => {
  assert.equal(formatAmountText("12.5"), "12.500");
  assert.equal(formatAmountText("12."), "12.000");
  assert.equal(formatAmountText("-3", ), "-3.000");
  assert.equal(formatAmountText("abc"), "abc");
  assert.equal(formatAmountText(""), "");
});

test("OTP: digits only, exact length", () => {
  assert.equal(digitsOnly("123 456", 6), "123456");
  assert.equal(digitsOnly("12a3456789", 6), "123456");
  assert.equal(checkOtp("123456"), null);
  assert.equal(checkOtp("12345"), "Enter the 6-digit code");
  assert.equal(checkOtp("1234567"), "Enter the 6-digit code");
  assert.equal(checkOtp("1234", 4), null);
});

test("checkEmail", () => {
  assert.equal(checkEmail("finance@alpharetail.example"), null);
  assert.equal(checkEmail(" a@b.co "), null);
  assert.notEqual(checkEmail(""), null);
  assert.notEqual(checkEmail("finance"), null);
  assert.notEqual(checkEmail("a@b"), null);
  assert.notEqual(checkEmail("a b@c.com"), null);
});

test("checkHttpsUrl needs https:// and a real host", () => {
  assert.equal(checkHttpsUrl("https://example.com/filspay/webhooks"), null);
  assert.equal(checkHttpsUrl("https://localhost:4000/hook"), null);
  assert.match(checkHttpsUrl("http://example.com") ?? "", /https/);
  assert.match(checkHttpsUrl("example.com") ?? "", /https/);
  assert.notEqual(checkHttpsUrl("https://"), null);
  assert.notEqual(checkHttpsUrl("https://nohost"), null);
  assert.notEqual(checkHttpsUrl(""), null);
  assert.notEqual(checkHttpsUrl(`https://example.com/${"a".repeat(2100)}`), null);
});

test("merchant ID: filter and check", () => {
  assert.equal(filterUuidInput(" 3f2a9c1e-0b4d-4e8a-9c2f-1a2b3c4d5e6f \n"), "3f2a9c1e-0b4d-4e8a-9c2f-1a2b3c4d5e6f");
  assert.equal(checkUuid("3f2a9c1e-0b4d-4e8a-9c2f-1a2b3c4d5e6f"), null);
  assert.notEqual(checkUuid("3f2a9c1e"), null);
  assert.notEqual(checkUuid("zz2a9c1e-0b4d-4e8a-9c2f-1a2b3c4d5e6f"), null);
});

test("lengthNote warns near the API limit", () => {
  assert.equal(lengthNote("a".repeat(10), REFUND_REASON_MAX), null);
  assert.equal(lengthNote("a".repeat(460), REFUND_REASON_MAX), "40 characters left");
  assert.equal(lengthNote("a".repeat(500), REFUND_REASON_MAX), "You reached the limit of 500 characters");
});

test("an amount with more than 3 decimals is refused with a clear message, never cut", () => {
  const typed = filterAmountInput("1.2345");
  const checked = checkAmount(typed);
  assert.equal(checked.ok, false, "1.2345 BD must not become 1.234 BD");
  assert.match((checked as { message: string }).message, /at most 3 decimals/);
});

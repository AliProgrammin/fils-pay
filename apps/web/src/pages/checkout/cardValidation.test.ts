import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CVV_MESSAGE,
  EXPIRED_MESSAGE,
  EXPIRY_MESSAGE,
  PAN_MESSAGE,
  bahrainYearMonth,
  luhnValid,
  validateCard,
} from "./cardValidation.js";

const NOW = new Date("2026-10-30T09:00:00Z");
const good = { pan: "4242 4242 4242 4242", expiryMonth: 12, expiryYear: 2028, cvv: "123" };

test("Luhn-valid test cards pass, including the documented decline cards", () => {
  for (const pan of ["4242 4242 4242 4242", "4000 0000 0000 0002", "4000000000000119", "4000-0000-0000-0069"]) {
    assert.deepEqual(validateCard({ ...good, pan }, NOW), {}, pan);
  }
});

test("a mistyped card number fails the Luhn check", () => {
  assert.equal(luhnValid("4242424242424241"), false);
  assert.equal(validateCard({ ...good, pan: "4242 4242 4242 4241" }, NOW).pan, PAN_MESSAGE);
  assert.equal(validateCard({ ...good, pan: "" }, NOW).pan, PAN_MESSAGE);
  assert.equal(validateCard({ ...good, pan: "4242abcd42424242" }, NOW).pan, PAN_MESSAGE);
  assert.equal(validateCard({ ...good, pan: "0000 0000" }, NOW).pan, PAN_MESSAGE);
});

test("expiry: the current Bahrain month is still valid, the month before is expired", () => {
  assert.equal(validateCard({ ...good, expiryMonth: 10, expiryYear: 2026 }, NOW).expiry, undefined);
  assert.equal(validateCard({ ...good, expiryMonth: 9, expiryYear: 2026 }, NOW).expiry, EXPIRED_MESSAGE);
  assert.equal(validateCard({ ...good, expiryMonth: 12, expiryYear: 2025 }, NOW).expiry, EXPIRED_MESSAGE);
  assert.equal(validateCard({ ...good, expiryMonth: 13, expiryYear: 2027 }, NOW).expiry, EXPIRY_MESSAGE);
  assert.equal(validateCard({ ...good, expiryMonth: 0, expiryYear: 2027 }, NOW).expiry, EXPIRY_MESSAGE);
});

test("the month boundary follows Asia/Bahrain, not UTC", () => {
  // 31 Oct 22:30 UTC is already 1 Nov 01:30 in Bahrain: an Oct card has expired.
  const lateUtc = new Date("2026-10-31T22:30:00Z");
  assert.deepEqual(bahrainYearMonth(lateUtc), { year: 2026, month: 11 });
  assert.equal(validateCard({ ...good, expiryMonth: 10, expiryYear: 2026 }, lateUtc).expiry, EXPIRED_MESSAGE);
  // 31 Oct 20:59 UTC is still 31 Oct 23:59 in Bahrain: an Oct card is fine.
  const stillOct = new Date("2026-10-31T20:59:00Z");
  assert.equal(validateCard({ ...good, expiryMonth: 10, expiryYear: 2026 }, stillOct).expiry, undefined);
});

test("CVV must be 3 or 4 digits", () => {
  assert.equal(validateCard({ ...good, cvv: "1234" }, NOW).cvv, undefined);
  for (const cvv of ["12", "12345", "12a", ""]) {
    assert.equal(validateCard({ ...good, cvv }, NOW).cvv, CVV_MESSAGE, cvv);
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ZERO_FILS,
  addFils,
  allocateRemainder,
  applyRateFils,
  bankersRoundDiv,
  calculateRefundFee,
  compareFils,
  formatBhd,
  isFils,
  negateFils,
  parseBhdToFils,
  subtractFils,
  toFils,
} from "./fils.js";

test("toFils accepts non-negative integers and brands them", () => {
  const f = toFils(4750);
  assert.equal(f, 4750);
  assert.equal(isFils(f), true);
});

test("toFils rejects non-integers", () => {
  assert.throws(() => toFils(4.75), RangeError);
  assert.throws(() => toFils(Number.NaN), RangeError);
  assert.throws(() => toFils(Number.POSITIVE_INFINITY), RangeError);
});

test("toFils rejects negatives by default but allows them via opt-in", () => {
  assert.throws(() => toFils(-1), RangeError);
  const negative = toFils(-1, { allowNegative: true });
  assert.equal(negative, -1);
});

test("toFils rejects values outside the safe integer range", () => {
  assert.throws(() => toFils(Number.MAX_SAFE_INTEGER + 2), RangeError);
});

test("isFils correctly distinguishes valid and invalid runtime shapes", () => {
  assert.equal(isFils(100), true);
  assert.equal(isFils(-5), true); // shape-valid even though toFils would reject it by default
  assert.equal(isFils(4.5), false);
  assert.equal(isFils("100"), false);
  assert.equal(isFils(Number.NaN), false);
});

test("addFils / subtractFils / negateFils / compareFils are exact integer arithmetic", () => {
  const a = toFils(300);
  const b = toFils(450);
  assert.equal(addFils(a, b), 750);
  assert.equal(subtractFils(b, a), 150);
  assert.equal(subtractFils(a, b), -150);
  assert.equal(negateFils(a), -300);
  assert.equal(compareFils(a, b), -1);
  assert.equal(compareFils(b, a), 1);
  assert.equal(compareFils(a, a), 0);
});

test("ZERO_FILS is the additive identity", () => {
  const a = toFils(1234);
  assert.equal(addFils(a, ZERO_FILS), 1234);
  assert.equal(subtractFils(a, ZERO_FILS), 1234);
});

test("bankersRoundDiv rounds ties to the even neighbor", () => {
  // 5/2 = 2.5 -> ties to 2 (even)
  assert.equal(bankersRoundDiv(5n, 2n), 2);
  // 7/2 = 3.5 -> ties to 4 (even)
  assert.equal(bankersRoundDiv(7n, 2n), 4);
  // 9/2 = 4.5 -> ties to 4 (even)
  assert.equal(bankersRoundDiv(9n, 2n), 4);
  // 15/10 = 1.5 -> ties to 2 (even)
  assert.equal(bankersRoundDiv(15n, 10n), 2);
  // 25/10 = 2.5 -> ties to 2 (even)
  assert.equal(bankersRoundDiv(25n, 10n), 2);
});

test("bankersRoundDiv rounds non-tie cases to the nearest integer", () => {
  assert.equal(bankersRoundDiv(7n, 3n), 2); // 2.333.. -> 2
  assert.equal(bankersRoundDiv(8n, 3n), 3); // 2.666.. -> 3
  assert.equal(bankersRoundDiv(0n, 5n), 0);
});

test("bankersRoundDiv handles negative numerators and denominators", () => {
  assert.equal(bankersRoundDiv(-5n, 2n), -2); // -2.5 -> -2 (even)
  assert.equal(bankersRoundDiv(-7n, 2n), -4); // -3.5 -> -4 (even)
  assert.equal(bankersRoundDiv(5n, -2n), -2);
  assert.equal(bankersRoundDiv(-5n, -2n), 2);
});

test("bankersRoundDiv rejects a zero denominator", () => {
  assert.throws(() => bankersRoundDiv(5n, 0n), RangeError);
});

test("applyRateFils matches a hand-computed table of amount/rate pairs", () => {
  const table: Array<[amount: number, bps: number, expected: number]> = [
    [10_000, 250, 250], // 10.000 BD at 2.50% MDR -> 0.250 BD
    [1_000, 100, 10], // 1.000 BD at 1.00% -> 0.010 BD
    [0, 250, 0], // zero amount -> zero fee
    [10_000, 0, 0], // zero rate -> zero fee
    [4_750, 250, 119], // 4.750 BD at 2.50% = 118.75 fils -> rounds up to 119 (not a tie)
    [333, 250, 8], // 3.33 BD-equivalent fils at 2.50% = 8.325 -> rounds to 8
  ];

  for (const [amount, bps, expected] of table) {
    const result = applyRateFils(toFils(amount), bps);
    assert.equal(
      result,
      expected,
      `applyRateFils(${amount}, ${bps}) expected ${expected}, got ${result}`,
    );
  }
});

test("applyRateFils rejects a non-integer basis-point rate", () => {
  assert.throws(() => applyRateFils(toFils(1000), 2.5), RangeError);
});

// FH: claude generated these weight sets, all pass. might add 0.1+0.2 style ones
test("allocateRemainder sums back to the exact total across adversarial weight sets", () => {
  const cases: Array<{ total: number; weights: number[] }> = [
    { total: 100, weights: [1, 1, 1] }, // classic non-divisible-by-3 case
    { total: 10_000, weights: [1, 1, 1, 1, 1, 1, 1] }, // prime count of equal shares
    { total: 9_973, weights: [17, 19, 23] }, // total and weights both prime-flavored
    { total: 1, weights: [1, 1, 1, 1, 1] }, // total smaller than weight count
    { total: 0, weights: [1, 2, 3] }, // zero total
    { total: 4_750, weights: [0.3333, 0.3333, 0.3334] }, // decimal weights
    { total: 1_000_000, weights: [30, 70] }, // simple percentage split
    { total: 7, weights: [1, 0, 6] }, // a zero weight among nonzero weights
  ];

  for (const { total, weights } of cases) {
    const shares = allocateRemainder(toFils(total), weights);
    const sum = shares.reduce((acc, s) => acc + s, 0);
    assert.equal(sum, total, `weights=${JSON.stringify(weights)} total=${total}`);
    for (const s of shares) {
      assert.ok(s >= 0, "every share must be >= 0");
    }
  }
});

test("allocateRemainder breaks ties deterministically by ascending index", () => {
  // Three equal weights splitting 10 -> base 3 each with 1 left over;
  // equal remainders must break ties toward the lowest index.
  const shares = allocateRemainder(toFils(10), [1, 1, 1]);
  assert.deepEqual(shares, [4, 3, 3]);
});

test("allocateRemainder is deterministic and reproducible", () => {
  const a = allocateRemainder(toFils(1_234_567), [3, 1, 4, 1, 5, 9, 2, 6]);
  const b = allocateRemainder(toFils(1_234_567), [3, 1, 4, 1, 5, 9, 2, 6]);
  assert.deepEqual(a, b);
});

test("allocateRemainder rejects empty, negative, and all-zero weights", () => {
  assert.throws(() => allocateRemainder(toFils(100), []), RangeError);
  assert.throws(() => allocateRemainder(toFils(100), [1, -1]), RangeError);
  assert.throws(() => allocateRemainder(toFils(100), [0, 0]), RangeError);
});

test("formatBhd renders D.DDD strings", () => {
  assert.equal(formatBhd(toFils(4750)), "4.750");
  assert.equal(formatBhd(ZERO_FILS), "0.000");
  assert.equal(formatBhd(toFils(1)), "0.001");
  assert.equal(formatBhd(toFils(-1, { allowNegative: true })), "-0.001");
});

test("parseBhdToFils parses exact D.DDD strings via string manipulation", () => {
  assert.equal(parseBhdToFils("4.750"), 4750);
  assert.equal(parseBhdToFils("4.75"), 4750);
  assert.equal(parseBhdToFils("4.7"), 4700);
  assert.equal(parseBhdToFils("4"), 4000);
  assert.equal(parseBhdToFils("0.001"), 1);
  assert.equal(parseBhdToFils("-4.750"), -4750);
});

test("parseBhdToFils rejects more than 3 fractional digits and non-numeric input", () => {
  assert.throws(() => parseBhdToFils("4.7501"), RangeError);
  assert.throws(() => parseBhdToFils("abc"), RangeError);
  assert.throws(() => parseBhdToFils(""), RangeError);
  assert.throws(() => parseBhdToFils("4.7.5"), RangeError);
});

test("formatBhd and parseBhdToFils round-trip", () => {
  for (const fils of [0, 1, 999, 1000, 4750, 123_456]) {
    const branded = toFils(fils);
    assert.equal(parseBhdToFils(formatBhd(branded)), fils);
  }
});

/** One-refund helper: nothing refunded or reversed before this refund. */
function firstRefundFee(captured: number, fee: number, refund: number) {
  return calculateRefundFee({
    capturedFils: toFils(captured),
    feeChargedFils: toFils(fee),
    refundedBeforeFils: ZERO_FILS,
    feeReversedBeforeFils: ZERO_FILS,
    refundAmountFils: toFils(refund),
  });
}

test("calculateRefundFee reverses the whole fee when the whole capture is refunded", () => {
  assert.equal(firstRefundFee(10_000, 250, 10_000), 250);
  assert.equal(firstRefundFee(1_000, 25, 1_000), 25);
  assert.equal(firstRefundFee(4_750, 119, 4_750), 119);
});

test("calculateRefundFee reverses a proportional share of the fee", () => {
  assert.equal(firstRefundFee(10_000, 250, 5_000), 125);
  assert.equal(firstRefundFee(10_000, 250, 2_000), 50);
});

test("calculateRefundFee reverses nothing for a zero refund", () => {
  assert.equal(firstRefundFee(10_000, 250, 0), 0);
});

test("calculateRefundFee breaks an exact tie to even, like applyRateFils", () => {
  // 25 * 100 / 1000 = 2.5 exactly — banker's rounding takes the even
  // neighbour, so 2 rather than 3.
  assert.equal(firstRefundFee(1_000, 25, 100), 2);
});

// R5: partial refunds must reverse, in total, exactly the fee charged.
// Rounding each refund on its own gave 10 x round(2.5) = 20, not 25.
test("calculateRefundFee: ten partial refunds of 100 on a 1000 capture reverse exactly the 25 fee", () => {
  let refunded = 0;
  let reversed = 0;
  for (let i = 0; i < 10; i += 1) {
    const share = calculateRefundFee({
      capturedFils: toFils(1_000),
      feeChargedFils: toFils(25),
      refundedBeforeFils: toFils(refunded),
      feeReversedBeforeFils: toFils(reversed),
      refundAmountFils: toFils(100),
    });
    assert.ok(share >= 0);
    refunded += 100;
    reversed += share;
    // After each refund the running total is round(fee * refunded / captured).
    assert.equal(reversed, Number(bankersRoundDiv(25n * BigInt(refunded), 1_000n)));
  }
  assert.equal(reversed, 25);
});

test("calculateRefundFee: any split of a capture sums back to the fee", () => {
  for (const parts of [[1, 1, 998], [333, 333, 334], [7, 993], [999, 1]]) {
    let refunded = 0;
    let reversed = 0;
    for (const part of parts) {
      reversed += calculateRefundFee({
        capturedFils: toFils(1_000),
        feeChargedFils: toFils(37),
        refundedBeforeFils: toFils(refunded),
        feeReversedBeforeFils: toFils(reversed),
        refundAmountFils: toFils(part),
      });
      refunded += part;
    }
    assert.equal(reversed, 37, `split ${parts.join("+")}`);
  }
});

test("calculateRefundFee rejects a non-positive captured amount", () => {
  assert.throws(() => firstRefundFee(0, 250, 100), RangeError);
  assert.throws(
    () =>
      calculateRefundFee({
        capturedFils: toFils(-10_000, { allowNegative: true }),
        feeChargedFils: toFils(250),
        refundedBeforeFils: ZERO_FILS,
        feeReversedBeforeFils: ZERO_FILS,
        refundAmountFils: toFils(100),
      }),
    RangeError,
  );
});

test("calculateRefundFee rejects negative inputs and a refund past the capture", () => {
  assert.throws(
    () =>
      calculateRefundFee({
        capturedFils: toFils(10_000),
        feeChargedFils: toFils(-250, { allowNegative: true }),
        refundedBeforeFils: ZERO_FILS,
        feeReversedBeforeFils: ZERO_FILS,
        refundAmountFils: toFils(100),
      }),
    RangeError,
  );
  assert.throws(
    () =>
      calculateRefundFee({
        capturedFils: toFils(10_000),
        feeChargedFils: toFils(250),
        refundedBeforeFils: ZERO_FILS,
        feeReversedBeforeFils: ZERO_FILS,
        refundAmountFils: toFils(-100, { allowNegative: true }),
      }),
    RangeError,
  );
  assert.throws(
    () =>
      calculateRefundFee({
        capturedFils: toFils(10_000),
        feeChargedFils: toFils(250),
        refundedBeforeFils: toFils(9_000),
        feeReversedBeforeFils: toFils(225),
        refundAmountFils: toFils(1_001),
      }),
    RangeError,
  );
});

test("calculateRefundFee returns a valid Fils", () => {
  const fee = firstRefundFee(10_000, 250, 3_333);
  assert.equal(isFils(fee), true);
});

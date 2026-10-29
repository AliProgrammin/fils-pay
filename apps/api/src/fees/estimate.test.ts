import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRateFils, toFils } from "@filspay/money";
import { estimateFeeFils } from "./estimate.js";

// D16: capture rounds the fee half-to-even (applyRateFils); the estimate must agree.
test("estimateFeeFils rounds an exact half to even, the same as capture", () => {
  // 20 fils at 2.50% = 0.5 fils: capture charges 0, Math.round said 1.
  assert.equal(estimateFeeFils(20, 250, 0), Number(applyRateFils(toFils(20), 250)));
  assert.equal(estimateFeeFils(20, 250, 0), 0);
});

test("estimateFeeFils takes the negotiated discount off the integer fee, as the discount adjustment does", () => {
  const fee = applyRateFils(toFils(10_000), 250); // 250
  const discount = applyRateFils(fee, 1_000); // 25
  assert.equal(estimateFeeFils(10_000, 250, 1_000), Number(fee) - Number(discount));
});

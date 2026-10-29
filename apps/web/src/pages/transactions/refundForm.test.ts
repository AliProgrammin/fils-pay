import assert from "node:assert/strict";
import test from "node:test";
import { RefundKeyKeeper, parseRefundAmount, refundableFils } from "./refundForm.js";

test("parseRefundAmount reads BD text as exact fils", () => {
  assert.deepEqual(parseRefundAmount("4.750", 10_000), { ok: true, amountFils: 4_750 });
  assert.deepEqual(parseRefundAmount("4.75", 10_000), { ok: true, amountFils: 4_750 });
  assert.deepEqual(parseRefundAmount("10", 10_000), { ok: true, amountFils: 10_000 });
  assert.deepEqual(parseRefundAmount("0.001", 10_000), { ok: true, amountFils: 1 });
});

test("parseRefundAmount refuses bad text, zero, too many decimals and more than refundable", () => {
  for (const text of ["", "abc", "1.2345", "-1", "4750fils"]) {
    assert.equal(parseRefundAmount(text, 10_000).ok, false, text);
  }
  assert.equal(parseRefundAmount("0", 10_000).ok, false);
  assert.equal(parseRefundAmount("10.001", 10_000).ok, false);
});

test("refundableFils is captured minus refunded, and 0 when not refundable", () => {
  assert.equal(refundableFils({ status: "captured", capturedFils: 10_000, refundedFils: 0 }), 10_000);
  assert.equal(refundableFils({ status: "partially_refunded", capturedFils: 10_000, refundedFils: 6_000 }), 4_000);
  assert.equal(refundableFils({ status: "refunded", capturedFils: 10_000, refundedFils: 10_000 }), 0);
  assert.equal(refundableFils({ status: "authorized", capturedFils: 0, refundedFils: 0 }), 0);
});

test("RefundKeyKeeper keeps one key across retries of the same submit", () => {
  let n = 0;
  const keeper = new RefundKeyKeeper(() => `key-${++n}`);
  const first = keeper.keyFor("t1", 4_750, "damaged");
  assert.equal(keeper.keyFor("t1", 4_750, "damaged"), first, "a retry reuses the key");
  assert.notEqual(keeper.keyFor("t1", 4_000, "damaged"), first, "a different amount is a new refund");
  const afterEdit = keeper.keyFor("t1", 4_000, "damaged");
  keeper.reset();
  assert.notEqual(keeper.keyFor("t1", 4_000, "damaged"), afterEdit, "after success the next refund gets a new key");
});

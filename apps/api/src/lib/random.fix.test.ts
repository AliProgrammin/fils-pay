/**
 * OTP codes, payment link tokens and admin invite codes are secrets. They
 * must come from node:crypto, not Math.random (a predictable PRNG). We pin
 * Math.random to a constant: if a generator still depends on it, its output
 * becomes constant and the test fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomDigits, randomFromAlphabet } from "./random.js";
import { generateInviteCode } from "../admin/inviteCode.js";

function withPinnedMathRandom(fn: () => void): void {
  const original = Math.random;
  Math.random = () => 0;
  try {
    fn();
  } finally {
    Math.random = original;
  }
}

function distinct(make: () => string, count = 20): number {
  return new Set(Array.from({ length: count }, make)).size;
}

test("secret generators do not depend on Math.random", () => {
  withPinnedMathRandom(() => {
    assert.ok(distinct(() => randomDigits(6)) > 1, "OTP digits must not come from Math.random");
    assert.ok(distinct(() => randomFromAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ", 22)) > 1, "tokens must not come from Math.random");
    assert.ok(distinct(() => generateInviteCode()) > 1, "invite codes must not come from Math.random");
  });
});

test("randomDigits and randomFromAlphabet keep their shape", () => {
  for (let i = 0; i < 200; i++) {
    assert.match(randomDigits(6), /^\d{6}$/);
    assert.match(randomFromAlphabet("ab", 22), /^[ab]{22}$/);
  }
});

/**
 * FP-240 (inbound): acquirer callback signature must be required by default,
 * computed over the raw body, and fresh (±5 minutes).
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyAcquirerCallbackSignature } from "./inboundVerify.js";

const SECRET = "acqsec_test_secret";
const nowSec = () => Math.floor(Date.now() / 1000);

function sign(rawBody: string, timestamp = nowSec(), secret = SECRET): string {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

test("FP-240: a callback with no signature header is rejected by default", () => {
  const result = verifyAcquirerCallbackSignature('{"callbackId":"acqcb_1"}', undefined, SECRET);
  assert.equal(result.valid, false);
});

test("FP-240: the signature is checked over the exact raw body bytes", () => {
  // The acquirer's own serialisation (spaces, key order) is what it signed.
  const raw = '{ "outcome": "cleared",  "callbackId": "acqcb_1" }';
  assert.deepEqual(verifyAcquirerCallbackSignature(raw, sign(raw), SECRET), { valid: true });
  const tampered = raw.replace("cleared", "confirmed_fraud");
  assert.equal(verifyAcquirerCallbackSignature(tampered, sign(raw), SECRET).reason, "signature_mismatch");
});

test("FP-240: a correctly-signed but stale or future-dated callback is rejected", () => {
  const raw = '{"callbackId":"acqcb_1"}';
  const old = verifyAcquirerCallbackSignature(raw, sign(raw, nowSec() - 3600), SECRET);
  assert.equal(old.valid, false);
  assert.equal(old.reason, "timestamp_out_of_tolerance");
  const future = verifyAcquirerCallbackSignature(raw, sign(raw, nowSec() + 3600), SECRET);
  assert.equal(future.reason, "timestamp_out_of_tolerance");
});

test("FP-240: a signature of the wrong length is a mismatch, not a crash", () => {
  const raw = '{"callbackId":"acqcb_1"}';
  assert.equal(verifyAcquirerCallbackSignature(raw, `t=${nowSec()},v1=abcd`, SECRET).reason, "signature_mismatch");
});

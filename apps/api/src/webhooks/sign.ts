import { createHmac } from "node:crypto";
import { canonicalJson } from "../payments/idempotency.js";
import { timingSafeEqualHex } from "../lib/crypto.js";

/**
 * Webhook signing: an HMAC over the exact body bytes sent (which are
 * canonicalJson(payload), so both kinds of receiver verify), a
 * timestamped Stripe-`t=...,v1=...`-style signature scheme, and a
 * constant-time comparison in verifySignature.
 *
 * — YA: wrote this one slowly. read it before copying it.
 */

export interface SignedPayload {
  /** unix seconds, the value folded into the signature */
  timestamp: number;
  /** header value: "t=<timestamp>,v1=<hex-hmac-sha256>" */
  signature: string;
}

/**
 * Computes the header value a delivery carries. `secret` is the raw
 * (decrypted) webhook secret — callers must decrypt
 * webhook_endpoints.secret_ciphertext (webhooks/secretCrypto.ts) before
 * calling this; sign.ts itself never touches encryption, only signing.
 *
 * Signs `${timestamp}.${body}`. A string is taken as the exact body the
 * caller puts on the wire (FP-240: a receiver verifies the raw bytes it got).
 * Any other value is signed as canonicalJson(payload), the original contract.
 * Senders put canonicalJson(payload) on the wire, so a raw-body receiver and
 * a parse-then-canonicalise receiver both verify. Not the body alone,
 * so a receiver can enforce its own freshness window using only what's in
 * the header — a captured genuine delivery can't be replayed by a third
 * party at an arbitrary later time with a signature that still looks fresh.
 */
export function signPayload(
  payload: unknown,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): SignedPayload {
  const signedString = `${timestamp}.${bodyString(payload)}`;
  const signature = createHmac("sha256", secret).update(signedString).digest("hex");
  return { timestamp, signature: `t=${timestamp},v1=${signature}` };
}

/** The exact signed string: a string as-is (raw body), else canonicalJson. */
function bodyString(payload: unknown): string {
  return typeof payload === "string" ? payload : canonicalJson(payload);
}

interface ParsedSignatureHeader {
  timestamp: number;
  signature: string;
}

function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestampStr: string | null = null;
  let signature: string | null = null;

  for (const part of header.split(",")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    const key = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (key === "t") timestampStr = value;
    else if (key === "v1") signature = value;
  }

  if (!timestampStr || !signature) return null;
  if (!/^\d+$/.test(timestampStr)) return null;

  const timestamp = Number.parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) return null;

  return { timestamp, signature };
}

export type VerifySignatureFailureReason = "malformed_header" | "signature_mismatch" | "timestamp_out_of_tolerance";

export interface VerifySignatureResult {
  valid: boolean;
  reason?: VerifySignatureFailureReason;
}

/**
 * Re-derives the expected signature and compares constant-time
 * (`timingSafeEqualHex`, never `===`). Used by the end-to-end tests (the
 * local receiver checks what the dispatcher actually sent) and meant for a
 * "test your webhook secret" merchant tool.
 */
// FH: tolerance is checked AFTER the compare — claude says that's a timing oracle on the timestamp
// doesnt matter, t is inside the mac — am
export function verifySignature(
  payload: unknown,
  header: string,
  secret: string,
  options?: { toleranceSeconds?: number; now?: number },
): VerifySignatureResult {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { valid: false, reason: "malformed_header" };

  const expected = createHmac("sha256", secret)
    .update(`${parsed.timestamp}.${bodyString(payload)}`)
    .digest("hex");

  if (!timingSafeEqualHex(expected, parsed.signature)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  const now = options?.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options?.toleranceSeconds ?? 300;
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  return { valid: true };
}

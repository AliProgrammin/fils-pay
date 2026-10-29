import { createHmac, timingSafeEqual } from "node:crypto";

/** Verifies the signature on an inbound acquirer callback. */

interface ParsedAcquirerSignatureHeader {
  timestamp: number;
  signature: string;
}

function parseAcquirerSignatureHeader(header: string): ParsedAcquirerSignatureHeader | null {
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

export type VerifyAcquirerCallbackFailureReason =
  | "malformed_header"
  | "signature_mismatch"
  | "timestamp_out_of_tolerance";

/** Max difference between the acquirer's `t=` and our clock (replay window). */
const TIMESTAMP_TOLERANCE_SECONDS = 300;

export interface VerifyAcquirerCallbackResult {
  valid: boolean;
  reason?: VerifyAcquirerCallbackFailureReason;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Verifies the acquirer callback signature over the exact raw request body
 * (`<t>.<rawBody>`) and checks that `t` is within ±5 minutes of now.
 */
export function verifyAcquirerCallbackSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  requireSignature = true,
  nowSeconds = Math.floor(Date.now() / 1000),
): VerifyAcquirerCallbackResult {
  if (!header) {
    return requireSignature
      ? { valid: false, reason: "malformed_header" }
      : { valid: true };
  }

  const parsed = parseAcquirerSignatureHeader(header);
  if (!parsed) return { valid: false, reason: "malformed_header" };

  const expected = createHmac("sha256", secret)
    .update(`${parsed.timestamp}.${rawBody}`)
    .digest("hex");

  if (!constantTimeEquals(expected, parsed.signature)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  if (Math.abs(nowSeconds - parsed.timestamp) > TIMESTAMP_TOLERANCE_SECONDS) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  return { valid: true };
}

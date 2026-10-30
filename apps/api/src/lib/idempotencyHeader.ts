import type { FastifyRequest } from "fastify";
import { BadRequestError } from "./errors.js";

/** Generous, and far above any UUID or ULID a client sends (W10). */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** Reads the required Idempotency-Key header; never generated server-side. */
export function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new BadRequestError(
      "invalid_request",
      `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
  return key;
}

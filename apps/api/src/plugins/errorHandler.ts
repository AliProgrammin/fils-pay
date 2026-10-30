import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../lib/errors.js";
import { formatIsoDate } from "../lib/dateFormat.js";
import { isPoolConnectTimeout } from "../db/pool.js";
import { sendServerBusy } from "./loadShedding.js";

/**
 * Uniform error -> HTTP response mapping. Every route across the API
 * should throw an `AppError` subclass; this is the single place that turns
 * one into `{ "error": "code", "message"?: "string" }`, plus any extra
 * fields in `AppError.details` (e.g. `existingImportId` on a duplicate import).
 */
// am: 500s log the full err incl. pg detail, might contain card ref? fine its server-side
export function errorHandler(
  err: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (err instanceof AppError) {
    reply.code(err.statusCode).send({ ...err.details, error: err.code, message: err.message });
    return;
  }

  const fastifyErr = err as FastifyError;

  // YA: 400 not 422 for schema validation errors — API.md section 2. correct
  if (fastifyErr.validation) {
    reply.code(400).send({ error: "validation_error", message: fastifyErr.message });
    return;
  }

  if (fastifyErr.code === "FST_REQ_FILE_TOO_LARGE" || fastifyErr.code === "FST_FILES_LIMIT") {
    reply.code(413).send({ error: "file_too_large", message: fastifyErr.message });
    return;
  }

  // The body could not be parsed (bad or empty JSON, wrong content type).
  // Fastify gives these a 4xx status; they are client mistakes, not a fault.
  if (
    typeof fastifyErr.code === "string" &&
    fastifyErr.code.startsWith("FST_ERR_CTP_") &&
    typeof fastifyErr.statusCode === "number" &&
    fastifyErr.statusCode >= 400 &&
    fastifyErr.statusCode < 500
  ) {
    reply.code(fastifyErr.statusCode).send({ error: "invalid_request", message: fastifyErr.message });
    return;
  }

  // Postgres 22021: the client sent a NUL byte or invalid UTF-8 in a text
  // field. That is bad input, not a server fault.
  if ((err as { code?: unknown }).code === "22021") {
    reply.code(400).send({ error: "invalid_request", message: "text input contains an invalid character" });
    return;
  }

  // No pool connection within the (short) connection timeout: overload, not
  // a fault. The request did no work yet: every money operation takes its
  // connection before its first step (withTransaction, withPinnedClient).
  if (isPoolConnectTimeout(err)) {
    sendServerBusy(reply);
    return;
  }

  request.log.error({ err, occurredOn: formatIsoDate(new Date()) }, "unhandled error");
  reply.code(500).send({ error: "internal_error" });
}

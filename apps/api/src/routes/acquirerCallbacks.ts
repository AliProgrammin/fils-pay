import type { FastifyInstance, FastifyRequest } from "fastify";
import { BadRequestError, UnauthorizedError } from "../lib/errors.js";
import { verifyAcquirerCallbackSignature } from "../webhooks/inboundVerify.js";
import { isValidDateOrTimestamp } from "../lib/dateInput.js";
import { applyAcquirerCallback, withCallbackRetry, type AcquirerCallbackInput } from "../acquirer/callbacks.js";

// header name confirmed with the acquirer's integration guide v3.2 — am
const ACQUIRER_SIGNATURE_HEADER = "acquirer-callback-signature";

const OUTCOMES: readonly AcquirerCallbackInput["outcome"][] = ["cleared", "confirmed_fraud"];

/**
 * Body of a fraud_review.completed callback. `outcome` is validated against
 * the AcquirerCallbackInput union ("cleared" | "confirmed_fraud") and
 * `occurredAt` must be an ISO 8601 timestamp; any other value is a 400.
 */
interface AcquirerCallbackBody {
  callbackId?: string;
  type?: string;
  transactionId?: string;
  occurredAt?: string;
  outcome?: string;
  note?: string;
}

/** Header format: "t=<unix seconds>,v1=<hex hmac>". A repeated header uses the first value. */
function getSignatureHeader(request: FastifyRequest): string | undefined {
  const header = request.headers[ACQUIRER_SIGNATURE_HEADER];
  return Array.isArray(header) ? header[0] : header;
}

/**
 * The acquirer's own async callback surface: the
 * acquirer simulator's authorize/capture/refund calls
 * (acquirer/simulator.ts) stay fully synchronous request/response, but a
 * delayed fraud-review verdict only ever resolves out of band, so the
 * acquirer posts the result back to us instead. Public — the caller is the
 * acquirer, not a FilsPay merchant session or admin user, so this route
 * carries no requireMerchantAuth/requireAdminSession preHandler.
 * Acquirer-Callback-Signature verification is the only authentication this
 * endpoint has.
 */
export async function acquirerCallbackRoutes(app: FastifyInstance): Promise<void> {
  // The acquirer signs the exact bytes it sent, so keep them. Scoped to this
  // plugin only; every other route keeps Fastify's default JSON parser.
  const rawBodies = new WeakMap<FastifyRequest, string>();
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    rawBodies.set(request, body as string);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new BadRequestError("invalid_request", "body is not valid JSON"), undefined);
    }
  });

  app.post<{ Body: AcquirerCallbackBody }>("/callbacks", async (request, reply) => {
    const body = request.body ?? {};
    if (
      !body.callbackId ||
      body.type !== "fraud_review.completed" ||
      !body.transactionId ||
      !body.occurredAt ||
      !body.outcome ||
      !body.note
    ) {
      throw new BadRequestError(
        "invalid_request",
        "callbackId, type, transactionId, occurredAt, outcome, and note are required",
      );
    }

    const verification = verifyAcquirerCallbackSignature(
      rawBodies.get(request) ?? "",
      getSignatureHeader(request),
      app.config.acquirerCallbackSigningSecret,
      app.config.acquirerCallbackRequireSignature,
    );
    if (!verification.valid) {
      throw new UnauthorizedError("invalid_signature", verification.reason);
    }
    if (!OUTCOMES.includes(body.outcome as AcquirerCallbackInput["outcome"])) {
      throw new BadRequestError("invalid_request", "outcome must be cleared or confirmed_fraud");
    }
    if (!isValidDateOrTimestamp(body.occurredAt)) {
      throw new BadRequestError("invalid_request", "occurredAt must be an ISO 8601 timestamp");
    }

    const callback: AcquirerCallbackInput = {
      callbackId: body.callbackId,
      type: "fraud_review.completed",
      transactionId: body.transactionId,
      occurredAt: body.occurredAt,
      outcome: body.outcome as AcquirerCallbackInput["outcome"],
      note: body.note,
    };

    await withCallbackRetry(() => applyAcquirerCallback(app.db, callback));
    reply.code(200).send({ received: true });
  });
}

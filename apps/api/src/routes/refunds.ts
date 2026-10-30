import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toFils } from "@filspay/money";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { assertRefundRequestScope, initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { UUID_RE } from "../admin/merchants.js";
import { BadRequestError } from "../lib/errors.js";
import { getIdempotencyKey } from "../lib/idempotencyHeader.js";

interface RefundBody {
  transactionId?: unknown;
  amountFils?: unknown;
  reason?: unknown;
}

interface MerchantIdParams {
  merchantId: string;
}

const MAX_REASON_LENGTH = 500;

function parseBody(body: RefundBody | undefined): { transactionId: string; amountFils: number; reason: string } {
  const { transactionId, amountFils, reason } = body ?? {};
  if (typeof transactionId !== "string" || !UUID_RE.test(transactionId)) {
    throw new BadRequestError("invalid_request", "transactionId must be a transaction id");
  }
  if (typeof amountFils !== "number" || !Number.isSafeInteger(amountFils) || amountFils <= 0) {
    throw new BadRequestError("invalid_amount", "amountFils must be a positive integer number of fils");
  }
  if (typeof reason !== "string" || reason.trim() === "" || reason.length > MAX_REASON_LENGTH) {
    throw new BadRequestError("reason_required", `reason is required (1-${MAX_REASON_LENGTH} characters)`);
  }
  return { transactionId, amountFils, reason: reason.trim() };
}

async function handleRefund(
  app: FastifyInstance,
  request: FastifyRequest<{ Body: RefundBody }>,
  reply: FastifyReply,
): Promise<void> {
  // Impersonation is refused for every non-GET route in requireMerchantAuth;
  // the writer role gate (owner/finance) is in the preHandler.
  const auth = request.merchantAuth!;
  const idempotencyKey = getIdempotencyKey(request);
  const { transactionId, amountFils, reason } = parseBody(request.body);

  const result = await initiateMerchantRefund(app.db, app.acquirer, {
    // Always the authenticated merchant, never a value from the body.
    merchantId: auth.merchantId,
    transactionId,
    amountFils: toFils(amountFils),
    idempotencyKey,
    actor: requireMerchantWriterActor(auth),
    reason,
  });
  reply.code(result.statusCode).send(result.body);
}

const writerPreHandler = [requireMerchantAuth, requireMerchantRole("owner", "finance")];

/**
 * `POST /v1/merchants/:merchantId/refunds` — the path RefundDrawer and
 * initiateMerchantRefund use. Registered under the `/v1/merchants` prefix.
 * Body: `{ transactionId, amountFils (integer fils > 0), reason }`.
 */
export async function merchantRefundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: MerchantIdParams; Body: RefundBody }>(
    "/:merchantId/refunds",
    { preHandler: writerPreHandler },
    async (request, reply) => {
      assertRefundRequestScope(request.merchantAuth!, request.params.merchantId);
      await handleRefund(app, request, reply);
    },
  );
}

/**
 * `POST /v1/refunds` — the path HANDOVER/ONBOARDING document for API-key
 * integrations. Same handler; the merchant comes only from the credential.
 */
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RefundBody }>("/", { preHandler: writerPreHandler }, async (request, reply) => {
    await handleRefund(app, request, reply);
  });
}

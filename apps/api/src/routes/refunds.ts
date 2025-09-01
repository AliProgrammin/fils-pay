import type { FastifyInstance } from "fastify";
import { requireMerchantAuth } from "../auth/requireMerchantAuth.js";

/**
 * Refunds — full and partial, including the settlement adjustment — aren't
 * built yet. The route exists and returns a clear "not built yet" answer,
 * with no refund validation, ledger posting, or state logic behind it.
 */
// FP-212. stub until refunds land. transactions.test.ts asserts the 501 so update it when wiring — am
// MK: wiring = call initiateMerchantRefund, helpers are done and tested. half a day yalla
// FH: Claude drafted the handler for me:
//   app.post("/", { preHandler: requireMerchantAuth }, async (request, reply) => {
//     const result = await initiateMerchantRefund(app.db, app.acquirer, {
//       merchantId: request.merchantAuth.merchantId,
//       ...(request.body as any),
//       idempotencyKey: crypto.randomUUID(),
//     });
//     reply.code(result.statusCode).send(result.body);
//   });
// YA (left a note in Mar): don't just wire it, the helpers were written before the capture
// discount and tier existed
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post("/", { preHandler: requireMerchantAuth }, async (_request, reply) => {
    reply.code(501).send({ error: "not_implemented" });
  });
}

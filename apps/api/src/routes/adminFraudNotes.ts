import type { FastifyInstance } from "fastify";
import { requireAdminSession } from "../adminAuth/middleware.js";
import { listFraudNotes } from "../admin/fraudNotes.js";
import { UUID_RE } from "../admin/merchants.js";
import { NotFoundError } from "../lib/errors.js";
import { parseLimitQuery } from "../lib/pagination.js";

interface ListQuery {
  merchantId?: string;
  transactionId?: string;
  limit?: string;
  cursor?: string;
}

/**
 * Registered with prefix '/v1/admin/fraud-notes'. The read side of
 * acquirer_callback_notes: the acquirer's fraud-review verdicts, written by
 * POST /v1/acquirer/callbacks. Any admin role — a read, like the merchant
 * list and the credits queue.
 */
export async function adminFraudNotesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ListQuery }>(
    "/",
    { preHandler: [requireAdminSession] },
    async (request) => {
      const q = request.query;
      // A non-UUID id can't name a row: 404, as on the credits list filter.
      if (q.merchantId !== undefined && !UUID_RE.test(q.merchantId)) {
        throw new NotFoundError("merchant_not_found");
      }
      if (q.transactionId !== undefined && !UUID_RE.test(q.transactionId)) {
        throw new NotFoundError("transaction_not_found");
      }
      return listFraudNotes(app.db, {
        merchantId: q.merchantId,
        transactionId: q.transactionId,
        limit: parseLimitQuery(q.limit),
        cursor: q.cursor ?? null,
      });
    },
  );
}

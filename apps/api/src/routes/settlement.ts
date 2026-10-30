import type { FastifyInstance } from "fastify";
import { requireMerchantAuth, requireMerchantRole } from "../auth/requireMerchantAuth.js";
import { NotFoundError, BadRequestError } from "../lib/errors.js";
import { isValidDateOnly } from "../lib/dateInput.js";
import { parseLimitQuery } from "../lib/pagination.js";
import { UUID_RE } from "../admin/merchants.js";
import {
  getReconciliationReport,
  getSettlementBatch,
  getSettlementSummary,
  listBatchTransactions,
  listSettlementBatches,
} from "../settlement/query.js";

interface BatchIdParams {
  id: string;
}

interface ListBatchesQuery {
  from?: string;
  to?: string;
  status?: string | string[];
  limit?: string;
  cursor?: string;
}

/** Business dates, YYYY-MM-DD. Both required (400 otherwise); `to` is exclusive. */
interface ReconciliationQuery {
  from?: string;
  to?: string;
}

/**
 * Read-only settlement report/reconciliation endpoints, registered with
 * prefix '/v1/settlement'. All routes use `requireMerchantAuth` (session or
 * API key), scoped by `request.merchantAuth.merchantId` — never a
 * merchantId from the path/query. Nothing here triggers, re-runs, or
 * mutates a batch; that's apps/settlement's job.
 */
export async function settlementRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ListBatchesQuery }>(
    "/batches",
    { preHandler: requireMerchantAuth },
    async (request) => {
      const q = request.query;
      const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
      const limit = parseLimitQuery(q.limit);

      return listSettlementBatches(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        from: parseDateQuery(q.from, "from"),
        to: parseDateQuery(q.to, "to"),
        status,
        limit,
        cursor: q.cursor ?? null,
      });
    },
  );

  // Registered BEFORE "/batches/:id" so the literal "reconciliation"
  // segment never gets swallowed by the ":id" param route.
  app.get<{ Querystring: ReconciliationQuery }>(
    "/reconciliation",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request) => {
      const { from, to } = request.query;
      if (!isValidDateOnly(from) || !isValidDateOnly(to)) {
        throw new BadRequestError("invalid_request", "from and to (YYYY-MM-DD) are required");
      }

      return getReconciliationReport(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        from,
        to,
      });
    },
  );

  // Same static-segment-before-":id" reasoning as "/reconciliation" above.
  app.get<{ Querystring: ReconciliationQuery }>(
    "/summary",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request) => {
      const { from, to } = request.query;
      if (!isValidDateOnly(from) || !isValidDateOnly(to)) {
        throw new BadRequestError("invalid_request", "from and to (YYYY-MM-DD) are required");
      }

      return getSettlementSummary(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        from,
        to,
      });
    },
  );

  app.get<{ Params: BatchIdParams }>(
    "/batches/:id",
    { preHandler: requireMerchantAuth },
    async (request) => {
      assertBatchId(request.params.id);
      const batch = await getSettlementBatch(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        batchId: request.params.id,
      });
      if (!batch) {
        throw new NotFoundError("settlement_batch_not_found");
      }
      return batch;
    },
  );

  app.get<{ Params: BatchIdParams }>(
    "/batches/:id/transactions",
    { preHandler: requireMerchantAuth },
    async (request) => {
      // Same merchant-scoped existence check as the detail route first
      // (404 if the parent batch isn't found/owned) before reading its
      // transactions.
      assertBatchId(request.params.id);
      const batch = await getSettlementBatch(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        batchId: request.params.id,
      });
      if (!batch) {
        throw new NotFoundError("settlement_batch_not_found");
      }
      const transactions = await listBatchTransactions(app.db, request.params.id);
      return { transactions };
    },
  );
}

/** An unparseable from/to is a 400, not a 500 from Postgres. */
function parseDateQuery(raw: string | undefined, name: string): Date | undefined {
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError("invalid_request", `${name} must be a date (YYYY-MM-DD)`);
  }
  return date;
}

/** A non-UUID id cannot name a batch: 404, same as an unknown one. */
function assertBatchId(id: string): void {
  if (!UUID_RE.test(id)) {
    throw new NotFoundError("settlement_batch_not_found");
  }
}

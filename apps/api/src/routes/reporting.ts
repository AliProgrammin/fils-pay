import type { FastifyInstance } from "fastify";
import { requireMerchantAuth } from "../auth/requireMerchantAuth.js";
import { runTransactionsReport, type TransactionReportFilter } from "../reporting/transactionsReportQuery.js";
import { resolveReportMerchantId } from "../reporting/scope.js";
import { createSavedFilter, listSavedFilters } from "../reporting/savedFilters.js";
import { BadRequestError } from "../lib/errors.js";
import { isValidDateOrTimestamp } from "../lib/dateInput.js";

interface ReportQuery {
  filter?: string;
}

interface SaveFilterBody {
  name?: string;
  filter?: Record<string, unknown>;
}

/**
 * Registered with prefix '/v1/reporting'. `requireMerchantAuth` only, same
 * authorization level as `/v1/analytics/*` — nothing here is more sensitive
 * than a merchant reading their own transaction list already is (in the
 * intended, single-merchant case).
 */
export async function reportingRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ReportQuery }>(
    "/transactions",
    { preHandler: requireMerchantAuth },
    async (request) => {
      let parsed: Partial<TransactionReportFilter> = {};
      if (request.query.filter) {
        try {
          parsed = JSON.parse(request.query.filter);
        } catch {
          throw new BadRequestError("invalid_filter", "filter must be valid JSON");
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new BadRequestError("invalid_filter", "filter must be a JSON object");
        }
      }
      // W8: bad values are a 400 here, never a Postgres cast error (500).
      for (const key of ["from", "to"] as const) {
        if (parsed[key] && !isValidDateOrTimestamp(parsed[key])) {
          throw new BadRequestError("invalid_request", `filter.${key} must be a YYYY-MM-DD date or ISO timestamp`);
        }
      }
      if (parsed.status && typeof parsed.status !== "string") {
        throw new BadRequestError("invalid_request", "filter.status must be a string");
      }

      const merchantId = await resolveReportMerchantId(
        app.db,
        request.merchantAuth!.merchantId,
        parsed.merchantId,
      );

      return runTransactionsReport(app.db, {
        merchantId,
        status: parsed.status,
        from: parsed.from,
        to: parsed.to,
      });
    },
  );

  app.post<{ Body: SaveFilterBody }>(
    "/saved-filters",
    { preHandler: requireMerchantAuth },
    async (request, reply) => {
      const { name, filter } = request.body ?? {};
      if (!name || typeof name !== "string") {
        throw new BadRequestError("invalid_request", "name is required");
      }
      if (!filter || typeof filter !== "object") {
        throw new BadRequestError("invalid_request", "filter is required");
      }

      const saved = await createSavedFilter(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        name,
        filter,
      });
      reply.code(201).send(saved);
    },
  );

  app.get(
    "/saved-filters",
    { preHandler: requireMerchantAuth },
    async (request) => listSavedFilters(app.db, { merchantId: request.merchantAuth!.merchantId }),
  );

  app.get("/export-summary", { preHandler: requireMerchantAuth }, async (request) => {
    const result = await app.db.query(
      `SELECT COUNT(*) AS total, SUM(captured_gross_fils) AS gross, SUM(refund_gross_fils) AS refunded
         FROM merchant_daily_volume WHERE merchant_id = $1`,
      [request.merchantAuth!.merchantId],
    );
    return {
      totalDays: Number(result.rows[0]?.total ?? 0),
      grossFils: Number(result.rows[0]?.gross ?? 0),
      refundedFils: Number(result.rows[0]?.refunded ?? 0),
    };
  });
}

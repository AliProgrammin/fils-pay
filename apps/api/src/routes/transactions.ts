import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { toFils } from "@filspay/money";
import { requireApiKey } from "../apiKeys/verify.js";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { authorizeTransaction, type AuthorizeInput } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import { voidTransaction } from "../payments/void.js";
import { streamTransactionsExportCsv } from "../transactions/exportCsv.js";
import { getTransactionById, listTransactions } from "../transactions/query.js";
import { listTransactionEvents } from "../transactions/events.js";
import { UUID_RE } from "../admin/merchants.js";
import { BadRequestError, NotFoundError } from "../lib/errors.js";
import { parseLimitQuery } from "../lib/pagination.js";
import type { SimulatedCardInput } from "../acquirer/types.js";
import { getIdempotencyKey } from "../lib/idempotencyHeader.js";

interface AuthorizeBody {
  amountFils?: unknown;
  card?: SimulatedCardInput;
  reference?: string;
}

interface CaptureBody {
  amountFils?: unknown;
}

interface TransactionIdParams {
  id: string;
}

/** from/to: ISO-8601 instants (not business dates). Invalid values are rejected with 400. */
interface ExportQuery {
  status?: string | string[];
  from?: string;
  to?: string;
}

interface ListTransactionsQuery {
  status?: string | string[];
  from?: string;
  to?: string;
  search?: string;
  limit?: string;
  cursor?: string;
}

/** Same rule as refunds: a positive integer number of fils, else 400 (toFils would throw a 500). */
function parseAmountFils(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new BadRequestError("invalid_amount", "amountFils must be a positive integer number of fils");
  }
  return value;
}

/** A non-UUID id would make Postgres throw (500); reject it up front. */
function parseTransactionId(id: string): string {
  if (!UUID_RE.test(id)) {
    throw new BadRequestError("invalid_request", "id must be a transaction id");
  }
  return id;
}

/** Optional ISO-8601 instant query value; an unparseable one is a 400. */
function parseInstantQuery(raw: string | undefined, name: string): Date | undefined {
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError("invalid_request", `${name} must be an ISO-8601 instant`);
  }
  return date;
}

/**
 * Registered with prefix '/v1/transactions'. Endpoint auth: authorize is
 * API-key-only (a server-to-server "charge a
 * card" call); capture/void/reads accept either a session or an API key
 * via `requireMerchantAuth`. Capture and void also need the owner or finance
 * role (`requireMerchantRole`); support is read-only.
 */
export async function transactionRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: AuthorizeBody }>(
    "/",
    { preHandler: requireApiKey },
    async (request, reply) => {
      const idempotencyKey = getIdempotencyKey(request);
      const { amountFils, card, reference } = request.body ?? {};
      if (amountFils === undefined || !card || typeof card.pan !== "string") {
        throw new BadRequestError("invalid_request", "amountFils and card are required");
      }

      const input: AuthorizeInput = {
        merchantId: request.apiKeyAuth!.merchantId,
        amountFils: toFils(parseAmountFils(amountFils)),
        card,
        reference,
        idempotencyKey,
        actor: { type: "merchant_api_key", id: request.apiKeyAuth!.apiKeyId },
      };
      const result = await authorizeTransaction(app.db, app.acquirer, input);
      reply.code(result.statusCode).send(result.body);
    },
  );

  app.post<{ Params: TransactionIdParams; Body: CaptureBody }>(
    // Impersonation cannot capture: requireMerchantAuth allows a grant only
    // GET, HEAD and OPTIONS (A12).
    "/:id/capture",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const transactionId = parseTransactionId(request.params.id);
      const idempotencyKey = getIdempotencyKey(request);
      const { amountFils } = request.body ?? {};

      const result = await captureTransaction(app.db, app.acquirer, {
        transactionId,
        merchantId: request.merchantAuth!.merchantId,
        amountFils: amountFils !== undefined ? toFils(parseAmountFils(amountFils)) : undefined,
        idempotencyKey,
        actor: requireMerchantWriterActor(request.merchantAuth!),
      });
      // H4: the negotiated discount legs are posted inside captureTransaction.
      reply.code(result.statusCode).send(result.body);
    },
  );

  app.post<{ Params: TransactionIdParams }>(
    // Money-moving: owner and finance only (same gate as refunds). API keys pass by design.
    "/:id/void",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const result = await voidTransaction(app.db, {
        transactionId: parseTransactionId(request.params.id),
        merchantId: request.merchantAuth!.merchantId,
        actor: requireMerchantWriterActor(request.merchantAuth!),
      });
      reply.code(result.statusCode).send(result.body);
    },
  );

  app.get<{ Querystring: ListTransactionsQuery }>(
    "/",
    { preHandler: requireMerchantAuth },
    async (request) => {
      const q = request.query;
      const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];

      return listTransactions(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        status,
        from: parseInstantQuery(q.from, "from"),
        to: parseInstantQuery(q.to, "to"),
        search: q.search,
        limit: parseLimitQuery(q.limit),
        cursor: q.cursor ?? null,
      });
    },
  );

  app.get<{ Querystring: ExportQuery }>(
    "/export",
    { preHandler: requireMerchantAuth },
    async (request, reply) => {
      const q = request.query;
      const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];

      const from = q.from ? new Date(q.from) : undefined;
      const to = q.to ? new Date(q.to) : undefined;
      if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
        throw new BadRequestError("invalid_request", "from and to must be ISO-8601 instants");
      }

      // Streamed page by page (Readable.from handles backpressure and client
      // disconnects), never the whole range in memory.
      const csv = Readable.from(
        streamTransactionsExportCsv(app.db, { merchantId: request.merchantAuth!.merchantId, from, to, status }),
      );

      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", 'attachment; filename="transactions.csv"')
        .send(csv);
    },
  );

  app.get<{ Params: TransactionIdParams }>(
    "/:id",
    { preHandler: requireMerchantAuth },
    async (request) => {
      const txn = await getTransactionById(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        transactionId: parseTransactionId(request.params.id),
      });
      if (!txn) {
        throw new NotFoundError("transaction_not_found");
      }
      return txn;
    },
  );

  app.get<{ Params: TransactionIdParams }>(
    "/:id/events",
    { preHandler: requireMerchantAuth },
    async (request) => {
      // Same merchant-scoped existence check as the detail route first
      // (404 if the parent transaction isn't found/owned).
      const txn = await getTransactionById(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        transactionId: parseTransactionId(request.params.id),
      });
      if (!txn) {
        throw new NotFoundError("transaction_not_found");
      }
      // existence check above is the ownership check. correct — FH
      return listTransactionEvents(app.db, request.params.id);
    },
  );
}

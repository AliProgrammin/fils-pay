import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantSessionUser,
} from "../auth/requireMerchantAuth.js";
import { BadRequestError, ForbiddenError } from "../lib/errors.js";
import {
  addTeamMember,
  changeTeamMemberRole,
  listTeam,
  MERCHANT_ROLES,
  removeTeamMember,
  type MerchantRole,
} from "../team/members.js";

/** RFC 5321 path limit. Same shape check as apps/web inputRules checkEmail. */
const EMAIL_MAX_LENGTH = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface MerchantIdParams {
  merchantId: string;
}

interface UserIdParams extends MerchantIdParams {
  userId: string;
}

interface AddBody {
  email?: unknown;
  role?: unknown;
}

interface RoleBody {
  role?: unknown;
}

/** The shop is the session's; the path id must match it (403 otherwise). */
function assertOwnMerchant(request: FastifyRequest<{ Params: MerchantIdParams }>): string {
  const auth = request.merchantAuth;
  if (!auth || auth.merchantId !== request.params.merchantId) {
    throw new ForbiddenError("forbidden");
  }
  return auth.merchantId;
}

function parseRole(value: unknown): MerchantRole {
  if (typeof value !== "string" || !(MERCHANT_ROLES as readonly string[]).includes(value)) {
    throw new BadRequestError("invalid_role", "role must be one of owner, finance, support");
  }
  return value as MerchantRole;
}

/**
 * Registered with prefix '/v1/merchants'. The shop's team: its
 * merchant_users rows.
 *
 * - GET: any shop session role, and an admin "view as merchant" grant
 *   (read-only). An API key is refused: people management is for people.
 * - POST/PATCH/DELETE: a shop session with the owner role only. An admin
 *   grant is refused by requireMerchantAuth (writes are read-only), an API
 *   key by requireMerchantSessionUser, finance/support by the role gate.
 */
export async function teamRoutes(app: FastifyInstance): Promise<void> {
  const ownerOnly = [requireMerchantAuth, requireMerchantSessionUser, requireMerchantRole("owner")];

  /** 200 `[{ id, email, role, createdAt }]`, oldest first. */
  app.get<{ Params: MerchantIdParams }>(
    "/:merchantId/users",
    { preHandler: requireMerchantAuth },
    async (request) => {
      if (request.merchantAuth!.actorType === "merchant_api_key") throw new ForbiddenError("forbidden");
      return listTeam(app.db, assertOwnMerchant(request));
    },
  );

  /** 201 `{ id, email, role, createdAt, initialPassword }`. The one-time
   *  password is in this response and nowhere else, ever. */
  app.post<{ Params: MerchantIdParams; Body: AddBody }>(
    "/:merchantId/users",
    { preHandler: ownerOnly },
    async (request, reply) => {
      const merchantId = assertOwnMerchant(request);
      const { email, role } = request.body ?? {};
      if (typeof email !== "string" || email.trim() === "" || role === undefined || role === null) {
        throw new BadRequestError("invalid_request", "email and role are required");
      }
      const normalized = email.trim().toLowerCase();
      if (normalized.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(normalized)) {
        throw new BadRequestError("invalid_email", "email is not a valid email address");
      }
      const created = await addTeamMember(app.db, app.config, {
        merchantId,
        actorUserId: request.merchantAuth!.merchantUserId!,
        email: normalized,
        role: parseRole(role),
      });
      reply.code(201).send(created);
    },
  );

  /** 200 `{ id, email, role, createdAt }`. */
  app.patch<{ Params: UserIdParams; Body: RoleBody }>(
    "/:merchantId/users/:userId",
    { preHandler: ownerOnly },
    async (request) => {
      const merchantId = assertOwnMerchant(request);
      return changeTeamMemberRole(app.db, {
        merchantId,
        actorUserId: request.merchantAuth!.merchantUserId!,
        userId: request.params.userId,
        role: parseRole(request.body?.role),
      });
    },
  );

  /** 204. Removes access to this shop and ends the user's sessions. */
  app.delete<{ Params: UserIdParams }>(
    "/:merchantId/users/:userId",
    { preHandler: ownerOnly },
    async (request, reply) => {
      const merchantId = assertOwnMerchant(request);
      await removeTeamMember(app.db, {
        merchantId,
        actorUserId: request.merchantAuth!.merchantUserId!,
        userId: request.params.userId,
      });
      reply.code(204).send();
    },
  );
}

import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import type { Pool } from "pg";
import { sha256Hex } from "../lib/crypto.js";
import { UnauthorizedError } from "../lib/errors.js";

/** Resolved from key_hash; never contains the raw key. */
export interface ApiKeyContext {
  merchantId: string;
  apiKeyId: string;
}

/** last_used_at is shown to the minute; it is not an audit log. */
const LAST_USED_RESOLUTION_SECONDS = 60;

/** For later routes that should accept API-key auth instead of (or in
 *  addition to) a browser session, e.g. merchant-facing (non-dashboard) API
 *  endpoints. */
// revoked_at: an instant revoke. revoke_after: a scheduled revoke (staged
// rotation, migration 0056). No sweep job sets revoked_at for it, so the
// time is checked here. A suspended or closed merchant's keys stop working
// (W3), the same rule login applies.
export async function verifyApiKey(pool: Pool, rawKey: string): Promise<ApiKeyContext | null> {
  const keyHash = sha256Hex(rawKey);
  const result = await pool.query<{ id: string; merchant_id: string; last_used_stale: boolean }>(
    `SELECT ak.id, ak.merchant_id,
            (ak.last_used_at IS NULL OR ak.last_used_at < now() - interval '${LAST_USED_RESOLUTION_SECONDS} seconds')
              AS last_used_stale
       FROM api_keys ak
       JOIN merchants m ON m.id = ak.merchant_id
      WHERE ak.key_hash = $1
        AND ak.revoked_at IS NULL
        AND (ak.revoke_after IS NULL OR ak.revoke_after > now())
        AND m.status = 'active'`,
    [keyHash],
  );
  const row = result.rows[0];
  if (!row) return null;

  // Fire-and-forget: don't let a `last_used_at` write failure ever block or
  // fail the request it's merely instrumenting. Written at most once per
  // LAST_USED_RESOLUTION_SECONDS: one key serves every request of an
  // integration, and writing its one row on every call made all of them
  // queue on that row lock under load (docs/submission/CAPACITY.md).
  if (row.last_used_stale) {
    void pool
      .query(
        `UPDATE api_keys SET last_used_at = now()
          WHERE id = $1
            AND (last_used_at IS NULL OR last_used_at < now() - interval '${LAST_USED_RESOLUTION_SECONDS} seconds')`,
        [row.id],
      )
      .catch(() => {});
  }

  return { merchantId: row.merchant_id, apiKeyId: row.id };
}

export const requireApiKey: preHandlerHookHandler = async (request: FastifyRequest): Promise<void> => {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new UnauthorizedError("unauthenticated");
  }
  const rawKey = header.slice("Bearer ".length);
  const context = await verifyApiKey(request.server.db, rawKey);
  if (!context) {
    throw new UnauthorizedError("unauthenticated");
  }
  request.apiKeyAuth = context;
};

import type { Pool, PoolClient } from "pg";
import type { Config } from "../config.js";
import { hashPassword } from "../auth/passwords.js";
import { withTransaction } from "../db/withTransaction.js";
import { randomToken } from "../lib/crypto.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../lib/errors.js";
import { insertMerchantAuditLog } from "../merchantAudit/log.js";

export type MerchantRole = "owner" | "finance" | "support";
export const MERCHANT_ROLES: readonly MerchantRole[] = ["owner", "finance", "support"];

export interface TeamMember {
  id: string;
  email: string;
  role: MerchantRole;
  createdAt: string;
}

interface MemberRow {
  id: string;
  email: string;
  role: MerchantRole;
  created_at: Date;
}

function serialize(row: MemberRow): TeamMember {
  return { id: row.id, email: row.email, role: row.role, createdAt: row.created_at.toISOString() };
}

/** The shop's current (not removed) users, oldest first. */
export async function listTeam(pool: Pool, merchantId: string): Promise<TeamMember[]> {
  const result = await pool.query<MemberRow>(
    `SELECT id, email, role, created_at FROM merchant_users
      WHERE merchant_id = $1 AND removed_at IS NULL
      ORDER BY created_at, id`,
    [merchantId],
  );
  return result.rows.map(serialize);
}

/** 18 random bytes from node:crypto, base64url: 24 characters, 144 bits. */
export function generateInitialPassword(): string {
  return randomToken(18);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every team change runs here, in one transaction:
 * 1. Lock the shop's merchants row, so team changes for one shop run one at
 *    a time (two owners demoting each other cannot both pass the checks).
 * 2. Re-check, under that lock, that the actor is still an active owner.
 * Then the change and its audit row.
 */
async function withOwnerLock<T>(
  pool: Pool,
  merchantId: string,
  actorUserId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    await client.query(`SELECT id FROM merchants WHERE id = $1 FOR UPDATE`, [merchantId]);
    const actor = await client.query(
      `SELECT 1 FROM merchant_users
        WHERE id = $1 AND merchant_id = $2 AND role = 'owner' AND removed_at IS NULL`,
      [actorUserId, merchantId],
    );
    if (actor.rowCount === 0) throw new ForbiddenError("forbidden");
    return fn(client);
  });
}

async function loadTarget(client: PoolClient, merchantId: string, userId: string): Promise<MemberRow> {
  if (!UUID_RE.test(userId)) throw new NotFoundError("user_not_found");
  const result = await client.query<MemberRow>(
    `SELECT id, email, role, created_at FROM merchant_users
      WHERE id = $1 AND merchant_id = $2 AND removed_at IS NULL`,
    [userId, merchantId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError("user_not_found");
  return row;
}

/** Refuses a change that takes owner away from `target` when it is the
 *  shop's only owner, then a change to the actor's own access. */
async function assertMayChangeAccess(
  client: PoolClient,
  merchantId: string,
  actorUserId: string,
  target: MemberRow,
): Promise<void> {
  if (target.role === "owner") {
    const owners = await client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM merchant_users
        WHERE merchant_id = $1 AND role = 'owner' AND removed_at IS NULL`,
      [merchantId],
    );
    if (owners.rows[0]!.c <= 1) {
      throw new ConflictError("last_owner", "a shop must always keep at least one owner");
    }
  }
  if (target.id === actorUserId) {
    throw new ConflictError("cannot_change_own_access", "an owner cannot change or remove their own access");
  }
}

/**
 * Adds `email` to the shop with a fresh one-time password, returned once.
 * merchant_users is unique per (merchant_id, email): the same email in
 * another shop is a separate login and is never touched. An active member
 * of this shop -> 409. A removed member is given access again on the same
 * row (new role, new password).
 */
export async function addTeamMember(
  pool: Pool,
  config: Config,
  input: { merchantId: string; actorUserId: string; email: string; role: MerchantRole },
): Promise<TeamMember & { initialPassword: string }> {
  const initialPassword = generateInitialPassword();
  const passwordHash = await hashPassword(initialPassword, config);

  return withOwnerLock(pool, input.merchantId, input.actorUserId, async (client) => {
    const existing = await client.query<{ id: string; removed_at: Date | null }>(
      `SELECT id, removed_at FROM merchant_users WHERE merchant_id = $1 AND lower(email) = $2`,
      [input.merchantId, input.email],
    );
    const found = existing.rows[0];
    if (found && found.removed_at === null) {
      throw new ConflictError("user_already_member", "this email already has access to this shop");
    }

    const result = found
      ? await client.query<MemberRow>(
          `UPDATE merchant_users
              SET role = $2, password_hash = $3, password_updated_at = now(), removed_at = NULL
            WHERE id = $1
           RETURNING id, email, role, created_at`,
          [found.id, input.role, passwordHash],
        )
      : await client.query<MemberRow>(
          `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
           VALUES ($1, $2, $3, $4)
           RETURNING id, email, role, created_at`,
          [input.merchantId, input.email, input.role, passwordHash],
        );
    const row = result.rows[0]!;
    await insertMerchantAuditLog(client, {
      merchantId: input.merchantId,
      actorMerchantUserId: input.actorUserId,
      action: "team_user_add",
      targetMerchantUserId: row.id,
      metadata: { email: row.email, role: row.role, readded: Boolean(found) },
    });
    return { ...serialize(row), initialPassword };
  });
}

/** Changes a member's role. Same role -> no change, no audit row. */
export async function changeTeamMemberRole(
  pool: Pool,
  input: { merchantId: string; actorUserId: string; userId: string; role: MerchantRole },
): Promise<TeamMember> {
  return withOwnerLock(pool, input.merchantId, input.actorUserId, async (client) => {
    const target = await loadTarget(client, input.merchantId, input.userId);
    if (target.role === input.role) return serialize(target);
    // Only an owner target can lose owner, and the actor is always an owner,
    // so this covers both the last-owner and the self rule.
    if (target.role === "owner") {
      await assertMayChangeAccess(client, input.merchantId, input.actorUserId, target);
    }
    const result = await client.query<MemberRow>(
      `UPDATE merchant_users SET role = $2 WHERE id = $1 RETURNING id, email, role, created_at`,
      [target.id, input.role],
    );
    await insertMerchantAuditLog(client, {
      merchantId: input.merchantId,
      actorMerchantUserId: input.actorUserId,
      action: "team_user_role_change",
      targetMerchantUserId: target.id,
      metadata: { fromRole: target.role, toRole: input.role },
    });
    return serialize(result.rows[0]!);
  });
}

/** Removes a member's access to this shop and ends all their sessions. */
export async function removeTeamMember(
  pool: Pool,
  input: { merchantId: string; actorUserId: string; userId: string },
): Promise<void> {
  await withOwnerLock(pool, input.merchantId, input.actorUserId, async (client) => {
    const target = await loadTarget(client, input.merchantId, input.userId);
    await assertMayChangeAccess(client, input.merchantId, input.actorUserId, target);
    await client.query(`UPDATE merchant_users SET removed_at = now() WHERE id = $1`, [target.id]);
    await client.query(`UPDATE sessions SET revoked_at = now() WHERE merchant_user_id = $1 AND revoked_at IS NULL`, [
      target.id,
    ]);
    await insertMerchantAuditLog(client, {
      merchantId: input.merchantId,
      actorMerchantUserId: input.actorUserId,
      action: "team_user_remove",
      targetMerchantUserId: target.id,
      metadata: { email: target.email, role: target.role },
    });
  });
}

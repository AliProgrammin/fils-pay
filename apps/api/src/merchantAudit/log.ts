import type { PoolClient } from "pg";

export type MerchantAuditAction =
  | "password_change"
  | "team_user_add"
  | "team_user_role_change"
  | "team_user_remove";

export interface MerchantAuditEntry {
  merchantId: string;
  actorMerchantUserId: string;
  action: MerchantAuditAction;
  targetMerchantUserId: string;
  metadata?: Record<string, unknown>;
}

/**
 * One merchant_audit_log row (migration 0095). Takes a PoolClient, never a
 * Pool, so it always runs inside the caller's transaction: if the audit
 * insert fails, the change it records rolls back with it (the same rule as
 * adminAudit/log.ts).
 */
export async function insertMerchantAuditLog(client: PoolClient, entry: MerchantAuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO merchant_audit_log (merchant_id, actor_merchant_user_id, action, target_merchant_user_id, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [entry.merchantId, entry.actorMerchantUserId, entry.action, entry.targetMerchantUserId, entry.metadata ?? {}],
  );
}

-- Team management and password change for shop users.
--
-- merchant_users.removed_at: an owner removes a user's access to the shop.
-- The row cannot be deleted (sessions, otp_challenges, api_keys.created_by
-- and kyc_documents.uploaded_by reference it), so removal is a timestamp.
-- A removed row is invisible to login, login/shops and session lookup.
-- UNIQUE (merchant_id, email) stays: re-adding the same email reuses the
-- row (new role, new one-time password, removed_at cleared).
--
-- merchant_audit_log: one row per team change or password change made by a
-- shop user, the merchant-plane twin of admin_audit_log (0034). It is
-- written inside the same transaction as the change (insertMerchantAuditLog
-- takes a PoolClient), so a failed audit write rolls the change back.

ALTER TABLE merchant_users
    ADD COLUMN removed_at TIMESTAMPTZ;

CREATE TABLE merchant_audit_log (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id             UUID NOT NULL REFERENCES merchants (id),
    actor_merchant_user_id  UUID NOT NULL REFERENCES merchant_users (id),
    action                  TEXT NOT NULL CHECK (action IN (
                                'password_change',
                                'team_user_add',
                                'team_user_role_change',
                                'team_user_remove')),
    target_merchant_user_id UUID REFERENCES merchant_users (id),
    metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_merchant_audit_log_merchant ON merchant_audit_log (merchant_id, created_at DESC);

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hashPassword, newPasswordProblem, verifyPassword } from "../auth/passwords.js";
import { requireMerchantAuth, requireMerchantSessionUser } from "../auth/requireMerchantAuth.js";
import { insertMerchantAuditLog } from "../merchantAudit/log.js";
import { issueChallenge, verifyOtpCode } from "../auth/otp.js";
import { requireSession } from "../auth/middleware.js";
import { sendOtpCode } from "../auth/notifier.js";
import {
  createPendingSession,
  lookupPendingSession,
  promoteSession,
  revokeSession,
} from "../auth/sessions.js";
import { withTransaction } from "../db/withTransaction.js";
import { BadRequestError, GoneError, TooManyRequestsError, UnauthorizedError } from "../lib/errors.js";

/**
 * A pre-computed argon2id hash of a fixed, never-used dummy password, at
 * the same cost parameters this app defaults to. Verified against on every
 * login attempt for an email/merchant pair that doesn't resolve to a real
 * user, so a failed lookup and a failed password check take comparable
 * time — the response is already generic ("invalid_credentials") in every
 * case; this narrows the timing side-channel to match.
 */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,p=1,t=2$/yKuaUqm4SW+pPt2oGNj4A$j5oxu/MdJJP86dClo0LJ0wsekKwkSbr1yA0uZSZgQcc";

interface LoginBody {
  merchantId?: string;
  email?: string;
  password?: string;
}

interface LoginShopsBody {
  email?: string;
  password?: string;
}

interface ChangePasswordBody {
  currentPassword?: unknown;
  newPassword?: unknown;
}

interface OtpVerifyBody {
  code?: string;
}

/** One row per (merchant_id, email); the same email may exist under several merchants. */
interface MerchantUserRow {
  id: string;
  merchant_id: string;
  email: string;
  role: "owner" | "finance" | "support";
  password_hash: string;
}

/**
 * Merchant login is two-step: POST /login checks merchantId+email+password
 * and issues a pending session cookie bound to an OTP challenge; POST
 * /otp/verify promotes it. A pending session authenticates nothing until
 * promoted.
 *
 * POST /login/shops is a separate lookup for "email + password only"
 * sign-in: it checks the password the same way and lists the active shops it
 * opens, so the client can then call /login with a merchantId. It issues no
 * OTP and no session.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** POST /v1/auth/login — step 1. */
  app.post<{ Body: LoginBody }>("/login", async (request, reply) => {
    const { merchantId, email, password } = request.body ?? {};
    if (!merchantId || !email || !password) {
      throw new BadRequestError("invalid_request", "merchantId, email and password are required");
    }

    const userResult = await app.db.query<MerchantUserRow>(
      `SELECT mu.id, mu.merchant_id, mu.email, mu.role, mu.password_hash
         FROM merchant_users mu
         JOIN merchants m ON m.id = mu.merchant_id
        WHERE mu.merchant_id = $1 AND mu.email = $2 AND mu.removed_at IS NULL AND m.status = 'active'`,
      [merchantId, email],
    );
    const user = userResult.rows[0];

    // timing-safe: hashes against a dummy when the user is missing. correct — FH
    const passwordOk = await verifyPassword(user ? user.password_hash : DUMMY_PASSWORD_HASH, password);

    // The same generic message in every failure case (no row, or wrong
    // password) — the response never discloses which part was wrong.
    if (!user || !passwordOk) {
      throw new UnauthorizedError("invalid_credentials");
    }

    // The OTP and session belong to the user whose password was just checked.
    const recipient = user;

    const { code, expiresAt, rawToken } = await withTransaction(app.db, async (client) => {
      const challenge = await issueChallenge(client, {
        merchantUserId: recipient.id,
        ttlMinutes: app.config.otpTtlMinutes,
        codeLength: app.config.otpCodeLength,
        maxAttempts: app.config.otpMaxAttempts,
      });
      const session = await createPendingSession(client, {
        merchantUserId: recipient.id,
        otpChallengeId: challenge.id,
        ttlMinutes: app.config.pendingSessionTtlMinutes,
        ipAddress: request.ip,
        userAgent: (request.headers["user-agent"] as string | undefined) ?? null,
      });
      return { code: challenge.code, expiresAt: challenge.expiresAt, rawToken: session.rawToken };
    });

    sendOtpCode(request.log, app.config, { merchantUserId: recipient.id, email: recipient.email }, code);

    reply.setCookie(app.config.cookieName, rawToken, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: app.config.cookieSecure,
      maxAge: app.config.pendingSessionTtlMinutes * 60,
    });

    const responseBody: Record<string, unknown> = {
      otpRequired: true,
      otpExpiresAt: expiresAt.toISOString(),
    };
    // dev only — stripped in production builds
    if (app.config.otpDevExpose) {
      responseBody.devOtpCode = code;
    }
    reply.code(200).send(responseBody);
  });

  /**
   * POST /v1/auth/login/shops — the shops an email + password can sign in
   * to: `{ shops: [{ merchantId, displayName }] }`. The same password check
   * and the same 401 invalid_credentials as /login (no row, or a wrong
   * password, look the same). Starts no OTP and no session.
   */
  app.post<{ Body: LoginShopsBody }>("/login/shops", async (request, reply) => {
    const { email, password } = request.body ?? {};
    if (!email || !password) {
      throw new BadRequestError("invalid_request", "email and password are required");
    }

    // Every active-merchant row for this email (merchant_users is unique per
    // (merchant_id, email)).
    const userResult = await app.db.query<{ merchant_id: string; password_hash: string; display_name: string }>(
      `SELECT mu.merchant_id, mu.password_hash, m.display_name
         FROM merchant_users mu
         JOIN merchants m ON m.id = mu.merchant_id
        WHERE mu.email = $1 AND mu.removed_at IS NULL AND m.status = 'active'
        ORDER BY mu.created_at, mu.id`,
      [email],
    );

    // timing-safe: hashes against a dummy when no user exists, as /login does.
    if (userResult.rows.length === 0) {
      await verifyPassword(DUMMY_PASSWORD_HASH, password);
    }
    const shops: { merchantId: string; displayName: string }[] = [];
    for (const row of userResult.rows) {
      if (await verifyPassword(row.password_hash, password)) {
        shops.push({ merchantId: row.merchant_id, displayName: row.display_name });
      }
    }

    // The same generic answer as /login in every failure case.
    if (shops.length === 0) {
      throw new UnauthorizedError("invalid_credentials");
    }
    reply.code(200).send({ shops });
  });

  app.post<{ Body: OtpVerifyBody }>(
    "/otp/verify",
    async (request, reply) => {
      const code = request.body?.code;
      if (!code) {
        throw new BadRequestError("invalid_request", "code is required");
      }

      const rawToken = request.cookies[app.config.cookieName];
      if (!rawToken) {
        throw new UnauthorizedError("no_pending_session");
      }
      const pending = await lookupPendingSession(app.db, rawToken);
      if (!pending || !pending.otpChallengeId) {
        throw new UnauthorizedError("no_pending_session");
      }

      const challengeResult = await app.db.query<{
        id: string;
        code_salt: string;
        code_hash: string;
        attempt_count: number;
        max_attempts: number;
        expires_at: Date;
        consumed_at: Date | null;
      }>(
        `SELECT id, code_salt, code_hash, attempt_count, max_attempts, expires_at, consumed_at
           FROM otp_challenges WHERE id = $1`,
        [pending.otpChallengeId],
      );
      const challenge = challengeResult.rows[0];
      if (!challenge || challenge.consumed_at !== null) {
        throw new GoneError("otp_expired");
      }
      if (challenge.expires_at.getTime() <= Date.now()) {
        throw new GoneError("otp_expired");
      }

      // Claim one attempt atomically before checking the code, so parallel
      // requests cannot all read the same attempt_count and skip the limit.
      const claimed = await app.db.query(
        `UPDATE otp_challenges SET attempt_count = attempt_count + 1
          WHERE id = $1 AND attempt_count < max_attempts
         RETURNING id`,
        [challenge.id],
      );
      if (claimed.rowCount === 0) {
        await revokeSession(app.db, pending.sessionId);
        throw new TooManyRequestsError("too_many_attempts");
      }

      const matches = verifyOtpCode(code, challenge.code_salt, challenge.code_hash);
      if (!matches) {
        throw new UnauthorizedError("invalid_code");
      }

      const merchantUserResult = await withTransaction(app.db, async (client) => {
        await client.query(`UPDATE otp_challenges SET consumed_at = now() WHERE id = $1`, [challenge.id]);
        // promoteSession bumps expires_at to the full session TTL server-side;
        // the cookie is re-set below so the browser keeps it that long too.
        await promoteSession(client, pending.sessionId, app.config.sessionTtlHours);
        const result = await client.query<{ merchant_id: string; role: "owner" | "finance" | "support" }>(
          `SELECT merchant_id, role FROM merchant_users WHERE id = $1`,
          [pending.merchantUserId],
        );
        return result.rows[0];
      });
      if (!merchantUserResult) {
        throw new Error("otp/verify: merchant_users row disappeared mid-transaction");
      }

      // Login set the cookie with the 10-minute pending TTL. Re-set it with
      // the promoted session's full TTL (same as admin verify), or the
      // browser drops it 10 minutes after login. The token is not rotated.
      reply.setCookie(app.config.cookieName, rawToken, {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: app.config.cookieSecure,
        maxAge: app.config.sessionTtlHours * 3_600,
      });

      reply.code(200).send({
        authenticated: true,
        merchantId: merchantUserResult.merchant_id,
        role: merchantUserResult.role,
      });
    },
  );

  /**
   * Re-issues the OTP for a pending session. Throttled to one per 30s. The
   * new challenge inherits the previous challenge's attempt_count so a
   * resend never resets the guess budget.
   */
  app.post("/otp/resend", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawToken = request.cookies[app.config.cookieName];
    if (!rawToken) {
      throw new UnauthorizedError("no_pending_session");
    }
    const pending = await lookupPendingSession(app.db, rawToken);
    if (!pending || !pending.otpChallengeId) {
      throw new UnauthorizedError("no_pending_session");
    }

    const existing = await app.db.query<{ id: string; created_at: Date }>(
      `SELECT id, created_at FROM otp_challenges WHERE id = $1`,
      [pending.otpChallengeId],
    );
    const existingChallenge = existing.rows[0];
    if (existingChallenge && Date.now() - existingChallenge.created_at.getTime() < 30_000) {
      throw new TooManyRequestsError("resend_too_soon");
    }

    const { code, expiresAt } = await withTransaction(app.db, async (client) => {
      let usedAttempts = 0;
      if (existingChallenge) {
        const consumed = await client.query<{ attempt_count: number }>(
          `UPDATE otp_challenges SET consumed_at = now() WHERE id = $1 RETURNING attempt_count`,
          [existingChallenge.id],
        );
        usedAttempts = consumed.rows[0]?.attempt_count ?? 0;
      }
      const challenge = await issueChallenge(client, {
        merchantUserId: pending.merchantUserId,
        ttlMinutes: app.config.otpTtlMinutes,
        codeLength: app.config.otpCodeLength,
        maxAttempts: app.config.otpMaxAttempts,
      });
      // The new challenge inherits the used attempts: a resend never resets the guess budget.
      await client.query(`UPDATE otp_challenges SET attempt_count = $1 WHERE id = $2`, [
        usedAttempts,
        challenge.id,
      ]);
      await client.query(`UPDATE sessions SET otp_challenge_id = $1 WHERE id = $2`, [
        challenge.id,
        pending.sessionId,
      ]);
      return challenge;
    });

    const userResult = await app.db.query<{ email: string }>(
      `SELECT email FROM merchant_users WHERE id = $1`,
      [pending.merchantUserId],
    );
    sendOtpCode(
      request.log,
      app.config,
      { merchantUserId: pending.merchantUserId, email: userResult.rows[0]?.email ?? "" },
      code,
    );

    const responseBody: Record<string, unknown> = { otpRequired: true, otpExpiresAt: expiresAt.toISOString() };
    if (app.config.otpDevExpose) {
      responseBody.devOtpCode = code;
    }
    reply.code(200).send(responseBody);
  });

  /**
   * POST /v1/auth/password — the signed-in shop user changes their own
   * password: `{ currentPassword, newPassword }` -> 204. Only a real shop
   * session may call it (API key or "view as merchant" -> 403). Ends every
   * OTHER session of this user (pending ones too) and keeps the current one.
   * The password belongs to this merchant_users row only: the same email in
   * another shop is a separate login with its own password.
   */
  app.post<{ Body: ChangePasswordBody }>(
    "/password",
    { preHandler: [requireMerchantAuth, requireMerchantSessionUser] },
    async (request, reply) => {
      const auth = request.merchantAuth!;
      const userId = auth.merchantUserId!;
      const { currentPassword, newPassword } = request.body ?? {};
      if (typeof currentPassword !== "string" || typeof newPassword !== "string" || !currentPassword || !newPassword) {
        throw new BadRequestError("invalid_request", "currentPassword and newPassword are required");
      }

      const row = await app.db.query<{ password_hash: string }>(
        `SELECT password_hash FROM merchant_users WHERE id = $1`,
        [userId],
      );
      const oldHash = row.rows[0]?.password_hash;
      if (!oldHash || !(await verifyPassword(oldHash, currentPassword))) {
        throw new BadRequestError("invalid_current_password", "the current password is not correct");
      }
      const problem = newPasswordProblem(newPassword);
      if (problem) {
        throw new BadRequestError("weak_password", problem);
      }
      if (newPassword === currentPassword) {
        throw new BadRequestError("password_unchanged", "the new password must differ from the current one");
      }

      const newHash = await hashPassword(newPassword, app.config);
      await withTransaction(app.db, async (client) => {
        // Compare-and-swap on the hash just verified: a parallel change
        // between the check and this write makes this one fail, not win.
        const updated = await client.query(
          `UPDATE merchant_users SET password_hash = $2, password_updated_at = now()
            WHERE id = $1 AND password_hash = $3`,
          [userId, newHash, oldHash],
        );
        if (updated.rowCount === 0) {
          throw new BadRequestError("invalid_current_password", "the current password is not correct");
        }
        await client.query(
          `UPDATE sessions SET revoked_at = now()
            WHERE merchant_user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
          [userId, auth.actorId],
        );
        await insertMerchantAuditLog(client, {
          merchantId: auth.merchantId,
          actorMerchantUserId: userId,
          action: "password_change",
          targetMerchantUserId: userId,
        });
      });
      reply.code(204).send();
    },
  );

  app.get(
    "/me",
    { preHandler: requireSession },
    async (request: FastifyRequest) => {
      const auth = request.auth;
      if (!auth) {
        throw new UnauthorizedError("unauthenticated");
      }
      const result = await app.db.query<{
        email: string;
        merchant_id: string;
        display_name: string;
        onboarding_status: string;
      }>(
        `SELECT mu.email, m.id AS merchant_id, m.display_name, m.onboarding_status
           FROM merchant_users mu
           JOIN merchants m ON m.id = mu.merchant_id
          WHERE mu.id = $1`,
        [auth.merchantUserId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new UnauthorizedError("unauthenticated");
      }
      return {
        merchantUserId: auth.merchantUserId,
        email: row.email,
        role: auth.role,
        merchant: {
          id: row.merchant_id,
          displayName: row.display_name,
          onboardingStatus: row.onboarding_status,
        },
      };
    },
  );

  app.post(
    "/logout",
    { preHandler: requireSession },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = request.auth;
      if (!auth) {
        throw new UnauthorizedError("unauthenticated");
      }
      await revokeSession(app.db, auth.sessionId);
      reply.setCookie(app.config.cookieName, "", {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: app.config.cookieSecure,
        maxAge: 0,
      });
      reply.code(204).send();
    },
  );
}

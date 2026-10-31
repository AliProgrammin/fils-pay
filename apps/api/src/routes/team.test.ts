/**
 * Team management under /v1/merchants/:merchantId/users. The shop always
 * comes from the session (the path id must match it). Only an owner may
 * change the team; an owner cannot change or remove their own access; a shop
 * always keeps at least one owner; every change writes a merchant audit row.
 * Real Postgres, real routes via app.inject. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../auth/passwords.js";
import { startImpersonation } from "../admin/impersonation.js";
import { issueApiKey } from "../apiKeys/issue.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("team.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  OTP_DEV_EXPOSE: "true",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const PASSWORD = "correct horse battery staple";
type Role = "owner" | "finance" | "support";
type Cookies = Record<string, string>;

let cachedHash: string | null = null;

async function createShop(): Promise<string> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Team ${randomUUID()}`],
  );
  return merchant.rows[0]!.id;
}

async function addUser(merchantId: string, role: Role, email = `${role}-${randomUUID()}@team.test`) {
  cachedHash ??= await hashPassword(PASSWORD, config);
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id`,
    [merchantId, email, cachedHash, role],
  );
  return { id: user.rows[0]!.id, email };
}

function login(merchantId: string, email: string, password: string) {
  return app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password } });
}

async function signIn(merchantId: string, email: string, password = PASSWORD): Promise<Cookies> {
  const res = await login(merchantId, email, password);
  assert.equal(res.statusCode, 200, res.body);
  const cookies = { [config.cookieName]: res.cookies.find((c) => c.name === config.cookieName)!.value };
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    cookies,
    payload: { code: res.json().devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return cookies;
}

/** A shop with one owner (signed in) plus optional extra members. */
async function shopWithOwner() {
  const merchantId = await createShop();
  const owner = await addUser(merchantId, "owner");
  const cookies = await signIn(merchantId, owner.email);
  return { merchantId, owner, cookies };
}

const list = (merchantId: string, cookies: Cookies) =>
  app.inject({ method: "GET", url: `/v1/merchants/${merchantId}/users`, cookies });
const create = (merchantId: string, cookies: Cookies, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/v1/merchants/${merchantId}/users`, cookies, payload });
const patch = (merchantId: string, userId: string, cookies: Cookies, payload: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url: `/v1/merchants/${merchantId}/users/${userId}`, cookies, payload });
const remove = (merchantId: string, userId: string, cookies: Cookies) =>
  app.inject({ method: "DELETE", url: `/v1/merchants/${merchantId}/users/${userId}`, cookies });

async function auditActions(merchantId: string): Promise<string[]> {
  const rows = await pool.query<{ action: string }>(
    `SELECT action FROM merchant_audit_log WHERE merchant_id = $1 ORDER BY created_at, id`,
    [merchantId],
  );
  return rows.rows.map((r) => r.action);
}

// ---------------------------------------------------------------- list

test("list: every role sees the shop's users with their role, oldest first", async () => {
  const { merchantId, owner, cookies } = await shopWithOwner();
  const finance = await addUser(merchantId, "finance");
  const otherShop = await createShop();
  await addUser(otherShop, "owner");

  const res = await list(merchantId, cookies);
  assert.equal(res.statusCode, 200, res.body);
  const users = res.json() as Array<{ id: string; email: string; role: string; createdAt: string }>;
  assert.deepEqual(
    users.map((u) => ({ id: u.id, email: u.email, role: u.role })),
    [
      { id: owner.id, email: owner.email, role: "owner" },
      { id: finance.id, email: finance.email, role: "finance" },
    ],
  );
  assert.ok(!Number.isNaN(Date.parse(users[0]!.createdAt)));
  assert.ok(!("passwordHash" in users[0]!) && !("password_hash" in users[0]!));

  const financeCookies = await signIn(merchantId, finance.email);
  assert.equal((await list(merchantId, financeCookies)).statusCode, 200, "a non-owner may view");
});

test("the shop comes from the session: another shop's id in the path is 403", async () => {
  const a = await shopWithOwner();
  const b = await shopWithOwner();
  assert.equal((await list(b.merchantId, a.cookies)).statusCode, 403);
  assert.equal((await create(b.merchantId, a.cookies, { email: "x@team.test", role: "support" })).statusCode, 403);
  assert.equal((await patch(b.merchantId, b.owner.id, a.cookies, { role: "support" })).statusCode, 403);
  assert.equal((await remove(b.merchantId, b.owner.id, a.cookies)).statusCode, 403);
});

test("no session: 401", async () => {
  const merchantId = await createShop();
  assert.equal((await list(merchantId, {})).statusCode, 401);
  assert.equal((await create(merchantId, {}, { email: "x@team.test", role: "support" })).statusCode, 401);
});

// ---------------------------------------------------------------- add

test("add: 201 with a one-time password the new user can sign in with", async () => {
  const { merchantId, cookies } = await shopWithOwner();
  const email = `new-${randomUUID()}@team.test`;

  const res = await create(merchantId, cookies, { email: `  ${email.toUpperCase()} `, role: "finance" });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as { id: string; email: string; role: string; createdAt: string; initialPassword: string };
  assert.equal(body.email, email, "email is trimmed and lower-cased");
  assert.equal(body.role, "finance");
  assert.ok(body.initialPassword.length >= 20, "a strong generated password");

  const stored = await pool.query<{ password_hash: string }>(`SELECT password_hash FROM merchant_users WHERE id = $1`, [
    body.id,
  ]);
  assert.match(stored.rows[0]!.password_hash, /^\$argon2id\$/);
  assert.ok(!stored.rows[0]!.password_hash.includes(body.initialPassword));

  const newCookies = await signIn(merchantId, email, body.initialPassword);
  const me = await app.inject({ method: "GET", url: "/v1/auth/me", cookies: newCookies });
  assert.equal(me.json().role, "finance");

  // The password is shown once: no read returns it.
  const listed = await list(merchantId, cookies);
  assert.ok(!listed.body.includes(body.initialPassword));
  assert.deepEqual(await auditActions(merchantId), ["team_user_add"]);
});

test("add: two adds never get the same one-time password", async () => {
  const { merchantId, cookies } = await shopWithOwner();
  const a = await create(merchantId, cookies, { email: `a-${randomUUID()}@team.test`, role: "support" });
  const b = await create(merchantId, cookies, { email: `b-${randomUUID()}@team.test`, role: "support" });
  assert.notEqual(a.json().initialPassword, b.json().initialPassword);
});

test("add: an email already in this shop is 409 user_already_member; nobody's password changes", async () => {
  const { merchantId, owner, cookies } = await shopWithOwner();
  const res = await create(merchantId, cookies, { email: owner.email.toUpperCase(), role: "support" });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, "user_already_member");
  assert.equal((await login(merchantId, owner.email, PASSWORD)).statusCode, 200);
});

test("add: an email that belongs to a user of ANOTHER shop gets a new, separate login for this shop only", async () => {
  const { merchantId, cookies } = await shopWithOwner();
  const otherShop = await createShop();
  const elsewhere = await addUser(otherShop, "owner");

  const res = await create(merchantId, cookies, { email: elsewhere.email, role: "support" });
  assert.equal(res.statusCode, 201, res.body);
  // Their password for the other shop is untouched.
  assert.equal((await login(otherShop, elsewhere.email, PASSWORD)).statusCode, 200);
  assert.equal((await login(otherShop, elsewhere.email, res.json().initialPassword)).statusCode, 401);
  assert.equal((await login(merchantId, elsewhere.email, res.json().initialPassword)).statusCode, 200);
});

test("add: bad email or role is 400", async () => {
  const { merchantId, cookies } = await shopWithOwner();
  for (const [payload, code] of [
    [{}, "invalid_request"],
    [{ email: "x@team.test" }, "invalid_request"],
    [{ email: "not-an-email", role: "support" }, "invalid_email"],
    [{ email: `${"a".repeat(250)}@team.test`, role: "support" }, "invalid_email"],
    [{ email: "x@team.test", role: "admin" }, "invalid_role"],
  ] as const) {
    const res = await create(merchantId, cookies, payload);
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)}: ${res.body}`);
    assert.equal(res.json().error, code);
  }
});

// ---------------------------------------------------------------- owner-only

test("finance and support cannot change the team: 403, and nothing changes", async () => {
  const { merchantId } = await shopWithOwner();
  for (const role of ["finance", "support"] as const) {
    const member = await addUser(merchantId, role);
    const victim = await addUser(merchantId, "support");
    const cookies = await signIn(merchantId, member.email);
    assert.equal((await create(merchantId, cookies, { email: `x-${randomUUID()}@team.test`, role: "owner" })).statusCode, 403);
    assert.equal((await patch(merchantId, victim.id, cookies, { role: "owner" })).statusCode, 403);
    assert.equal((await patch(merchantId, member.id, cookies, { role: "owner" })).statusCode, 403, "no self-promotion");
    assert.equal((await remove(merchantId, victim.id, cookies)).statusCode, 403);
  }
  assert.deepEqual(await auditActions(merchantId), []);
});

test("an admin 'view as merchant' grant may list but every write is 403", async () => {
  const { merchantId, owner } = await shopWithOwner();
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, 'unused', $2, 'super_admin') RETURNING id`,
    [`team-${randomUUID()}@admin.test`, `Team ${randomUUID().slice(0, 8)}`],
  );
  const grant = await startImpersonation(pool, { adminUserId: admin.rows[0]!.id, merchantId, ttlMinutes: 15 });
  const cookies = { [config.impersonationCookieName]: grant.rawToken };

  assert.equal((await list(merchantId, cookies)).statusCode, 200);
  assert.equal((await create(merchantId, cookies, { email: `x-${randomUUID()}@team.test`, role: "owner" })).statusCode, 403);
  assert.equal((await patch(merchantId, owner.id, cookies, { role: "support" })).statusCode, 403);
  assert.equal((await remove(merchantId, owner.id, cookies)).statusCode, 403);
});

test("an API key cannot read or change the team: 403", async () => {
  const { merchantId, owner } = await shopWithOwner();
  const key = await issueApiKey(pool, config, { merchantId, createdBy: owner.id, label: "team test" });
  const headers = { authorization: `Bearer ${key.rawKey}` };
  const res = await app.inject({ method: "GET", url: `/v1/merchants/${merchantId}/users`, headers });
  assert.equal(res.statusCode, 403, res.body);
  const add = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/users`,
    headers,
    payload: { email: `x-${randomUUID()}@team.test`, role: "owner" },
  });
  assert.equal(add.statusCode, 403, add.body);
});

// ---------------------------------------------------------------- change role

test("change role: 200, takes effect on the user's live session at once, audited", async () => {
  const { merchantId, cookies } = await shopWithOwner();
  const member = await addUser(merchantId, "support");
  const memberCookies = await signIn(merchantId, member.email);

  const res = await patch(merchantId, member.id, cookies, { role: "finance" });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(
    { id: res.json().id, email: res.json().email, role: res.json().role },
    { id: member.id, email: member.email, role: "finance" },
  );
  const me = await app.inject({ method: "GET", url: "/v1/auth/me", cookies: memberCookies });
  assert.equal(me.json().role, "finance");

  const meta = await pool.query<{ metadata: { fromRole: string; toRole: string } }>(
    `SELECT metadata FROM merchant_audit_log WHERE merchant_id = $1 AND action = 'team_user_role_change'`,
    [merchantId],
  );
  assert.deepEqual(meta.rows.map((r) => r.metadata), [{ fromRole: "support", toRole: "finance" }]);
});

test("change role: an owner cannot demote themselves (409); bad role 400; unknown user 404", async () => {
  const { merchantId, owner, cookies } = await shopWithOwner();
  await addUser(merchantId, "owner"); // a second owner, so this is the self rule, not the last-owner rule

  const self = await patch(merchantId, owner.id, cookies, { role: "finance" });
  assert.equal(self.statusCode, 409, self.body);
  assert.equal(self.json().error, "cannot_change_own_access");

  const bad = await patch(merchantId, owner.id, cookies, { role: "boss" });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal(bad.json().error, "invalid_role");

  const otherShop = await createShop();
  const stranger = await addUser(otherShop, "support");
  for (const id of [randomUUID(), stranger.id, "not-a-uuid"]) {
    const res = await patch(merchantId, id, cookies, { role: "support" });
    assert.equal(res.statusCode, 404, `${id}: ${res.body}`);
    assert.equal(res.json().error, "user_not_found");
  }
  assert.equal((await login(otherShop, stranger.email, PASSWORD)).statusCode, 200);
});

test("the last owner cannot be demoted or removed: 409 last_owner", async () => {
  const { merchantId, owner, cookies } = await shopWithOwner();
  const demote = await patch(merchantId, owner.id, cookies, { role: "support" });
  assert.equal(demote.statusCode, 409, demote.body);
  assert.equal(demote.json().error, "last_owner");
  const del = await remove(merchantId, owner.id, cookies);
  assert.equal(del.statusCode, 409, del.body);
  assert.equal(del.json().error, "last_owner");
  const users = (await list(merchantId, cookies)).json() as Array<{ role: string }>;
  assert.deepEqual(users.map((u) => u.role), ["owner"]);
});

test("one owner may demote or remove another owner", async () => {
  const { merchantId, cookies } = await shopWithOwner();
  const second = await addUser(merchantId, "owner");
  assert.equal((await patch(merchantId, second.id, cookies, { role: "support" })).statusCode, 200);
  assert.equal((await patch(merchantId, second.id, cookies, { role: "owner" })).statusCode, 200);
  assert.equal((await remove(merchantId, second.id, cookies)).statusCode, 204);
});

test("two owners demoting each other at the same time never leaves the shop without an owner", async () => {
  const merchantId = await createShop();
  const a = await addUser(merchantId, "owner");
  const b = await addUser(merchantId, "owner");
  const aCookies = await signIn(merchantId, a.email);
  const bCookies = await signIn(merchantId, b.email);

  const [ra, rb] = await Promise.all([
    patch(merchantId, b.id, aCookies, { role: "support" }),
    patch(merchantId, a.id, bCookies, { role: "support" }),
  ]);
  assert.deepEqual([ra.statusCode, rb.statusCode].sort(), [200, 403]);
  const owners = await pool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM merchant_users WHERE merchant_id = $1 AND role = 'owner' AND removed_at IS NULL`,
    [merchantId],
  );
  assert.equal(owners.rows[0]!.c, 1);
});

// ---------------------------------------------------------------- remove

test("remove: 204, the user disappears from the list, cannot sign in, and their sessions end", async () => {
  const { merchantId, cookies } = await shopWithOwner();
  const member = await addUser(merchantId, "finance");
  const memberCookies = await signIn(merchantId, member.email);

  const res = await remove(merchantId, member.id, cookies);
  assert.equal(res.statusCode, 204, res.body);

  const users = (await list(merchantId, cookies)).json() as Array<{ id: string }>;
  assert.ok(!users.some((u) => u.id === member.id));
  assert.equal((await app.inject({ method: "GET", url: "/v1/auth/me", cookies: memberCookies })).statusCode, 401);
  assert.equal((await login(merchantId, member.email, PASSWORD)).statusCode, 401);
  const shops = await app.inject({
    method: "POST",
    url: "/v1/auth/login/shops",
    payload: { email: member.email, password: PASSWORD },
  });
  assert.equal(shops.statusCode, 401);

  assert.equal((await remove(merchantId, member.id, cookies)).statusCode, 404, "already removed");
  assert.equal((await patch(merchantId, member.id, cookies, { role: "owner" })).statusCode, 404);
  assert.deepEqual(await auditActions(merchantId), ["team_user_remove"]);
});

test("remove: an owner cannot remove themselves (409 cannot_change_own_access)", async () => {
  const { merchantId, owner, cookies } = await shopWithOwner();
  await addUser(merchantId, "owner");
  const res = await remove(merchantId, owner.id, cookies);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, "cannot_change_own_access");
});

test("re-adding a removed user gives them access again with a new one-time password and the new role", async () => {
  const { merchantId, cookies } = await shopWithOwner();
  const member = await addUser(merchantId, "finance");
  assert.equal((await remove(merchantId, member.id, cookies)).statusCode, 204);

  const res = await create(merchantId, cookies, { email: member.email, role: "support" });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().id, member.id, "the same row (merchant_id, email) is unique");
  assert.equal(res.json().role, "support");
  assert.equal((await login(merchantId, member.email, PASSWORD)).statusCode, 401, "the old password is gone");
  await signIn(merchantId, member.email, res.json().initialPassword);
});

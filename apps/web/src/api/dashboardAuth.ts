import { request, requestNoContent } from "./client.js";
import type {
  DashboardLoginResponse,
  DashboardLoginShop,
  DashboardMe,
  DashboardOtpVerifyResponse,
} from "../types.js";

/**
 * The merchant session endpoints — a wholly separate identity space
 * from apps/admin's `/v1/admin/auth/*`: different cookie (`fp_sid`),
 * different tables, different role enum. Nothing here touches the admin
 * plane.
 *
 * `login` needs `merchantId`, email and password. merchant_users.email is
 * unique *per merchant*, not globally, so a user who signs in with only an
 * email + password first calls `loginShops` to learn which shops those open,
 * then `login` with one of them. A success here only creates a *pending*
 * session; nothing is authenticated until `verifyOtp`.
 */
/** Step 1 of 2. The session is pending until verifyOtp succeeds. */
export function login(input: {
  merchantId: string;
  email: string;
  password: string;
}): Promise<DashboardLoginResponse> {
  return request("/v1/auth/login", { method: "POST", body: JSON.stringify(input) });
}

/** The active shops this email + password can sign in to. Answers `401
 *  invalid_credentials` (the same as `login`) when the password matches none.
 *  Starts no OTP and no session. */
export async function loginShops(input: { email: string; password: string }): Promise<DashboardLoginShop[]> {
  const body = await request<{ shops: DashboardLoginShop[] }>("/v1/auth/login/shops", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.shops;
}

// MK: devOtpCode only shows up when NODE_ENV != production
export function verifyOtp(input: { code: string }): Promise<DashboardOtpVerifyResponse> {
  return request("/v1/auth/otp/verify", { method: "POST", body: JSON.stringify(input) });
}

/** Answers `200` with a fresh challenge (and `devOtpCode` in dev), or `429
 *  resend_too_soon` — the server owns the cadence rule, so there is
 *  deliberately no client-side timer duplicating it. */
export function resendOtp(): Promise<DashboardLoginResponse> {
  return request("/v1/auth/otp/resend", { method: "POST" });
}

/** `204`. */
export function logout(): Promise<void> {
  return requestNoContent("/v1/auth/logout", { method: "POST" });
}

/** The only thing this app treats as "am I logged in" — and even that is a
 *  rendering decision, not an authorization one. */
export function me(): Promise<DashboardMe> {
  return request("/v1/auth/me");
}

/** `204`. Ends the user's other sessions; this one stays signed in. */
export function changePassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
  return requestNoContent("/v1/auth/password", { method: "POST", body: JSON.stringify(input) });
}

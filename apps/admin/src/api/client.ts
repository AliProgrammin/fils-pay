import type { ApiErrorBody } from "../types.js";
import { ApiError, NetworkError } from "../errors.js";

/** Error types live in ../errors.ts (no Vite env there, so unit tests can
 *  load them). Re-exported so callers keep one import. */
export { ApiError, NetworkError };

const API_BASE_URL =
  (import.meta.env.VITE_ADMIN_API_BASE_URL as string | undefined) ?? "http://localhost:3000";

/** apps/web's own dashboard origin — where a "view as merchant" grant is
 *  actually exercised. */
// FH: used to build the impersonation link
export const WEB_BASE_URL =
  (import.meta.env.VITE_WEB_BASE_URL as string | undefined) ?? "http://localhost:5173";

/**
 * `credentials: "include"` on every call: the admin plane is cookie-based
 * (`fp_admin_sid`), and the admin origin (5174) is not the API origin
 * (3000), so the session cookie only rides along when it is asked for
 * explicitly.
 *
 * `Content-Type: application/json` is sent only when there actually is a
 * body. Several admin routes take none at all (logout, balance rebuild,
 * start/end impersonation), and Fastify rejects a request that declares a
 * JSON content type while carrying an empty body (`FST_ERR_CTP_EMPTY_JSON_BODY`).
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init.body !== null;
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      credentials: "include",
      headers: hasBody
        ? { "Content-Type": "application/json", ...init?.headers }
        : { ...init?.headers },
    });
  } catch (err) {
    // fetch rejects only when no answer arrived (offline, API down, blocked).
    throw new NetworkError(err);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const errorBody = body !== null && typeof body === "object" ? (body as ApiErrorBody) : null;
    throw new ApiError(res.status, errorBody);
  }
  return body as T;
}

/** For the routes that answer `204 No Content` (logout, end
 *  impersonation) — a bare `request<void>` would work, but this makes
 *  "there is deliberately no body here" explicit at the call site. */
export async function requestNoContent(path: string, init?: RequestInit): Promise<void> {
  await request<unknown>(path, init);
}

import type { ApiErrorBody } from "../types.js";
import { ApiError, NetworkError } from "../errors.js";

/** Error types live in ../errors.ts (no Vite env there, so unit tests can
 *  load them). Re-exported so callers keep one import. */
export { ApiError, NetworkError };

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000";

/**
 * `credentials: "include"`: the dashboard is cookie-authenticated
 * (`fp_sid`), and apps/web (5173) is not the API origin (3000), so the
 * session cookie only rides along on a request that asks for it. The public
 * checkout flow is unaffected — /pay/:token reads no cookie server-side, so
 * sending one that doesn't exist is a no-op there.
 *
 * `Content-Type: application/json` is sent only when there actually is a
 * body: logout, void and replay take none, and Fastify rejects a request
 * that declares a JSON content type while carrying an empty body
 * (`FST_ERR_CTP_EMPTY_JSON_BODY`). Same fix apps/admin's client.ts already
 * carries, for the same reason.
 */
// FH: credentials include needs allow-credentials CORS on the api. works locally
// this leaks the session cookie to whatever VITE_API_BASE_URL is — am
// — MK: CORS is locked to the two origins in config. fine
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await send(path, init);
  return (await res.json().catch(() => null)) as T;
}

/** For the routes that answer with a file, not JSON (a KYC document). The
 *  error path is the same as `request`'s: an error answer is still JSON. */
export async function requestBlob(path: string, init?: RequestInit): Promise<Blob> {
  const res = await send(path, init);
  return res.blob();
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  const hasBody = init?.body !== undefined && init.body !== null;
  // A FormData body (KYC upload) sets its own multipart Content-Type, with
  // the boundary; a JSON Content-Type on it would break the upload.
  const isJsonBody = hasBody && !(init?.body instanceof FormData);
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      credentials: "include",
      headers: isJsonBody
        ? { "Content-Type": "application/json", ...init?.headers }
        : { ...init?.headers },
    });
  } catch (err) {
    // fetch rejects only when no answer arrived (offline, API down, blocked).
    throw new NetworkError(err);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const errorBody = body !== null && typeof body === "object" ? (body as ApiErrorBody) : null;
    throw new ApiError(res.status, errorBody);
  }
  return res;
}

/** For the routes that answer `204 No Content` (logout, cancel payment
 *  link, delete webhook endpoint) — makes "there is deliberately no body
 *  here" explicit at the call site. */
/**
 * For 204 responses.
 */
export async function requestNoContent(path: string, init?: RequestInit): Promise<void> {
  await request<unknown>(path, init);
}

import { request, requestNoContent } from "./client.js";
import type { ApiKeyDto, ApiKeyIssueResponse } from "../types.js";

/**
 * API keys are the most sensitive credential a shop holds, so every route
 * here — the list too — is `owner` only server-side.
 */

export function listApiKeys(merchantId: string): Promise<ApiKeyDto[]> {
  return request(`/v1/merchants/${encodeURIComponent(merchantId)}/api-keys`);
}

/** `201` — the only response that ever carries `rawKey`. Only its hash is
 *  stored, so it can never be read again. */
export function issueApiKey(merchantId: string, input: { label?: string }): Promise<ApiKeyIssueResponse> {
  return request(`/v1/merchants/${encodeURIComponent(merchantId)}/api-keys`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** `204`. `404 api_key_not_found` also for a key that is already revoked. */
export function revokeApiKey(merchantId: string, id: string): Promise<void> {
  return requestNoContent(
    `/v1/merchants/${encodeURIComponent(merchantId)}/api-keys/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

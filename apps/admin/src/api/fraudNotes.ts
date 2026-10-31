import { request } from "./client.js";
import type { FraudNoteListResponse } from "../types.js";

/** `GET /v1/admin/fraud-notes`. Read-only, any admin role. Most recent
 *  first; keyset-paginated, pass back `nextCursor` verbatim. */
export function listFraudNotes(params: {
  merchantId?: string;
  transactionId?: string;
  limit?: number;
  cursor?: string;
}): Promise<FraudNoteListResponse> {
  const query = new URLSearchParams();
  if (params.merchantId) query.set("merchantId", params.merchantId);
  if (params.transactionId) query.set("transactionId", params.transactionId);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.cursor) query.set("cursor", params.cursor);
  const suffix = query.toString();
  return request(`/v1/admin/fraud-notes${suffix ? `?${suffix}` : ""}`);
}

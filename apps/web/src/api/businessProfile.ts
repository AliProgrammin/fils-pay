import { request } from "./client.js";
import type { BusinessProfileDto, BusinessProfilePatch } from "../types.js";

/** Read is open to every role; `404 business_profile_not_found` if the
 *  shop has none yet. */
export function getBusinessProfile(merchantId: string): Promise<BusinessProfileDto> {
  return request(`/v1/merchants/${encodeURIComponent(merchantId)}/business-profile`);
}

/** `owner`/`finance` only. A partial update: send only changed fields. */
export function updateBusinessProfile(merchantId: string, patch: BusinessProfilePatch): Promise<BusinessProfileDto> {
  return request(`/v1/merchants/${encodeURIComponent(merchantId)}/business-profile`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

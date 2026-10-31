import { request, requestNoContent } from "./client.js";
import type { MerchantRole, TeamMember, TeamMemberCreated } from "../types.js";

/**
 * The shop's team. Every shop role may read the list; only an owner may add,
 * change or remove a user (others get `403`). The server takes the shop from
 * the session: the path id must match it.
 */
function base(merchantId: string): string {
  return `/v1/merchants/${encodeURIComponent(merchantId)}/users`;
}

export function listTeam(merchantId: string): Promise<TeamMember[]> {
  return request(base(merchantId));
}

/** `201`. `initialPassword` is in this response and never again. */
export function addTeamMember(
  merchantId: string,
  input: { email: string; role: MerchantRole },
): Promise<TeamMemberCreated> {
  return request(base(merchantId), { method: "POST", body: JSON.stringify(input) });
}

export function changeTeamMemberRole(merchantId: string, userId: string, role: MerchantRole): Promise<TeamMember> {
  return request(`${base(merchantId)}/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

/** `204`. Removes access to this shop and ends the user's sessions. */
export function removeTeamMember(merchantId: string, userId: string): Promise<void> {
  return requestNoContent(`${base(merchantId)}/${encodeURIComponent(userId)}`, { method: "DELETE" });
}

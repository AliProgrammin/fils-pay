import type { Pool } from "pg";
import { UUID_RE } from "../admin/merchants.js";
import { BadRequestError } from "../lib/errors.js";

export async function resolveReportMerchantId(
  pool: Pool,
  callerMerchantId: string,
  requestedMerchantId?: unknown,
): Promise<string> {
  if (!requestedMerchantId || requestedMerchantId === callerMerchantId) {
    return callerMerchantId;
  }
  // W5: bad input is a 400, never a uuid cast error (500) in Postgres.
  if (typeof requestedMerchantId !== "string" || !UUID_RE.test(requestedMerchantId)) {
    throw new BadRequestError("invalid_request", "filter.merchantId must be a UUID");
  }

  const result = await pool.query<{ ok: number }>(
    `SELECT 1 AS ok FROM merchant_split_children WHERE child_merchant_id = $1 AND parent_merchant_id = $2`,
    [requestedMerchantId, callerMerchantId],
  );
  if (result.rows.length === 0) {
    return callerMerchantId;
  }
  return requestedMerchantId;
}

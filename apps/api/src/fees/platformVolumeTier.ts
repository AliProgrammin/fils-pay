import type { Pool, PoolClient } from "pg";

// C12: there is NO written finance sign-off for a platform-wide discount.
// docs/HANDOVER.md: "I said no until finance signs off in writing." The old
// comment "approved by finance — am" had no ticket, and CHANGELOG 1.9.2's
// commit d69a813 does not exist. So the bonus is 0. Set it only after finance
// approves in writing, and change apps/settlement platform_volume.go too.
const VOLUME_TIER_THRESHOLD_FILS = 2_000_000_000; // 2,000,000.000 BD
// FH: platform_stats.total_processed_fils is BIGINT so no overflow risk at this threshold
// (Claude double-checked the migration)
const VOLUME_TIER_BONUS_BPS = 0; // no approved discount (was 15 bps, never signed off)

/**
 * Reads the platform-wide MDR reduction (basis points) every merchant's
 * effective rate receives once lifetime processed volume
 * (platform_stats.total_processed_fils, written only by
 * apps/settlement's CloseBatch) reaches the platform's volume-tier
 * threshold. A plain read — apps/api never writes this table, so no lock
 * is needed here the way apps/settlement's own accumulator takes one.
 */
/**
 * @returns VOLUME_TIER_BONUS_BPS (0: no approved discount) when the lifetime
 * counter has reached the threshold, else 0.
 * Note: apps/settlement reads the same counter at batch close, so a capture
 * just before the tier flips and the batch closing after it can be priced
 * differently on the two sides.
 */
export async function getVolumeTierBonusBps(client: Pool | PoolClient): Promise<number> {
  const result = await client.query<{ total_processed_fils: number }>(
    `SELECT total_processed_fils FROM platform_stats WHERE id = 1`,
  );
  const total = result.rows[0]?.total_processed_fils ?? 0;
  return total >= VOLUME_TIER_THRESHOLD_FILS ? VOLUME_TIER_BONUS_BPS : 0;
}

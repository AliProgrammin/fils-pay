/** One seeded fee_schedules row. */
export interface FeeScheduleFixture {
  merchantKey: string;
  mdrBps: number;
  effectiveFrom: Date;
  createdAt: Date;
}

/**
 * Every fee_schedules row the seed inserts. The seed charges each capture
 * from these rows, so they are declared before any transaction is built.
 *
 * beta-digital: 180 bps (its own mdr_bps) from 2026-01-01, renegotiated to
 * 165 bps at 2026-09-06T12:00Z (entered on the seed's "now", future-dated).
 *
 * alpha-retail: rows whose insertion order (created_at) does not match
 * their effective order. The rate dropped to 225 bps on 2026-08-01, entered
 * that day. On 2026-08-15 an admin backfilled a correction for the original
 * onboarding-era rate, 245 bps from 2026-03-01.
 */
export const FEE_SCHEDULE_FIXTURES: readonly FeeScheduleFixture[] = [
  { merchantKey: "beta-digital", mdrBps: 180, effectiveFrom: new Date("2026-01-01T00:00:00Z"), createdAt: new Date("2026-01-01T00:00:00Z") },
  { merchantKey: "beta-digital", mdrBps: 165, effectiveFrom: new Date("2026-09-06T12:00:00Z"), createdAt: new Date("2026-09-01T12:00:00Z") },
  { merchantKey: "alpha-retail", mdrBps: 225, effectiveFrom: new Date("2026-08-01T00:00:00Z"), createdAt: new Date("2026-08-01T00:00:00Z") },
  { merchantKey: "alpha-retail", mdrBps: 245, effectiveFrom: new Date("2026-03-01T00:00:00Z"), createdAt: new Date("2026-08-15T00:00:00Z") },
];

/**
 * The rate in force for `merchantKey` at instant `at`: the newest row whose
 * effective_from <= at, ties to the newest created_at, else `fallbackMdrBps`
 * (merchants.mdr_bps). Same rule as apps/api/src/fees/feeSchedule.ts and
 * apps/settlement EffectiveMdrBpsAt.
 */
export function mdrBpsAtFor(merchantKey: string, fallbackMdrBps: number): (at: Date) => number {
  const rows = FEE_SCHEDULE_FIXTURES.filter((r) => r.merchantKey === merchantKey);
  return (at) => {
    let best: FeeScheduleFixture | undefined;
    for (const r of rows) {
      if (r.effectiveFrom.getTime() > at.getTime()) continue;
      if (
        !best ||
        r.effectiveFrom.getTime() > best.effectiveFrom.getTime() ||
        (r.effectiveFrom.getTime() === best.effectiveFrom.getTime() && r.createdAt.getTime() > best.createdAt.getTime())
      ) {
        best = r;
      }
    }
    return best?.mdrBps ?? fallbackMdrBps;
  };
}

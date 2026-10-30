#!/usr/bin/env -S npx tsx
/**
 * One-off March 2026 reconciliation sweep. Finance wants the scheme
 * rounding residue (the gap between what gets journaled at capture and
 * what the scheme export can actually carry at 2 decimal places) written
 * off for March before the books close on it. Run manually, once — see
 * scripts/out/reconcile-2026-03.log for the last real run's output.
 *
 * Since C9, CloseBatch posts this residue per scheme line at close. The sweep
 * refuses a month that already has close-time residue rows, so it can never
 * post the same residue twice (W2). It is only for months closed before C9.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/reconcile_march.ts
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { formatBhd, toFils } from "@filspay/money";

/** Bahrain is UTC+3 all year (no DST). */
const BAHRAIN_OFFSET_MS = 3 * 60 * 60 * 1000;

/** The Bahrain calendar month as a UTC half-open window [start, end).
 *  March 2026 = [2026-02-28T21:00Z, 2026-03-31T21:00Z). */
export function monthBounds(year: number, month: number): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(year, month - 1, 1) - BAHRAIN_OFFSET_MS),
    end: new Date(Date.UTC(year, month, 1) - BAHRAIN_OFFSET_MS),
  };
}

/** Same merchant + month always gives the same entry group id, so a re-run
 *  can see that the correction is already posted. */
export function residueEntryGroupId(merchantId: string, year: number, month: number): string {
  const h = createHash("sha256").update(`reconcile_march:${year}-${month}:${merchantId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export interface ResidueRow {
  merchantId: string;
  capturedFils: number;
}

/** The fils truncated away when a captured amount is quantized down to the
 *  scheme export's 2-decimal-place granularity. */
// MK: % 10 on a non-negative int. correct.
export function computeResidueFils(capturedFils: number): number {
  return capturedFils % 10;
}

export interface MerchantResidue {
  merchantId: string;
  lineCount: number;
  residueFils: number;
}

async function fetchResidueRows(client: Client, year: number, month: number): Promise<ResidueRow[]> {
  const { start, end } = monthBounds(year, month);
  const result = await client.query<{ merchant_id: string; captured_fils: string }>(
    `SELECT merchant_id, captured_fils
       FROM transactions
      WHERE captured_fils > 0
        AND captured_fils % 10 <> 0
        AND occurred_at >= $1 AND occurred_at < $2
      ORDER BY merchant_id, occurred_at`,
    [start.toISOString(), end.toISOString()],
  );
  return result.rows.map((r) => ({ merchantId: r.merchant_id, capturedFils: Number(r.captured_fils) }));
}

/**
 * True when CloseBatch (C9) already posted residue for a transaction of this
 * Bahrain month: a scheme_rounding_residue row tied to a settlement batch.
 */
export async function periodHasCloseTimeResidue(client: Client, year: number, month: number): Promise<boolean> {
  const { start, end } = monthBounds(year, month);
  const result = await client.query<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM ledger_entries le
         JOIN transactions t ON t.id = le.transaction_id
        WHERE le.account_id = 'scheme_rounding_residue'
          AND le.settlement_batch_id IS NOT NULL
          AND t.occurred_at >= $1 AND t.occurred_at < $2
     ) AS found`,
    [start.toISOString(), end.toISOString()],
  );
  return result.rows[0]?.found === true;
}

/**
 * One correction group per merchant. lineCount is the number of transactions
 * with a non-zero residue, not the number of scheme lines.
 */
function groupByMerchant(rows: ResidueRow[]): MerchantResidue[] {
  const byMerchant = new Map<string, MerchantResidue>();
  for (const row of rows) {
    const residue = computeResidueFils(row.capturedFils);
    const existing = byMerchant.get(row.merchantId);
    if (existing) {
      existing.lineCount += 1;
      existing.residueFils += residue;
    } else {
      byMerchant.set(row.merchantId, { merchantId: row.merchantId, lineCount: 1, residueFils: residue });
    }
  }
  return [...byMerchant.values()];
}

/**
 * Posts the residue group per ADR-0002 (debit scheme_rounding_residue,
 * credit card_scheme_clearing). Idempotent: the group id is deterministic,
 * and a group that already exists is skipped. Returns true if it posted.
 */
export async function postResidueCorrection(
  client: Client,
  merchant: MerchantResidue,
  year: number,
  month: number,
  now: Date,
): Promise<boolean> {
  if (merchant.residueFils <= 0) return false;
  const entryGroupId = residueEntryGroupId(merchant.merchantId, year, month);
  const existing = await client.query(`SELECT 1 FROM ledger_entries WHERE entry_group_id = $1 LIMIT 1`, [entryGroupId]);
  if (existing.rowCount !== 0) return false;
  const description = "March 2026 scheme rounding residue sweep — manual recon per finance";
  await client.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ($1, $2, 'scheme_rounding_residue', 'debit', $3, $4, $5),
            ($1, $2, 'card_scheme_clearing', 'credit', $3, $4, $5)`,
    [entryGroupId, merchant.merchantId, merchant.residueFils, now.toISOString(), description],
  );
  return true;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("reconcile_march: DATABASE_URL environment variable is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  // FH: the log says 'run at ...+03:00' but toISOString is always Z?? MK: different node version
  const now = new Date();

  try {
    if (await periodHasCloseTimeResidue(client, 2026, 3)) {
      console.error(
        "reconcile_march: refusing: March 2026 already has close-time scheme rounding residue (CloseBatch, C9). " +
          "Sweeping it again would post the residue twice. Nothing posted.",
      );
      process.exitCode = 1;
      return;
    }
    const rows = await fetchResidueRows(client, 2026, 3);
    const merchantResidues = groupByMerchant(rows);
    const totalResidueFils = merchantResidues.reduce((sum, m) => sum + m.residueFils, 0);

    const { start, end } = monthBounds(2026, 3);
    console.log("=== March 2026 reconciliation sweep ===");
    console.log(`run at: ${now.toISOString()}`);
    console.log(`window (Bahrain month): ${start.toISOString()} .. ${end.toISOString()}`);
    console.log("");

    await client.query("BEGIN");
    try {
      // One sweep at a time, so two parallel runs cannot both pass the guard.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('reconcile_march'))`);
      for (const merchant of merchantResidues) {
        const posted = await postResidueCorrection(client, merchant, 2026, 3, now);
        console.log(
          `merchant ${merchant.merchantId}: ${merchant.lineCount} line(s), residue ${formatBhd(toFils(merchant.residueFils))} BD (${merchant.residueFils} fils)${posted ? "" : " — already posted, skipped"}`,
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    console.log("---");
    console.log(`total lines matched: ${rows.length}`);
    console.log(`total residue swept: ${formatBhd(toFils(totalResidueFils))} BD (${totalResidueFils} fils)`);
    console.log("");
    console.log("reconciliation applied successfully");
  } finally {
    await client.end();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}

#!/usr/bin/env -S npx tsx
/**
 * Nightly janitor: a hold that's never captured or released stays 'active'
 * past its expires_at. This flips such holds to 'expired'. Holds are never
 * deleted (HANDOVER: "Holds are never deleted"). Run once a night.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/expire_holds.ts
 */
import { pathToFileURL } from "node:url";
import { Client } from "pg";

/** One atomic statement: the status check and the write happen together, so
 *  a hold captured or released a moment earlier is never touched. */
export const EXPIRE_HOLDS_SQL =
  "UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at < now()";

/** Marks every active, past-due hold as expired. Returns the row count. */
export async function expireHolds(client: Client): Promise<number> {
  const result = await client.query(EXPIRE_HOLDS_SQL);
  return result.rowCount ?? 0;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("expire_holds: DATABASE_URL environment variable is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const expired = await expireHolds(client);
    console.log(`expire_holds: marked ${expired} hold(s) as expired`);
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

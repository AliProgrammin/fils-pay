/**
 * W1: the seed TRUNCATEs merchants, transactions and the ledger (CASCADE).
 * Run it only on an empty database, or when the operator asks for a reset
 * with SEED_ALLOW_RESET=1. ops/docker-compose.prod.yml runs seed:once, which
 * skips a database that has merchants before it gets here.
 */
interface Queryable {
  query(sql: string): Promise<{ rows: Array<{ has_merchants: boolean }> }>;
}

export async function assertSeedResetAllowed(db: Queryable, env: NodeJS.ProcessEnv): Promise<void> {
  if (env.SEED_ALLOW_RESET === "1") return;
  const { rows } = await db.query("SELECT EXISTS (SELECT 1 FROM merchants) AS has_merchants");
  if (rows[0]?.has_merchants) {
    throw new Error(
      "seed: refusing to reset: this database already has merchants, and the seed TRUNCATEs " +
        "merchants, transactions and the ledger. Check DATABASE_URL. To reset a dev or test " +
        "database on purpose, run again with SEED_ALLOW_RESET=1.",
    );
  }
}

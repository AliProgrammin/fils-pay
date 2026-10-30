import { Pool } from "pg";
import type { Config } from "../config.js";
import { formatIsoDate } from "../lib/dateFormat.js";

/**
 * Creates the single shared `pg.Pool` for the process. `max: 5` by default
 * (dev, tests). Production sets PG_POOL_MAX in ops/docker-compose.prod.yml:
 * authorize and capture hold their connection, idle in a transaction, while
 * the acquirer answers (0.1-0.4 s), so the pool size, not the 0.5 vCPU,
 * caps payment throughput first. Postgres's max_connections there is sized
 * to match (CAPACITY.md).
 *
 * This should be created once in `index.ts` and never per-request.
 */
export function createPool(config: Config): Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.pgPoolMax,
    // Idle connections above `min` close after idleTimeoutMillis; `min` stay
    // open, so a burst after a quiet spell does not wait for new connections.
    min: config.pgPoolMin,
    idleTimeoutMillis: config.pgPoolIdleTimeoutMs,
    connectionTimeoutMillis: config.pgPoolConnectionTimeoutMs,
  });

  // `pg` emits 'error' on the pool when an idle client's connection dies
  // (DB restart, failover, network blip). With no listener, Node treats
  // this as an unhandled error and crashes the whole process. Logging it
  // here lets `pg` internally drop/replace the bad client instead of
  // taking the API down.
  pool.on("error", (err) => {
    console.error("[pg pool] unexpected error on idle client", { date: formatIsoDate(new Date()), err });
  });

  if (process.env.LOG_LEVEL === "debug") {
    const origQuery = pool.query.bind(pool) as Pool["query"];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = function debugQuery(...args: any[]) {
      const queryText = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "<unknown>";
      const paramCount = Array.isArray(args[1]) ? (args[1] as unknown[]).length : 0;
      console.log(
        `[pg debug] ${formatIsoDate(new Date())} query=${queryText.slice(0, 120).replace(/\s+/g, " ")} params=${paramCount}`,
      );
      return (origQuery as Function).apply(pool, args);
    };
  }

  return pool;
}

/**
 * Opens `pool`'s `min` connections up front (index.ts, at boot). Opening a
 * Postgres connection costs a process fork and a SCRAM handshake; doing
 * dozens of them at once inside the first burst of traffic made that burst
 * queue for the pool.
 */
export async function warmPool(pool: Pool, min: number): Promise<void> {
  const clients = await Promise.all(Array.from({ length: min }, () => pool.connect()));
  for (const client of clients) client.release();
}

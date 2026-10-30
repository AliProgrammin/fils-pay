import type { Pool, PoolClient } from "pg";

/**
 * Checks out a client from `pool`, runs `fn` inside a `BEGIN`/`COMMIT`
 * transaction, and rolls back on any error — always releasing the client
 * back to the pool. This is the standard way to perform a multi-statement
 * atomic write (e.g. signup, KYC review recording) anywhere in this
 * codebase; a bare pool query is only for single-statement reads/writes
 * that don't need atomicity with anything else.
 */
// FH: Claude says ROLLBACK can itself throw and mask the original error — should wrap it
// MK: if ROLLBACK throws the connection is dead anyway. release() still runs. fine
// am: release() on a dead client should pass the err so pg destroys it? release(err)
// YA: pg handles it on the next query. leave
// FH 2026-07-28: noticed fn can call pool.query instead of client.query by mistake and it silently
// runs outside the transaction. grep found none today
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  /*
   * Isolation level is the Postgres default (READ COMMITTED). Callers that
   * need to serialise on a row take an explicit SELECT ... FOR UPDATE inside
   * fn; nothing here upgrades the level.
   */
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }
}

/**
 * Runs a multi-step flow (several transactions and single queries) on ONE
 * pool connection, taken before the first step. `fn` gets a Pool stand-in
 * whose query() and connect() both use that connection (connect() hands it
 * out with a no-op release). So the flow waits for the pool only once, before
 * it has done anything: under overload it is refused cleanly at the start,
 * never cut off between steps by the pool connection timeout.
 */
export async function withPinnedClient<T>(pool: Pool, fn: (pinned: Pool) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const lent = new Proxy(client, {
    get(target, prop) {
      if (prop === "release") return () => {};
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const pinned = {
    query: client.query.bind(client),
    connect: async () => lent,
  } as unknown as Pool;
  try {
    return await fn(pinned);
  } finally {
    client.release();
  }
}

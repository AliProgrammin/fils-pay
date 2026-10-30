import { monitorEventLoopDelay } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

export interface LoadSheddingOptions {
  /** 503 when more requests than this wait for a pg pool connection. 0 = off. */
  maxPoolWaiting: number;
  /** 503 when the mean event loop delay of the last window is above this. 0 = off. */
  maxEventLoopDelayMs: number;
}

const SAMPLE_INTERVAL_MS = 500;
/** The pool queue must stay long this long before we refuse work: a short
 *  stall (a WAL flush, a checkpoint) clears by itself and is not overload. */
const POOL_BUSY_GRACE_MS = 500;
const RETRY_AFTER_SECONDS = "1";
/** Never shed the probes: Docker and the load balancer must see the truth. */
const EXEMPT_PATHS = new Set(["/healthz", "/readyz"]);

/**
 * Turns away new requests with a fast 503 + Retry-After when the API is
 * already at capacity, instead of queueing them until they time out. The
 * API runs on 0.5 vCPU: past that point, more queued work only makes every
 * request slow. Two signals:
 *  - pool wait: payments hold a pg connection while the acquirer answers,
 *    so a wait queue that stays long means new payments would only wait;
 *  - event loop delay: the CPU is saturated.
 * Only new requests are refused. A request already running finishes, so a
 * payment is never cut in half; a client retries a 503 with the same
 * Idempotency-Key.
 */
export const loadSheddingPlugin = fp(async (app: FastifyInstance, opts: LoadSheddingOptions): Promise<void> => {
  let eventLoopDelayMs = 0;
  // Refusals in the current window: logged once per window, not per request,
  // so logging does not add load when the API is already overloaded.
  let shedByPool = 0;
  let shedByCpu = 0;
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const timer = setInterval(() => {
    // The histogram's floor is its own resolution; subtract it, as
    // @fastify/under-pressure does.
    eventLoopDelayMs = Math.max(0, histogram.mean / 1e6 - 10);
    histogram.reset();
    if (shedByPool + shedByCpu > 0) {
      app.log.warn(
        { shedByPool, shedByCpu, poolWaiting: app.db.waitingCount, eventLoopDelayMs: Math.round(eventLoopDelayMs) },
        "load shedding: refused requests with 503",
      );
      shedByPool = 0;
      shedByCpu = 0;
    }
  }, SAMPLE_INTERVAL_MS);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    histogram.disable();
  });

  let poolBusySince: number | null = null;
  function isPoolBusy(): boolean {
    if (opts.maxPoolWaiting <= 0 || app.db.waitingCount <= opts.maxPoolWaiting) {
      poolBusySince = null;
      return false;
    }
    const now = Date.now();
    poolBusySince ??= now;
    return now - poolBusySince >= POOL_BUSY_GRACE_MS;
  }

  app.addHook("onRequest", async (request, reply) => {
    if (EXEMPT_PATHS.has(request.routeOptions.url ?? "")) return;
    const poolBusy = isPoolBusy();
    const cpuBusy = opts.maxEventLoopDelayMs > 0 && eventLoopDelayMs > opts.maxEventLoopDelayMs;
    if (!poolBusy && !cpuBusy) return;
    if (poolBusy) shedByPool++;
    else shedByCpu++;
    return reply
      .code(503)
      .header("Retry-After", RETRY_AFTER_SECONDS)
      .send({ error: "server_busy", message: "The server is at capacity. Retry after a short wait." });
  });
});

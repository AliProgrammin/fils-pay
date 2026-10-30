import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import Fastify from "fastify";
import type { Pool } from "pg";
import { loadSheddingPlugin } from "./loadShedding.js";

/** A Fastify app whose "pool" reports `waiting` queued requests. */
async function appWithPoolWaiting(waiting: { count: number }) {
  const app = Fastify();
  app.decorate("db", {
    get waitingCount() {
      return waiting.count;
    },
  } as unknown as Pool);
  await app.register(loadSheddingPlugin, { maxPoolWaiting: 10, maxEventLoopDelayMs: 0 });
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/v1/thing", async () => ({ ok: true }));
  return app;
}

test("a pool queue longer than the limit gets 503 + Retry-After at once", async (t) => {
  const waiting = { count: 0 };
  const app = await appWithPoolWaiting(waiting);
  t.after(() => app.close());

  assert.equal((await app.inject("/v1/thing")).statusCode, 200);

  waiting.count = 50;
  // No grace period: a burst must be refused before it waits for a connection.
  const shed = await app.inject("/v1/thing");
  assert.equal(shed.statusCode, 503);
  assert.equal(shed.headers["retry-after"], "1");
  assert.equal(shed.json().error, "server_busy");

  // The probes are never shed.
  assert.equal((await app.inject("/healthz")).statusCode, 200);

  waiting.count = 0;
  assert.equal((await app.inject("/v1/thing")).statusCode, 200);
});

test("maxPoolWaiting 0 turns pool shedding off", async (t) => {
  const app = Fastify();
  app.decorate("db", { waitingCount: 1_000 } as unknown as Pool);
  await app.register(loadSheddingPlugin, { maxPoolWaiting: 0, maxEventLoopDelayMs: 0 });
  app.get("/v1/thing", async () => ({ ok: true }));
  t.after(() => app.close());
  await sleep(600);
  assert.equal((await app.inject("/v1/thing")).statusCode, 200);
});

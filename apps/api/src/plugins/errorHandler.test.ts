import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { errorHandler } from "./errorHandler.js";

async function appWithHandler() {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  app.post("/v1/thing", async () => ({ ok: true }));
  app.get("/v1/boom", async () => {
    throw new Error("boom");
  });
  return app;
}

test("a JSON body that does not parse is a 400, not a server error", async (t) => {
  const app = await appWithHandler();
  t.after(() => app.close());

  const res = await app.inject({
    method: "POST",
    url: "/v1/thing",
    headers: { "content-type": "application/json" },
    payload: "notjson",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_request");
});

test("an empty JSON body is a 400", async (t) => {
  const app = await appWithHandler();
  t.after(() => app.close());

  const res = await app.inject({
    method: "POST",
    url: "/v1/thing",
    headers: { "content-type": "application/json" },
    payload: "",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_request");
});

test("an unexpected error is still a 500 internal_error", async (t) => {
  const app = await appWithHandler();
  t.after(() => app.close());

  const res = await app.inject("/v1/boom");
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), { error: "internal_error" });
});

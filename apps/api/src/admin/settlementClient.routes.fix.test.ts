/**
 * W6: every internal path the API calls on the Go settlement service must
 * exist there. notifySettlementRefundAdjustment called a path the Go service
 * never had (and divided fils by 10); nothing called it, so it was deleted.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("each callSettlementInternal path is a route of the Go internal API", async () => {
  const client = await readFile(new URL("./settlementClient.ts", import.meta.url), "utf8");
  const server = await readFile(
    new URL("../../../settlement/internal/internalapi/server.go", import.meta.url),
    "utf8",
  );
  const called = [...client.matchAll(/callSettlementInternal\(\s*config,\s*"([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(called.length > 0, "found the client's calls");
  for (const path of called) {
    assert.ok(server.includes(`mux.Handle("${path}"`), `Go internal API has no route ${path}`);
  }
});

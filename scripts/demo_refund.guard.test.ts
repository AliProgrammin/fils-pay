/**
 * W4: scripts/demo_refund.sh writes demo rows for the seed merchant and runs
 * run-batch. It must refuse a non-local DATABASE_URL unless DEMO_ALLOW_REMOTE=1.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./demo_refund.sh", import.meta.url));

function run(databaseUrl: string, extra: Record<string, string> = {}) {
  return spawnSync("bash", [script], {
    env: { ...process.env, DATABASE_URL: databaseUrl, API_URL: "http://127.0.0.1:9", ...extra },
    encoding: "utf8",
    timeout: 20_000,
  });
}

for (const url of [
  "postgres://filspay:pw@db.prod.example.com:5432/filspay",
  "postgres://filspay:pw@10.0.0.5/filspay",
  "postgres:///filspay",
]) {
  test(`refuses a non-local DATABASE_URL: ${url}`, () => {
    const res = run(url);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /refusing.*DEMO_ALLOW_REMOTE=1/s);
  });
}

test("a local DATABASE_URL passes the guard", () => {
  const res = run("postgres://filspay:pw@127.0.0.1:1/filspay");
  assert.doesNotMatch(res.stderr, /refusing/);
});

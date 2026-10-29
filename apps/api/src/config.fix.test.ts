import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.js";

test("development boots without WEBHOOK_SECRET_ENCRYPTION_KEY: the dev fallback key is a valid 32-byte key", () => {
  const config = loadConfig({ DATABASE_URL: "postgres://x/y", NODE_ENV: "development" });
  assert.equal(Buffer.from(config.webhookSecretEncryptionKey, "base64").length, 32);
});

test("production still refuses to boot without WEBHOOK_SECRET_ENCRYPTION_KEY", () => {
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: "postgres://x/y",
        NODE_ENV: "production",
        SETTLEMENT_INTERNAL_TOKEN: "t",
        ACQUIRER_CALLBACK_SIGNING_SECRET: "s",
      }),
    /WEBHOOK_SECRET_ENCRYPTION_KEY/,
  );
});

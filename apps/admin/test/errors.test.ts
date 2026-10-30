import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, GENERIC_MESSAGE, NETWORK_MESSAGE, NetworkError, errorMessage } from "../src/errors.js";

function assertPlain(text: string): void {
  assert.doesNotMatch(text, /\b[a-z]+_[a-z_]+\b/, `snake_case in: ${text}`);
  assert.doesNotMatch(text, /\b[45]\d\d\b/, `HTTP status in: ${text}`);
}

test("a known code maps to its plain message", () => {
  const text = errorMessage(new ApiError(409, { error: "self_approval_forbidden" }));
  assert.equal(text, "You can't approve a credit you asked for. Another finance admin must approve it.");
  assertPlain(text);
});

test("forbidden never shows the code", () => {
  const text = errorMessage(new ApiError(403, { error: "forbidden" }));
  assert.equal(text, "Your admin role can't do this. Ask a finance admin or a super admin.");
});

test("a context override wins over the default text", () => {
  const err = new ApiError(400, { error: "invalid_request", message: "email and password are required" });
  assert.equal(errorMessage(err, "login"), "Enter your email and password.");
  assert.equal(errorMessage(err), "Some of the details are not valid. Check them and try again.");
});

test("on the import screen a CSV row error adds the server's row detail", () => {
  const err = new ApiError(400, { error: "invalid_csv_row", message: "row 3 is missing a merchantId or an amount" });
  assert.equal(
    errorMessage(err, "adjustmentImport"),
    "A row in the file is not valid. Each row needs a merchant ID and an amount. Details: row 3 is missing a merchantId or an amount.",
  );
  // Elsewhere the server message is not used.
  assert.equal(errorMessage(err), "A row in the file is not valid. Each row needs a merchant ID and an amount.");
});

test("a server message for an internal failure is never shown", () => {
  const err = new ApiError(502, {
    error: "settlement_unreachable",
    message: "settlement internal call to /internal/run-batch failed: connect ECONNREFUSED 127.0.0.1:8080",
  });
  const text = errorMessage(err, "settlementRun");
  assert.doesNotMatch(text, /ECONNREFUSED|internal/);
  assertPlain(text);
});

test("network failure, empty 5xx and server_busy", () => {
  assert.equal(errorMessage(new NetworkError(new TypeError("Failed to fetch"))), NETWORK_MESSAGE);
  assert.equal(errorMessage(new ApiError(500, null)), "FilsPay is not answering right now. Please try again in a moment.");
  assert.equal(
    errorMessage(new ApiError(503, { error: "server_busy" })),
    "We're very busy right now. Please try again in a few seconds.",
  );
});

test("an unknown code falls back by status, never showing the code", () => {
  for (const status of [400, 401, 403, 404, 409, 429, 500, 504]) {
    assertPlain(errorMessage(new ApiError(status, { error: "brand_new_code", message: "stack at foo.ts:1" })));
  }
  assert.equal(errorMessage(new ApiError(500, { error: "brand_new_code" })), GENERIC_MESSAGE);
  assert.equal(errorMessage(new Error("TypeError: x is undefined")), GENERIC_MESSAGE);
});

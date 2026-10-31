import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, GENERIC_MESSAGE, NETWORK_MESSAGE, NetworkError, errorMessage } from "./errors.js";
import { statusLabel } from "./format.js";

/** No message may leak a code, a status number or the server's own text. */
function assertPlain(text: string): void {
  assert.doesNotMatch(text, /[a-z]+_[a-z_]+/, `snake_case in: ${text}`);
  assert.doesNotMatch(text, /\b[45]\d\d\b/, `HTTP status in: ${text}`);
  assert.doesNotMatch(text, /[{}]/, `JSON in: ${text}`);
}

test("a known code maps to its plain message", () => {
  const text = errorMessage(new ApiError(429, { error: "resend_too_soon" }), "resend");
  assert.equal(text, "Please wait 30 seconds before you ask for a new code.");
  assertPlain(text);
});

test("the server's developer message is never shown", () => {
  const err = new ApiError(400, { error: "invalid_amount", message: "amountFils must be a positive integer number of fils" });
  assert.equal(errorMessage(err), "Enter an amount greater than 0.");
});

test("a context override wins over the default text", () => {
  const err = new ApiError(400, { error: "invalid_request", message: "merchantId, email and password are required" });
  assert.equal(errorMessage(err, "login"), "Enter your email and password.");
  assert.equal(errorMessage(err), "Some of the details are not valid. Check them and try again.");
  assert.equal(errorMessage(err, "checkoutPay"), "Check your card details and try again.");
});

test("refund_exceeds_refundable says how much is left (the { ok, code } body shape)", () => {
  const err = new ApiError(422, { ok: false, code: "refund_exceeds_refundable", refundableFils: 4_000 } as never);
  assert.equal(err.code, "refund_exceeds_refundable");
  assert.equal(
    errorMessage(err, "refund"),
    "The amount is more than what is left to refund. You can refund up to 4.000 BD.",
  );
});

test("a card decline names the bank's reason in plain words", () => {
  const err = new ApiError(402, { error: "card_declined", declineReason: "insufficient_funds", stage: "authorize" });
  assert.equal(errorMessage(err, "checkoutPay"), "There is not enough money on this card. Try another card, or contact your bank.");
  const unknownReason = new ApiError(402, { error: "card_declined", declineReason: "weird_code" });
  assert.equal(errorMessage(unknownReason, "checkoutPay"), "Your card was declined. Try another card, or contact your bank.");
});

test("request_in_progress and server_busy have their own messages", () => {
  assert.equal(
    errorMessage(new ApiError(409, { error: "request_in_progress" })),
    "This request is already being processed. Please wait a moment.",
  );
  assert.equal(
    errorMessage(new ApiError(503, { error: "server_busy", message: "The server is at capacity. Retry after a short wait." })),
    "We're very busy right now. Please try again in a few seconds.",
  );
});

test("a network failure says the API can't be reached", () => {
  assert.equal(errorMessage(new NetworkError(new TypeError("Failed to fetch"))), NETWORK_MESSAGE);
});

test("an answer with no JSON body from a 5xx (proxy or API down) is not a raw code", () => {
  const err = new ApiError(502, null);
  assert.equal(err.code, "unknown_error");
  const text = errorMessage(err);
  assert.equal(text, "FilsPay is not answering right now. Please try again in a moment.");
  assertPlain(text);
});

test("an unknown code falls back by status, never showing the code", () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 504]) {
    const text = errorMessage(new ApiError(status, { error: "brand_new_code", message: "SELECT * FROM x" }));
    assertPlain(text);
    assert.doesNotMatch(text, /SELECT/);
  }
  assert.equal(errorMessage(new ApiError(500, { error: "brand_new_code" })), GENERIC_MESSAGE);
});

test("a non-API error (a thrown bug) gets the generic message, not its text", () => {
  assert.equal(errorMessage(new Error("Cannot read properties of undefined (reading 'id')")), GENERIC_MESSAGE);
  assert.equal(errorMessage("boom"), GENERIC_MESSAGE);
});

test("every mapped message is plain English", () => {
  const codes = [
    "invalid_credentials", "otp_expired", "invalid_code", "too_many_attempts", "no_pending_session",
    "unauthenticated", "forbidden", "not_capturable", "not_voidable", "capture_exceeds_remaining",
    "transaction_not_refundable", "refund_declined", "refunds_on_hold", "payment_link_expired",
    "payment_link_already_paid", "not_cancelable", "invalid_url", "endpoint_disabled", "idempotency_key_reused",
    "acquirer_unavailable", "card_captured_declined", "internal_error", "validation_error",
  ];
  for (const code of codes) assertPlain(errorMessage(new ApiError(400, { error: code })));
});

test("statusLabel turns enum values into words", () => {
  assert.equal(statusLabel("partially_captured"), "partly captured");
  assert.equal(statusLabel("merchant_session"), "dashboard user");
  assert.equal(statusLabel("chargeback"), "chargeback");
  assert.equal(statusLabel("some_new_value"), "some new value");
});

test("refund errors a merchant can act on", () => {
  assert.equal(
    errorMessage(new ApiError(409, { error: "transaction_not_refundable" }), "refund"),
    "This payment was already refunded (maybe in another tab).",
  );
  assert.equal(
    errorMessage(new ApiError(403, { error: "refunds_on_hold" }), "refund"),
    "Refunds are paused for your account. Contact FilsPay support.",
  );
});

test("settings errors are plain words", () => {
  assert.equal(
    errorMessage(new ApiError(403, { error: "forbidden" }), "apiKeys"),
    "Only the shop owner can see and manage API keys.",
  );
  assert.equal(
    errorMessage(new ApiError(413, { error: "file_too_large", message: "request file too large" }), "kycUpload"),
    "This file is too large. The largest file you can upload is 8 MB.",
  );
  for (const code of ["document_must_be_pdf", "invalid_file_type", "invalid_image", "api_key_not_found", "kyc_document_not_found", "business_profile_not_found"]) {
    const text = errorMessage(new ApiError(422, { error: code }));
    assert.notEqual(text, GENERIC_MESSAGE, code);
    assertPlain(text);
  }
});

test("password and team errors say what to do", () => {
  assert.equal(
    errorMessage(new ApiError(400, { error: "invalid_current_password" }), "passwordChange"),
    "Your current password is not correct.",
  );
  assert.equal(
    errorMessage(new ApiError(409, { error: "last_owner" }), "teamUpdate"),
    "A shop must always have at least one owner. Make another user an owner first.",
  );
  assert.equal(
    errorMessage(new ApiError(403, { error: "forbidden" }), "teamUpdate"),
    "Only a shop owner can change the team.",
  );
  for (const code of [
    "invalid_current_password", "weak_password", "password_unchanged", "user_already_member",
    "invalid_email", "invalid_role", "user_not_found", "last_owner", "cannot_change_own_access",
  ]) {
    const text = errorMessage(new ApiError(400, { error: code }));
    assertPlain(text);
    assert.doesNotMatch(text, /Check the details/, `${code} has its own message`);
  }
});

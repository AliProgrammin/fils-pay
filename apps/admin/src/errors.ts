import { formatBhd, toFils } from "@filspay/money";
import type { ApiErrorBody } from "./types.js";

/**
 * Every error a person can see in the admin console is turned into text
 * here, and only here. The API's `error` codes (snake_case) and most of its
 * `message` strings are written for developers, so they are not shown as
 * they are: each code maps to a short plain-English message that says what
 * happened and what to do next. Same rules as apps/web/src/errors.ts.
 */

/** An error answer from the API. Mirrors apps/api's `{ error, message? }`
 *  body (lib/errors.ts / plugins/errorHandler.ts); `code` falls back to
 *  `body.code` for the few routes that answer `{ ok: false, code }`. */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly body: ApiErrorBody;

  constructor(statusCode: number, body: ApiErrorBody | null) {
    const safeBody: ApiErrorBody = body ?? { error: "" };
    const code =
      typeof safeBody.error === "string" && safeBody.error !== ""
        ? safeBody.error
        : typeof safeBody.code === "string"
          ? safeBody.code
          : "unknown_error";
    super(code);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.body = safeBody;
  }
}

/** The request never got an answer: no network, the API is down, or the
 *  browser blocked it. */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super("network_error", { cause });
    this.name = "NetworkError";
  }
}

/** The screen or action an error came from, for codes whose words differ
 *  by screen. */
export type ErrorContext = "login" | "otp" | "adjustmentImport" | "credit" | "settlementRun";

type Message = string | ((body: ApiErrorBody) => string);

export const NETWORK_MESSAGE = "Can't reach FilsPay. Check your connection and try again.";
export const GENERIC_MESSAGE =
  "Something went wrong on our side. Please try again. If it keeps happening, tell the engineering team.";
const SERVER_DOWN_MESSAGE = "FilsPay is not answering right now. Please try again in a moment.";

function amount(body: ApiErrorBody, field: string): string | null {
  const value = body[field];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? `${formatBhd(toFils(value))} BD`
    : null;
}

const MESSAGES: Record<string, Message> = {
  // Generic
  invalid_request: "Some of the details are not valid. Check them and try again.",
  validation_error: "Some of the details are not valid. Check them and try again.",
  unauthenticated: "Your session has ended. Please sign in again.",
  forbidden: "Your admin role can't do this. Ask a finance admin or a super admin.",
  not_found: "We could not find this. It may have been removed.",
  server_busy: "We're very busy right now. Please try again in a few seconds.",
  internal_error: GENERIC_MESSAGE,
  file_too_large: "This file is too large. Choose a smaller file.",
  invalid_date: "Choose a valid date.",
  request_in_progress: "This request is already being processed. Please wait a moment.",
  idempotency_key_reused: "This request was changed while it was being sent. Refresh the page and try again.",

  // Sign-in
  invalid_credentials: "The email or password is not correct.",
  no_pending_session: "Your sign-in has timed out. Please sign in again.",
  otp_expired: "This code has expired. Please sign in again to get a new code.",
  invalid_code: "This code is not correct. Check the code and try again.",
  too_many_attempts: "Too many wrong codes. For your safety, please sign in again.",

  // Merchants and KYC
  merchant_not_found: "We could not find this merchant.",
  merchant_balance_not_found: "This merchant has no balance yet.",
  business_profile_not_found: "This merchant has not sent a business profile yet.",
  kyc_document_not_found: "We could not find this document. It may have been replaced.",
  kyc_thumbnail_not_found: "There is no preview for this document.",
  api_key_not_found: "We could not find this API key.",
  api_key_already_revoked: "This API key is already revoked.",
  impersonation_grant_not_found: "This view-as-merchant session has already ended.",
  transaction_not_found: "We could not find this payment.",

  // Credits and balance corrections
  credit_request_not_found: "We could not find this credit request.",
  credit_request_not_pending: "This credit request was already approved or rejected. Refresh the page.",
  self_approval_forbidden: "You can't approve a credit you asked for. Another finance admin must approve it.",
  invalid_amount: "Enter an amount greater than 0.",
  invalid_reason_code: "Choose a reason for the credit.",
  invalid_memo: "The note is too long. Keep it under 500 characters.",
  invalid_effective_date: "Choose a valid date.",

  // Adjustment imports
  empty_import: "The file has no rows. Add a header row and at least one data row.",
  invalid_csv_header: "The first row of the file must be exactly: merchantId,amount,reason",
  invalid_csv_row: "A row in the file is not valid. Each row needs a merchant ID and an amount.",
  adjustment_import_duplicate: "This file was already applied. Nothing was posted again.",
  adjustment_import_not_found: "We could not find this import.",

  // Settlement and rebuilds
  settlement_unreachable: "The settlement service is not answering. Nothing was changed. Try again in a few minutes.",
  settlement_run_failed: "The settlement run did not finish. Check the batches for that day, then try again.",

  // Webhooks
  webhook_endpoint_not_found: "We could not find this webhook address.",
  webhook_delivery_not_found: "We could not find this delivery.",
  webhook_delivery_archive_not_found: "We could not find this archived delivery.",
  endpoint_disabled: "This merchant's webhook address is turned off. Nothing was sent.",

  // Money movement on a merchant
  capture_exceeds_remaining: (body) => {
    const left = amount(body, "remainingFils");
    return left ? `At most ${left} can still be captured.` : "The amount is more than what is left to capture.";
  },
  refund_exceeds_refundable: (body) => {
    const left = amount(body, "refundableFils");
    return left ? `At most ${left} can still be refunded.` : "The amount is more than what is left to refund.";
  },
};

/** Codes whose server `message` names the exact bad row or value in an
 *  uploaded CSV. Those messages are written for people and hold no secrets,
 *  so on the import screen they are added as details. */
const CSV_DETAIL_CODES = new Set(["invalid_csv_row", "invalid_amount"]);

const OVERRIDES: Partial<Record<ErrorContext, Record<string, Message>>> = {
  login: {
    invalid_request: "Enter your email and password.",
    validation_error: "Enter your email and password.",
  },
  otp: {
    invalid_request: "Enter the code we sent you.",
    validation_error: "Enter the code we sent you.",
  },
  adjustmentImport: {
    invalid_amount: "An amount in the file is not valid. Use BD with up to 3 decimals, for example 12.500.",
    invalid_request: "Paste the CSV content before you apply it.",
  },
  credit: {
    invalid_request: "Some of the credit details are not valid. Check them and try again.",
  },
  settlementRun: {
    invalid_request: "Choose a day before today and, if you give one, a valid merchant ID.",
  },
};

function resolve(message: Message, body: ApiErrorBody): string {
  return typeof message === "function" ? message(body) : message;
}

/** Text for anything thrown by `request` (or any other error) — what every
 *  error box in the admin console shows. */
export function errorMessage(err: unknown, context?: ErrorContext): string {
  if (err instanceof NetworkError) return NETWORK_MESSAGE;
  if (!(err instanceof ApiError)) return GENERIC_MESSAGE;

  const message = (context ? OVERRIDES[context]?.[err.code] : undefined) ?? MESSAGES[err.code];
  if (message) {
    const text = resolve(message, err.body);
    const detail = err.body.message;
    if (context === "adjustmentImport" && CSV_DETAIL_CODES.has(err.code) && typeof detail === "string" && detail) {
      return `${text} Details: ${detail}.`;
    }
    return text;
  }

  if (err.code === "unknown_error" && err.statusCode >= 500) return SERVER_DOWN_MESSAGE;
  switch (err.statusCode) {
    case 401:
      return MESSAGES.unauthenticated as string;
    case 403:
      return MESSAGES.forbidden as string;
    case 404:
      return MESSAGES.not_found as string;
    case 408:
    case 504:
      return "This took too long. Please try again.";
    case 409:
      return "This changed while you were working. Refresh the page and try again.";
    case 429:
      return "Too many tries. Please wait a moment and try again.";
    case 503:
      return MESSAGES.server_busy as string;
    default:
      return err.statusCode >= 400 && err.statusCode < 500
        ? "We could not do this. Check the details and try again."
        : GENERIC_MESSAGE;
  }
}

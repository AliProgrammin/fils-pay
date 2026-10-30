import { formatBhd, toFils } from "@filspay/money";
import type { ApiErrorBody } from "./types.js";

/**
 * Every error a person can see in apps/web (merchant dashboard and customer
 * checkout) is turned into text here, and only here. The API's `error` codes
 * (snake_case) and its `message` strings are written for developers, so they
 * are never shown as they are: each code maps to a short plain-English
 * message that says what happened and what to do next.
 */

/** An error answer from the API. Mirrors apps/api's `{ error, message? }`
 *  body (lib/errors.ts / plugins/errorHandler.ts). A few routes answer
 *  `{ ok: false, code }` instead (refund validation), so `code` falls back
 *  to `body.code`. */
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

/** The screen or action an error came from. The same code can need other
 *  words on another screen (e.g. `invalid_amount` on a refund vs. on a new
 *  payment link). */
export type ErrorContext =
  | "login"
  | "otp"
  | "resend"
  | "signOut"
  | "capture"
  | "void"
  | "refund"
  | "paymentLinkCreate"
  | "paymentLinkCancel"
  | "checkoutLoad"
  | "checkoutPay"
  | "webhookCreate"
  | "webhookUpdate"
  | "webhookReplay";

type Message = string | ((body: ApiErrorBody) => string);

export const NETWORK_MESSAGE = "Can't reach FilsPay. Check your connection and try again.";
export const GENERIC_MESSAGE =
  "Something went wrong on our side. Please try again. If it keeps happening, contact FilsPay support.";
const SERVER_DOWN_MESSAGE = "FilsPay is not answering right now. Please try again in a moment.";
const TRY_ANOTHER_CARD = "Try another card, or contact your bank.";

function amount(body: ApiErrorBody, field: string): string | null {
  const value = body[field];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? `${formatBhd(toFils(value))} BD`
    : null;
}

const DECLINE_REASONS: Record<string, string> = {
  insufficient_funds: "There is not enough money on this card.",
  card_expired: "This card has expired.",
  do_not_honor: "Your bank declined this payment.",
  suspected_fraud: "Your bank declined this payment.",
};

function cardDeclined(body: ApiErrorBody): string {
  const reason = typeof body.declineReason === "string" ? DECLINE_REASONS[body.declineReason] : undefined;
  return `${reason ?? "Your card was declined."} ${TRY_ANOTHER_CARD}`;
}

/** The default text for each code the API can send to apps/web. */
const MESSAGES: Record<string, Message> = {
  // Generic
  invalid_request: "Some of the details are not valid. Check them and try again.",
  validation_error: "Some of the details are not valid. Check them and try again.",
  unauthenticated: "Your session has ended. Please sign in again.",
  forbidden: "You don't have permission to do this. Ask the shop owner or a finance user on your account.",
  not_found: "We could not find this. It may have been removed.",
  server_busy: "We're very busy right now. Please try again in a few seconds.",
  internal_error: GENERIC_MESSAGE,
  file_too_large: "This file is too large. Choose a smaller file.",
  invalid_date: "Choose a valid date range.",
  invalid_filter: "These filters are not valid. Clear them and try again.",

  // Sign-in
  invalid_credentials: "The email or password is not correct.",
  merchant_id_required:
    "This email is used by more than one shop. Enter the merchant ID of the shop you want to sign in to.",
  no_pending_session: "Your sign-in has timed out. Please sign in again.",
  otp_expired: "This code has expired. Ask for a new code.",
  invalid_code: "This code is not correct. Check the code and try again.",
  too_many_attempts: "Too many wrong codes. For your safety, please sign in again.",
  resend_too_soon: "Please wait 30 seconds before you ask for a new code.",

  // Repeated or overlapping requests
  idempotency_key_required: "We could not send this request. Refresh the page and try again.",
  idempotency_key_reused: "This request was changed while it was being sent. Refresh the page and try again.",
  request_in_progress: "This request is already being processed. Please wait a moment.",

  // Payments
  transaction_not_found: "We could not find this payment on your account.",
  invalid_amount: "Enter an amount greater than 0.",
  not_capturable: "This payment can no longer be captured. Refresh the page to see its latest status.",
  not_voidable: "This payment can no longer be voided. Refresh the page to see its latest status.",
  capture_exceeds_remaining: (body) => {
    const left = amount(body, "remainingFils");
    return left
      ? `You can capture at most ${left} on this payment.`
      : "The amount is more than what is left to capture on this payment.";
  },
  card_declined: cardDeclined,
  card_captured_declined: "The bank did not complete this payment. No money was taken.",
  acquirer_unavailable: "The card network is not answering right now. No money was taken. Please try again.",
  merchant_not_approved: "This shop can't take payments yet. Its account is still being checked.",
  test_mode_merchant: "This shop is in test mode and can't take real payments.",

  // Refunds
  refund_exceeds_refundable: (body) => {
    const left = amount(body, "refundableFils");
    return left
      ? `The amount is more than what is left to refund. You can refund up to ${left}.`
      : "The amount is more than what is left to refund.";
  },
  refund_amount_invalid: "Enter a refund amount greater than 0.",
  transaction_not_refundable: "This payment can't be refunded. Only captured payments can be refunded.",
  refund_declined: "The bank did not accept this refund. No money was moved. Please try again later.",
  refunds_not_enabled: "Refunds are turned off for your shop. Contact FilsPay support to turn them on.",
  reason_required: "Enter a reason for the refund (up to 500 characters).",

  // Payment links
  payment_link_not_found: "This payment link does not exist. Check the link, or ask the shop for a new one.",
  payment_link_expired: "This payment link has expired. Ask the shop to send you a new one.",
  payment_link_already_paid: "This payment link has already been paid.",
  payment_link_canceled: "This payment link has been canceled. Ask the shop for a new one.",
  payment_link_processing: "A payment for this link is already in progress. Please wait a moment, then refresh the page.",
  payment_link_not_payable: "This payment link can't be paid now. Refresh the page to see its latest status.",
  not_cancelable: "This payment link can't be canceled. It is already paid, canceled or being paid.",
  invalid_expiry: "Choose an expiry date and time in the future.",

  // Webhooks
  invalid_url: "Enter a full web address that starts with https://",
  webhook_endpoint_not_found: "We could not find this webhook address. It may have been deleted.",
  webhook_delivery_not_found: "We could not find this delivery. Refresh the page and try again.",
  endpoint_disabled: "This webhook address is turned off. Turn it on before you send deliveries again.",

  // Payouts
  settlement_batch_not_found: "We could not find this payout.",
};

/** Words that differ by screen. Checked before MESSAGES. */
const OVERRIDES: Partial<Record<ErrorContext, Record<string, Message>>> = {
  login: {
    invalid_request: "Enter your email and password.",
    validation_error: "Enter your email and password.",
  },
  otp: {
    invalid_request: "Enter the code we sent you.",
    validation_error: "Enter the code we sent you.",
  },
  capture: {
    invalid_amount: "Enter the amount to capture in fils, greater than 0, or leave it blank to capture all.",
  },
  refund: {
    invalid_amount: "Enter a refund amount greater than 0.",
    forbidden: "You don't have permission to refund. Ask the shop owner or a finance user on your account.",
  },
  paymentLinkCreate: {
    invalid_amount: "Enter an amount greater than 0, for example 12.750.",
    invalid_request: "Enter an amount and an expiry date.",
  },
  checkoutLoad: {
    not_found: MESSAGES.payment_link_not_found!,
    invalid_request: MESSAGES.payment_link_not_found!,
    validation_error: MESSAGES.payment_link_not_found!,
  },
  checkoutPay: {
    invalid_request: "Check your card details and try again.",
    validation_error: "Check your card details and try again.",
    card_captured_declined: `The bank did not complete this payment. No money was taken. ${TRY_ANOTHER_CARD}`,
  },
  webhookCreate: {
    invalid_request: "Enter the web address that should receive webhook events.",
  },
};

function resolve(message: Message, body: ApiErrorBody): string {
  return typeof message === "function" ? message(body) : message;
}

/** Text for anything thrown by `request` (or any other error) — what every
 *  error box in apps/web shows. Never returns a code, a status number or a
 *  server message. */
export function errorMessage(err: unknown, context?: ErrorContext): string {
  if (err instanceof NetworkError) return NETWORK_MESSAGE;
  if (!(err instanceof ApiError)) return GENERIC_MESSAGE;

  const override = context ? OVERRIDES[context]?.[err.code] : undefined;
  if (override) return resolve(override, err.body);
  const known = MESSAGES[err.code];
  if (known) return resolve(known, err.body);

  // A code this map does not know: fall back by HTTP status.
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

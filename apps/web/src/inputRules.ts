import { formatBhd, parseBhdToFils, toFils } from "@filspay/money";
import { bhd } from "./format.js";

/**
 * Typing filters and checks for the dashboard's form fields. Pure (no React),
 * so they run under plain `tsx --test`. They catch wrong shapes before a
 * round trip; the API still decides, and its answer is still shown.
 */

/** Most whole-BD digits an amount box takes: 999,999,999.999 BD. */
export const AMOUNT_MAX_WHOLE_DIGITS = 9;

/** Limits the API enforces (apps/api/src/routes/refunds.ts). */
export const REFUND_REASON_MAX = 500;
/** No API limit; kept short because checkout and receipts show them. */
export const LINK_REFERENCE_MAX = 100;
export const LINK_DESCRIPTION_MAX = 200;
/** A URL longer than this is a mistake, not an endpoint. */
export const WEBHOOK_URL_MAX = 2048;
export const SEARCH_MAX = 100;
export const EMAIL_MAX = 254;
/** The API's default OTP_CODE_LENGTH (apps/api/src/config.ts). */
export const OTP_LENGTH = 6;
/** The API's default KYC_MAX_FILE_SIZE_BYTES (8 MiB, apps/api/src/config.ts).
 *  A larger file is refused here before the upload starts; the API's own
 *  `413 file_too_large` is still the real answer. */
export const KYC_MAX_FILE_BYTES = 8_388_608;
export const KYC_MAX_FILE_MB = KYC_MAX_FILE_BYTES / 1_048_576;

/**
 * What the amount box keeps of what was typed or pasted: digits and one dot,
 * at most 9 whole digits, and a leading minus only when the
 * field allows negatives. Spaces, commas, letters and "BD" are dropped.
 */
export function filterAmountInput(raw: string, opts: { allowNegative?: boolean } = {}): string {
  const negative = opts.allowNegative === true && raw.trim().startsWith("-");
  const kept = raw.replace(/[^\d.]/g, "");
  const dot = kept.indexOf(".");
  const whole = (dot === -1 ? kept : kept.slice(0, dot)).slice(0, AMOUNT_MAX_WHOLE_DIGITS);
  const fraction = dot === -1 ? null : kept.slice(dot + 1).replace(/\./g, "");
  return `${negative ? "-" : ""}${whole}${fraction === null ? "" : `.${fraction}`}`;
}

export type AmountCheck = { ok: true; fils: number } | { ok: false; message: string };

export interface AmountRules {
  /** Largest allowed amount in fils, shown in the message. */
  maxFils?: number;
  /** Negatives allowed (then only 0 is refused). */
  allowNegative?: boolean;
  /** Example shown in the "wrong shape" message. */
  example?: string;
}

/** Turns "12.", ".5" and "-.5" into text parseBhdToFils reads. */
function normaliseAmount(text: string): string {
  let t = text.trim();
  if (t.endsWith(".")) t = t.slice(0, -1);
  return t.replace(/^(-?)\./, "$10.");
}

/** Parses BD text to exact fils and checks it against the field's rules. */
export function checkAmount(text: string, rules: AmountRules = {}): AmountCheck {
  const example = rules.example ?? "12.750";
  const t = normaliseAmount(text);
  if (t === "" || t === "-") return { ok: false, message: "Enter an amount in BD" };
  if (!rules.allowNegative && t.startsWith("-")) {
    return { ok: false, message: "The amount cannot be negative" };
  }
  // Never cut a 4th decimal: 1.2345 BD is refused, not sent as 1.234 BD.
  if (/\.\d{4,}$/.test(t)) {
    return { ok: false, message: "BD amounts have at most 3 decimals (1 BD = 1000 fils)" };
  }
  let fils: number;
  try {
    fils = parseBhdToFils(t);
  } catch {
    return { ok: false, message: `Enter an amount in BD with up to 3 decimals, for example ${example}` };
  }
  if (rules.allowNegative ? fils === 0 : fils <= 0) {
    return { ok: false, message: rules.allowNegative ? "The amount must not be 0" : "The amount must be more than 0" };
  }
  if (rules.maxFils !== undefined && fils > rules.maxFils) {
    return { ok: false, message: `The most you can enter is ${bhd(rules.maxFils)}` };
  }
  return { ok: true, fils };
}

/** On blur: "12.5" -> "12.500". Text that does not parse is left as typed. */
export function formatAmountText(text: string): string {
  const t = normaliseAmount(text);
  try {
    return formatBhd(toFils(parseBhdToFils(t), { allowNegative: true }));
  } catch {
    return text;
  }
}

/** Digits only, cut to `max` (OTP codes; pasted "123 456" becomes "123456"). */
export function digitsOnly(raw: string, max: number): string {
  return raw.replace(/\D/g, "").slice(0, max);
}

/** Null when the code has exactly `length` digits. */
export function checkOtp(code: string, length: number = OTP_LENGTH): string | null {
  return new RegExp(`^\\d{${length}}$`).test(code) ? null : `Enter the ${length}-digit code`;
}

/** The API's new-password rules (apps/api/src/auth/passwords.ts). */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/** Null when `next` may be the new password: 12 to 128 characters, not the
 *  current one, and typed the same twice. Counts characters, not bytes. */
export function checkNewPassword(next: string, confirm: string, current: string): string | null {
  const length = [...next].length;
  if (length === 0) return "Enter a new password";
  if (length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters`;
  if (length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters`;
  if (next === current) return "Choose a password that is different from your current one";
  if (next !== confirm) return "The two new passwords do not match";
  return null;
}

/** Null when the text looks like an email address. */
export function checkEmail(text: string): string | null {
  const t = text.trim();
  if (t === "") return "Enter your email address";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? null : "Enter an email address like name@shop.com";
}

/** Null when the text is a full https:// URL with a host. */
export function checkHttpsUrl(text: string): string | null {
  const t = text.trim();
  if (t === "") return "Enter the endpoint URL";
  if (/^http:\/\//i.test(t)) return "Use https://. Plain http:// is not secure for webhooks";
  if (!/^https:\/\//i.test(t)) return "The URL must start with https://";
  try {
    const url = new URL(t);
    const host = url.hostname;
    if (host !== "localhost" && !host.includes(".")) {
      return "Enter a full URL, for example https://example.com/filspay/webhooks";
    }
  } catch {
    return "Enter a full URL, for example https://example.com/filspay/webhooks";
  }
  if (t.length > WEBHOOK_URL_MAX) return `The URL is too long (at most ${WEBHOOK_URL_MAX} characters)`;
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a merchant ID box keeps: hex digits and dashes, 36 at most. */
export function filterUuidInput(raw: string): string {
  return raw.replace(/[^0-9a-fA-F-]/g, "").slice(0, 36);
}

/** True when the text is a UUID (the shape of every record id). */
export function isUuid(text: string): boolean {
  return UUID_RE.test(text);
}

/** Null when the text is a merchant ID (a UUID). */
export function checkUuid(text: string): string | null {
  return UUID_RE.test(text.trim())
    ? null
    : "A merchant ID has 36 characters, like 3f2a9c1e-0b4d-4e8a-9c2f-1a2b3c4d5e6f";
}

/** A short note once a text field is close to its limit, else null. */
export function lengthNote(value: string, max: number): string | null {
  if (value.length >= max) return `You reached the limit of ${max} characters`;
  if (value.length >= Math.floor(max * 0.9)) return `${max - value.length} characters left`;
  return null;
}

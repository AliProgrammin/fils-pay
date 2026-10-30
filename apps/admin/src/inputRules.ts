import { formatBhd, parseBhdToFils, toFils } from "@filspay/money";
import { bhd } from "./format.js";

/**
 * Typing filters and checks for the console's form fields. Pure (no React),
 * so they run under plain `tsx --test`. They catch wrong shapes before a
 * round trip; the API still decides, and its answer is still shown.
 */

/** Most whole-BD digits an amount box takes: 999,999,999.999 BD. */
export const AMOUNT_MAX_WHOLE_DIGITS = 9;

/** The API's limit on a credit memo (admin/creditRequestValidation.ts). */
export const CREDIT_MEMO_MAX = 500;
/** No API limit on these; the same 500 as the memo and the refund reason. */
export const ADJUST_REASON_MAX = 500;
export const REJECT_REASON_MAX = 500;
export const KYC_NOTES_MAX = 1000;
export const KEY_LABEL_MAX = 100;
export const FILENAME_MAX = 255;
export const SEARCH_MAX = 100;
export const EMAIL_MAX = 254;
/** The API's default ADMIN_OTP_CODE_LENGTH (apps/api/src/config.ts). */
export const OTP_LENGTH = 6;

/**
 * What an amount box keeps of what was typed or pasted: digits and one dot,
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
  maxFils?: number;
  /** Negatives allowed (then only 0 is refused). */
  allowNegative?: boolean;
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
  const example = rules.example ?? (rules.allowNegative ? "50.000 or -12.500" : "50.000");
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
  if (rules.maxFils !== undefined && Math.abs(fils) > rules.maxFils) {
    return { ok: false, message: `The most you can enter is ${bhd(rules.maxFils)}` };
  }
  return { ok: true, fils };
}

/** On blur: "12.5" -> "12.500". Text that does not parse is left as typed. */
export function formatAmountText(text: string): string {
  try {
    return formatBhd(toFils(parseBhdToFils(normaliseAmount(text)), { allowNegative: true }));
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

/** Null when the text looks like an email address. */
export function checkEmail(text: string): string | null {
  const t = text.trim();
  if (t === "") return "Enter your email address";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? null : "Enter an email address like name@filspay.com";
}

/** The API's merchant id shape (admin/merchants.ts UUID_RE). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a merchant id box keeps: hex digits and dashes, 36 at most. */
export function filterUuidInput(raw: string): string {
  return raw.replace(/[^0-9a-fA-F-]/g, "").slice(0, 36);
}

/** True when the text is a UUID (the shape of every record id). */
export function isUuid(text: string): boolean {
  return UUID_RE.test(text);
}

/** Null when the text is a merchant id (a UUID). */
export function checkUuid(text: string): string | null {
  return UUID_RE.test(text.trim())
    ? null
    : "A merchant id has 36 characters, like 3f2a9c1e-0b4d-4e8a-9c2f-1a2b3c4d5e6f";
}

/** A short note once a text field is close to its limit, else null. */
export function lengthNote(value: string, max: number): string | null {
  if (value.length >= max) return `You reached the limit of ${max} characters`;
  if (value.length >= Math.floor(max * 0.9)) return `${max - value.length} characters left`;
  return null;
}

export interface CsvCheck {
  /** Data rows read (header excluded). */
  rowCount: number;
  /** Sum of the rows that parsed, in fils. */
  totalFils: number;
  /** One plain message per problem, with its line number. Empty = send it. */
  problems: string[];
}

/** Most problems listed; the rest are counted. */
const MAX_LISTED_PROBLEMS = 10;

/**
 * The same reading of an adjustment CSV as the API
 * (admin/adjustmentCsvParsing.ts + the route's UUID check), done before the
 * paste is sent, so every bad line is named at once. It also flags what the
 * API would take silently: a 4th column (a comma in a reason cuts it) and a
 * 0 amount (a row that posts nothing).
 */
export function checkAdjustmentCsv(content: string): CsvCheck {
  const lines = content
    .split(/\r?\n/)
    .map((line, index) => ({ text: line.trim(), number: index + 1 }))
    .filter((line) => line.text !== "");
  const problems: string[] = [];
  let totalFils = 0;
  if (lines.length === 0) return { rowCount: 0, totalFils, problems: ["Paste the CSV: a header line and at least one row"] };

  const header = lines[0]!.text.split(",").map((cell) => cell.trim().toLowerCase());
  if (header[0] !== "merchantid" || header[1] !== "amount") {
    problems.push(`Line ${lines[0]!.number}: the first line must be the header merchantId,amount,reason`);
  }
  const rows = lines.slice(1);
  if (rows.length === 0) problems.push("Add at least one row under the header");

  for (const row of rows) {
    const cells = row.text.split(",").map((cell) => cell.trim());
    const where = `Line ${row.number}`;
    const [merchantId = "", amount = ""] = cells;
    if (merchantId === "" || amount === "") {
      problems.push(`${where}: a merchant id and an amount are required`);
      continue;
    }
    if (!UUID_RE.test(merchantId)) problems.push(`${where}: "${merchantId}" is not a merchant id`);
    if (cells.length > 3) problems.push(`${where}: more than 3 columns. A reason cannot contain a comma`);
    try {
      const fils = parseBhdToFils(amount);
      if (fils === 0) problems.push(`${where}: the amount is 0`);
      totalFils += fils;
    } catch {
      problems.push(`${where}: "${amount}" is not a BD amount with up to 3 decimals`);
    }
  }

  if (problems.length > MAX_LISTED_PROBLEMS) {
    const more = problems.length - MAX_LISTED_PROBLEMS;
    problems.splice(MAX_LISTED_PROBLEMS, more, `and ${more} more problem${more === 1 ? "" : "s"}`);
  }
  return { rowCount: rows.length, totalFils, problems };
}

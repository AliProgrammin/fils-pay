/**
 * Client-side card checks for the checkout form. Pure (no React), so it runs
 * under plain `tsx --test`. They only catch obvious typing mistakes before a
 * round trip; the server and the bank still decide. The request body is sent
 * exactly as typed.
 */

export interface CardFields {
  pan: string;
  expiryMonth: number;
  expiryYear: number;
  cvv: string;
}

export type CardErrors = Partial<Record<"pan" | "expiry" | "cvv", string>>;

export const PAN_MESSAGE = "Check the card number";
export const EXPIRED_MESSAGE = "This card has expired";
export const EXPIRY_MESSAGE = "Enter the expiry month (1–12) and a 4-digit year";
export const CVV_MESSAGE = "The CVV must be 3 or 4 digits";

/** The Luhn (mod 10) check every real card number passes. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** The current year and month (1–12) in Asia/Bahrain (UTC+3, no DST). */
export function bahrainYearMonth(now: Date = new Date()): { year: number; month: number } {
  const bahrain = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return { year: bahrain.getUTCFullYear(), month: bahrain.getUTCMonth() + 1 };
}

/** Field errors for the card form; an empty object means "send it". A card
 *  is valid through the end of its expiry month. */
export function validateCard(card: CardFields, now: Date = new Date()): CardErrors {
  const errors: CardErrors = {};

  const pan = card.pan.trim();
  const digits = pan.replace(/[\s-]/g, "");
  if (!/^[\d\s-]+$/.test(pan) || digits.length < 12 || digits.length > 19 || !luhnValid(digits)) {
    errors.pan = PAN_MESSAGE;
  }

  const { expiryMonth: month, expiryYear: year } = card;
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 1000 || year > 9999) {
    errors.expiry = EXPIRY_MESSAGE;
  } else {
    const current = bahrainYearMonth(now);
    if (year < current.year || (year === current.year && month < current.month)) errors.expiry = EXPIRED_MESSAGE;
  }

  if (!/^\d{3,4}$/.test(card.cvv.trim())) errors.cvv = CVV_MESSAGE;

  return errors;
}

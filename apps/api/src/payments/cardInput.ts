import type { SimulatedCardInput } from "../acquirer/types.js";
import { BadRequestError } from "../lib/errors.js";

/** Luhn (mod 10) check over a string of digits. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Rejects card input no acquirer would accept as a card: a card number that
 * is not 12-19 digits (spaces allowed) or fails the Luhn check, an expiry
 * month that is not an integer 1-12, an expiry year that is not an integer,
 * or a CVV that is not 3-4 digits. Malformed input, so 400 invalid_request,
 * like the routes' other card checks. Whether the card has expired is the
 * bank's decision: the acquirer declines it (card_expired).
 */
export function assertValidCardInput(card: SimulatedCardInput): void {
  const digits = typeof card.pan === "string" ? card.pan.replace(/ /g, "") : "";
  if (!/^\d{12,19}$/.test(digits) || !passesLuhn(digits)) {
    throw new BadRequestError("invalid_request", "card.pan is not a valid card number");
  }
  if (!Number.isInteger(card.expiryMonth) || card.expiryMonth < 1 || card.expiryMonth > 12) {
    throw new BadRequestError("invalid_request", "card.expiryMonth must be an integer from 1 to 12");
  }
  if (!Number.isInteger(card.expiryYear)) {
    throw new BadRequestError("invalid_request", "card.expiryYear must be an integer");
  }
  if (typeof card.cvv !== "string" || !/^\d{3,4}$/.test(card.cvv)) {
    throw new BadRequestError("invalid_request", "card.cvv must be 3 or 4 digits");
  }
}

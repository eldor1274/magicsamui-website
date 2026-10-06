// Classifies checkout refusals for the booking page. Isomorphic.

/**
 * True for a refusal caused by a Cloudbeds stay rule (Stripe hold-first:
 * minimum/maximum stay, closed to arrival/departure) rather than a sale, so
 * the page can say which rule applies instead of "no longer available".
 * Kept in step with RESTRICTION_MESSAGES in stripeCheckout.ts (tested).
 */
export function isRestrictionMessage(message: string | undefined): boolean {
  return typeof message === "string" && /minimum stay of \d+|at most \d+ nights|can't be booked with (arrival|departure)/.test(message);
}

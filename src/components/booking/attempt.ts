// The last Stripe checkout attempt started in this tab: its booking ref and
// signed link token (no personal data - the token carries the booking facts
// and the Checkout Session id, signed by our server).
//
// Why: Stripe holds the room in Cloudbeds while the guest is on Checkout. If
// the guest comes back with the browser's Back button (not Stripe's own back
// link) and presses Pay again, the old hold would still block the room. So
// before a NEW checkout the booking page asks /api/booking/abandon about the
// previous attempt: "paid"/"pending" -> show its return page (never charge
// twice); otherwise the old session is expired and its hold released first.

import { isBookingRef } from "@/lib/booking/ref";

const KEY = "msv_booking_attempt_v1";

export interface CheckoutAttempt {
  ref: string;
  /** Signed link token (a valid booking token that also carries the session id). */
  token: string;
  /** When the checkout was started (ms since epoch; 0 when unknown). */
  startedAt: number;
}

/**
 * How long an attempt's Checkout Session can still be paid: Stripe's 30-minute
 * session lifetime plus a margin (the server adds a minute for clock skew).
 * After this the session is expired at Stripe whatever we were able to do.
 */
export const ATTEMPT_PAYABLE_MS = 33 * 60_000;

/** True while the attempt's session might still be paid (so a second payable session must not be opened). */
export function attemptMayStillBePaid(attempt: CheckoutAttempt, nowMs: number): boolean {
  return attempt.startedAt > 0 && nowMs - attempt.startedAt < ATTEMPT_PAYABLE_MS;
}

export function rememberAttempt(attempt: CheckoutAttempt): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(attempt));
  } catch {
    // storage blocked: Stripe's 30-minute expiry still releases the hold
  }
}

export function readAttempt(): CheckoutAttempt | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<CheckoutAttempt>;
    if (!isBookingRef(v.ref) || typeof v.token !== "string" || v.token.length === 0 || v.token.length > 4096) return null;
    const startedAt = typeof v.startedAt === "number" && Number.isFinite(v.startedAt) && v.startedAt > 0 ? v.startedAt : 0;
    return { ref: v.ref, token: v.token, startedAt };
  } catch {
    return null;
  }
}

/** Forget the attempt (only when it is for `ref`, so a newer attempt is never dropped by an old answer). */
export function clearAttempt(ref: string): void {
  try {
    const current = readAttempt();
    if (!current || current.ref === ref) sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

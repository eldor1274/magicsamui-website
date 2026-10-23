// The last hold-first checkout attempt (Stripe, or a hold-first Beam mode) started in this tab: its booking ref
// and signed link token (no personal data - the token carries the booking facts and the payment id: the Checkout
// Session or the Beam link, signed by our server).
//
// Why: the payment page holds the room in Cloudbeds while the guest is on it. If the guest comes back with the
// browser's Back button (not the payment page's own back or Cancel link) and presses Pay again, the old hold would
// still block the room. So before a NEW checkout the booking page asks /api/booking/abandon about the previous
// attempt: "paid"/"pending" -> show its return page (never charge twice); otherwise the old payment page is closed
// and its hold released first. The rules (which pages track attempts, how long one may still be paid) are in
// lib/booking/checkoutAttempt.ts (Beam design S5.1).

import { parseAttempt } from "@/lib/booking/checkoutAttempt";
import type { CheckoutAttempt } from "@/lib/booking/checkoutAttempt";

export type { CheckoutAttempt } from "@/lib/booking/checkoutAttempt";
export { attemptMayStillBePaid } from "@/lib/booking/checkoutAttempt";

const KEY = "msv_booking_attempt_v1";

export function rememberAttempt(attempt: CheckoutAttempt): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(attempt));
  } catch {
    // storage blocked: the payment page's 30-minute expiry still releases the hold
  }
}

export function readAttempt(): CheckoutAttempt | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    // lib/booking/checkoutAttempt.ts parseAttempt: the same checks as always, plus a Beam attempt's own window (round 7).
    return parseAttempt(JSON.parse(raw));
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

// The booking page's checkout attempts (Beam design S5.1): which pages track the attempt they start, how long its
// payment may still succeed, what an abandon answer means for it, and the payment page's cancel landing. Pure and
// isomorphic, so node --test covers the rules; components/booking/attempt.ts keeps the attempt in sessionStorage,
// and BookingApp.tsx and OwnBookingPage.tsx apply these.
//
// Why: a hold-first checkout holds the room in Cloudbeds while the guest is on the payment page. Before a NEW
// checkout the page asks /api/booking/abandon about the previous attempt: "paid"/"pending" -> its return page
// (never charge twice); otherwise the old page is closed and its hold released first. Stripe's rules are exactly
// as before; the hold-first Beam modes follow them with Beam's longer payable window.

import { isHoldFirstMode, providerOf } from "./payments/provider.ts";
import { isBookingRef } from "./ref.ts";
import type { AbandonResponse, CheckoutSuccess, PaymentMode, PaymentProvider, PublicBookingConfig } from "./types.ts";

/** The last hold-first checkout attempt started in a tab: its booking ref and signed link token (no personal data). */
export interface CheckoutAttempt {
  ref: string;
  /** Signed link token (a valid booking token that also carries the payment id: the Checkout Session or the Beam link). */
  token: string;
  /** When the checkout was started (ms since epoch; 0 when unknown). */
  startedAt: number;
}

/**
 * Stripe's payable window: its 30-minute Checkout Session plus a margin (the server adds a minute for clock skew).
 * After it the session is expired at Stripe whatever we were able to do. Also the window of a page whose config
 * carries no attemptPayableMinutes (every Stripe and demo config).
 */
export const DEFAULT_ATTEMPT_PAYABLE_MINUTES = 33;

/** A Beam page or answer in a hold-first Beam mode (beam-playground, beam-live: isHoldFirstMode, design S4.6). */
function beamHoldFirst(provider: PaymentProvider, mode: PaymentMode): boolean {
  return provider === "beam" && providerOf(mode) === "beam" && isHoldFirstMode(mode);
}

/**
 * Whether the page tracks its checkout attempts (releases the earlier attempt before a new Pay, releases the
 * payment page's cancel landing at once, and words a cancelled landing as "the room is no longer held"): every
 * Stripe page as before (provider stripe, a locked Stripe page included) and the hold-first Beam modes
 * (beam-playground, beam-live). Never the demo - BOOKING_PAYMENT_PROVIDER=beam without Beam keys included - and
 * not a locked Beam page (its paymentMode is the demo's: its holds are left to the link expiry and the sweeper).
 */
export function tracksAttempts(cfg: Pick<PublicBookingConfig, "provider" | "paymentMode">): boolean {
  return cfg.provider === "stripe" || beamHoldFirst(cfg.provider, cfg.paymentMode);
}

/**
 * How long after it started an attempt's payment may still succeed, in ms: the config's attemptPayableMinutes
 * (Beam: the link's 30 minutes + BEAM_PENDING_GRACE_MINUTES + 3 = 53 by default), else Stripe's 33 minutes.
 */
export function attemptPayableMs(cfg: Pick<PublicBookingConfig, "attemptPayableMinutes">): number {
  const m = cfg.attemptPayableMinutes;
  return (typeof m === "number" && Number.isFinite(m) && m > 0 ? m : DEFAULT_ATTEMPT_PAYABLE_MINUTES) * 60_000;
}

/**
 * True while the attempt's payment might still succeed, so a second payable page must not be opened (a guest paying
 * both would be charged twice). An attempt whose start is unknown (0) never blocks. `payableMs`: attemptPayableMs
 * of the page's config (Stripe's 33 minutes when left out).
 */
export function attemptMayStillBePaid(attempt: Pick<CheckoutAttempt, "startedAt">, nowMs: number, payableMs: number = DEFAULT_ATTEMPT_PAYABLE_MINUTES * 60_000): boolean {
  return attempt.startedAt > 0 && nowMs - attempt.startedAt < payableMs;
}

/**
 * The attempt a successful checkout starts, remembered before the redirect: a Stripe checkout's as before, and a
 * hold-first Beam checkout's (its link token carries the Beam link id). null without a link token (the demo).
 */
export function attemptOf(res: Pick<CheckoutSuccess, "ref" | "linkToken" | "provider" | "paymentMode">, nowMs: number): CheckoutAttempt | null {
  if (!res.linkToken) return null;
  if (res.provider === "stripe" || beamHoldFirst(res.provider, res.paymentMode)) {
    return { ref: res.ref, token: res.linkToken, startedAt: nowMs };
  }
  return null;
}

/**
 * What an abandon answer means for the earlier attempt. "return-page": it was paid, or is still being paid - an
 * unconfirmed Beam payment and a released Beam hold included (abandon answers "pending") - so the guest goes to its
 * return page and never pays twice. "forget": released, already closed or not this provider's: drop it. "error": it
 * could not be checked: keep it (the next Pay asks again; the payment page's expiry and the sweeper release the hold).
 */
export function abandonVerdict(res: AbandonResponse): "return-page" | "forget" | "error" {
  if (res.ok && (res.state === "paid" || res.state === "pending")) return "return-page";
  return res.ok ? "forget" : "error";
}

/**
 * The payment page's cancel landing (Stripe's cancel_url, Beam's cancelUrl: ?resume=payment&reason=cancelled&ref&t)
 * on a page that tracks attempts: the attempt to release at once (POST /api/booking/abandon) before Pay is allowed
 * again, else null. Stripe's rule is unchanged: any resume=payment with a booking ref and a token of at most 4096
 * characters.
 */
export function cancelledAttemptOf(
  cfg: Pick<PublicBookingConfig, "provider" | "paymentMode">,
  landing: { resume: string | null | undefined; ref: string | undefined; t: string | undefined },
): { ref: string; t: string } | null {
  const { ref, t } = landing;
  return landing.resume === "payment" && tracksAttempts(cfg) && isBookingRef(ref) && t && t.length <= 4096 ? { ref, t } : null;
}

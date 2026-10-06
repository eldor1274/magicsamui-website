// POST /api/booking/abandon (WI-7 server side). The guest came back from
// Stripe Checkout via its back link (cancel_url) or pressed Cancel on our
// page: expire the Checkout Session so it can never be paid afterwards, then
// release the Cloudbeds hold so the unit is back on sale within a minute
// (instead of waiting for Stripe's 30-minute expiry). A paid session is never
// cancelled - it is fulfilled instead.

import { redactForLog } from "./cloudbedsWrite.ts";
import type { BookingConfig } from "./config.ts";
import { abandonSession, bookingPointer } from "./fulfil.ts";
import { isSessionId } from "./payments/stripe.ts";
import { providerOf } from "./payments/provider.ts";
import type { StripeDeps } from "./stripeDeps.ts";
import { verifyBookingToken } from "./token.ts";
import type { AbandonResponse } from "./types.ts";

export interface AbandonDeps {
  config: BookingConfig;
  stripe?: StripeDeps | null;
  /** Drain: Stripe deps for bookings started before the provider was switched away from stripe. */
  stripeDrain?: () => StripeDeps | null;
  nowMs?: number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface AbandonResult {
  status: number;
  body: AbandonResponse;
}

export async function runAbandon(raw: unknown, deps: AbandonDeps): Promise<AbandonResult> {
  const nowMs = deps.nowMs ?? Date.now();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { status: 400, body: { ok: false, error: "invalid_request", message: "Invalid request." } };
  }
  const body = raw as Record<string, unknown>;
  const verified = verifyBookingToken(body.t, deps.config.tokenSecret, nowMs);
  if (!verified.ok) return { status: 400, body: { ok: false, error: "invalid_token", message: "This booking link is not valid." } };
  const booking = verified.payload.booking;
  let sd = deps.stripe ?? null;
  let config = deps.config;
  if (providerOf(booking.paymentMode) === "stripe" && booking.paymentMode !== config.paymentMode && deps.stripeDrain) {
    const drain = deps.stripeDrain();
    if (drain && drain.config.paymentMode === booking.paymentMode) {
      sd = drain;
      config = drain.config;
    }
  }
  if (providerOf(config.paymentMode) !== "stripe" || booking.paymentMode !== config.paymentMode) {
    return { status: 200, body: { ok: true, state: "not_applicable" } };
  }
  if (!sd) return { status: 503, body: { ok: false, error: "payment_unavailable", message: "Please try again in a moment." } };

  let sessionId: string | null = isSessionId(body.s) ? body.s : null;
  if (!sessionId && typeof body.l === "string") {
    const link = verifyBookingToken(body.l, config.tokenSecret, nowMs);
    if (link.ok && link.payload.booking.ref === booking.ref && isSessionId(link.payload.paymentLinkId)) sessionId = link.payload.paymentLinkId;
  }
  try {
    if (!sessionId) sessionId = (await bookingPointer(sd, booking.ref))?.sessionId ?? null;
    if (!sessionId) return { status: 200, body: { ok: true, state: "closed" } };
    const outcome = await abandonSession(sessionId, sd, booking.ref);
    deps.log?.("booking_abandoned", { ref: booking.ref, state: outcome.state });
    return { status: 200, body: { ok: true, state: outcome.state } };
  } catch (e) {
    deps.log?.("booking_abandon_failed", { ref: booking.ref, error: redactForLog(e instanceof Error ? e.message : String(e)) });
    // The hold is still released by Stripe's expiry webhook or the sweeper.
    return { status: 502, body: { ok: false, error: "upstream_error", message: "We couldn't cancel the payment just now - it will expire on its own within 30 minutes." } };
  }
}

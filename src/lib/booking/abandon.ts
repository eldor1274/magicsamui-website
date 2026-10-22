// POST /api/booking/abandon (WI-7 server side). The guest came back from the
// payment page (Stripe Checkout) via its back link (cancel_url) or pressed
// Cancel on our page: cancel the payment page (Stripe: expire the Checkout
// Session) so it can never be paid afterwards, then release the Cloudbeds hold
// so the unit is back on sale within a minute (instead of waiting for the
// provider's 30-minute expiry). A paid payment is never cancelled - it is
// fulfilled instead. The deps and gateway are picked by the BOOKING's
// provider (deps.providerDeps: the active config's, or that provider's drain).

import { redactForLog } from "./cloudbedsWrite.ts";
import type { BookingConfig } from "./config.ts";
import { abandonPayment, bookingPointer } from "./fulfil.ts";
import type { FulfilDone } from "./fulfil.ts";
import { keys, readJson } from "./lock.ts";
import { holdFirstProvider, providerDepsOf, requestPaymentKey } from "./providerDispatch.ts";
import { isPayMethod } from "./quote.ts";
import type { CoreDeps, ProviderDeps, ProviderDepsFn, StripeDeps } from "./stripeDeps.ts";
import { verifyBookingToken } from "./token.ts";
import type { AbandonResponse } from "./types.ts";

export interface AbandonDeps {
  config: BookingConfig;
  /** The deps and gateway that finish a provider's payments (see StatusDeps.providerDeps); the routes pass runtime.ts providerDepsFor(config). */
  providerDeps?: ProviderDepsFn;
  /** Stripe shorthand, used only without providerDeps: the active config's Stripe deps. */
  stripe?: StripeDeps | null;
  /** Stripe shorthand, used only without providerDeps. Drain: Stripe deps for bookings started before the provider was switched away from stripe. */
  stripeDrain?: () => StripeDeps | null;
  nowMs?: number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface AbandonResult {
  status: number;
  body: AbandonResponse;
}

/**
 * Beam only (round 6, status-cost hardening): a booking already finished or released needs no Beam call and no
 * disable. Its done marker (this booking's) answers "paid": the return page shows the marker's state. Its hold's
 * release marker (the pointer's reservation, for this very payment) answers "pending": the guest goes to the return
 * page, which reads the link once and tells "expired" (Try again) from "still being confirmed" (never pay twice) -
 * abandon can't tell them apart without that reading. null: ask Beam as before.
 */
async function settledBeamBooking(deps: CoreDeps, key: string, ref: string): Promise<{ state: "paid" | "pending"; by: "done" | "released" } | null> {
  const done = await readJson<FulfilDone>(deps.kv, keys.fulfilDone(key));
  if (done) return done.ref === ref ? { state: "paid", by: "done" } : null;
  const pointer = await bookingPointer(deps, ref);
  if (pointer && pointer.sessionId === key && (await deps.kv.get(keys.releaseDone(pointer.reservationId))) !== null) return { state: "pending", by: "released" };
  return null;
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
  const providerDeps = providerDepsOf(deps);
  let drained: ProviderDeps | null = null;
  let config = deps.config;
  const bookingProvider = holdFirstProvider(booking.paymentMode);
  if (bookingProvider && booking.paymentMode !== config.paymentMode) {
    const drain = providerDeps(bookingProvider);
    if (drain && drain.deps.config.paymentMode === booking.paymentMode) {
      drained = drain;
      config = drain.deps.config;
    }
  }
  const provider = holdFirstProvider(config.paymentMode);
  if (!provider || booking.paymentMode !== config.paymentMode) {
    return { status: 200, body: { ok: true, state: "not_applicable" } };
  }
  const pd = drained ?? providerDeps(provider);
  if (!pd) return { status: 503, body: { ok: false, error: "payment_unavailable", message: "Please try again in a moment." } };
  // Beam only (design S3.2, round 6): a payMethod that is not one of the two groups is refused before anything is
  // read. The token check itself is mode-blind (as on production main), so Stripe and demo tokens never reach this.
  if (pd.gw.provider === "beam" && booking.payMethod !== undefined && !isPayMethod(booking.payMethod)) {
    return { status: 400, body: { ok: false, error: "invalid_token", message: "This booking link is not valid." } };
  }

  // The key: the redirect's own id (Stripe: s), else the link token, else (below) what checkout recorded for the ref.
  let key = requestPaymentKey(body.s, body.l, booking, config.tokenSecret, pd.gw, nowMs);
  try {
    if (!key) key = (await bookingPointer(pd.deps, booking.ref))?.sessionId ?? null;
    if (!key) return { status: 200, body: { ok: true, state: "closed" } };
    const settled = pd.gw.provider === "beam" ? await settledBeamBooking(pd.deps, key, booking.ref) : null;
    if (settled) {
      deps.log?.("booking_abandoned", { ref: booking.ref, state: settled.state, settled: settled.by });
      return { status: 200, body: { ok: true, state: settled.state } };
    }
    const outcome = await abandonPayment(key, pd.deps, pd.gw, booking.ref);
    deps.log?.("booking_abandoned", { ref: booking.ref, state: outcome.state });
    return { status: 200, body: { ok: true, state: outcome.state } };
  } catch (e) {
    deps.log?.("booking_abandon_failed", { ref: booking.ref, error: redactForLog(e instanceof Error ? e.message : String(e)) });
    // The hold is still released by the provider's expiry (Stripe's webhook) or the sweeper.
    return { status: 502, body: { ok: false, error: "upstream_error", message: "We couldn't cancel the payment just now - it will expire on its own within 30 minutes." } };
  }
}

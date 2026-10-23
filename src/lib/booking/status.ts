// Payment status for the return page (server). Never trusts the query
// string alone: the booking token is verified, then the status comes from a
// signed demo proof (demo mode) or, in the hold-first modes (stripe-*, and
// beam-* since Beam design S4.6), from the provider itself through its
// PaymentGateway. The deps and gateway are picked by the BOOKING's provider
// (deps.providerDeps: the active config's, or that provider's drain). There a
// paid payment is also FULFILLED (Stripe recommends the return page triggers
// fulfilment too): the answer says whether the Cloudbeds reservation is
// confirmed yet. A finished Beam booking is answered from its done marker
// without calling Beam (gap review 16).

import { redactForLog } from "./cloudbedsWrite.ts";
import type { BookingConfig } from "./config.ts";
import { alertFulfilPaymentFailure, bookingPointer, fulfilPayment, releasePayment } from "./fulfil.ts";
import type { FulfilDone } from "./fulfil.ts";
import { keys, readJson } from "./lock.ts";
import { isLiveMode, providerOf } from "./payments/provider.ts";
import { holdFirstProvider, providerDepsOf, requestPaymentKey } from "./providerDispatch.ts";
import { isPayMethod, satangToBaht } from "./quote.ts";
import type { ProviderDeps, ProviderDepsFn, StripeDeps } from "./stripeDeps.ts";
import { verifyBookingToken, verifyDemoProof } from "./token.ts";
import type { ApiError, BookingSummary, FulfilmentView, PaymentStatus, PurchaseView, StatusResponse } from "./types.ts";

export interface StatusParams {
  t: string | null;
  p: string | null;
  l: string | null;
  /** Stripe Checkout Session id from the success_url ({CHECKOUT_SESSION_ID}). */
  s?: string | null;
}

export interface StatusDeps {
  config: BookingConfig;
  nowMs?: number;
  log?: (message: string, data?: Record<string, unknown>) => void;
  /**
   * Hold-first modes: the deps and gateway that finish a provider's payments,
   * the active config's for its own provider, else that provider's drain
   * (after BOOKING_PAYMENT_PROVIDER moved away from it, its bookings already
   * started are still checked and confirmed with its credentials). The routes
   * pass runtime.ts providerDepsFor(config, env, {deadlineMs}): every Beam call
   * of the request ends by the route's deadline.
   */
  providerDeps?: ProviderDepsFn;
  /** Stripe shorthand, used only without providerDeps: the active config's Stripe deps. */
  stripe?: StripeDeps;
  /** Stripe shorthand, used only without providerDeps: the Stripe drain (runtime.ts getStripeFulfilmentDeps). */
  stripeDrain?: () => StripeDeps | null;
}

const NOT_APPLICABLE: FulfilmentView = { state: "not_applicable", reservationId: null };

// The provider-dispatch helpers (holdFirstProvider, providerDepsOf, requestPaymentKey) live in
// providerDispatch.ts, which abandon.ts imports too (Beam design step S2.0). Re-exported here, so every
// existing import of them from status.ts keeps working.
export { holdFirstProvider, providerDepsOf, requestPaymentKey } from "./providerDispatch.ts";

export interface StatusResult {
  status: number;
  body: StatusResponse | ApiError;
}

function ok(
  booking: BookingSummary,
  status: PaymentStatus,
  failureCode: string | null,
  nowMs: number,
  fulfilment: FulfilmentView = NOT_APPLICABLE,
  purchase: PurchaseView | null = null,
  /** Only when the provider's payment carries one (never Stripe): no key at all otherwise. */
  pendingReason?: StatusResponse["pendingReason"],
): StatusResult {
  return {
    status: 200,
    body: {
      ok: true,
      ref: booking.ref,
      paymentMode: booking.paymentMode,
      provider: providerOf(booking.paymentMode),
      status,
      ...(pendingReason ? { pendingReason } : {}),
      failureCode,
      booking,
      fulfilment,
      purchase,
      checkedAt: new Date(nowMs).toISOString(),
    },
  };
}

/**
 * The GA4 purchase a paid booking's answer may carry: only in a live mode on the production deployment, and
 * only once the Cloudbeds reservation is confirmed (its reservationID is the transaction id).
 */
export function purchaseFor(
  config: Pick<BookingConfig, "paymentMode" | "production">,
  booking: BookingSummary,
  fulfilment: FulfilmentView,
): PurchaseView | null {
  return fulfilment.state === "confirmed" && fulfilment.reservationId && isLiveMode(config.paymentMode) && config.production
    ? { transactionId: fulfilment.reservationId, valueBaht: satangToBaht(booking.dueNowSatang), currency: "THB" }
    : null;
}

/** Demo mode only (no provider to ask): the simulated link simply lapses after its 30 minutes. */
function pendingOrExpired(booking: BookingSummary, nowMs: number): PaymentStatus {
  return Date.parse(booking.linkExpiresAt) <= nowMs ? "expired" : "pending";
}

export async function runStatus(params: StatusParams, deps: StatusDeps): Promise<StatusResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const { config } = deps;

  const verified = verifyBookingToken(params.t, config.tokenSecret, nowMs);
  if (!verified.ok) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "invalid_token",
        message:
          verified.reason === "expired"
            ? "This booking link has expired. Please contact us if you have paid."
            : "This booking link is not valid.",
      },
    };
  }
  const booking = verified.payload.booking;
  const providerDeps = providerDepsOf(deps);
  const bookingProvider = holdFirstProvider(booking.paymentMode);
  if (booking.paymentMode !== config.paymentMode && bookingProvider) {
    // Drain: the booking's provider is no longer the active one (or runs in another mode).
    const drain = providerDeps(bookingProvider);
    if (drain && drain.deps.config.paymentMode === booking.paymentMode) {
      return holdFirstStatus(booking, params, { config: drain.deps.config, log: deps.log }, drain, nowMs);
    }
  }
  if (booking.paymentMode !== config.paymentMode) {
    return {
      status: 409,
      body: { ok: false, error: "invalid_token", message: "This booking was made in a different payment mode." },
    };
  }

  if (config.paymentMode === "demo") {
    if (params.p) {
      const proof = verifyDemoProof(params.p, config.tokenSecret, nowMs);
      if (proof.ok && proof.payload.ref === booking.ref) {
        return ok(booking, proof.payload.status, proof.payload.failureCode, nowMs);
      }
      return { status: 400, body: { ok: false, error: "invalid_token", message: "The payment confirmation is not valid." } };
    }
    return ok(booking, pendingOrExpired(booking, nowMs), null, nowMs);
  }

  const provider = holdFirstProvider(config.paymentMode);
  if (provider) {
    const active = providerDeps(provider);
    if (!active) return { status: 503, body: { ok: false, error: "payment_unavailable", message: "Payment status is unavailable." } };
    return holdFirstStatus(booking, params, deps, active, nowMs);
  }

  // Every other mode is hold-first (above): the legacy link-only Beam status is gone (design S4.6).
  return { status: 503, body: { ok: false, error: "payment_unavailable", message: "Payment status is unavailable." } };
}

/* ----------------------------- hold-first ----------------------------- */

/**
 * A hold-first booking: the payment is re-read from its provider through the
 * gateway (never trusted from the request), released when it can no longer be
 * paid and fulfilled when paid. ctx.config is the config the booking belongs
 * to (the active one, or its provider's drain); log names follow the provider
 * (stripe_status_mismatch, ...).
 *
 * Gateway hooks (Beam design step S2.6; Stripe payments carry none of them, so
 * every Stripe answer is what it was): a payment carrying a mismatch gets the
 * mismatch answer (contact us, never "Try again"); a pending answer carries the
 * payment's pendingReason; and a payment that expired while still unconfirmed
 * at the bank (pendingReason "unconfirmed") is released, best effort, but
 * answered pending/unconfirmed - never "expired" or "cancelled", which offer
 * "Try again", a second payment (money review 8).
 *
 * Beam only (design S4.6, gap review 16): a booking fulfil has finished is
 * answered from its done marker before any Beam call - paid, with the marker's
 * confirmed or needs_attention and the GA4 purchase (purchaseFor) - when the
 * marker's ref and amount are the token's; a needs_attention marker of a payment
 * refunded before it was confirmed (FulfilDone.refunded) answers "refunded", as a
 * refund read from Beam does (round 8). Anything else (no marker, or one
 * that is not this booking's) is read from Beam as above. A hold already
 * released (its release marker) is not released again: no second Beam
 * reading (round 6). A Beam token whose payMethod is present but not one of
 * the two groups is refused before anything is read (design S3.2, round 6:
 * the token check itself is mode-blind, as on production main).
 */
async function holdFirstStatus(
  booking: BookingSummary,
  params: StatusParams,
  ctx: Pick<StatusDeps, "config" | "log">,
  { deps, gw }: ProviderDeps,
  nowMs: number,
): Promise<StatusResult> {
  if (gw.provider === "beam" && booking.payMethod !== undefined && !isPayMethod(booking.payMethod)) {
    return { status: 400, body: { ok: false, error: "invalid_token", message: "This booking link is not valid." } };
  }
  try {
    // The key: the redirect's own id (Stripe: the success_url's {CHECKOUT_SESSION_ID}), else the link token, else what checkout recorded for the ref.
    let key = requestPaymentKey(params.s, params.l, booking, ctx.config.tokenSecret, gw, nowMs);
    if (!key) key = (await bookingPointer(deps, booking.ref))?.sessionId ?? null;
    if (!key) return ok(booking, "pending", null, nowMs, { state: "awaiting_payment", reservationId: null });

    // Beam: a finished booking needs no Beam call (rate limits, gap review 16). Stripe never takes this path.
    if (gw.provider === "beam") {
      const done = await readJson<FulfilDone>(deps.kv, keys.fulfilDone(key));
      if (done && done.ref === booking.ref && done.totalSatang === booking.dueNowSatang) {
        // Refunded before it was confirmed (round 8): the same answer as a refund read from Beam - never "Payment received".
        if (done.state === "needs_attention" && done.refunded === true) return ok(booking, "refunded", null, nowMs, NOT_APPLICABLE);
        const fulfilment: FulfilmentView = { state: done.state, reservationId: done.reservationId };
        return ok(booking, "paid", null, nowMs, fulfilment, purchaseFor(ctx.config, booking, fulfilment));
      }
    }

    const payment = await gw.get(key);
    const meta = payment.meta;
    // The payment must be THIS booking's, for exactly the amount the token says - and the provider must not
    // report it at odds with our own record of the booking (payment.mismatch, never Stripe): a person settles it.
    if (
      !meta ||
      meta.ref !== booking.ref ||
      payment.amountSatang !== booking.dueNowSatang ||
      (payment.currency ?? "").toLowerCase() !== "thb" ||
      payment.mismatch
    ) {
      ctx.log?.(`${gw.provider}_status_mismatch`, { ref: booking.ref, sessionId: key, ...(payment.mismatch ? { providerMismatch: true } : {}) });
      return ok(booking, "failed", "AMOUNT_OR_REFERENCE_MISMATCH", nowMs, { state: "not_applicable", reservationId: null });
    }
    const state = payment.state;
    if (state === "open" || state === "processing") {
      return ok(booking, "pending", null, nowMs, { state: "awaiting_payment", reservationId: null }, null, payment.pendingReason);
    }
    if (state === "expired" || state === "failed") {
      // Best effort: the webhook/sweeper release it too. Beam: a hold already released is not asked of Beam again.
      const released = gw.provider === "beam" && (await deps.kv.get(keys.releaseDone(meta.reservationId))) !== null;
      if (!released) {
        await releasePayment(key, deps, gw, state === "expired" ? `${gw.text.sessionLabel.short} expired` : "delayed payment failed").catch((e) =>
          ctx.log?.(`${gw.provider}_status_release_failed`, { ref: booking.ref, error: e instanceof Error ? e.message : String(e) }),
        );
      }
      const fulfilment: FulfilmentView = { state: "released", reservationId: null };
      // The window is over but a payment was still waiting for the bank's answer: it may yet succeed, so the
      // guest is told not to pay again (pending/unconfirmed), whatever the Cancel button did (money review 8).
      if (state === "expired" && payment.pendingReason === "unconfirmed") return ok(booking, "pending", null, nowMs, fulfilment, null, "unconfirmed");
      if (state === "failed") return ok(booking, "failed", "PAYMENT_FAILED", nowMs, fulfilment);
      const abandoned = (await deps.kv.get(keys.abandoned(key))) !== null;
      return ok(booking, abandoned ? "cancelled" : "expired", null, nowMs, fulfilment);
    }
    // Refunded at the provider (Stripe never reports it): never fulfilled from here.
    if (state === "refunded") return ok(booking, "refunded", null, nowMs, NOT_APPLICABLE);

    // Paid: make sure the Cloudbeds reservation is confirmed (idempotent).
    let fulfilment: FulfilmentView = { state: "confirming", reservationId: null };
    try {
      const outcome = await fulfilPayment(key, deps, gw);
      if (outcome.state === "confirmed") fulfilment = { state: "confirmed", reservationId: outcome.reservationId };
      else if (outcome.state === "needs_attention") fulfilment = { state: "needs_attention", reservationId: outcome.reservationId };
    } catch (e) {
      await alertFulfilPaymentFailure(deps, gw, key, e);
    }
    return ok(booking, "paid", null, nowMs, fulfilment, purchaseFor(ctx.config, booking, fulfilment));
  } catch (e) {
    ctx.log?.(`${gw.provider}_status_failed`, { ref: booking.ref, message: redactForLog(e instanceof Error ? e.message : String(e)) });
    return { status: 502, body: { ok: false, error: "upstream_error", message: "We couldn't check the payment just now." } };
  }
}

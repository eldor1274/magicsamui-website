// Payment status for the return page (server). Never trusts the query
// string alone: the booking token is verified, then the status comes from a
// signed demo proof (demo mode), from Beam itself (beam-* modes) or from
// Stripe itself (stripe-* modes). In stripe modes a paid session is also
// FULFILLED here (Stripe recommends the return page triggers fulfilment too):
// the answer says whether the Cloudbeds reservation is confirmed yet.

import { getPaymentLink, listPaymentLinkCharges, mapLinkStatus } from "./beam.ts";
import type { BeamCharge } from "./beam.ts";
import { redactForLog } from "./cloudbedsWrite.ts";
import type { BookingConfig } from "./config.ts";
import { alertFulfilFailure, bookingPointer, fulfilSession, releaseSession } from "./fulfil.ts";
import { keys } from "./lock.ts";
import { isSessionId, parseSessionMeta, retrieveSession, sessionPaymentState } from "./payments/stripe.ts";
import { providerOf } from "./payments/provider.ts";
import { satangToBaht } from "./quote.ts";
import type { StripeDeps } from "./stripeDeps.ts";
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
  fetchImpl?: typeof fetch;
  log?: (message: string, data?: Record<string, unknown>) => void;
  /** Stripe modes. */
  stripe?: StripeDeps;
  /**
   * Drain: after BOOKING_PAYMENT_PROVIDER moved away from stripe, Stripe
   * bookings already started are still checked (and confirmed) with the
   * Stripe credentials (runtime.ts getStripeFulfilmentDeps).
   */
  stripeDrain?: () => StripeDeps | null;
}

const NOT_APPLICABLE: FulfilmentView = { state: "not_applicable", reservationId: null };

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
): StatusResult {
  return {
    status: 200,
    body: {
      ok: true,
      ref: booking.ref,
      paymentMode: booking.paymentMode,
      provider: providerOf(booking.paymentMode),
      status,
      failureCode,
      booking,
      fulfilment,
      purchase,
      checkedAt: new Date(nowMs).toISOString(),
    },
  };
}

/** Demo mode only (no Beam to ask): the simulated link simply lapses after its 30 minutes. */
function pendingOrExpired(booking: BookingSummary, nowMs: number): PaymentStatus {
  return Date.parse(booking.linkExpiresAt) <= nowMs ? "expired" : "pending";
}

/** A charge that pays exactly this booking (amount and currency as quoted). */
function paysBooking(c: BeamCharge, booking: BookingSummary): boolean {
  return c.status === "SUCCEEDED" && c.amount === booking.dueNowSatang && c.currency === "THB";
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
  if (booking.paymentMode !== config.paymentMode && providerOf(booking.paymentMode) === "stripe" && deps.stripeDrain) {
    const drain = deps.stripeDrain();
    if (drain && drain.config.paymentMode === booking.paymentMode) {
      return stripeStatus(booking, params, { ...deps, config: drain.config, stripe: drain }, nowMs);
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

  if (providerOf(config.paymentMode) === "stripe") return stripeStatus(booking, params, deps, nowMs);

  if (!config.beam) {
    return { status: 503, body: { ok: false, error: "payment_unavailable", message: "Payment status is unavailable." } };
  }

  try {
    let paymentLinkId: string | null = null;
    if (params.l) {
      const link = verifyBookingToken(params.l, config.tokenSecret, nowMs);
      if (link.ok && link.payload.booking.ref === booking.ref) paymentLinkId = link.payload.paymentLinkId;
    }

    if (paymentLinkId) {
      const link = await getPaymentLink(config.beam, paymentLinkId, deps.fetchImpl);
      const refMatches = !link.order?.referenceId || link.order.referenceId === booking.ref;
      if (!refMatches || link.order?.netAmount !== booking.dueNowSatang || link.order?.currency !== "THB") {
        deps.log?.("beam_status_mismatch", { ref: booking.ref, paymentLinkId });
        return ok(booking, "failed", "AMOUNT_OR_REFERENCE_MISMATCH", nowMs);
      }
      const status = mapLinkStatus(link.status);
      if (status === "expired" || status === "cancelled") {
        // These answers offer "Try again", which is a second payment. Beam only
        // redirects here after a successful payment, so first make sure no
        // charge on this exact link (sourceId = paymentLinkId) succeeded, e.g.
        // a PromptPay QR or a slow 3-D Secure step that finished at the deadline.
        const charges = await listPaymentLinkCharges(config.beam, { sourceId: paymentLinkId }, deps.fetchImpl);
        if (charges.some((c) => paysBooking(c, booking))) {
          deps.log?.("beam_status_paid_after_link_closed", { ref: booking.ref, paymentLinkId, linkStatus: link.status });
          return ok(booking, "paid", null, nowMs);
        }
      }
      return ok(booking, status, null, nowMs);
    }

    // Fallback without the link id (the server render of the return page, or
    // a new tab): look for a succeeded charge for this ref. Whether Beam copies
    // order.referenceId onto the charge is undocumented and the list may lag,
    // so "nothing found" is NOT proof of non-payment. Never answer "expired"
    // from here: it offers "Try again", which could charge the guest twice.
    // Only the payment link's own status can say EXPIRED. Until the browser
    // supplies the link id the guest sees "pending" and, after the polling
    // budget, "please don't pay again - message us".
    const charges = await listPaymentLinkCharges(config.beam, { referenceId: booking.ref }, deps.fetchImpl);
    const paid = charges.some((c) => paysBooking(c, booking) && c.referenceId === booking.ref);
    return ok(booking, paid ? "paid" : "pending", null, nowMs);
  } catch (e) {
    deps.log?.("beam_status_failed", { ref: booking.ref, message: e instanceof Error ? e.message : String(e) });
    return { status: 502, body: { ok: false, error: "upstream_error", message: "We couldn't check the payment just now." } };
  }
}

/* ------------------------------- Stripe ------------------------------- */

async function stripeStatus(booking: BookingSummary, params: StatusParams, deps: StatusDeps, nowMs: number): Promise<StatusResult> {
  const sd = deps.stripe;
  if (!sd) return { status: 503, body: { ok: false, error: "payment_unavailable", message: "Payment status is unavailable." } };
  try {
    // Session id: the success_url's {CHECKOUT_SESSION_ID}, else the link token, else what checkout recorded for the ref.
    let sessionId: string | null = isSessionId(params.s) ? params.s : null;
    if (!sessionId && params.l) {
      const link = verifyBookingToken(params.l, deps.config.tokenSecret, nowMs);
      if (link.ok && link.payload.booking.ref === booking.ref && isSessionId(link.payload.paymentLinkId)) sessionId = link.payload.paymentLinkId;
    }
    if (!sessionId) sessionId = (await bookingPointer(sd, booking.ref))?.sessionId ?? null;
    if (!sessionId) return ok(booking, "pending", null, nowMs, { state: "awaiting_payment", reservationId: null });

    const session = await retrieveSession(sd.stripe, sessionId);
    const meta = parseSessionMeta(session);
    // The session must be THIS booking's, for exactly the amount the token says.
    if (!meta || meta.ref !== booking.ref || session.amount_total !== booking.dueNowSatang || (session.currency ?? "").toLowerCase() !== "thb") {
      deps.log?.("stripe_status_mismatch", { ref: booking.ref, sessionId });
      return ok(booking, "failed", "AMOUNT_OR_REFERENCE_MISMATCH", nowMs, { state: "not_applicable", reservationId: null });
    }
    const payment = sessionPaymentState(session);
    if (payment === "open" || payment === "processing") {
      return ok(booking, "pending", null, nowMs, { state: "awaiting_payment", reservationId: null });
    }
    if (payment === "expired" || payment === "failed") {
      // Best effort: the webhook/sweeper release it too.
      await releaseSession(sessionId, sd, payment === "expired" ? "session expired" : "delayed payment failed").catch((e) =>
        deps.log?.("stripe_status_release_failed", { ref: booking.ref, error: e instanceof Error ? e.message : String(e) }),
      );
      const fulfilment: FulfilmentView = { state: "released", reservationId: null };
      if (payment === "failed") return ok(booking, "failed", "PAYMENT_FAILED", nowMs, fulfilment);
      const abandoned = (await sd.kv.get(keys.abandoned(sessionId))) !== null;
      return ok(booking, abandoned ? "cancelled" : "expired", null, nowMs, fulfilment);
    }

    // Paid: make sure the Cloudbeds reservation is confirmed (idempotent).
    let fulfilment: FulfilmentView = { state: "confirming", reservationId: null };
    try {
      const outcome = await fulfilSession(sessionId, sd);
      if (outcome.state === "confirmed") fulfilment = { state: "confirmed", reservationId: outcome.reservationId };
      else if (outcome.state === "needs_attention") fulfilment = { state: "needs_attention", reservationId: outcome.reservationId };
    } catch (e) {
      await alertFulfilFailure(sd, sessionId, e);
    }
    const purchase: PurchaseView | null =
      fulfilment.state === "confirmed" && fulfilment.reservationId && deps.config.paymentMode === "stripe-live" && deps.config.production
        ? { transactionId: fulfilment.reservationId, valueBaht: satangToBaht(booking.dueNowSatang), currency: "THB" }
        : null;
    return ok(booking, "paid", null, nowMs, fulfilment, purchase);
  } catch (e) {
    deps.log?.("stripe_status_failed", { ref: booking.ref, message: redactForLog(e instanceof Error ? e.message : String(e)) });
    return { status: 502, body: { ok: false, error: "upstream_error", message: "We couldn't check the payment just now." } };
  }
}

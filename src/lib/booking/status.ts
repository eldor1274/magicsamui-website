// Payment status for the return page (server). Never trusts the query
// string alone: the booking token is verified, then the status comes from a
// signed demo proof (demo mode), from Beam itself (the beam-* link preview)
// or, in the hold-first modes (stripe-*), from the provider itself through
// its PaymentGateway. The deps and gateway are picked by the BOOKING's
// provider (deps.providerDeps: the active config's, or that provider's
// drain). There a paid payment is also FULFILLED (Stripe recommends the
// return page triggers fulfilment too): the answer says whether the Cloudbeds
// reservation is confirmed yet.

import { getPaymentLink, listPaymentLinkCharges, mapLinkStatus } from "./beam.ts";
import type { BeamCallOptions, BeamCharge } from "./beam.ts";
import { redactForLog } from "./cloudbedsWrite.ts";
import type { BookingConfig } from "./config.ts";
import { alertFulfilPaymentFailure, bookingPointer, fulfilPayment, releasePayment } from "./fulfil.ts";
import { keys } from "./lock.ts";
import type { PaymentGateway } from "./payments/gateway.ts";
import { isSessionId } from "./payments/stripe.ts";
import { stripeGateway } from "./payments/stripeGateway.ts";
import { isHoldFirstMode, isLiveMode, providerOf } from "./payments/provider.ts";
import { satangToBaht } from "./quote.ts";
import type { ProviderDeps, ProviderDepsFn, StripeDeps } from "./stripeDeps.ts";
import { verifyBookingToken, verifyDemoProof } from "./token.ts";
import type { ApiError, BookingSummary, FulfilmentView, PaymentMode, PaymentStatus, PurchaseView, StatusResponse } from "./types.ts";

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
  /**
   * Hold-first modes: the deps and gateway that finish a provider's payments,
   * the active config's for its own provider, else that provider's drain
   * (after BOOKING_PAYMENT_PROVIDER moved away from it, its bookings already
   * started are still checked and confirmed with its credentials). The routes
   * pass runtime.ts providerDepsFor(config).
   */
  providerDeps?: ProviderDepsFn;
  /** Stripe shorthand, used only without providerDeps: the active config's Stripe deps. */
  stripe?: StripeDeps;
  /** Stripe shorthand, used only without providerDeps: the Stripe drain (runtime.ts getStripeFulfilmentDeps). */
  stripeDrain?: () => StripeDeps | null;
  /** Wall clock of the Beam preview's read budget (default Date.now; tests move it). */
  clock?: () => number;
}

const NOT_APPLICABLE: FulfilmentView = { state: "not_applicable", reservationId: null };

/**
 * The Beam preview's (beam-* link, no hold) budget for all its Beam reads of one status request together:
 * the link, then maybe its charges, each read with its one retry inside what is left. Well inside the status
 * route's maxDuration of 30 s, so a slow Beam gets the guest the 502 "couldn't check" answer, never a
 * platform timeout.
 */
export const BEAM_PREVIEW_STATUS_BUDGET_MS = 12_000;

/**
 * deps.providerDeps, else one made of the Stripe shorthand: `stripe` while the
 * active config is a Stripe mode, `stripeDrain` otherwise.
 */
export function providerDepsOf(deps: {
  config: BookingConfig;
  providerDeps?: ProviderDepsFn;
  stripe?: StripeDeps | null;
  stripeDrain?: () => StripeDeps | null;
}): ProviderDepsFn {
  if (deps.providerDeps) return deps.providerDeps;
  return (provider) => {
    if (provider !== "stripe") return null;
    const sd = providerOf(deps.config.paymentMode) === "stripe" ? deps.stripe : deps.stripeDrain?.();
    return sd ? { deps: sd, gw: stripeGateway(sd) } : null;
  };
}

/** The provider of a hold-first mode (one finished through a PaymentGateway), else null. */
export function holdFirstProvider(mode: PaymentMode): PaymentGateway["provider"] | null {
  const provider = providerOf(mode);
  return isHoldFirstMode(mode) && provider !== "demo" ? provider : null;
}

/** An id in the shape the provider issues (Stripe: a Checkout Session id). No other provider's id is read from a request yet. */
function isProviderPaymentId(provider: PaymentGateway["provider"], id: unknown): id is string {
  return provider === "stripe" && isSessionId(id);
}

/**
 * The payment key a return or cancel request names itself, before the
 * pointer msv:booking:{ref} is read: the provider's id in the redirect (s:
 * Stripe's {CHECKOUT_SESSION_ID}), else the link token's (l) when that token
 * is this booking's. Only an id in the shape the provider issues counts.
 */
export function requestPaymentKey(s: unknown, l: unknown, booking: BookingSummary, tokenSecret: string, gw: PaymentGateway, nowMs: number): string | null {
  if (isProviderPaymentId(gw.provider, s)) return gw.keyOf(s);
  if (typeof l !== "string" || l === "") return null;
  const link = verifyBookingToken(l, tokenSecret, nowMs);
  if (!link.ok || link.payload.booking.ref !== booking.ref) return null;
  const id = link.payload.paymentLinkId;
  return isProviderPaymentId(gw.provider, id) ? gw.keyOf(id) : null;
}

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

  if (!config.beam) {
    return { status: 503, body: { ok: false, error: "payment_unavailable", message: "Payment status is unavailable." } };
  }

  // One budget for every Beam read of this request (BEAM_PREVIEW_STATUS_BUDGET_MS).
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const readOpts = (): BeamCallOptions => ({ budgetMs: Math.max(0, BEAM_PREVIEW_STATUS_BUDGET_MS - (clock() - started)), now: clock });

  try {
    let paymentLinkId: string | null = null;
    if (params.l) {
      const link = verifyBookingToken(params.l, config.tokenSecret, nowMs);
      if (link.ok && link.payload.booking.ref === booking.ref) paymentLinkId = link.payload.paymentLinkId;
    }

    if (paymentLinkId) {
      const link = await getPaymentLink(config.beam, paymentLinkId, deps.fetchImpl, readOpts());
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
        const charges = await listPaymentLinkCharges(config.beam, { sourceId: paymentLinkId }, deps.fetchImpl, readOpts());
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
    const charges = await listPaymentLinkCharges(config.beam, { referenceId: booking.ref }, deps.fetchImpl, readOpts());
    const paid = charges.some((c) => paysBooking(c, booking) && c.referenceId === booking.ref);
    return ok(booking, paid ? "paid" : "pending", null, nowMs);
  } catch (e) {
    deps.log?.("beam_status_failed", { ref: booking.ref, message: e instanceof Error ? e.message : String(e) });
    return { status: 502, body: { ok: false, error: "upstream_error", message: "We couldn't check the payment just now." } };
  }
}

/* ----------------------------- hold-first ----------------------------- */

/**
 * A hold-first booking: the payment is re-read from its provider through the
 * gateway (never trusted from the request), released when it can no longer be
 * paid and fulfilled when paid. ctx.config is the config the booking belongs
 * to (the active one, or its provider's drain); log names follow the provider
 * (stripe_status_mismatch, ...).
 */
async function holdFirstStatus(
  booking: BookingSummary,
  params: StatusParams,
  ctx: Pick<StatusDeps, "config" | "log">,
  { deps, gw }: ProviderDeps,
  nowMs: number,
): Promise<StatusResult> {
  try {
    // The key: the redirect's own id (Stripe: the success_url's {CHECKOUT_SESSION_ID}), else the link token, else what checkout recorded for the ref.
    let key = requestPaymentKey(params.s, params.l, booking, ctx.config.tokenSecret, gw, nowMs);
    if (!key) key = (await bookingPointer(deps, booking.ref))?.sessionId ?? null;
    if (!key) return ok(booking, "pending", null, nowMs, { state: "awaiting_payment", reservationId: null });

    const payment = await gw.get(key);
    const meta = payment.meta;
    // The payment must be THIS booking's, for exactly the amount the token says.
    if (!meta || meta.ref !== booking.ref || payment.amountSatang !== booking.dueNowSatang || (payment.currency ?? "").toLowerCase() !== "thb") {
      ctx.log?.(`${gw.provider}_status_mismatch`, { ref: booking.ref, sessionId: key });
      return ok(booking, "failed", "AMOUNT_OR_REFERENCE_MISMATCH", nowMs, { state: "not_applicable", reservationId: null });
    }
    const state = payment.state;
    if (state === "open" || state === "processing") {
      return ok(booking, "pending", null, nowMs, { state: "awaiting_payment", reservationId: null });
    }
    if (state === "expired" || state === "failed") {
      // Best effort: the webhook/sweeper release it too.
      await releasePayment(key, deps, gw, state === "expired" ? `${gw.text.sessionLabel.short} expired` : "delayed payment failed").catch((e) =>
        ctx.log?.(`${gw.provider}_status_release_failed`, { ref: booking.ref, error: e instanceof Error ? e.message : String(e) }),
      );
      const fulfilment: FulfilmentView = { state: "released", reservationId: null };
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

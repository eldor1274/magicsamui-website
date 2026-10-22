// Hold-first Stripe checkout (WI-5 server side). Runs after checkout.ts has
// validated the cart and re-quoted it from Cloudbeds with no cache:
//
//   test-mode guard -> open-holds brake -> hold INTENT recorded (before any
//   Cloudbeds write) -> lock every physical unit in the cart -> refuse a cart
//   that overlaps one of OUR open holds (units + dates in Redis) ->
//   restrictions + availability re-checked under the lock (no cache) ->
//   postReservation (the HOLD: exact roomTypeID + priced roomRateID, guest
//   details, thirdPartyIdentifier = MSV ref (+ -TEST outside live),
//   sendEmailConfirmation=false, sourceID) -> hold record (units + dates) ->
//   unlock -> assert Cloudbeds grandTotal AND the folio read back ==
//   our room subtotal, with no Cloudbeds taxes/fees (else cancel +
//   price_changed, or "message us" when Cloudbeds adds fees) -> status
//   "not_confirmed" -> Stripe Checkout Session -> redirect.
//
// The route has 30 s (maxDuration): a deadline is passed in, and the chain
// refuses to start a hold it may not have time to finish or cancel, and
// sizes the Stripe call to the time that is left.
//
// The hold takes the unit out of Booking.com/Airbnb before the guest pays, so
// we never charge for a room we don't hold. Any failure after the hold
// cancels it again (and expires the Stripe session if one exists). A hold
// whose outcome is unknown (timeout/5xx) stays in the intent index, and the
// sweeper finds and releases it by its thirdPartyIdentifier. Personal data
// goes only to Cloudbeds and Stripe.
//
// The chain itself is startHoldFirstCheckout (holdFirstCheckout.ts), which
// leaves only the payment page to the provider. Its constants and helpers
// (the checks before the hold, the price check, holdFailed) live in
// checkoutShared.ts, which both files import (no import cycle) and this
// file re-exports. This file keeps the Stripe side: stripeCheckoutAdapter
// (the Checkout Session as the payment page) and startStripeCheckout, the
// core with it.

import { createHash } from "node:crypto";
import { NOTHING_CHARGED, fail } from "./checkoutShared.ts";
import type { StripeCheckoutContext, StripeCheckoutInput, StripeCheckoutResult } from "./checkoutShared.ts";
import { MERCHANT_NAME, PAYMENT_LINK_TTL_MINUTES } from "./config.ts";
import type { StripeSettings } from "./config.ts";
import { startHoldFirstCheckout } from "./holdFirstCheckout.ts";
import type { CheckoutAdapter } from "./holdFirstCheckout.ts";
import { STRIPE_MAX_CHARGE_SATANG, buildCheckoutSessionParams, isStripeCheckoutUrl, stripeErrorInfo } from "./payments/stripe.ts";
import type { StripeDeps } from "./stripeDeps.ts";
import type { ThemeName } from "./types.ts";
import { stripeCancelUrl, stripeReturnUrl } from "./urls.ts";

// The shared constants, types and helpers, under the names this file has always exported.
export * from "./checkoutShared.ts";

/** One Stripe idempotency key per booking attempt (same ref + salt -> same key). */
export function stripeIdempotencyKey(ref: string, mode: string, salt: string): string {
  return `msv-cs-${createHash("sha256").update(`stripe-checkout|${mode}|${ref}|${salt}`).digest("hex").slice(0, 40)}`;
}

/**
 * The Stripe side of the hold-first checkout (holdFirstCheckout.ts): the payment page is a Checkout Session, whose
 * id is both the key (every Redis key keeps its name) and the payment id the booking token carries.
 */
export function stripeCheckoutAdapter(
  deps: Pick<StripeDeps, "config" | "stripe">,
  stripe: StripeSettings,
  at: { origin: string; nowMs: number; theme?: ThemeName },
): CheckoutAdapter<ReturnType<typeof stripeErrorInfo>> {
  const mode = deps.config.paymentMode;
  return {
    provider: "stripe",
    brand: "Stripe",
    maxChargeSatang: STRIPE_MAX_CHARGE_SATANG,
    async createPage({ ref, reservationId, quote, guest, token, basePath, guestFlags, budgetMs, nonce }) {
      // Sized to the budget: Stripe's own timeout, and its one network retry only when that still fits.
      const requestOptions = Number.isFinite(budgetMs) ? { timeout: Math.min(15_000, Math.floor(budgetMs)), maxNetworkRetries: budgetMs > 20_000 ? 1 : 0 } : {};
      const params = buildCheckoutSessionParams({
        ref,
        reservationId,
        quote,
        customerEmail: guest.email,
        successUrl: stripeReturnUrl(at.origin, basePath, ref, token, at.theme),
        cancelUrl: stripeCancelUrl(at.origin, basePath, ref, token, at.theme),
        nowMs: at.nowMs,
        ttlMinutes: PAYMENT_LINK_TTL_MINUTES,
        allowedPaymentMethodTypes: stripe.allowedPaymentMethodTypes,
        merchantName: MERCHANT_NAME,
        mode,
        guestFlags,
      });
      const session = await deps.stripe.checkout.sessions.create(params, {
        idempotencyKey: stripeIdempotencyKey(ref, mode, nonce()),
        ...requestOptions,
      });
      return { key: session.id, paymentId: session.id, redirectUrl: session.url };
    },
    // stripe-mock's page is served from our own origin.
    isAllowedUrl: (url) => isStripeCheckoutUrl(url, stripe.mock ? at.origin : null),
    cancelPage: (key) => deps.stripe.checkout.sessions.expire(key),
    errorInfo: stripeErrorInfo,
    // A persistent Stripe-side problem (key permission, PromptPay not activated, account restricted) breaks EVERY booking.
    pageFailedAlert: (info, ref) => ({
      subject: "Booking stopped: Stripe could not create the payment page",
      lines: [
        `Booking ${ref}: Stripe refused or failed to create the Checkout Session (${info.type}${info.code ? `, code ${info.code}` : ""}${info.statusCode ? `, HTTP ${info.statusCode}` : ""}${info.requestId ? `, request ${info.requestId}` : ""}).`,
        "The hold was cancelled and nothing was charged. If this repeats, every online booking is failing: check the restricted key's permissions, the payment methods (PromptPay) and the account status in the Stripe Dashboard.",
      ],
      key: `stripe-session-fail:${info.code ?? info.type}`,
    }),
  };
}

/** The hold-first checkout (holdFirstCheckout.ts) with a Stripe Checkout Session as the payment page. */
export async function startStripeCheckout(input: StripeCheckoutInput, ctx: StripeCheckoutContext): Promise<StripeCheckoutResult> {
  const stripe = ctx.deps.config.stripe;
  if (!stripe) return fail(503, { error: "payment_unavailable", message: `Online payment is not available right now. ${NOTHING_CHARGED}` });
  return startHoldFirstCheckout(input, ctx, stripeCheckoutAdapter(ctx.deps, stripe, { origin: ctx.origin, nowMs: ctx.nowMs, theme: input.theme }));
}

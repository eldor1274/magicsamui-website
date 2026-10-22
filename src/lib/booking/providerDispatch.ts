// Provider dispatch shared by the status and abandon requests (server): which provider finishes a
// hold-first booking (holdFirstProvider), the deps and gateway that provider's payments are finished with
// (providerDepsOf: deps.providerDeps, else the Stripe shorthand) and the payment key a request names itself
// (requestPaymentKey: the provider's id in the redirect, else the link token's).
//
// Moved verbatim out of status.ts (Beam design step S2.0) so that abandon.ts no longer imports status.ts,
// and through it beam.ts: both files import this one, and status.ts re-exports these names, so every
// existing import of them from status.ts keeps working. Since S2.6 requestPaymentKey reads `s` for Stripe
// only and checks a link token's id with gw.isPaymentId when the gateway has one (the Stripe gateway has
// none: its check is the Checkout Session id's, as before).

import type { BookingConfig } from "./config.ts";
import type { PaymentGateway } from "./payments/gateway.ts";
import { isSessionId } from "./payments/stripe.ts";
import { stripeGateway } from "./payments/stripeGateway.ts";
import { isHoldFirstMode, providerOf } from "./payments/provider.ts";
import type { ProviderDepsFn, StripeDeps } from "./stripeDeps.ts";
import { verifyBookingToken } from "./token.ts";
import type { BookingSummary, PaymentMode } from "./types.ts";

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

/**
 * An id in the shape the provider issues, as a request or a token names it (the bare id): gw.isPaymentId when
 * the gateway has one (Beam design S2.6), else a Checkout Session id for Stripe and nothing for any other provider.
 */
function isProviderPaymentId(gw: PaymentGateway, id: unknown): id is string {
  if (gw.isPaymentId) return gw.isPaymentId(id);
  return gw.provider === "stripe" && isSessionId(id);
}

/**
 * The payment key a return or cancel request names itself, before the
 * pointer msv:booking:{ref} is read: the provider's id in the redirect (s:
 * Stripe's {CHECKOUT_SESSION_ID}; read for Stripe only - no other provider
 * adds an id to its redirect), else the link token's (l) when that token is
 * this booking's. Only an id in the shape the provider issues counts. A token
 * carries the bare id; gw.keyOf makes the key (Beam: adds "beam:", money
 * review 14).
 */
export function requestPaymentKey(s: unknown, l: unknown, booking: BookingSummary, tokenSecret: string, gw: PaymentGateway, nowMs: number): string | null {
  if (gw.provider === "stripe" && isProviderPaymentId(gw, s)) return gw.keyOf(s);
  if (typeof l !== "string" || l === "") return null;
  const link = verifyBookingToken(l, tokenSecret, nowMs);
  if (!link.ok || link.payload.booking.ref !== booking.ref) return null;
  const id = link.payload.paymentLinkId;
  return isProviderPaymentId(gw, id) ? gw.keyOf(id) : null;
}

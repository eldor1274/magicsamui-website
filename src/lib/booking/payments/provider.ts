// Payment-provider facts shared by the server config and the browser.
// Isomorphic and secret-free.
//
// Providers: "stripe" (go-live, the owner's Stripe account that is already
// connected to Cloudbeds), "beam" (kept as a ready second provider - its live
// mode stays locked because Beam has no fulfilment yet) and "demo" (simulated).

import type { CardBrand, PaymentMethodBadge, PaymentMode, PaymentProvider } from "../types.ts";

export const PAYMENT_PROVIDERS: PaymentProvider[] = ["demo", "beam", "stripe"];

export function isPaymentProvider(v: unknown): v is PaymentProvider {
  return v === "demo" || v === "beam" || v === "stripe";
}

export function providerOf(mode: PaymentMode): PaymentProvider {
  if (mode === "demo") return "demo";
  if (mode === "beam-playground" || mode === "beam-live") return "beam";
  return "stripe";
}

/** Real money can move. */
export function isLiveMode(mode: PaymentMode): boolean {
  return mode === "beam-live" || mode === "stripe-live";
}

/** Provider test/sandbox mode (test cards only). */
export function isTestMode(mode: PaymentMode): boolean {
  return mode === "beam-playground" || mode === "stripe-test";
}

/** Stripe modes create a Cloudbeds hold before payment (hold-first) and need the guest's details. */
export function isHoldFirstMode(mode: PaymentMode): boolean {
  return providerOf(mode) === "stripe";
}

/**
 * Guest-facing "Payment processing fee" when BOOKING_CARD_FEE_PCT is unset.
 * Owner decision: 5% on Stripe (a Thai Stripe account costs about 5.1% on a
 * foreign card incl. VAT), 3% on Beam (cheaper), 3% in the demo.
 */
export const DEFAULT_FEE_PCT_BY_PROVIDER: Record<PaymentProvider, number> = {
  stripe: 5,
  beam: 3,
  demo: 3,
};

export function defaultCardFeePct(provider: PaymentProvider): number {
  return DEFAULT_FEE_PCT_BY_PROVIDER[provider];
}

/**
 * Card brands a Thai Stripe account accepts: Visa and Mastercard only (no
 * Amex, JCB or UnionPay). Beam accepts all five.
 */
export function acceptedCardBrands(provider: PaymentProvider): CardBrand[] {
  return provider === "stripe" ? ["visa", "mastercard"] : ["visa", "mastercard", "amex", "jcb", "unionpay"];
}

/** Badges to show. Apple Pay / Google Pay come through Stripe's card method. */
export function paymentMethodBadges(provider: PaymentProvider): PaymentMethodBadge[] {
  return provider === "stripe" ? ["card", "apple_pay", "google_pay", "promptpay"] : ["card", "promptpay"];
}

/** Hosts a booking page may redirect the browser to for payment (besides our own origin). */
export function paymentRedirectHosts(provider: PaymentProvider): string[] {
  if (provider === "stripe") return ["checkout.stripe.com"];
  if (provider === "beam") return ["pay.beamcheckout.com", "playground-pay.beamcheckout.com"];
  return [];
}

/** All payment-page hosts any provider may use (for a client-side redirect allow-list). */
export const ALL_PAYMENT_REDIRECT_HOSTS: string[] = ["checkout.stripe.com", "pay.beamcheckout.com", "playground-pay.beamcheckout.com"];

/** analytics `payment_type`. */
export function analyticsPaymentType(mode: PaymentMode): string {
  return providerOf(mode);
}

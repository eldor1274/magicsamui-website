// Payment-provider facts shared by the server config and the browser.
// Isomorphic and secret-free.
//
// Providers: "stripe" (go-live, the owner's Stripe account that is already
// connected to Cloudbeds), "beam" (kept as a ready second provider - its live
// mode stays locked because Beam has no fulfilment yet) and "demo" (simulated).

import type { CardBrand, PayMethod, PaymentMethodBadge, PaymentMode, PaymentProvider } from "../types.ts";

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

/**
 * The Stripe and Beam modes create a Cloudbeds hold before payment (hold-first) and need the guest's details (Beam
 * design S4.6; it agrees with config.ts rulesProviderOf: beam-playground and beam-live are hold-first, the demo -
 * BOOKING_PAYMENT_PROVIDER=beam without Beam keys included - is not).
 */
export function isHoldFirstMode(mode: PaymentMode): boolean {
  const provider = providerOf(mode);
  return provider === "stripe" || provider === "beam";
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
 * The largest single Beam payment, in satang: THB 200,000.00 per transaction for online checkout (Beam's written
 * answer, 26 Oct 2026). It is compared with the fee-inclusive amount charged (quote.dueNowSatang: Beam bookings are
 * paid in full). runCheckout refuses a larger stay before anything is held (OVER_MAX_CHARGE: message us on WhatsApp),
 * buildPaymentLinkRequest refuses such a link again, and the payment step says so before Pay (paymentCopy.ts
 * overMaxChargeNote). Here, in the isomorphic module, so the booking page reads the same number; beam.ts re-exports it.
 */
export const BEAM_MAX_CHARGE_SATANG = 20_000_000;

/** The card brands the Beam pages name (Beam design S3.1): its card group is all on or all off, these are the ones we show. */
export const BEAM_CARD_BRANDS: readonly CardBrand[] = ["visa", "mastercard", "jcb", "amex"];

/** Beam's e-wallet badges while BEAM_EWALLETS is on (owner decision 2); wechat_pay is added only with BEAM_WECHAT_PAY. */
export const BEAM_WALLET_BADGES: readonly PaymentMethodBadge[] = ["alipay", "line_pay", "truemoney", "shopeepay"];

/** The Beam method switches the badges follow (config.beam: BEAM_PROMPTPAY, BEAM_EWALLETS, BEAM_WECHAT_PAY). */
export interface BeamMethodSwitches {
  promptPay: boolean;
  ewallets: boolean;
  wechatPay: boolean;
}

/** The switches' defaults: PromptPay and the e-wallets on, WeChat Pay off until Beam approves it. */
export const BEAM_METHOD_DEFAULTS: BeamMethodSwitches = { promptPay: true, ewallets: true, wechatPay: false };

/**
 * Card brands shown per provider. A Thai Stripe account accepts Visa and
 * Mastercard only (no Amex, JCB or UnionPay); Beam: BEAM_CARD_BRANDS; the
 * demo (the simulated Beam page) keeps its five.
 */
export function acceptedCardBrands(provider: PaymentProvider): CardBrand[] {
  if (provider === "stripe") return ["visa", "mastercard"];
  if (provider === "beam") return [...BEAM_CARD_BRANDS];
  return ["visa", "mastercard", "amex", "jcb", "unionpay"];
}

/**
 * Badges to show. Apple Pay / Google Pay come through Stripe's card method.
 * Beam: card, promptpay while BEAM_PROMPTPAY is on, then the e-wallets while
 * BEAM_EWALLETS is on (wechat_pay too with BEAM_WECHAT_PAY). The demo: card, promptpay.
 */
export function paymentMethodBadges(provider: PaymentProvider, beam: BeamMethodSwitches | null = null): PaymentMethodBadge[] {
  if (provider === "stripe") return ["card", "apple_pay", "google_pay", "promptpay"];
  if (provider !== "beam") return ["card", "promptpay"];
  const s = beam ?? BEAM_METHOD_DEFAULTS;
  return [
    "card",
    ...(s.promptPay ? (["promptpay"] as const) : []),
    ...(s.ewallets ? [...BEAM_WALLET_BADGES, ...(s.wechatPay ? (["wechat_pay"] as const) : [])] : []),
  ];
}

/** Hosts a booking page may redirect the browser to for payment (besides our own origin). */
export function paymentRedirectHosts(provider: PaymentProvider): string[] {
  if (provider === "stripe") return ["checkout.stripe.com"];
  if (provider === "beam") return ["pay.beamcheckout.com", "playground-pay.beamcheckout.com"];
  return [];
}

/** All payment-page hosts any provider may use (for a client-side redirect allow-list). */
export const ALL_PAYMENT_REDIRECT_HOSTS: string[] = ["checkout.stripe.com", "pay.beamcheckout.com", "playground-pay.beamcheckout.com"];

/**
 * analytics `payment_type`: the provider ("stripe", "demo") as before; in a Beam mode the method group the guest chose
 * (design S5.2): "promptpay", else "card_or_ewallet".
 */
export function analyticsPaymentType(mode: PaymentMode, payMethod: PayMethod | null = null): string {
  const provider = providerOf(mode);
  if (provider !== "beam") return provider;
  return payMethod === "promptpay" ? "promptpay" : "card_or_ewallet";
}

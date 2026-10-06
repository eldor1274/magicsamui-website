// Guest-facing payment copy per provider (WI-9). Isomorphic and secret-free:
// the booking page, the summary, the secure-payment modal and the return page
// all word the payment step from the PUBLIC config, so no Stripe page ever
// mentions Beam and no Beam page mentions Stripe.
//
// The demo mode runs through the simulated Beam checkout, so it keeps Beam's
// wording (and its badges) - exactly what the preview showed before Stripe.

import type { CardBrand, PaymentMethodBadge, PaymentMode, PaymentProvider, PublicBookingConfig } from "./types.ts";

/** Plain-text badge labels (no brand artwork). */
export type PaymentMethodLabel = "Visa" | "Mastercard" | "JCB" | "Amex" | "UnionPay" | "PromptPay" | "Apple Pay" | "Google Pay";

const CARD_LABEL: Record<CardBrand, PaymentMethodLabel> = {
  visa: "Visa",
  mastercard: "Mastercard",
  jcb: "JCB",
  amex: "Amex",
  unionpay: "UnionPay",
};

/** Display order of the card brands (Beam's historical order). */
const CARD_ORDER: CardBrand[] = ["visa", "mastercard", "jcb", "amex", "unionpay"];

/** Which provider's checkout the guest actually sees ("demo" = the simulated Beam page). */
export function checkoutBrand(provider: PaymentProvider): "Stripe" | "Beam" {
  return provider === "stripe" ? "Stripe" : "Beam";
}

/**
 * Badges for the accepted methods, in a stable order: the card brands, then
 * PromptPay, then the wallets.
 * - Stripe (Thai account): Visa, Mastercard, PromptPay, Apple Pay, Google Pay.
 * - Beam / demo: Visa, Mastercard, JCB, Amex, UnionPay, PromptPay.
 */
export function paymentMethodLabels(config: Pick<PublicBookingConfig, "acceptedCardBrands" | "paymentMethods">): PaymentMethodLabel[] {
  const out: PaymentMethodLabel[] = [];
  const methods = new Set<PaymentMethodBadge>(config.paymentMethods);
  if (methods.has("card")) {
    for (const brand of CARD_ORDER) if (config.acceptedCardBrands.includes(brand)) out.push(CARD_LABEL[brand]);
  }
  if (methods.has("promptpay")) out.push("PromptPay");
  if (methods.has("apple_pay")) out.push("Apple Pay");
  if (methods.has("google_pay")) out.push("Google Pay");
  return out;
}

/** "A, B and C" */
export function joinList(items: string[], conjunction = "and"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

/** "Visa, Mastercard, Apple Pay, Google Pay or Thai PromptPay" - the ways a guest can pay. */
export function payWithText(config: Pick<PublicBookingConfig, "acceptedCardBrands" | "paymentMethods">): string {
  const labels = paymentMethodLabels(config).filter((l) => l !== "PromptPay");
  const methods = new Set(config.paymentMethods);
  const parts: string[] = [...labels];
  if (methods.has("promptpay")) parts.push("Thai PromptPay QR");
  return joinList(parts, "or");
}

/** The fields providerCopy() reads. */
export type CopyConfig = Pick<PublicBookingConfig, "provider" | "acceptedCardBrands" | "paymentMethods" | "holdMinutes">;

/** Wording outside the booking app (or before a config exists): the demo / Beam copy. */
export const DEMO_COPY_CONFIG: CopyConfig = { provider: "demo", acceptedCardBrands: [], paymentMethods: [], holdMinutes: 30 };

export interface ProviderCopy {
  /** "Stripe" | "Beam". */
  brand: "Stripe" | "Beam";
  /** Trust line under the summary CTA ("Secure payment by Stripe"). */
  secureLine: string;
  /** Payment step heading. */
  payHeading: string;
  /** Payment step explanation (what happens when Pay is pressed). */
  payExplainer: string;
  /** Pay button label suffix ("securely with Stripe"). */
  payButtonSuffix: string;
  /** Busy label while the checkout request runs. */
  busyLabel: string;
  /** Screen-reader announcement when Pay is pressed. */
  payAnnouncement: string;
  /** Explanation of the payment processing fee (summary info button). */
  feeExplainer: (pct: number) => string;
  /** Search-step perk ("Secure payment by Stripe" / methods). */
  perk: { title: string; text: string };
}

/** Copy for the payment step, summary and search perks. */
export function providerCopy(config: CopyConfig): ProviderCopy {
  const brand = checkoutBrand(config.provider);
  if (brand === "Stripe") {
    return {
      brand,
      secureLine: "Secure payment by Stripe",
      payHeading: "Pay securely with Stripe",
      payExplainer:
        `When you press Pay we reserve your room in our booking system and hold it for ${config.holdMinutes} minutes while you pay on ` +
        `Stripe's secure checkout - by ${payWithText(config)}. You then come straight back here with your booking reference. ` +
        "Card details are entered on Stripe's PCI DSS compliant page - never on our site.",
      payButtonSuffix: "securely with Stripe",
      busyLabel: "Reserving your room...",
      payAnnouncement: "Reserving your room and taking you to Stripe's secure payment page.",
      // Neutral wording: no claim about what the fee costs us (that differs by payment method).
      feeExplainer: (pct) =>
        `A ${pct}% payment processing fee applies to online payments (card, wallet or PromptPay). It is shown as its own line ` +
        "and already included in the total below - there are no other charges at checkout.",
      perk: { title: "Secure payment by Stripe", text: "Visa, Mastercard, Apple Pay, Google Pay or Thai PromptPay." },
    };
  }
  return {
    brand,
    secureLine: "Secure payment by Beam",
    payHeading: "Pay securely with Beam",
    payExplainer:
      "You'll go to Beam's secure payment page to pay by card or Thai PromptPay QR, then come straight back here with your booking " +
      "reference. Card details are entered on Beam's PCI DSS compliant page - never on our site.",
    payButtonSuffix: "securely with Beam",
    busyLabel: "Taking you to Beam...",
    payAnnouncement: "Taking you to Beam's secure payment page.",
    feeExplainer: (pct) =>
      `A ${pct}% payment processing fee applies to online payments (card or PromptPay). It is shown as its own line and ` +
      "already included in the total below - there are no other charges at checkout.",
    perk: { title: "Secure payment by Beam", text: "Cards from any country, or Thai PromptPay." },
  };
}

/** Short mode label for the preview banner and notes. */
export type ModeKind = "demo" | "mock" | "test" | "live";

export function modeKind(mode: PaymentMode): ModeKind {
  if (mode === "stripe-mock") return "mock";
  if (mode === "beam-playground" || mode === "stripe-test") return "test";
  if (mode === "beam-live" || mode === "stripe-live") return "live";
  return "demo";
}

export type DataSourceLabel = "demo" | "cloudbeds" | "demo-fallback";

/**
 * One honest sentence for the preview banner: provider, mode and where
 * availability comes from (and whether a reservation is really written).
 */
export function previewHeadline(input: {
  paymentMode: PaymentMode;
  dataSource: DataSourceLabel | null;
  cloudbedsWrites?: "live" | "mock" | "none";
}): string {
  const live = input.dataSource === "cloudbeds";
  switch (input.paymentMode) {
    case "demo":
      return live
        ? "demo mode: live Cloudbeds availability, simulated payment - no real payment is taken."
        : "demo mode: availability and prices are simulated, no real payment is taken.";
    case "beam-playground":
      return live
        ? "Beam test mode: live Cloudbeds availability, payments go to Beam's playground - use Beam test cards only, no real money moves."
        : "Beam test mode: simulated availability, payments go to Beam's playground - use Beam test cards only, no real money moves.";
    case "beam-live":
      return "LIVE payments: real cards are charged through Beam.";
    case "stripe-mock":
      return "MOCK mode: fake Stripe checkout and a simulated Cloudbeds reservation - nothing is charged or reserved.";
    case "stripe-test":
      if (input.cloudbedsWrites === "live") {
        return (
          "Stripe test mode: test cards only, no real money moves - but a REAL Cloudbeds reservation is held and confirmed or " +
          "cancelled. Test bookings need an arrival 12+ months ahead and the owner's test email."
        );
      }
      return live
        ? "Stripe test mode: live Cloudbeds availability, Stripe test cards only (no real money moves); the reservation is simulated."
        : "Stripe test mode: simulated availability, Stripe test cards only (no real money moves); the reservation is simulated.";
    case "stripe-live":
      return "LIVE payments: real cards are charged through Stripe and real reservations are made in Cloudbeds.";
  }
}

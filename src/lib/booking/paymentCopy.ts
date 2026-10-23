// Guest-facing payment copy per provider (WI-9). Isomorphic and secret-free:
// the booking page, the summary, the secure-payment modal and the return page
// all word the payment step from the PUBLIC config, so no Stripe page ever
// mentions Beam and no Beam page mentions Stripe.
//
// The demo mode runs through the simulated Beam checkout, so it keeps Beam's
// wording (and its badges) - exactly what the preview showed before Stripe.
// A Beam page that asks the guest how to pay (quote.ts pageOffersMethodChoice:
// the hold-first Beam modes and a locked Beam page) has its own wording (Beam
// design S5.2): the card/e-wallet and PromptPay choice, the fee by method, the
// hold, and no receipt promise. Stripe and the demo keep theirs exactly.

import { formatThbWithCode } from "./format.ts";
import { pageOffersMethodChoice, pagePayMethod, pagePayMethods } from "./quote.ts";
import type { CardBrand, PayMethod, PaymentMethodBadge, PaymentMode, PaymentProvider, PublicBookingConfig } from "./types.ts";

/** Plain-text badge labels (no brand artwork). */
export type PaymentMethodLabel =
  | "Visa"
  | "Mastercard"
  | "JCB"
  | "Amex"
  | "UnionPay"
  | "PromptPay"
  | "Apple Pay"
  | "Google Pay"
  | "Alipay"
  | "LINE Pay"
  | "TrueMoney"
  | "ShopeePay"
  | "WeChat Pay";

const CARD_LABEL: Record<CardBrand, PaymentMethodLabel> = {
  visa: "Visa",
  mastercard: "Mastercard",
  jcb: "JCB",
  amex: "Amex",
  unionpay: "UnionPay",
};

/** Display order of the card brands (Beam's historical order). */
const CARD_ORDER: CardBrand[] = ["visa", "mastercard", "jcb", "amex", "unionpay"];

/** Card brands as sentences name them ("American Express", where the badge says "Amex"). */
const CARD_NAME: Record<CardBrand, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  jcb: "JCB",
  amex: "American Express",
  unionpay: "UnionPay",
};

/** Beam's e-wallets in display order (badge and sentence alike): the order of provider.ts BEAM_WALLET_BADGES, then WeChat Pay. */
const WALLETS: [PaymentMethodBadge, PaymentMethodLabel][] = [
  ["alipay", "Alipay"],
  ["line_pay", "LINE Pay"],
  ["truemoney", "TrueMoney"],
  ["shopeepay", "ShopeePay"],
  ["wechat_pay", "WeChat Pay"],
];

/** Which provider's checkout the guest actually sees ("demo" = the simulated Beam page). */
export function checkoutBrand(provider: PaymentProvider): "Stripe" | "Beam" {
  return provider === "stripe" ? "Stripe" : "Beam";
}

/**
 * Badges for the accepted methods, in a stable order: the card brands, then
 * PromptPay, then the wallets.
 * - Stripe (Thai account): Visa, Mastercard, PromptPay, Apple Pay, Google Pay.
 * - Beam (design S5.2): Visa, Mastercard, JCB, Amex, PromptPay (BEAM_PROMPTPAY), then its e-wallets while
 *   BEAM_EWALLETS is on: Alipay, LINE Pay, TrueMoney, ShopeePay (and WeChat Pay with BEAM_WECHAT_PAY).
 * - The demo: Visa, Mastercard, JCB, Amex, UnionPay, PromptPay.
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
  for (const [badge, label] of WALLETS) if (methods.has(badge)) out.push(label);
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

/** The fields providerCopy() reads (feeByMethod: Beam only - a page with it asks how to pay, design S5.2). */
export type CopyConfig = Pick<PublicBookingConfig, "provider" | "acceptedCardBrands" | "paymentMethods" | "holdMinutes"> &
  Partial<Pick<PublicBookingConfig, "feeByMethod">>;

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
  if (pageOffersMethodChoice(config)) return beamChoiceCopy(config);
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

/* ------------------- Beam: how the guest pays (design S5.2) ------------------- */

/** The public fields the Beam method-choice copy reads. */
export type MethodCopyConfig = Pick<PublicBookingConfig, "provider" | "acceptedCardBrands" | "paymentMethods"> &
  Partial<Pick<PublicBookingConfig, "feeByMethod">>;

/** What a Beam method-choice page offers, as its copy names it. */
interface BeamPayFacts {
  /** Card brands in sentence form ("American Express"). */
  cards: string[];
  /** The e-wallets on the page (BEAM_EWALLETS, WeChat Pay with BEAM_WECHAT_PAY); [] while they are off. */
  wallets: string[];
  /** The card/e-wallet group's fee %. */
  cardFeePct: number;
  /** PromptPay's fee %, or null while PromptPay is not offered (BEAM_PROMPTPAY=off). */
  promptPayFeePct: number | null;
}

function beamPayFacts(config: MethodCopyConfig): BeamPayFacts {
  const methods = new Set(config.paymentMethods);
  const fees = new Map(pagePayMethods(config).map((m) => [m.method, m.feePct]));
  return {
    cards: CARD_ORDER.filter((b) => config.acceptedCardBrands.includes(b)).map((b) => CARD_NAME[b]),
    wallets: WALLETS.filter(([badge]) => methods.has(badge)).map(([, label]) => label),
    cardFeePct: fees.get("card_ewallet") ?? 0,
    promptPayFeePct: fees.get("promptpay") ?? null,
  };
}

/** "card or e-wallet", or "card" while the e-wallets are off. */
function cardGroupWords(f: BeamPayFacts): string {
  return f.wallets.length > 0 ? "card or e-wallet" : "card";
}

/** "3% payment processing fee." or "No fee." */
function feeSentence(pct: number): string {
  return pct > 0 ? `${pct}% payment processing fee.` : "No fee.";
}

/**
 * Who pays the fee, in one or two sentences ("A 3% payment processing fee applies when you pay by card or e-wallet. Thai
 * PromptPay QR has no fee."). True for every method the page offers: no PromptPay sentence while PromptPay is off, no
 * e-wallets while they are off, and BEAM_PROMPTPAY_FEE_PCT or BOOKING_CARD_FEE_PCT overrides named as they are.
 */
function beamFeeRule(f: BeamPayFacts): string {
  const card = f.cardFeePct;
  const pp = f.promptPayFeePct;
  const words = cardGroupWords(f);
  if (card > 0) {
    if (pp === null) return `A ${card}% payment processing fee applies when you pay by ${words}.`;
    if (pp === card) return `A ${card}% payment processing fee applies to every online payment.`;
    if (pp === 0) return `A ${card}% payment processing fee applies when you pay by ${words}. Thai PromptPay QR has no fee.`;
    return `A ${card}% payment processing fee applies when you pay by ${words}, and ${pp}% with Thai PromptPay QR.`;
  }
  if (pp !== null && pp > 0) return `A ${pp}% payment processing fee applies when you pay with Thai PromptPay QR. Paying by ${words} has no fee.`;
  return "There is no payment processing fee.";
}

/** The Beam method-choice page's payment step, summary and search perk copy (providerCopy). */
function beamChoiceCopy(config: CopyConfig): ProviderCopy {
  const f = beamPayFacts(config);
  const ways = ["Cards from any country", ...(f.wallets.length > 0 ? ["e-wallets"] : []), ...(f.promptPayFeePct !== null ? ["Thai PromptPay QR"] : [])];
  return {
    brand: "Beam",
    secureLine: "Secure payment by Beam",
    payHeading: "Pay securely with Beam",
    payExplainer:
      `When you press Pay we reserve your room in our booking system and hold it for ${config.holdMinutes} minutes while you pay on ` +
      "Beam's secure payment page. You then come straight back here with your booking reference. Card details are entered on " +
      "Beam's PCI DSS compliant page - never on our site.",
    payButtonSuffix: "securely with Beam",
    busyLabel: "Reserving your room...",
    payAnnouncement: "Reserving your room and taking you to Beam's secure payment page.",
    // The page's own fees by method (feeByMethod), whichever line the summary shows.
    feeExplainer: () =>
      `${beamFeeRule(f)} It is shown as its own line and already included in the total below - there are no other charges at checkout.`,
    perk: { title: "Secure payment by Beam", text: `${joinList(ways, "or")}.` },
  };
}

/** One radio of the Beam payment step's "How would you like to pay?" choice. */
export interface PayMethodOption {
  method: PayMethod;
  /** "Card or e-wallet" ("Card" while the e-wallets are off) | "Thai PromptPay QR". */
  title: string;
  /** "Visa, Mastercard, JCB, American Express, Alipay, LINE Pay, TrueMoney or ShopeePay. 3% payment processing fee." */
  description: string;
  /** The group's payment processing fee (feeByMethod). */
  feePct: number;
}

/**
 * The payment method groups a Beam page offers, in order (design S5.2): card or e-wallet, then Thai PromptPay QR while
 * BEAM_PROMPTPAY is on. [] on every Stripe and demo page (no choice is shown there).
 */
export function payMethodOptions(config: MethodCopyConfig): PayMethodOption[] {
  if (!pageOffersMethodChoice(config)) return [];
  const f = beamPayFacts(config);
  const out: PayMethodOption[] = [
    {
      method: "card_ewallet",
      title: f.wallets.length > 0 ? "Card or e-wallet" : "Card",
      description: `${joinList([...f.cards, ...f.wallets], "or")}. ${feeSentence(f.cardFeePct)}`,
      feePct: f.cardFeePct,
    },
  ];
  if (f.promptPayFeePct !== null) {
    out.push({
      method: "promptpay",
      title: "Thai PromptPay QR",
      description: `Scan with any Thai banking app. ${feeSentence(f.promptPayFeePct)}`,
      feePct: f.promptPayFeePct,
    });
  }
  return out;
}

/** The amount on the right of a method's radio: "+ THB 393.00" (its fee for this stay), or "No fee". */
export function payMethodFeeLabel(feeSatang: number): string {
  return feeSatang > 0 ? `+ ${formatThbWithCode(feeSatang)}` : "No fee";
}

/** Under the Beam method choice once Thai PromptPay QR is chosen (guest copy promptPayHint). */
export const PROMPTPAY_HINT = "Scan the QR in your banking app. The bank's confirmation can take a few minutes - please don't pay twice.";

/** Under the Beam method choice while no method is chosen (the Pay button says nothing until then). */
export const CHOOSE_METHOD_HINT = "Choose how you'd like to pay to continue.";

/**
 * Next to the fee line before a method is chosen (design S5.2): the summary shows the card/e-wallet total, so "No fee
 * with Thai PromptPay QR" says how it can be lower - a total never rises after the choice. null once a method is
 * chosen, while PromptPay is off or has a fee, and on every Stripe and demo page.
 */
export function noFeeAlternative(config: MethodCopyConfig, payMethod: unknown): string | null {
  if (!pageOffersMethodChoice(config) || pagePayMethod(config, payMethod) !== null) return null;
  const f = beamPayFacts(config);
  return f.cardFeePct > 0 && f.promptPayFeePct === 0 ? "No fee with Thai PromptPay QR" : null;
}

/**
 * Whether the summary leaves out its "Payment processing fee" line (design S5.2: hidden when the fee is 0, e.g. Thai
 * PromptPay QR). Only on a Beam method-choice page: Stripe and the demo show their line exactly as before.
 */
export function feeLineHidden(config: MethodCopyConfig, quote: { cardFeeSatang: number }): boolean {
  return pageOffersMethodChoice(config) && quote.cardFeeSatang === 0;
}

/** The fee notes of the results step on a Beam method-choice page (null fields: no fee to mention). */
export interface ResultsFeeNotes {
  /** Under each rate's price: "+ 3% payment processing fee by card or e-wallet (none with PromptPay)". */
  card: string | null;
  /** The results header: "Prices are for the stay; a 3% payment processing fee is added when you pay by card or e-wallet (none with PromptPay)." */
  results: string | null;
}

/**
 * The results step's fee notes on a Beam method-choice page (design S5.2), or null on every Stripe and demo page (their
 * room cards and header keep "+ X% payment processing fee" and "... added to every online payment." exactly).
 */
export function resultsFeeNotes(config: MethodCopyConfig): ResultsFeeNotes | null {
  if (!pageOffersMethodChoice(config)) return null;
  const f = beamPayFacts(config);
  const card = f.cardFeePct;
  const pp = f.promptPayFeePct;
  const words = cardGroupWords(f);
  if (card > 0) {
    if (pp === null || pp === card) {
      return { card: `+ ${card}% payment processing fee`, results: `Prices are for the stay; a ${card}% payment processing fee is added to every online payment.` };
    }
    const other = pp === 0 ? "none" : `${pp}%`;
    return {
      card: `+ ${card}% payment processing fee by ${words} (${other} with PromptPay)`,
      results: `Prices are for the stay; a ${card}% payment processing fee is added when you pay by ${words} (${other} with PromptPay).`,
    };
  }
  if (pp !== null && pp > 0) {
    return {
      card: `+ ${pp}% payment processing fee with PromptPay (none by ${words})`,
      results: `Prices are for the stay; a ${pp}% payment processing fee is added when you pay with Thai PromptPay QR (none by ${words}).`,
    };
  }
  return { card: null, results: null };
}

/** One point of the Beam secure-payment window ("Learn more"); `kind` picks its icon. */
export interface SecurePaymentPoint {
  kind: "card" | "wallet" | "promptpay" | "lock" | "hold";
  title: string;
  body: string;
}

/**
 * The secure-payment window's points and fee note on a Beam method-choice page (design S5.2): the cards, the e-wallets
 * and Thai PromptPay QR the page offers, card details on Beam's page, and the room held while the guest pays. null on
 * every Stripe and demo page (they keep their own points).
 */
export function beamSecurePayment(config: MethodCopyConfig & Pick<PublicBookingConfig, "holdMinutes">): { points: SecurePaymentPoint[]; feeNote: string } | null {
  if (!pageOffersMethodChoice(config)) return null;
  const f = beamPayFacts(config);
  const points: SecurePaymentPoint[] = [
    {
      kind: "card",
      title: "Cards, including overseas cards",
      body: `${joinList(f.cards)} issued in Thailand or abroad. Your bank may convert the Thai baht amount to your currency.`,
    },
  ];
  if (f.wallets.length > 0) points.push({ kind: "wallet", title: "E-wallets", body: `Pay with ${joinList(f.wallets, "or")} on Beam's page.` });
  if (f.promptPayFeePct !== null) {
    points.push({
      kind: "promptpay",
      title: "Thai PromptPay QR",
      body: `Scan the QR code with any Thai banking app. ${feeSentence(f.promptPayFeePct)} The bank's confirmation can take a few minutes - please don't pay twice.`,
    });
  }
  points.push(
    {
      kind: "lock",
      title: "Card details never touch our site",
      body: "You enter them on Beam's PCI DSS compliant hosted payment page. We never see or store your card number.",
    },
    {
      kind: "hold",
      title: "Your room is held while you pay",
      body: `We reserve your room before you pay and hold it for ${config.holdMinutes} minutes. If you cancel or the time runs out, nothing is charged and the room is released. 3-D Secure checks by your bank happen on Beam's page.`,
    },
  );
  return { points, feeNote: `${beamFeeRule(f)} It is shown as its own line in your reservation summary before you pay - no hidden charges.` };
}

/** The fields guestStepCopy() reads. */
export type GuestStepCopyConfig = Pick<PublicBookingConfig, "provider" | "live" | "requiresGuestDetails" | "sendsBookingConfirmationEmail">;

/**
 * The guest-details step's email hint and the note under its Continue button (`config` undefined: no booking
 * context). Stripe and the demo keep their words exactly. A hold-first Beam page (requiresGuestDetails) sends the
 * details to our reservation system only - Beam gets no name, email or phone from us - and promises no receipt:
 * Beam sends none, the Cloudbeds confirmation email is the guest's written confirmation (owner decision 6; beam-live
 * checkout requires it) - Beam design S5.1.
 */
export function guestStepCopy(config: GuestStepCopyConfig | undefined): { emailHint: string; detailsNote: string } {
  // Only a live booking sends a confirmation; the preview modes say what would happen.
  const live = config?.live === true;
  const stripe = config?.provider === "stripe";
  // Stripe: Cloudbeds only emails a confirmation when CLOUDBEDS_SEND_STATUS_EMAIL is on; otherwise the receipt is the only email.
  const stripeEmails = config?.sendsBookingConfirmationEmail ? "payment receipt and booking confirmation are" : "payment receipt is";
  const emailHint = stripe
    ? live
      ? `Your ${stripeEmails} sent here.`
      : `In live mode your ${stripeEmails} sent here.`
    : live
      ? "Your booking confirmation is sent here."
      : "In live mode your booking confirmation is sent here.";
  const detailsNote =
    config?.requiresGuestDetails === true
      ? config.provider === "beam"
        ? "When you press Pay, your details go securely to our reservation system to hold your room. Nothing is charged until you pay."
        : "When you press Pay, your details go securely to our reservation system to hold your room, and your email to Stripe for your receipt. Nothing is charged until you pay."
      : "Preview: your details stay in this browser and are not sent anywhere. Nothing is booked until you pay.";
  return { emailHint, detailsNote };
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

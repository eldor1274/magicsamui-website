// The payment-gateway seam of the hold-first flow (fulfil, release, abandon,
// sweep, status). Server only. Types only: the provider adapters implement
// them (stripeGateway.ts wraps payments/stripe.ts without changing it).
//
// - A payment is named by its KEY: the id every Redis key of the flow is built
//   from (msv:done:fulfil:{key}, msv:paid:session:{key}, the msv:paid:res value,
//   the paid-index member). Stripe's key is the Checkout Session id itself, so
//   every live Stripe key keeps its exact name.
// - get(key) always re-reads the payment from the provider (never trust a
//   caller or a payload) and answers in one normalised shape; meta is null when
//   the payment is not one of ours or belongs to the other mode (test vs live).
// - text holds every provider-specific word the shared code writes into
//   Cloudbeds notes, payment descriptions and owner alerts.

import type { PaymentProvider } from "../types.ts";
import type { SessionMeta } from "./stripe.ts";

/** What a payment carries about its booking (no personal data): the shape of Stripe's session metadata. */
export type PaymentMeta = SessionMeta;

/**
 * open: the guest can still pay. processing: a payment is pending (e.g. a
 * delayed method). paid: money taken. failed: the payment failed. expired: it
 * can never be paid. refunded: paid, then refunded at the provider.
 */
export type GatewayState = "open" | "processing" | "paid" | "failed" | "expired" | "refunded";

/** The provider's ids for the folio and the alerts (meaningful once paid). */
export interface GatewayReceipt {
  /** The id quoted in notes and alerts (Stripe: the PaymentIntent id); null while there is none. */
  primaryId: string | null;
  /** The provider's ids as they open the Cloudbeds payment description (no TEST label, no ref). */
  description: string;
  /** The payment method the guest used, when the provider reports it. */
  methodType?: string;
  /** Whether the provider can refund it through its API, when known. */
  refundable?: boolean;
  /** Whether a partial refund is possible, when known. */
  partialRefundable?: boolean;
}

export interface GatewayPayment {
  key: string;
  /** The provider's own id of the payment (Stripe: the Checkout Session id = the key). */
  paymentId: string;
  state: GatewayState;
  /** null = not one of ours, or the other mode's (test vs live). */
  meta: PaymentMeta | null;
  /** The amount and currency exactly as the provider reports them (alerts quote them as they are). */
  amountSatang: number | null;
  currency: string | null;
  /** A payment was started on the provider's page (Stripe: the session has a PaymentIntent). */
  attempted: boolean;
  receipt: GatewayReceipt;
}

/** The fee line's Cloudbeds item (see fulfil.ts feeItemFor: Cloudbeds keeps the first name/note an appItemID gets). */
export interface FeeItem {
  appItemId: string;
  itemSku: string;
  name: string;
  note: string;
}

/** Every provider-specific word in what fulfil, release, sweep and their alerts write. */
export interface GatewayText {
  /** The paid note's opening after "PAID ": "via Stripe pi_… (THB 18,900.00)". `amount` is already formatted. */
  paidVia(receipt: GatewayReceipt, amount: string): string;
  /** The Cloudbeds payment description after the TEST label: "Stripe pi_… charge ch_… session cs_… ref MSV-…". */
  paymentDescription(receipt: GatewayReceipt, ref: string): string;
  /**
   * The provider's payment page in alerts. long follows the brand ("Stripe Checkout Session cs_…");
   * short follows the brand or stands alone ("Stripe session cs_…", "session cs_…").
   */
  sessionLabel: { long: string; short: string };
  /** Where the owner refunds, after "refund ": "in Stripe". */
  refundWhere: string;
  /** The env var holding the Cloudbeds payment method for this provider's money. */
  methodEnvVar: string;
  /** Its variant for test money (outside live). */
  testMethodEnvVar: string;
  feeItem(mode: string): FeeItem;
  /** The fee line's name, as alerts quote it. */
  feeItemName: string;
  /** The Cloudbeds note when the sweeper gives a hold back: what the guest's payment page did. */
  releaseNoteText(payments: Pick<GatewayPayment, "state" | "attempted">[]): string;
  /** Who retries a paid booking besides the return page and the sweeper: "Stripe webhook retries". */
  webhookRetryHint: string;
}

export interface PaymentGateway {
  provider: Exclude<PaymentProvider, "demo">;
  /** The provider's name in notes and alerts ("Stripe"). */
  brand: string;
  /** Redis key of a provider payment id, and back. */
  keyOf(paymentId: string): string;
  idOf(key: string): string;
  /** Re-reads the payment from the provider. Throws on network/5xx and on a payment the provider does not know (see isMissing). */
  get(key: string): Promise<GatewayPayment>;
  /**
   * Makes the payment page unpayable (Stripe: expires the session). not_open: it
   * was no longer open (paid, expired, or unknown). Throws on network/5xx.
   */
  cancel(key: string): Promise<"cancelled" | "not_open">;
  /** The provider answered that the payment does not exist (in this account and mode): it can never be paid. */
  isMissing(e: unknown): boolean;
  text: GatewayText;
}

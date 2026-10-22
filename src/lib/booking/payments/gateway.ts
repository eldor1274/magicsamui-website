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
// - sweepRecent lists the provider's recent payments of ours for the
//   sweeper's step 1 (sweep.ts), which fulfils or releases them itself.
// - Every optional member (Beam design steps S2.5 and S2.6) is a hook the
//   Stripe gateway does not set: the shared code then does exactly what it did
//   before the hook existed, so each Stripe call, text, KV write and TTL stays
//   the same.

import type { AlertSeverity } from "../stripeDeps.ts";
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
  /**
   * The provider's payment disagrees with our own record of the booking (amount, currency, ref, merchant), or
   * can't be settled automatically (Beam: a refunded link with several successful charges). A whole sentence
   * for the owner: fulfil hands the payment to the owner with it as the needs_attention reason (money review
   * 2), never "not ours". Never set by Stripe.
   */
  mismatch?: string;
  /**
   * Why a payment is not settled yet. processing: still being confirmed. unconfirmed: the payment window is
   * over (state "expired") but a payment was still waiting for the bank's answer after the grace: the hold
   * is released, but the guest is told not to pay again (money review 8). Never set by Stripe.
   */
  pendingReason?: "processing" | "unconfirmed";
}

/** One payment of ours (this mode) the provider lists for the sweeper's step 1. */
export interface RecentPayment {
  key: string;
  /** The Cloudbeds hold it was created for, as the provider's own copy of the booking names it. */
  reservationId: string;
  /** The listing already reports it paid: a failure to finish it then alerts as a paid booking's. */
  listedPaid: boolean;
  /**
   * The payment in the gateway's shape. Re-reads it from the provider only when the listing can't tell its
   * state (Stripe: a complete but unpaid session, whose PaymentIntent the list does not expand).
   */
  read(): Promise<GatewayPayment>;
}

/** The fee line's Cloudbeds item (see fulfil.ts feeItemFor: Cloudbeds keeps the first name/note an appItemID gets). */
export interface FeeItem {
  appItemId: string;
  itemSku: string;
  name: string;
  note: string;
}

/** An owner alert in a gateway's words: deps.alert's arguments. */
export interface GatewayAlert {
  subject: string;
  lines: string[];
  /** De-duplicates repeats (deps.alert's key). */
  key: string;
  severity: AlertSeverity;
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
  /**
   * The refund instruction for this payment's method, after "refund " (instead of refundWhere) in the
   * needs_attention reasons of a paid booking whose hold is already cancelled before the fee line (step 5),
   * or is no longer pending or confirmed at the confirm step (step 7: e.g. cancelled by a release that raced
   * the payment) - owner decisions 3 and 4. Absent (Stripe): refundWhere.
   */
  refundHow?(receipt: GatewayReceipt): string;
  /** The env var holding the Cloudbeds payment method for this provider's money. */
  methodEnvVar: string;
  /** Its variant for test money (outside live). */
  testMethodEnvVar: string;
  /** The fee line's Cloudbeds item for a payment mode (live and test each have their own). */
  feeItem(mode: string): FeeItem;
  /** The fee line's name, as alerts quote it. */
  feeItemName: string;
  /** The Cloudbeds note when the sweeper gives a hold back: what the guest's payment page did. */
  releaseNoteText(payments: Pick<GatewayPayment, "state" | "attempted" | "pendingReason">[]): string;
  /** Who retries a paid booking besides the return page and the sweeper: "Stripe webhook retries". */
  webhookRetryHint: string;
  /** postPayment's type with the MOCK Cloudbeds writer when no method is configured. Absent (Stripe): "mock-stripe". */
  mockMethod?: string;
  /** One more line for the "New direct booking" alert (Beam: the method's refund path, owner decision 4). Absent (Stripe): none. */
  bookedExtra?(receipt: GatewayReceipt): string;
  /**
   * The owner's warning once a hold was released while its payment was still unconfirmed (pendingReason
   * "unconfirmed"): it may succeed later (fulfil.ts afterPaymentReleased). Absent (Stripe): no alert.
   */
  pendingReleasedAlert?(payment: GatewayPayment, reservationId: string): GatewayAlert;
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
  /**
   * The provider's payments of ours (this mode) created since sinceMs, for the sweeper's step 1 (Stripe: the
   * Checkout Sessions of the lookback window, foreign and other-mode ones left out). Throws on network/5xx.
   */
  sweepRecent(sinceMs: number): Promise<RecentPayment[]>;
  text: GatewayText;
  /**
   * TTL (seconds) of every marker fulfil writes for this provider's payments: the done marker, the paid
   * markers and the step markers. Absent (Stripe): lock.ts DONE_TTL_SECONDS (30 days). Beam:
   * BEAM_RECORD_TTL_SECONDS (708 days), so a webhook arriving months later can never run fulfil again on a
   * finished booking.
   */
  doneTtlSeconds?: number;
  /**
   * A fresh look at the provider inside the release lock, right before the Cloudbeds cancel (releaseHold's
   * stillReleasable): true only while the payment still can never be paid. false keeps the hold
   * (refused_open; money review 9). Absent (Stripe): no such look.
   */
  releaseGuard?(key: string): Promise<boolean>;
  /** Parses the thirdPartyIdentifier of this provider's holds. Absent (Stripe): lock.ts parseHoldIdentifier. */
  parseHoldId?(id: string | null | undefined): { ref: string; live: boolean } | null;
  /**
   * An id in the shape this provider issues, as a request or a token names it (the bare id: keyOf adds any
   * prefix). Absent (Stripe): the Checkout Session id check.
   */
  isPaymentId?(id: unknown): id is string;
}

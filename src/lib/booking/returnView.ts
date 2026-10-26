// Which view the return page shows for a verified status (WI-7), and whether
// it keeps polling. Pure and isomorphic so the rules are unit-tested:
//
//   paid + confirmed (or not_applicable: demo)       -> "paid"        success
//   paid + confirming                                -> "confirming"  "Payment received - confirming your booking", poll
//   paid + needs_attention                           -> "attention"   "Payment received - we'll contact you" (never "try again")
//   pending                                          -> "pending"     waiting for the payment, poll
//   failed AMOUNT_OR_REFERENCE_MISMATCH              -> "mismatch"    contact us (never "try again")
//   expired / cancelled / failed / refunded          -> "unpaid"      explain; "Try again" except refunded
//
// A paid answer is NEVER offered "Try again": that would be a second charge.
//
// The views' words that depend on the provider live here too (pure, so returnCopy.test.ts can check them in every
// mode): the unpaid views' title and text per provider, and Beam's own words on the paid and pending views (design
// S5.3; Stripe and the demo keep the words in components/booking/return/ReturnStatus.tsx).

import { isHoldFirstMode, isLiveMode, providerOf } from "./payments/provider.ts";
import type { PaymentMode, PaymentStatus, StatusResponse } from "./types.ts";

export type ReturnViewKind = "paid" | "confirming" | "attention" | "pending" | "mismatch" | "unpaid";

export const MISMATCH_FAILURE = "AMOUNT_OR_REFERENCE_MISMATCH";

export function returnViewKind(result: Pick<StatusResponse, "status" | "failureCode" | "fulfilment">): ReturnViewKind {
  if (result.status === "paid") {
    if (result.fulfilment.state === "confirming") return "confirming";
    if (result.fulfilment.state === "needs_attention" || result.fulfilment.state === "released") return "attention";
    return "paid";
  }
  if (result.status === "pending") return "pending";
  if (result.status === "failed" && result.failureCode === MISMATCH_FAILURE) return "mismatch";
  return "unpaid";
}

/** "Try again" (a new payment) is only safe for these. */
export function canRetryPayment(result: Pick<StatusResponse, "status" | "failureCode" | "fulfilment">): boolean {
  return returnViewKind(result) === "unpaid" && result.status !== "refunded";
}

/** Views that keep checking the server automatically. */
export function isPollingView(kind: ReturnViewKind): boolean {
  return kind === "pending" || kind === "confirming";
}

export interface PollPlan {
  /** Delay before the first check (ms). */
  firstMs: number;
  /** Delay before check number `attempt` (1-based, after the first). */
  nextMs: (attempt: number) => number;
  /** Stop automatic checks after this long (ms); the page then offers "Check again". */
  maxMs: number;
}

/** Beam's first check (ms), the growth of each later wait, the longest wait and how long it keeps checking (design S5.1). */
export const BEAM_POLL_FIRST_MS = 2_000;
export const BEAM_POLL_GROWTH = 1.5;
export const BEAM_POLL_MAX_WAIT_MS = 15_000;
export const BEAM_POLL_MAX_MS = 15 * 60_000;

/**
 * Stripe: a steady ~3 s poll (the webhook usually lands within seconds; a
 * PromptPay or delayed payment can take longer) for up to 3 minutes.
 * Beam (beam-playground, beam-live; design S5.1, gap review 14): the first check
 * after 2 s, then each wait x1.5 (3 s, 4.5 s, 6.75 s, 10.1 s) up to 15 s, for 15
 * minutes - a PromptPay or 3-D Secure confirmation can take minutes, and the
 * browser reports the purchase once it is confirmed.
 * The demo: the original backoff (1 s, 2 s, 4 s ... capped at 30 s, about 2 minutes).
 */
export function pollPlan(result: Pick<StatusResponse, "paymentMode">): PollPlan {
  const provider = providerOf(result.paymentMode);
  if (provider === "stripe") {
    return { firstMs: 2_000, nextMs: () => 3_000, maxMs: 180_000 };
  }
  if (provider === "beam") {
    return {
      firstMs: BEAM_POLL_FIRST_MS,
      nextMs: (attempt) => Math.min(Math.round(BEAM_POLL_FIRST_MS * BEAM_POLL_GROWTH ** attempt), BEAM_POLL_MAX_WAIT_MS),
      maxMs: BEAM_POLL_MAX_MS,
    };
  }
  return { firstMs: 1_000, nextMs: (attempt) => Math.min(2_000 * 2 ** (attempt - 1), 30_000), maxMs: 120_000 };
}

export const UNPAID_REASON: Record<Exclude<PaymentStatus, "paid" | "pending">, "failed" | "expired" | "cancelled"> = {
  failed: "failed",
  expired: "expired",
  cancelled: "cancelled",
  refunded: "failed",
};

/* -------------------------------- the views' words -------------------------------- */

export type UnpaidStatus = Exclude<PaymentStatus, "paid" | "pending">;

/** A view's title and text. */
export interface ViewCopy {
  title: string;
  body: string;
}

/** The demo's words: its simulated page holds no room. */
export const UNPAID_COPY: Record<UnpaidStatus, ViewCopy> = {
  failed: { title: "Payment didn't go through", body: "Nothing has been charged. You can try again with another card or PromptPay." },
  expired: {
    title: "Payment link expired",
    body: "Payment links last 30 minutes. Nothing has been charged - start the payment again when you're ready.",
  },
  cancelled: { title: "Payment cancelled", body: "Nothing has been charged. Your reservation details are still saved in this browser." },
  refunded: { title: "Payment refunded", body: "This payment has been refunded. Message us if you weren't expecting this." },
};

/** Stripe wording: the room was held while the guest paid, and is released when the payment doesn't happen. */
export const STRIPE_UNPAID_COPY: Record<UnpaidStatus, ViewCopy> = {
  failed: {
    title: "Payment didn't go through",
    body: "Nothing has been charged and the room hold was released. You can try again with another card, a wallet or PromptPay.",
  },
  expired: {
    title: "Payment time ran out",
    body: "Your room was held for 30 minutes while you paid and has now been released. Nothing has been charged - start again when you're ready.",
  },
  cancelled: {
    title: "Payment cancelled",
    body: "Nothing has been charged and the room hold was released. Your reservation details are still saved in this browser.",
  },
  refunded: UNPAID_COPY.refunded,
};

/**
 * Beam (design S5.3): hold-first, so Stripe's words - expired and cancelled are the design's guestCopy texts word for
 * word, refunded as today - except 'failed' (Beam itself never answers it: a declined attempt leaves the link open),
 * which names no method the page may not offer (BEAM_EWALLETS, BEAM_PROMPTPAY).
 */
export const BEAM_UNPAID_COPY: Record<UnpaidStatus, ViewCopy> = {
  ...STRIPE_UNPAID_COPY,
  failed: {
    title: "Payment didn't go through",
    body: "Nothing has been charged and the room hold was released. You can try again with another card or another way to pay.",
  },
};

/** The unpaid view's words: hold-first (from the mode) by provider, the demo its own. */
export function unpaidCopy(result: Pick<StatusResponse, "status" | "paymentMode">): ViewCopy {
  const status = result.status === "paid" || result.status === "pending" ? "failed" : result.status;
  const table = isHoldFirstMode(result.paymentMode) ? (providerOf(result.paymentMode) === "beam" ? BEAM_UNPAID_COPY : STRIPE_UNPAID_COPY) : UNPAID_COPY;
  return table[status];
}

/** What the paid view knows of the booking's config: whether Cloudbeds emails the confirmation, and whether its writes are real. */
export interface PaidCopyFlags {
  sendsConfirmationEmail: boolean;
  cloudbedsWrites: "live" | "mock" | "none";
}

/** Beam's paid view (design S5.3). */
export interface BeamPaidCopy {
  /**
   * No Cloudbeds confirmation email (hold-first && !sendsConfirmationEmail): this page is the guest's booking
   * confirmation - the "Save or print" callout and the agreed terms, as on Stripe.
   */
  pageIsConfirmation: boolean;
  eyebrow: string;
  /** The line under "Thank you". */
  lead: string;
  /** The first "What happens next" item: its bold title and its text. */
  emailTitle: string;
  emailText: string;
}

/** beam-live with the Cloudbeds email (owner decision 6: it is the guest's written confirmation; Beam sends no receipt). */
export const BEAM_PAID_LEAD = "Your stay is booked and paid. Your booking confirmation is on its way to the email address you entered.";
export const BEAM_CONFIRMATION_EMAIL_TEXT =
  "We email your booking confirmation to the address you entered within a few minutes - check your spam folder if it hasn't arrived. Keep it with your booking reference: it is your record of this booking and payment.";

/**
 * Beam's words on the paid view, for beam-playground and beam-live only (null for Stripe and the demo, whose words
 * stay in ReturnStatus.tsx). beam-live with the email: the design's text. Without it (beam-live checkout requires
 * CLOUDBEDS_SEND_STATUS_EMAIL, so this is a booking finished after it was switched off) the page is the confirmation
 * and promises no email. beam-playground: what Stripe's test mode says (the reservation is confirmed in Cloudbeds, or
 * simulated with the MOCK writer) and what a live guest receives - never a receipt.
 */
export function beamPaidCopy(mode: PaymentMode, flags: PaidCopyFlags): BeamPaidCopy | null {
  if (providerOf(mode) !== "beam") return null;
  const pageIsConfirmation = isHoldFirstMode(mode) && !flags.sendsConfirmationEmail;
  const eyebrow = "Booking confirmed";
  if (isLiveMode(mode)) {
    return pageIsConfirmation
      ? {
          pageIsConfirmation,
          eyebrow,
          lead: "Your stay is booked and paid.",
          emailTitle: "Booking confirmation.",
          emailText: "This page is your record of this booking and payment - save or print it and keep your booking reference.",
        }
      : { pageIsConfirmation, eyebrow, lead: BEAM_PAID_LEAD, emailTitle: "Confirmation email.", emailText: BEAM_CONFIRMATION_EMAIL_TEXT };
  }
  return {
    pageIsConfirmation,
    eyebrow,
    lead: `Your test payment went through and the reservation is confirmed${flags.cloudbedsWrites === "live" ? " in Cloudbeds" : " (simulated)"}.`,
    emailTitle: "Confirmation email.",
    emailText: "In live mode the guest receives the Cloudbeds booking confirmation by email.",
  };
}

/** The name Beam puts on card statements (and PromptPay slips) for our merchant account: Beam's written answer, 26 Oct 2026. */
export const BEAM_STATEMENT_DESCRIPTOR = "magicsuitesandvillas";

/**
 * The one line Beam's paid view adds under its lead for a card or e-wallet booking (the token's payMethod
 * card_ewallet) in beam-live: how the charge shows on the guest's card statement, so it is not taken for an unknown
 * charge (fewer disputes). null for PromptPay (the guest sees the name on the bank's slip while paying), for a token
 * without the method group, in beam-playground (test cards: nothing reaches a statement), and for Stripe and the demo.
 */
export function beamStatementNote(result: Pick<StatusResponse, "paymentMode" | "booking">): string | null {
  if (result.paymentMode !== "beam-live" || result.booking.payMethod !== "card_ewallet") return null;
  return `If you paid by card, your card statement will show the charge as "${BEAM_STATEMENT_DESCRIPTOR}".`;
}

/**
 * A poll answer's pendingReason for the pending view's words while the view stays "pending" (design S5.3): Beam only
 * (the reason may change while the page polls, e.g. processing -> unconfirmed once the window is over and the hold
 * released), so the page shows it without starting a new round of checks. null for Stripe and the demo (their
 * answers carry no reason) and for any answer that is not pending.
 */
export function beamPolledReason(res: Pick<StatusResponse, "status" | "paymentMode" | "pendingReason">): { reason: StatusResponse["pendingReason"] } | null {
  return res.status === "pending" && providerOf(res.paymentMode) === "beam" ? { reason: res.pendingReason } : null;
}

/** The reason a Beam poll last read for the pending view (design S5.3), with the poll plan it was read under. */
export interface PolledReason {
  plan: PollPlan;
  reason: StatusResponse["pendingReason"];
}

/**
 * The page's next polled reason after a Beam poll answer (beamPolledReason; round 8, so the rule "the words follow the
 * reason while the page polls" is table-tested): the same plan and reason keep `prev` itself (no re-render); a new
 * reason under the same plan, or any reason under a new plan (a new round of checks), replaces it.
 */
export function nextPolledReason(prev: PolledReason | null, plan: PollPlan, polled: { reason: StatusResponse["pendingReason"] }): PolledReason {
  return prev !== null && prev.plan === plan && prev.reason === polled.reason ? prev : { plan, reason: polled.reason };
}

/** Beam's pending view: its title and text, and what the page's live region says. */
export interface BeamPendingCopy extends ViewCopy {
  announcement: string;
}

/**
 * Beam's words on the pending view (design S5.3, guestCopy; null for Stripe and the demo). Never "Try again" here:
 * the payment may still go through (money review 8).
 * - unconfirmed (the window is over, the bank's answer still outstanding, the hold released): don't pay again,
 *   message us if the app shows it paid; nothing was charged if it didn't go through. Also once checking stops.
 * - after the poll budget (15 minutes): taking longer than usual, don't pay again, WhatsApp.
 * - otherwise (being confirmed, also a link whose charge Beam has not listed yet): the room stays reserved, don't
 *   pay again, the page updates by itself.
 */
export function beamPendingCopy(result: Pick<StatusResponse, "paymentMode" | "ref" | "pendingReason">, exhausted: boolean): BeamPendingCopy | null {
  if (providerOf(result.paymentMode) !== "beam") return null;
  const stopped = exhausted ? " Automatic checking has stopped - use Check again, or message us on WhatsApp." : "";
  if (result.pendingReason === "unconfirmed") {
    return {
      title: "Waiting for your bank or wallet to confirm",
      body: `If your banking or wallet app shows this payment as completed, please do NOT pay again - message us on WhatsApp with booking reference ${result.ref} and we'll confirm your booking. If it didn't go through, nothing has been charged.`,
      announcement: `Waiting for your bank or wallet to confirm. Please don't pay again.${stopped}`,
    };
  }
  if (exhausted) {
    return {
      title: "This is taking longer than usual",
      body: `Please don't pay again. If your banking or wallet app shows the payment as completed, message us on WhatsApp with booking reference ${result.ref}.`,
      announcement: `This is taking longer than usual. Please don't pay again.${stopped}`,
    };
  }
  return {
    title: "Confirming your payment...",
    body: "Your payment is being confirmed by your bank or wallet. Your room stays reserved while we wait. Please don't pay again - this page updates by itself.",
    announcement: "Confirming your payment. Please don't pay again.",
  };
}

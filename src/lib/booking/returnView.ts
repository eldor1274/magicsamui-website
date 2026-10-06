// Which view the return page shows for a verified status (WI-7), and whether
// it keeps polling. Pure and isomorphic so the rules are unit-tested:
//
//   paid + confirmed (or not_applicable: demo/beam)  -> "paid"        success
//   paid + confirming                                -> "confirming"  "Payment received - confirming your booking", poll
//   paid + needs_attention                           -> "attention"   "Payment received - we'll contact you" (never "try again")
//   pending                                          -> "pending"     waiting for the payment, poll
//   failed AMOUNT_OR_REFERENCE_MISMATCH              -> "mismatch"    contact us (never "try again")
//   expired / cancelled / failed / refunded          -> "unpaid"      explain; "Try again" except refunded
//
// A paid answer is NEVER offered "Try again": that would be a second charge.

import { providerOf } from "./payments/provider.ts";
import type { PaymentStatus, StatusResponse } from "./types.ts";

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

/**
 * Stripe: a steady ~3 s poll (the webhook usually lands within seconds; a
 * PromptPay or delayed payment can take longer) for up to 3 minutes.
 * Beam/demo: the original backoff (1 s, 2 s, 4 s ... capped at 30 s, about 2 minutes).
 */
export function pollPlan(result: Pick<StatusResponse, "paymentMode">): PollPlan {
  if (providerOf(result.paymentMode) === "stripe") {
    return { firstMs: 2_000, nextMs: () => 3_000, maxMs: 180_000 };
  }
  return { firstMs: 1_000, nextMs: (attempt) => Math.min(2_000 * 2 ** (attempt - 1), 30_000), maxMs: 120_000 };
}

export const UNPAID_REASON: Record<Exclude<PaymentStatus, "paid" | "pending">, "failed" | "expired" | "cancelled"> = {
  failed: "failed",
  expired: "expired",
  cancelled: "cancelled",
  refunded: "failed",
};

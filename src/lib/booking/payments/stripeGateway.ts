// PaymentGateway for Stripe Checkout (see gateway.ts). Server only.
//
// A thin wrapper: it only calls what payments/stripe.ts already exports
// (retrieveSession, parseSessionMeta, sessionPaymentState, paymentIntentId,
// chargeId, isNotOpenError, isMissingSessionError) and sessions.expire, one
// Stripe request per call, exactly as fulfil.ts and sweep.ts make them today.
// key = the Checkout Session id, so every Redis key keeps its name. The text
// values are the fulfil.ts and sweep.ts literals, copied verbatim.

import type { StripeDeps } from "../stripeDeps.ts";
import type { FeeItem, GatewayPayment, GatewayReceipt, GatewayText, PaymentGateway } from "./gateway.ts";
import { chargeId, isMissingSessionError, isNotOpenError, parseSessionMeta, paymentIntentId, retrieveSession, sessionPaymentState } from "./stripe.ts";
import type { CheckoutSession } from "./stripe.ts";

const FEE_ITEM_NAME = "Payment processing fee";

/** = fulfil.ts feeItemFor (live and test each have their own Cloudbeds item). */
function stripeFeeItem(mode: string): FeeItem {
  return mode === "stripe-live"
    ? { appItemId: "msv-payment-processing-fee", itemSku: "MSV-PAYMENT-FEE", name: FEE_ITEM_NAME, note: "Online booking payment processing fee, paid via Stripe." }
    : {
        appItemId: "msv-payment-processing-fee-test",
        itemSku: "MSV-PAYMENT-FEE-TEST",
        name: `TEST - ${FEE_ITEM_NAME}`,
        note: "TEST MODE - NOT REAL MONEY. Test fee line.",
      };
}

/** = sweep.ts releaseNoteText: no session, a failed payment, a payment started, or a page nobody tried. */
function stripeReleaseNoteText(payments: Pick<GatewayPayment, "state" | "attempted">[]): string {
  if (payments.length === 0) {
    return "Hold released by the sweeper: no payment page was ever created (the booking page failed before Stripe). Nothing was charged.";
  }
  if (payments.some((x) => x.state === "failed")) {
    return "Hold released by the sweeper: a payment was attempted on the Stripe page but did not go through. Nothing was charged.";
  }
  return payments.some((x) => x.attempted)
    ? "Hold released by the sweeper: the Stripe payment page was opened and a payment was started but never completed. Nothing was charged."
    : "Hold released by the sweeper: the Stripe payment page was created but no payment was ever attempted. Nothing was charged.";
}

export const STRIPE_GATEWAY_TEXT: GatewayText = {
  paidVia: (receipt: GatewayReceipt, amount: string) => `via Stripe ${receipt.primaryId ?? "-"} (${amount})`,
  paymentDescription: (receipt: GatewayReceipt, ref: string) => `${receipt.description} ref ${ref}`,
  sessionLabel: { long: "Checkout Session", short: "session" },
  refundWhere: "in Stripe",
  methodEnvVar: "CLOUDBEDS_STRIPE_PAYMENT_METHOD",
  testMethodEnvVar: "CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD",
  feeItem: stripeFeeItem,
  feeItemName: FEE_ITEM_NAME,
  releaseNoteText: stripeReleaseNoteText,
  webhookRetryHint: "Stripe webhook retries",
};

/** A retrieved session in the gateway's shape; `wantLive` = this deployment's Stripe mode (fulfil.ts modeMatches). */
export function stripePaymentOf(key: string, session: CheckoutSession, wantLive: boolean): GatewayPayment {
  const meta = parseSessionMeta(session);
  const pi = paymentIntentId(session);
  return {
    key,
    paymentId: key,
    state: sessionPaymentState(session),
    meta: meta && session.livemode === wantLive ? meta : null,
    amountSatang: session.amount_total,
    currency: session.currency,
    attempted: session.payment_intent !== null && session.payment_intent !== undefined,
    receipt: { primaryId: pi, description: `Stripe ${pi ?? "-"} charge ${chargeId(session) ?? "-"} session ${key}` },
  };
}

export function stripeGateway(deps: Pick<StripeDeps, "config" | "stripe">): PaymentGateway {
  return {
    provider: "stripe",
    brand: "Stripe",
    keyOf: (paymentId) => paymentId,
    idOf: (key) => key,
    async get(key) {
      const session = await retrieveSession(deps.stripe, key);
      return stripePaymentOf(key, session, deps.config.stripe?.livemode ?? false);
    },
    async cancel(key) {
      try {
        await deps.stripe.checkout.sessions.expire(key);
        return "cancelled";
      } catch (e) {
        if (!isNotOpenError(e)) throw e; // network/5xx
        return "not_open";
      }
    },
    isMissing: isMissingSessionError,
    text: STRIPE_GATEWAY_TEXT,
  };
}

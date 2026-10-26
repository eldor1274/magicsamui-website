// Every Beam word the shared core writes into Cloudbeds notes, payment descriptions and owner alerts (design
// S4.1): the GatewayText of the Beam gateway (payments/beamGateway.ts). Server only (no I/O, no secrets).
//
// - The PAID note says the charge, the method and its refund path (gap review 4), so staff find the money in
//   Beam Lighthouse and know how a cancellation is paid back without opening Lighthouse first.
// - Refund paths follow the owner's decisions (21 Oct 2026) and Beam's written answer (26 Oct 2026): voids and refunds
//   are supported only for card and QR (PromptPay) payments - every e-wallet (Alipay, WeChat Pay, LINE Pay, TrueMoney,
//   ShopeePay) is paid back by bank transfer - and only CARD in part. In Lighthouse a full refund on the day of the
//   payment before 8 PM is a Void (no Beam fee); later it is a Refund and Beam's fee still applies; a card refund
//   reaches the guest in 7-14 business days. A payment that succeeds after its hold was released is re-booked or
//   refunded IN FULL by the owner, never automatically (decision 3); a 50% cancellation refund of anything Beam cannot
//   refund in part goes by bank transfer (decision 4).
// - No text names Stripe (beamGateway.test.ts pins it), and the Cloudbeds fee item has its own Beam ids: Cloudbeds
//   keeps the name and note an appItemID is first used with, and Stripe's note says "paid via Stripe".
// - Nothing here carries personal data: charge and link ids, method names, amounts and booking refs only.

import { DEFAULT_BEAM_PENDING_GRACE_MINUTES } from "../config.ts";
import type { BeamSettings } from "../config.ts";
import type { FeeItem, GatewayAlert, GatewayPayment, GatewayReceipt, GatewayText } from "./gateway.ts";

/** The fee line's name, as alerts quote it (the test item's name carries a "TEST - " prefix). */
export const BEAM_FEE_ITEM_NAME = "Payment processing fee";

/**
 * The Beam payment method types Beam can refund (Lighthouse and API): cards and the PromptPay QR only (Beam's written
 * answer, 26 Oct 2026; card instalments are card payments). Every other type - every e-wallet included - goes by bank
 * transfer.
 */
export const BEAM_REFUNDABLE_METHODS: ReadonlySet<string> = new Set(["CARD", "CARD_INSTALLMENTS", "QR_PROMPT_PAY"]);

/** The e-wallets, as staff read them: every one is paid back by bank transfer (Beam can't refund them). */
const E_WALLETS = "Alipay, WeChat Pay, LINE Pay, TrueMoney or ShopeePay";

/** A full refund in Lighthouse: Void on the day of the payment before 8 PM (no Beam fee), else Refund (Beam's fee still applies). */
const VOID_OR_REFUND = "Void on the day of the payment before 8 PM, with no Beam fee; later Refund, and Beam's fee still applies";

/** How long a card refund takes to reach the guest (Beam's written answer, 26 Oct 2026), mid-sentence; the "Beam refund done" alert quotes it too. */
export const BEAM_CARD_REFUND_TIME = "a card refund takes 7-14 business days to reach the guest";
/** The same as the start of a sentence (no final period). */
const CARD_REFUND = `A${BEAM_CARD_REFUND_TIME.slice(1)}`;

/** Card payments (a card's refund timing applies). */
const CARD_METHODS: ReadonlySet<string> = new Set(["CARD", "CARD_INSTALLMENTS"]);

/** The Beam payment method types Beam can refund in part (a 50% cancellation refund). */
export const BEAM_PARTIAL_REFUND_METHODS: ReadonlySet<string> = new Set(["CARD"]);

/** Beam's paymentMethodType values as staff read them. */
const METHOD_NAMES: Record<string, string> = {
  CARD: "card",
  CARD_INSTALLMENTS: "card instalments",
  QR_PROMPT_PAY: "PromptPay",
  ALIPAY: "Alipay",
  WECHAT_PAY: "WeChat Pay",
  LINE_PAY: "LINE Pay",
  TRUE_MONEY: "TrueMoney",
  SHOPEE_PAY: "ShopeePay",
};

/**
 * A payment method as staff read it: Beam's paymentMethodType by name ("card", "PromptPay", "LINE Pay"), an
 * unknown type as Beam spells it (letters, digits and underscores only, at most 32), "method pending" when Beam
 * has not reported one yet (a PAID link whose charge is not listed).
 */
export function beamMethodName(methodType: string | undefined): string {
  if (methodType === undefined || methodType === "") return "method pending";
  const known = METHOD_NAMES[methodType];
  if (known) return known;
  const raw = methodType.replace(/[^A-Za-z0-9_]/g, "").slice(0, 32);
  return raw === "" ? "method pending" : raw;
}

/**
 * Where a cancellation refund of this payment goes (owner decision 4): Lighthouse, bank transfer, or both. A full
 * refund in Lighthouse on the day of the payment before 8 PM is a Void, with no Beam fee.
 */
function refundLine(receipt: GatewayReceipt): string {
  const name = beamMethodName(receipt.methodType);
  if (receipt.refundable === false) return `bank transfer only (Beam can't refund ${name})`;
  if (receipt.partialRefundable === true) {
    return `Beam Lighthouse (full or 50% refunds of the ${name} payment; a full refund on the day of the payment before 8 PM is a Void, with no Beam fee)`;
  }
  if (receipt.refundable === true) {
    return `Beam Lighthouse for a full refund (on the day of the payment before 8 PM a Void, with no Beam fee); a 50% refund by bank transfer (Beam refunds ${name} only in full)`;
  }
  return (
    "check the charge's method in Beam Lighthouse - cards are refunded there in full or 50%, PromptPay in full there and 50% by bank " +
    `transfer, e-wallets (${E_WALLETS}) by bank transfer only`
  );
}

/**
 * The full refund of a paid booking whose hold is gone (owner decision 3), after "refund " in fulfil's
 * needs_attention reasons, which add the final period.
 */
function refundHow(receipt: GatewayReceipt): string {
  return `${beamFullRefundHow(receipt.methodType, receipt.primaryId)}. Nothing is refunded automatically`;
}

/**
 * How to give a whole Beam charge back, by its method (no final period): in Beam Lighthouse for a card or PromptPay
 * (Void on the day of the payment before 8 PM, no Beam fee; later Refund, Beam's fee still applies; a card's 7-14
 * business days), by bank transfer for anything Beam can't refund (every e-wallet), and both ways named while the
 * method is not known. refundHow and the duplicate-charge alert (beamGateway.ts) use it.
 */
export function beamFullRefundHow(methodType: string | undefined, chargeId: string | null): string {
  const lighthouse = `the full amount in Beam Lighthouse (Payments > charge ${chargeId ?? "of this booking"}: ${VOID_OR_REFUND})`;
  if (methodType === undefined || methodType === "") {
    return `${lighthouse}, or by bank transfer if it was paid with an e-wallet (${E_WALLETS}: Beam can't refund those)`;
  }
  if (!BEAM_REFUNDABLE_METHODS.has(methodType)) return `the full amount by bank transfer: Beam can't refund ${beamMethodName(methodType)}`;
  return CARD_METHODS.has(methodType) ? `${lighthouse}. ${CARD_REFUND}` : lighthouse;
}

/** The fee line's Cloudbeds item: beam-live and the test modes each have their own (new ids, never Stripe's). */
function beamFeeItem(mode: string): FeeItem {
  return mode === "beam-live"
    ? {
        appItemId: "msv-payment-processing-fee-beam",
        itemSku: "MSV-BEAM-PAYMENT-FEE",
        name: BEAM_FEE_ITEM_NAME,
        note: "Online booking payment processing fee (card or e-wallet), paid via Beam.",
      }
    : {
        appItemId: "msv-payment-processing-fee-beam-test",
        itemSku: "MSV-BEAM-PAYMENT-FEE-TEST",
        name: `TEST - ${BEAM_FEE_ITEM_NAME}`,
        note: "TEST MODE - NOT REAL MONEY. Test fee line.",
      };
}

/** The sweeper's Cloudbeds note when it gives a Beam hold back: what the guest's payment link did. */
function beamReleaseNoteText(payments: Pick<GatewayPayment, "state" | "attempted" | "pendingReason">[]): string {
  if (payments.length === 0) {
    return "Hold released by the sweeper: no payment link was ever created (the booking page failed before Beam). Nothing was charged.";
  }
  if (payments.some((p) => p.pendingReason === "unconfirmed")) {
    return (
      "Hold released by the sweeper: a payment on the Beam payment link was still pending at the bank when the time for it ran out, so " +
      "nothing is confirmed as charged. If it succeeds later the owner gets an URGENT alert to re-book or refund the guest."
    );
  }
  return payments.some((p) => p.attempted)
    ? "Hold released by the sweeper: a payment was attempted on the Beam payment link but not completed. Nothing was charged."
    : "Hold released by the sweeper: the Beam payment link was created but no payment was ever attempted. Nothing was charged.";
}

/**
 * The Beam gateway's words. `beam.pendingGraceMinutes` (BEAM_PENDING_GRACE_MINUTES) is quoted by the warning
 * sent when a hold is released while its payment is still unconfirmed.
 */
export function beamGatewayText(beam: Pick<BeamSettings, "pendingGraceMinutes">): GatewayText {
  const graceMinutes = beam.pendingGraceMinutes;
  return {
    paidVia: (receipt, amount) =>
      `via Beam ${receipt.primaryId ?? "charge id pending"} (${beamMethodName(receipt.methodType)}, ${amount}). Refund path: ${refundLine(receipt)}`,
    paymentDescription: (receipt, ref) => `${receipt.description} ref ${ref}`,
    sessionLabel: { long: "payment link", short: "link" },
    refundWhere: "in full in Beam Lighthouse, or by bank transfer for an e-wallet payment (nothing is refunded automatically)",
    refundHow,
    // = config.ts BEAM_PAYMENT_METHOD_SOURCE (beamGateway.test.ts checks the two agree).
    methodEnvVar: "CLOUDBEDS_BEAM_PAYMENT_METHOD",
    testMethodEnvVar: "CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD",
    feeItem: beamFeeItem,
    feeItemName: BEAM_FEE_ITEM_NAME,
    releaseNoteText: beamReleaseNoteText,
    webhookRetryHint: "Beam webhook retries",
    mockMethod: "mock-beam",
    bookedExtra: (receipt) =>
      `If the guest cancels: ${refundLine(receipt)}.${receipt.methodType !== undefined && CARD_METHODS.has(receipt.methodType) ? ` ${CARD_REFUND}.` : ""}`,
    // A booking without a fee (PromptPay, owner decision 1) has no fee line on the folio.
    noFeeNote: (receipt) => (receipt.methodType ? `no fee: ${beamMethodName(receipt.methodType)}` : "no fee"),
    pendingReleasedAlert: (payment: GatewayPayment, reservationId: string): GatewayAlert => {
      const ref = payment.meta?.ref ?? "-";
      return {
        subject: `Beam payment still pending: hold ${reservationId} released (booking ${ref})`,
        lines: [
          `A ${beamMethodName(payment.receipt.methodType)} payment on Beam link ${payment.paymentId} was still waiting for the bank's confirmation ${graceMinutes} minutes after the payment window closed, so the Cloudbeds hold was released and the unit is back on sale.`,
          `If it succeeds later you get an URGENT alert: re-book the guest if the unit is still free, otherwise refund the full amount in Beam Lighthouse (by bank transfer for an e-wallet: ${E_WALLETS}).`,
        ],
        key: `beam-pending-released:${payment.paymentId}`,
        severity: "warning",
      };
    },
  };
}

/** The Beam words at the default pending grace (DEFAULT_BEAM_PENDING_GRACE_MINUTES); the gateway uses its own settings'. */
export const BEAM_GATEWAY_TEXT: GatewayText = beamGatewayText({ pendingGraceMinutes: DEFAULT_BEAM_PENDING_GRACE_MINUTES });

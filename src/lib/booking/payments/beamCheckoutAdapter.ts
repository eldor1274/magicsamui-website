// The Beam side of the hold-first checkout (design S4.3): a Beam payment link as the payment page of
// holdFirstCheckout.ts. beamCheckout.ts startBeamCheckout is the core with this adapter. Server only.
//
// - The page is a payment link offering only the guest's method group (card_ewallet: cards, plus the e-wallets
//   while BEAM_EWALLETS is on; promptpay: the PromptPay QR only), for exactly quote.dueNowSatang, with the booking
//   ref as referenceId, our signed, PII-free note (payments/beamRecord.ts) and expiresAt = now + 30 minutes. Its
//   key is 'beam:{linkId}' (lock.ts beamKeyOf); the booking token carries the bare link id.
// - A group the checkout does not take (payMethodOffered: PromptPay while BEAM_PROMPTPAY is off) is refused with a
//   RangeError before any Beam call, as is a quote whose fee is not the group's (buildPaymentLinkRequest): the core
//   then cancels the hold. S4.6 refuses both before anything is held; this is the second check.
// - The create runs inside the core's budget: each attempt's timeout fits it, and the one retry (same idempotency
//   key, after a network error, a timeout, 429 or 5xx) runs only when it still fits (beam.ts createPaymentLink).
//   A create whose answer is lost twice is a failure: the hold is cancelled. The link Beam may have made was never
//   handed out, and if a charge ever appears on it, the sweeper's charge scan finds the signed note and raises
//   the cancelled-hold CRITICAL (owner decision 3).
// - Circuit breaker (gap review 19): every failed create call counts in keys.beamPageFail (a 5-minute window); the
//   third in a row pauses Beam checkout for 5 minutes (keys.beamPaused) and tells the owner. While paused,
//   beforeHold refuses every checkout before anything is written. A created link ends the run of failures. A
//   create Beam answered 429 (after its one retry) is not counted (round 6): a rate limit is not an outage, and
//   counting it would turn a burst of 429s (our own status reads, if Beam limits per merchant) into a 5-minute
//   checkout pause; the runtime's 429 counter ("Beam is rate-limiting the booking engine") and the page-failed
//   alert still tell the owner.
// - afterCreate writes the PaymentRecord (708 days) and the links-open entry (score = the link's expiresAt), which
//   the sweeper reads on every run; a failure of either makes the core disable the link and cancel the hold.
//   cancelPage is the gateway's disable with a fresh idempotency key.
// - The hold's Cloudbeds note says when an unpaid hold goes, the PromptPay/wallet grace included, and the crash
//   alert says the page was 'disabled' (never Stripe's 'expired').
//
// No personal data reaches Beam, Redis or the logs from here: the note and the record carry booking facts and
// yes/no flags only; the guest's name, email, phone and requests never leave the core.

import { BEAM_MAX_CHARGE_SATANG, beamErrorInfo, buildPaymentLinkRequest, createPaymentLink, isBeamHostedPageUrl } from "../beam.ts";
import type { BeamCallOptions, BeamErrorInfo } from "../beam.ts";
import { POLICY_VERSION } from "../catalogue.ts";
import { fail } from "../checkoutShared.ts";
import type { StripeCheckoutResult } from "../checkoutShared.ts";
import { MERCHANT_NAME, PAYMENT_LINK_TTL_MINUTES } from "../config.ts";
import type { BeamSettings } from "../config.ts";
import type { CheckoutAdapter } from "../holdFirstCheckout.ts";
import { beamKeyOf, keyScope, keys } from "../lock.ts";
import { feePctFor, payMethodOffered } from "../quote.ts";
import { idempotencyKeyFor } from "../token.ts";
import type { PayMethod, ThemeName } from "../types.ts";
import { beamCancelUrl, beamReturnUrl } from "../urls.ts";
import { beamGateway, trackOpenLink } from "./beamGateway.ts";
import type { BeamGatewayDeps } from "./beamGateway.ts";
import { buildBeamNote, writeRecord } from "./beamRecord.ts";
import type { BeamNote, PaymentRecord } from "./beamRecord.ts";

/** Failed create calls in a row (inside one window) that pause Beam checkout. */
export const BEAM_PAGE_FAIL_PAUSE_COUNT = 3;
/** The circuit breaker's counting window (keys.beamPageFail's TTL from the first failure). */
export const BEAM_PAGE_FAIL_WINDOW_SECONDS = 5 * 60;
/** How long the circuit breaker pauses Beam checkout (keys.beamPaused's TTL). */
export const BEAM_PAUSE_SECONDS = 5 * 60;
/** What a guest is told while Beam checkout is paused. */
export const BEAM_PAUSED_MESSAGE =
  "Online payment is briefly unavailable. Nothing has been reserved or charged. Please book on our classic booking page or message us on WhatsApp.";
/** The page-failed alert's error code for a request this adapter refused before calling Beam. */
export const BEAM_NOT_SENT = "NOT_SENT";
/** The crash alert's word for what cancelPage did to the link. */
export const BEAM_CLOSED_WORD = "disabled";

/**
 * The hold note's deadline: the link's 30 minutes, and how long a PromptPay or wallet payment still being confirmed
 * keeps the hold (the pending grace, BEAM_PENDING_GRACE_MINUTES): 'after 30 minutes (up to 50 minutes while ...)'.
 */
export function beamHoldNoteDeadline(beam: Pick<BeamSettings, "pendingGraceMinutes">): string {
  return `after ${PAYMENT_LINK_TTL_MINUTES} minutes (up to ${PAYMENT_LINK_TTL_MINUTES + beam.pendingGraceMinutes} minutes while a PromptPay or wallet payment is still being confirmed)`;
}

/** Where and when the Beam page is created: the request's origin, the checkout's clock, the theme and the guest's method group. */
export interface BeamCheckoutAt {
  origin: string;
  nowMs: number;
  theme?: ThemeName;
  payMethod: PayMethod;
}

/**
 * The Beam CheckoutAdapter. `deps` are the gateway's (BeamGatewayDeps: Beam's fetch, the 429 counter, the test seams);
 * `beam` is the Beam mode's settings (config.beam).
 */
export function beamCheckoutAdapter(deps: BeamGatewayDeps, beam: BeamSettings, at: BeamCheckoutAt): CheckoutAdapter<BeamErrorInfo> {
  const { config } = deps;
  const mode = config.paymentMode;
  const scope = keyScope(mode);
  const { payMethod } = at;
  const clock = deps.clock ?? Date.now;
  // cancelPage: the gateway's disable, a fresh idempotency key per attempt (gap review 15).
  const gw = beamGateway({ ...deps, beam });
  /** The record of each link this adapter created, written by afterCreate. */
  const records = new Map<string, PaymentRecord>();

  /** Counts a failed create call; the third in a row pauses Beam checkout and tells the owner. Never throws. */
  async function countPageFailure(info: BeamErrorInfo): Promise<void> {
    try {
      const failures = await deps.kv.incr(keys.beamPageFail(scope), BEAM_PAGE_FAIL_WINDOW_SECONDS);
      if (failures < BEAM_PAGE_FAIL_PAUSE_COUNT) return;
      await deps.kv.set(keys.beamPaused(scope), String(at.nowMs), BEAM_PAUSE_SECONDS);
      deps.log("beam_checkout_paused", { failures, errorCode: info.errorCode, status: info.status });
      await deps.alert(
        "Beam payment pages are failing: Beam checkout paused for 5 minutes",
        [
          `${failures} bookings in a row could not create a Beam payment page (latest: ${info.errorCode ?? "no error code"}, ${info.status ? `HTTP ${info.status}` : "no HTTP answer"}). New Beam checkouts are refused before anything is held for 5 minutes.`,
          "If Beam is down (status.beamcheckout.com), set BOOKING_PAYMENT_PROVIDER=stripe and redeploy: in-flight Beam payments are still finished by the Beam drain.",
        ],
        { key: "beam-checkout-paused", severity: "warning" },
      );
    } catch (e) {
      deps.log("beam_breaker_failed", { error: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
    }
  }

  return {
    provider: "beam",
    brand: "Beam",
    maxChargeSatang: BEAM_MAX_CHARGE_SATANG,
    holdNoteDeadline: beamHoldNoteDeadline(beam),
    closedWord: BEAM_CLOSED_WORD,

    // The circuit breaker: nothing is written while Beam checkout is paused.
    async beforeHold(): Promise<StripeCheckoutResult | null> {
      if ((await deps.kv.get(keys.beamPaused(scope))) === null) return null;
      return fail(503, { error: "payment_unavailable", message: BEAM_PAUSED_MESSAGE });
    },

    async createPage({ ref, reservationId, quote, token, basePath, guestFlags, budgetMs, nonce }) {
      // The second check of the BEAM_PROMPTPAY switch (S4.6 refuses first): no link for a group the checkout does not take.
      if (!payMethodOffered(config, payMethod)) throw new RangeError(`Beam ${String(payMethod)} payments are switched off`);
      // Exactly the link body's expiresAt: the record and the note carry it (the gateway's fallbackExpiresAtMs).
      const expiresAt = at.nowMs + PAYMENT_LINK_TTL_MINUTES * 60_000;
      const facts: BeamNote = {
        mode,
        ref,
        reservationId,
        roomsSatang: quote.roomsSubtotalSatang,
        feeSatang: quote.cardFeeSatang,
        totalSatang: quote.totalSatang,
        payMethod,
        checkIn: quote.checkIn,
        checkOut: quote.checkOut,
        termsVersion: POLICY_VERSION,
        arrivalLate: guestFlags.arrivalLate,
        hasRequests: guestFlags.hasRequests,
        noteSaved: guestFlags.noteSaved,
        expiresAt,
      };
      const body = buildPaymentLinkRequest({
        ref,
        quote,
        merchantName: MERCHANT_NAME,
        redirectUrl: beamReturnUrl(at.origin, basePath, ref, token, at.theme),
        cancelUrl: beamCancelUrl(at.origin, basePath, ref, token, at.theme),
        nowMs: at.nowMs,
        ttlMinutes: PAYMENT_LINK_TTL_MINUTES,
        group: payMethod,
        ewallets: beam.ewallets,
        expectedFeePct: feePctFor(config, payMethod),
        internalNote: buildBeamNote(facts, config.tokenSecret),
        log: deps.log,
      });
      // The core's budget, and the gateway's own deadline when it has one.
      const budget = Math.min(budgetMs, deps.deadlineMs !== undefined ? deps.deadlineMs - clock() : Number.POSITIVE_INFINITY);
      const opts: BeamCallOptions = {
        ...(Number.isFinite(budget) ? { budgetMs: Math.max(0, Math.floor(budget)) } : {}),
        ...(deps.onRateLimited ? { onRateLimited: deps.onRateLimited } : {}),
        ...(deps.clock ? { now: deps.clock } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      };
      let link: { id: string; url: string };
      try {
        link = await createPaymentLink(beam, body, idempotencyKeyFor(ref, mode, nonce()), deps.fetchImpl, opts);
      } catch (e) {
        const info = beamErrorInfo(e);
        // A rate limit is no outage: never counted towards the pause (round 6).
        if (info.status !== 429) await countPageFailure(info);
        throw e;
      }
      // A created link ends a run of failures (best effort: a stale count only brings a pause forward).
      await deps.kv.del(keys.beamPageFail(scope)).catch(() => undefined);
      const key = beamKeyOf(link.id);
      records.set(key, { v: 1, linkId: link.id, merchantId: beam.merchantId, createdAt: at.nowMs, ...facts });
      return { key, paymentId: link.id, redirectUrl: link.url };
    },

    // https on exactly the hosted host of this mode's API base (money review 17).
    isAllowedUrl: (url) => url !== null && isBeamHostedPageUrl(url, beam.apiBase),

    // The record first, then links-open: the sweeper reads the link on every run until it is done or released.
    async afterCreate(page) {
      const record = records.get(page.key);
      if (!record) throw new Error("Beam checkout: no payment record for the page");
      await writeRecord(deps.kv, record);
      await trackOpenLink(deps.kv, mode, record.linkId, record.expiresAt);
    },

    cancelPage: (key) => gw.cancel(key),

    errorInfo: (e) => (e instanceof RangeError ? { ...beamErrorInfo(e), errorCode: BEAM_NOT_SENT } : beamErrorInfo(e)),

    pageFailedAlert: (info, ref) => ({
      subject: "Booking stopped: Beam could not create the payment page",
      lines:
        info.errorCode === BEAM_NOT_SENT
          ? [
              `Booking ${ref}: the Beam payment link was not requested (${info.message}). The hold was cancelled and nothing was charged.`,
              "If this repeats, every online booking is failing: check the Beam settings (BEAM_PROMPTPAY, BOOKING_CARD_FEE_PCT, BEAM_PROMPTPAY_FEE_PCT) and the Vercel logs for beam_session_failed.",
            ]
          : [
              `Booking ${ref}: Beam refused or failed to create the payment link (${info.errorCode ?? "no error code"}, ${info.status ? `HTTP ${info.status}` : "no HTTP answer"}). The hold was cancelled and nothing was charged.`,
              "If this repeats, every online booking is failing: check the Beam keys, the merchant status and the enabled methods in Lighthouse.",
            ],
      key: `beam-link-fail:${info.errorCode ?? (info.status ? `HTTP_${info.status}` : "unknown")}`,
    }),
  };
}

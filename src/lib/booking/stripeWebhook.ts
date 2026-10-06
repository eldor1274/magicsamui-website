// Stripe webhook handling (WI-6). The route reads the RAW body (capped) and
// hands it here with the Stripe-Signature header.
//
// - Signature: stripe.webhooks.constructEvent over the exact bytes, 300 s
//   tolerance -> 400 on a bad/old signature. Stripe retries every non-2xx
//   answer (4xx included), so a wrong STRIPE_WEBHOOK_SECRET (e.g. the test
//   secret with live keys) means every event fails: after a few rejected
//   signatures in an hour the owner is alerted.
// - checkout.session.completed (payment_status paid) and
//   checkout.session.async_payment_succeeded -> fulfil.
// - checkout.session.expired and checkout.session.async_payment_failed ->
//   release the hold (release re-reads the session and refuses a paid one).
// - Sessions that are not ours (this Stripe account is shared with Cloudbeds)
//   or of the other mode (test vs live) are acknowledged and ignored.
// - Any failure -> 500 so Stripe retries (for up to 3 days in live mode).
// - Fast: Checkout waits up to 10 s for this webhook before redirecting.

import { redactForLog } from "./cloudbedsWrite.ts";
import { alertFulfilFailure, fulfilSession, releaseSession } from "./fulfil.ts";
import { isSessionId, isSignatureError, parseSessionMeta, verifyStripeWebhook } from "./payments/stripe.ts";
import type { CheckoutSession } from "./payments/stripe.ts";
import type { StripeDeps } from "./stripeDeps.ts";
import { keyScope, keys } from "./lock.ts";

export interface WebhookResult {
  status: number;
  body: string;
}

const HANDLED = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.expired",
  "checkout.session.async_payment_failed",
]);

/** While another caller holds the fulfil lock, wait up to this long for it to finish before asking Stripe to retry. */
const IN_PROGRESS_WAIT_MS = 6_000;
/** Rejected signatures per hour before the owner is alerted (one stray probe is not worth an email). */
export const BAD_SIGNATURE_ALERT_THRESHOLD = 3;

async function noteBadSignature(deps: StripeDeps, header: string | null): Promise<void> {
  try {
    const n = await deps.kv.incr(keys.badSignatures(keyScope(deps.config.paymentMode)), 3600);
    if (n !== BAD_SIGNATURE_ALERT_THRESHOLD) return;
    // "t=...,v1=..." only tells whether a signature was sent; never log the header itself.
    await deps.alert(
      "Stripe webhook: signatures are being rejected",
      [
        `${n} webhook deliveries in the last hour had a signature that did not verify against STRIPE_WEBHOOK_SECRET (mode ${deps.config.paymentMode}${header ? "" : ", one without a signature header"}).`,
        "If this is Stripe itself, the secret is wrong (e.g. the test endpoint's secret with live keys): paid bookings are then only confirmed by the return page and the sweeper. Check the event destination's signing secret in Stripe.",
      ],
      { key: "webhook-bad-signature", severity: "warning" },
    );
  } catch {
    // Best effort only.
  }
}

async function waitForDone(deps: StripeDeps, sessionId: string, maxMs: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    if ((await deps.kv.get(keys.fulfilDone(sessionId))) !== null) return true;
    await sleep(500);
  }
  return (await deps.kv.get(keys.fulfilDone(sessionId))) !== null;
}

export async function handleStripeWebhook(
  rawBody: string | Uint8Array,
  signature: string | null,
  deps: StripeDeps,
  options: { nowMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<WebhookResult> {
  const secret = deps.config.stripe?.webhookSecret;
  if (!secret) {
    deps.log("stripe_webhook_unconfigured");
    return { status: 503, body: "webhook not configured" };
  }
  let event;
  try {
    event = verifyStripeWebhook(rawBody, signature, secret, options.nowMs ?? (deps.now ? deps.now() : undefined));
  } catch (e) {
    if (isSignatureError(e)) {
      deps.log("stripe_webhook_bad_signature", { mode: deps.config.paymentMode, hasHeader: Boolean(signature) });
      await noteBadSignature(deps, signature);
      return { status: 400, body: "invalid signature" };
    }
    deps.log("stripe_webhook_unparseable");
    return { status: 400, body: "invalid payload" };
  }

  if (!HANDLED.has(event.type)) return { status: 200, body: "ignored" };
  const session = event.data.object as CheckoutSession;
  const meta = parseSessionMeta(session);
  const wantLive = deps.config.stripe?.livemode ?? false;
  if (!meta || event.livemode !== wantLive || !isSessionId(session.id)) {
    // Not one of our booking sessions (e.g. Cloudbeds' own use of this account) or the other mode.
    return { status: 200, body: "not ours" };
  }
  deps.log("stripe_webhook", { type: event.type, eventId: event.id, ref: meta.ref, sessionId: session.id });

  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      if (event.type === "checkout.session.completed" && session.payment_status === "unpaid") {
        // Delayed method: wait for async_payment_succeeded/failed. The hold stays.
        return { status: 200, body: "awaiting async payment" };
      }
      const outcome = await fulfilSession(session.id, deps);
      if (outcome.state === "in_progress") {
        // The return page or the sweeper is fulfilling right now.
        if (await waitForDone(deps, session.id, IN_PROGRESS_WAIT_MS, sleep)) return { status: 200, body: "fulfilled" };
        return { status: 503, body: "fulfilment in progress - retry" };
      }
      return { status: 200, body: outcome.state };
    }
    // expired / async_payment_failed
    const released = await releaseSession(session.id, deps, event.type === "checkout.session.expired" ? "session expired" : "delayed payment failed");
    if (released.state === "in_progress") return { status: 503, body: "release in progress - retry" };
    if (released.state === "refused_paid") {
      // Should never happen for these events; make sure the paid booking is confirmed instead.
      await fulfilSession(session.id, deps);
    }
    return { status: 200, body: released.state };
  } catch (e) {
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      await alertFulfilFailure(deps, session.id, e).catch(() => undefined);
    } else {
      const error = redactForLog(e instanceof Error ? e.message : String(e));
      deps.log("stripe_webhook_release_failed", { sessionId: session.id, error });
      await deps
        .alert(
          `Hold for booking ${meta.ref} could not be released`,
          [
            `Stripe says Checkout Session ${session.id} can no longer be paid (${event.type}), but cancelling Cloudbeds reservation ${meta.reservationId} failed: ${error.slice(0, 200)}`,
            "Stripe retries this webhook and the sweeper retries too. If it keeps failing, cancel the reservation in Cloudbeds by hand so the unit goes back on sale.",
          ],
          { key: `release-fail:${meta.reservationId}`, severity: "warning" },
        )
        .catch(() => undefined);
    }
    return { status: 500, body: "processing failed - retry" };
  }
}

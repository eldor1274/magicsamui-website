// stripe-mock ONLY: what the local MOCK checkout page's buttons do. Each
// action changes the fake Stripe session the way the guest's choice would,
// then delivers the matching webhook (signed, through the REAL webhook
// handler) and returns where Stripe would send the browser.

import { handleStripeWebhook } from "../stripeWebhook.ts";
import type { StripeDeps } from "../stripeDeps.ts";
import type { MockStripeAction, MockStripeResponse } from "../types.ts";
import type { FakeStripe } from "./fakeStripe.ts";

const ACTIONS: MockStripeAction[] = ["pay", "pay_delayed_success", "pay_delayed_failure", "cancel", "expire"];

export interface MockStripeResult {
  status: number;
  body: MockStripeResponse;
}

export async function runMockStripeAction(raw: unknown, fake: FakeStripe, deps: StripeDeps): Promise<MockStripeResult> {
  if (deps.config.paymentMode !== "stripe-mock") return { status: 404, body: { ok: false, error: "not_found", message: "Not found." } };
  const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const action = body.action as MockStripeAction;
  const session = fake.session(sessionId);
  if (!session || !ACTIONS.includes(action)) return { status: 400, body: { ok: false, error: "invalid_request", message: "Invalid request." } };
  if (session.status !== "open") return { status: 409, body: { ok: false, error: "invalid_request", message: `This MOCK session is already ${session.status}.` } };

  const deliver = async (type: string) => {
    const { payload, header } = fake.signedEvent(type, sessionId);
    const res = await handleStripeWebhook(payload, header, deps);
    deps.log("mock_stripe_webhook", { type, status: res.status, body: res.body });
    if (res.status >= 400) throw new Error(`MOCK webhook ${type} answered ${res.status}: ${res.body}`);
  };
  const success = session.success_url.replace("{CHECKOUT_SESSION_ID}", encodeURIComponent(sessionId));
  try {
    return await perform(action, sessionId, success, session.cancel_url, fake, deliver);
  } catch (e) {
    // Surfaced on the MOCK page (in real Stripe a failed webhook is retried; the return page also fulfils).
    return { status: 502, body: { ok: false, error: "upstream_error", message: e instanceof Error ? e.message : String(e) } };
  }
}

async function perform(
  action: MockStripeAction,
  sessionId: string,
  success: string,
  cancelUrl: string | null,
  fake: FakeStripe,
  deliver: (type: string) => Promise<void>,
): Promise<MockStripeResult> {
  switch (action) {
    case "pay":
      fake.complete(sessionId);
      await deliver("checkout.session.completed");
      return { status: 200, body: { ok: true, redirectUrl: success } };
    case "pay_delayed_success":
      fake.completeDelayed(sessionId);
      await deliver("checkout.session.completed");
      fake.asyncSucceed(sessionId);
      await deliver("checkout.session.async_payment_succeeded");
      return { status: 200, body: { ok: true, redirectUrl: success } };
    case "pay_delayed_failure":
      fake.completeDelayed(sessionId);
      await deliver("checkout.session.completed");
      fake.asyncFail(sessionId);
      await deliver("checkout.session.async_payment_failed");
      return { status: 200, body: { ok: true, redirectUrl: success } };
    case "expire":
      fake.expire(sessionId);
      await deliver("checkout.session.expired");
      return { status: 200, body: { ok: true, redirectUrl: success } };
    case "cancel":
    default:
      // Stripe's back link only navigates; the booking page then calls /api/booking/abandon.
      return { status: 200, body: { ok: true, redirectUrl: cancelUrl ?? success } };
  }
}

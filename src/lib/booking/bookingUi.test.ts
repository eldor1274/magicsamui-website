// UI-facing booking rules (WI-5/7/9/12): provider copy and badges, the
// preview banner headline, which return-page view a status gets (and that a
// paid booking is never offered "Try again"), polling plans, the own-engine
// URLs, the restriction-message classifier, and the BOOKING_ENGINE switch as
// the pages see it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isRestrictionMessage } from "./checkoutMessages.ts";
import { getPublicBookingConfig, resolveBookingEngine } from "./config.ts";
import type { Env } from "./config.ts";
import { DEMO_COPY_CONFIG, joinList, modeKind, paymentMethodLabels, payWithText, previewHeadline, providerCopy } from "./paymentCopy.ts";
import { canRetryPayment, isPollingView, pollPlan, returnViewKind } from "./returnView.ts";
import { RESTRICTION_MESSAGES } from "./stripeCheckout.ts";
import { STRIPE_LIVE_ENV, STRIPE_TEST_ENV, checkout, makeKit, sessionIdOf } from "./testkit.ts";
import type { CheckoutSuccess, FulfilmentState, PaymentMode, PaymentStatus, PublicBookingConfig, StatusResponse } from "./types.ts";
import { resumePaymentPath, returnPagePath, safeBookingBasePath, stripeCancelUrl } from "./urls.ts";

const MOCK_ENV: Env = { BOOKING_PAYMENT_PROVIDER: "stripe", BOOKING_STRIPE_MOCK: "true" };
const BEAM_ENV: Env = {
  BOOKING_PAYMENT_PROVIDER: "beam",
  BEAM_API_BASE: "https://playground.api.beamcheckout.com",
  BEAM_MERCHANT_ID: "m",
  BEAM_API_KEY: "k",
  BOOKING_TOKEN_SECRET: "test-only-7f3K9qLm2xVw8RtY4pZn6bHc1dJe5gUa",
};

function config(env: Env): PublicBookingConfig {
  return getPublicBookingConfig(env);
}

/* ------------------------------ copy + badges ----------------------------- */

test("badges: Stripe shows Visa, Mastercard, PromptPay, Apple Pay, Google Pay - never Amex/JCB/UnionPay", () => {
  const labels = paymentMethodLabels(config(MOCK_ENV));
  assert.deepEqual(labels, ["Visa", "Mastercard", "PromptPay", "Apple Pay", "Google Pay"]);
});

test("badges: Beam and the demo keep their full set (5 card brands + PromptPay)", () => {
  const expected = ["Visa", "Mastercard", "JCB", "Amex", "UnionPay", "PromptPay"];
  assert.deepEqual(paymentMethodLabels(config(BEAM_ENV)), expected);
  assert.deepEqual(paymentMethodLabels(config({})), expected);
});

test("copy: a Stripe page never mentions Beam, a Beam/demo page never mentions Stripe", () => {
  const strings = (c: ReturnType<typeof providerCopy>) =>
    [c.secureLine, c.payHeading, c.payExplainer, c.payButtonSuffix, c.busyLabel, c.payAnnouncement, c.feeExplainer(5), c.perk.title, c.perk.text].join(" ");
  const stripe = strings(providerCopy(config(MOCK_ENV)));
  assert.doesNotMatch(stripe, /Beam/);
  assert.match(stripe, /Stripe/);
  assert.match(stripe, /held? .*30 minutes|hold it for 30 minutes/);
  for (const env of [BEAM_ENV, {}]) {
    const beam = strings(providerCopy(config(env)));
    assert.doesNotMatch(beam, /Stripe/);
    assert.match(beam, /Beam/);
  }
  assert.equal(providerCopy(DEMO_COPY_CONFIG).brand, "Beam");
});

test("copy: the fee explainer and label use the configured percentage (Stripe 5%, Beam 3%, override)", () => {
  assert.equal(config(MOCK_ENV).cardFeePct, 5);
  assert.equal(config(BEAM_ENV).cardFeePct, 3);
  assert.equal(config({}).cardFeePct, 3);
  assert.equal(config({ ...MOCK_ENV, BOOKING_CARD_FEE_PCT: "4" }).cardFeePct, 4);
  assert.match(providerCopy(config(MOCK_ENV)).feeExplainer(5), /^A 5% payment processing fee applies/);
  // No cost-recovery claim the business can't back for every method (PromptPay/domestic cards cost far less).
  assert.doesNotMatch(providerCopy(config(MOCK_ENV)).feeExplainer(5), /covers the cost/);
  assert.doesNotMatch(providerCopy(config(BEAM_ENV)).feeExplainer(3), /covers the cost/);
});

test("copy: payWithText lists the ways to pay in plain words", () => {
  assert.equal(payWithText(config(MOCK_ENV)), "Visa, Mastercard, Apple Pay, Google Pay or Thai PromptPay QR");
  assert.equal(joinList(["a"]), "a");
  assert.equal(joinList(["a", "b"]), "a and b");
  assert.equal(joinList(["a", "b", "c"], "or"), "a, b or c");
});

/* ------------------------------ preview banner ---------------------------- */

test("banner headline: honest about provider, mode, data source and Cloudbeds writes", () => {
  assert.match(previewHeadline({ paymentMode: "demo", dataSource: "demo" }), /^demo mode: availability and prices are simulated/);
  assert.match(previewHeadline({ paymentMode: "demo", dataSource: "cloudbeds" }), /live Cloudbeds availability, simulated payment/);
  assert.match(previewHeadline({ paymentMode: "stripe-mock", dataSource: "demo" }), /^MOCK mode: fake Stripe checkout and a simulated Cloudbeds reservation/);
  const realWrites = previewHeadline({ paymentMode: "stripe-test", dataSource: "cloudbeds", cloudbedsWrites: "live" });
  assert.match(realWrites, /REAL Cloudbeds reservation/);
  assert.match(realWrites, /12\+ months ahead and the owner's test email/);
  assert.match(previewHeadline({ paymentMode: "stripe-test", dataSource: "demo", cloudbedsWrites: "mock" }), /reservation is simulated/);
  assert.match(previewHeadline({ paymentMode: "stripe-live", dataSource: "cloudbeds" }), /^LIVE payments: real cards are charged through Stripe/);
  assert.match(previewHeadline({ paymentMode: "beam-playground", dataSource: "cloudbeds" }), /^Beam test mode/);
});

test("mode kinds", () => {
  const kinds: Record<PaymentMode, string> = {
    demo: "demo",
    "beam-playground": "test",
    "beam-live": "live",
    "stripe-mock": "mock",
    "stripe-test": "test",
    "stripe-live": "live",
  };
  for (const [mode, kind] of Object.entries(kinds)) assert.equal(modeKind(mode as PaymentMode), kind, mode);
});

test("public config the UI reads, per mode", () => {
  const mock = config(MOCK_ENV);
  assert.equal(mock.provider, "stripe");
  assert.equal(mock.mock, true);
  assert.equal(mock.cloudbedsWrites, "mock");
  assert.equal(mock.requiresGuestDetails, true);
  assert.equal(mock.collectPostcode, true);
  assert.equal(mock.addonsEnabled, false);
  assert.deepEqual(mock.ratePlans, ["standard"]);
  assert.equal(mock.depositPct, 100);
  assert.equal(mock.promoEnabled, false);
  const test = config(STRIPE_TEST_ENV);
  assert.equal(test.paymentMode, "stripe-test");
  assert.equal(test.cloudbedsWrites, "live");
  assert.deepEqual(test.testGuard, { minArrivalMonths: 12 });
  const demo = config({});
  assert.equal(demo.provider, "demo");
  assert.equal(demo.requiresGuestDetails, false);
  assert.equal(demo.collectPostcode, false);
  assert.equal(demo.addonsEnabled, true);
  assert.equal(demo.bookingPath, "/booking-preview");
  // Locked: still names the configured provider (banner) and offers WhatsApp.
  const locked = config({ BOOKING_PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_live_abcdefghijkl" });
  assert.equal(locked.paymentStatus, "locked");
  assert.equal(locked.paymentMode, "demo");
  assert.equal(locked.provider, "stripe");
  assert.match(locked.whatsappUrl, /^https:\/\/wa\.me\//);
});

/* ------------------------------ return page ------------------------------- */

function status(s: PaymentStatus, fulfilment: FulfilmentState = "not_applicable", failureCode: string | null = null) {
  return { status: s, failureCode, fulfilment: { state: fulfilment, reservationId: fulfilment === "confirmed" ? "123456" : null } };
}

test("return view: Stripe paid states wait for Cloudbeds before success", () => {
  assert.equal(returnViewKind(status("paid", "confirmed")), "paid");
  assert.equal(returnViewKind(status("paid", "confirming")), "confirming");
  assert.equal(returnViewKind(status("paid", "needs_attention")), "attention");
  assert.equal(returnViewKind(status("pending", "awaiting_payment")), "pending");
  // demo / Beam: no fulfilment step
  assert.equal(returnViewKind(status("paid")), "paid");
  assert.equal(returnViewKind(status("pending")), "pending");
});

test("return view: unpaid states, retry rules, mismatch is contact-only", () => {
  assert.equal(returnViewKind(status("expired", "released")), "unpaid");
  assert.equal(returnViewKind(status("cancelled", "released")), "unpaid");
  assert.equal(returnViewKind(status("failed", "released", "PAYMENT_FAILED")), "unpaid");
  assert.equal(returnViewKind(status("failed", "not_applicable", "AMOUNT_OR_REFERENCE_MISMATCH")), "mismatch");
  assert.equal(canRetryPayment(status("expired", "released")), true);
  assert.equal(canRetryPayment(status("cancelled", "released")), true);
  assert.equal(canRetryPayment(status("failed", "released", "PAYMENT_FAILED")), true);
  assert.equal(canRetryPayment(status("failed", "not_applicable", "CH_CARD_DECLINED")), true);
  assert.equal(canRetryPayment(status("failed", "not_applicable", "AMOUNT_OR_REFERENCE_MISMATCH")), false);
  assert.equal(canRetryPayment(status("refunded")), false);
});

test("return view: a paid booking is NEVER offered a new payment, whatever its fulfilment state", () => {
  const states: FulfilmentState[] = ["not_applicable", "awaiting_payment", "confirming", "confirmed", "needs_attention", "released"];
  for (const f of states) {
    assert.equal(canRetryPayment(status("paid", f)), false, f);
    assert.notEqual(returnViewKind(status("paid", f)), "unpaid", f);
  }
});

test("return view: polling views and plans (Stripe ~3 s for 3 minutes; Beam backoff)", () => {
  assert.equal(isPollingView("pending"), true);
  assert.equal(isPollingView("confirming"), true);
  for (const k of ["paid", "attention", "mismatch", "unpaid"] as const) assert.equal(isPollingView(k), false, k);
  const stripe = pollPlan({ paymentMode: "stripe-live" });
  assert.equal(stripe.nextMs(1), 3_000);
  assert.equal(stripe.nextMs(40), 3_000);
  assert.equal(stripe.maxMs, 180_000);
  const beam = pollPlan({ paymentMode: "beam-playground" });
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(beam.nextMs), [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  assert.equal(beam.firstMs, 1_000);
  assert.equal(beam.maxMs, 120_000);
});

/* ---------------------------------- URLs ---------------------------------- */

test("urls: Try again goes back to the page the booking was made on; only our two paths are allowed", () => {
  assert.equal(resumePaymentPath("expired", undefined, "MSV-ABCDEFGH-2"), "/booking-preview?resume=payment&reason=expired");
  assert.match(resumePaymentPath("cancelled", "classic", null, "/booking"), /^\/booking\?resume=payment&reason=cancelled&theme=classic$/);
  assert.equal(safeBookingBasePath("/booking"), "/booking");
  assert.equal(safeBookingBasePath("/booking-preview"), "/booking-preview");
  for (const bad of ["https://evil.example", "//evil.example", "/booking/../admin", "", null, undefined]) {
    assert.equal(safeBookingBasePath(bad), "/booking-preview", String(bad));
  }
  assert.equal(returnPagePath("/booking", "MSV-X", "tok.en", "classic"), "/booking/return?ref=MSV-X&t=tok.en&theme=classic");
  assert.equal(returnPagePath("https://evil.example", "MSV-X", "t"), "/booking-preview/return?ref=MSV-X&t=t");
});

test("urls: Stripe's back link carries exactly what the booking page needs to release the hold (no PII)", () => {
  const url = new URL(stripeCancelUrl("https://magicsamui.com", "/booking", "MSV-ABC", "signed.token", "magic"));
  assert.equal(url.pathname, "/booking");
  assert.equal(url.searchParams.get("resume"), "payment");
  assert.equal(url.searchParams.get("reason"), "cancelled");
  assert.equal(url.searchParams.get("ref"), "MSV-ABC");
  assert.equal(url.searchParams.get("t"), "signed.token");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["reason", "ref", "resume", "t"]);
});

test("checkout through the real server code: success/cancel URLs use the page's base path and carry no guest data", async () => {
  const kit = makeKit();
  const res = await checkout(kit);
  const body = res.body as CheckoutSuccess;
  assert.equal(body.ok, true, JSON.stringify(res.body));
  assert.equal(body.provider, "stripe");
  assert.ok(body.linkToken, "link token for the return page and the abandon call");
  const session = kit.fakeStripe.session(sessionIdOf(body))!;
  const success = new URL(session.success_url.replace("{CHECKOUT_SESSION_ID}", "cs_x"));
  assert.equal(success.pathname, "/booking-preview/return");
  const cancel = new URL(session.cancel_url!);
  assert.equal(cancel.pathname, "/booking-preview");
  assert.equal(cancel.searchParams.get("reason"), "cancelled");
  assert.equal(cancel.searchParams.get("ref"), body.ref);
  for (const u of [session.success_url, session.cancel_url!, body.redirectUrl]) {
    // testkit GUEST: owner-test@example.com, +66 95 246 6011, postcode 84320, "Late dinner please".
    assert.doesNotMatch(u, /owner-test|84320|Late(%20|\+| )dinner|95(%20|\+| )246/i);
  }
});

/* ----------------------------- restrictions ------------------------------- */

test("restriction refusals are recognised (so the page names the rule), sales are not", () => {
  const name = "Honeymoon Suite";
  for (const reason of ["closed_to_arrival", "closed_to_departure", "min_stay", "max_stay"]) {
    assert.equal(isRestrictionMessage(RESTRICTION_MESSAGES[reason](name, 3)), true, reason);
  }
  for (const reason of ["blocked", "sold_out"]) assert.equal(isRestrictionMessage(RESTRICTION_MESSAGES[reason](name)), false, reason);
  assert.equal(isRestrictionMessage("Sorry - a room in your reservation was just booked by someone else. Please choose again."), false);
  assert.equal(isRestrictionMessage(undefined), false);
});

/* ------------------------------ engine switch ----------------------------- */

test("BOOKING_ENGINE: default and production rules as the pages see them", () => {
  assert.equal(resolveBookingEngine({}), "cloudbeds");
  assert.equal(resolveBookingEngine({ BOOKING_ENGINE: "cloudbeds" }), "cloudbeds");
  assert.equal(resolveBookingEngine({ BOOKING_ENGINE: "OWN" }), "own"); // local / preview deployments
  assert.equal(resolveBookingEngine({ BOOKING_ENGINE: "own", ...MOCK_ENV }), "own");
  // Production: only a fully unlocked live Stripe engine may replace the public /booking.
  assert.equal(resolveBookingEngine({ BOOKING_ENGINE: "own", VERCEL_ENV: "production" }), "cloudbeds");
  assert.equal(resolveBookingEngine({ BOOKING_ENGINE: "own", ...STRIPE_TEST_ENV, VERCEL_ENV: "production" }), "cloudbeds");
  const live = { BOOKING_ENGINE: "own", ...STRIPE_LIVE_ENV };
  assert.equal(resolveBookingEngine(live), "own");
  assert.equal(getPublicBookingConfig(live).bookingPath, "/booking");
  // Emergency stop: /booking falls back to Cloudbeds at once.
  assert.equal(resolveBookingEngine({ ...live, BOOKING_ALLOW_LIVE_PAYMENTS: "false" }), "cloudbeds");
  assert.equal(getPublicBookingConfig({ ...live, BOOKING_ALLOW_LIVE_PAYMENTS: "false" }).bookingPath, "/booking-preview");
});

test("StatusResponse fields the return page reads stay in the contract", () => {
  // Compile-time guard: if these fields move, this file stops type-checking.
  const sample: Pick<StatusResponse, "status" | "failureCode" | "fulfilment" | "purchase" | "provider"> = {
    status: "paid",
    failureCode: null,
    fulfilment: { state: "confirmed", reservationId: "1" },
    purchase: { transactionId: "1", valueBaht: 100, currency: "THB" },
    provider: "stripe",
  };
  assert.equal(returnViewKind(sample), "paid");
});

test("own engine: the DIRECT-code perk is swapped out (promos are off there); default pages keep it", async () => {
  const { landings, perksForEngine, OWN_ENGINE_PERK } = await import("../../data/landings.ts");
  for (const t of Object.values(landings)) {
    assert.ok(t.perks.some((p) => p.text.includes("DIRECT")), `${t.code} has the DIRECT perk today`);
    assert.deepEqual(perksForEngine(t.perks, t.code, false), t.perks, "default engine: unchanged");
    const own = perksForEngine(t.perks, t.code, true);
    assert.equal(own.some((p) => p.text.includes("DIRECT")), false, `${t.code}: no DIRECT promise on the own engine`);
    assert.equal(own.length, t.perks.length);
    assert.ok(OWN_ENGINE_PERK[t.code], `${t.code} has a translated replacement`);
  }
});

test("confirmation-email copy follows CLOUDBEDS_SEND_STATUS_EMAIL (Stripe only)", () => {
  assert.equal(getPublicBookingConfig(STRIPE_TEST_ENV).sendsBookingConfirmationEmail, false);
  assert.equal(getPublicBookingConfig({ ...STRIPE_TEST_ENV, CLOUDBEDS_SEND_STATUS_EMAIL: "true" }).sendsBookingConfirmationEmail, true);
  assert.equal(getPublicBookingConfig({ CLOUDBEDS_SEND_STATUS_EMAIL: "true" }).sendsBookingConfirmationEmail, false, "demo/beam: not a Stripe booking");
});

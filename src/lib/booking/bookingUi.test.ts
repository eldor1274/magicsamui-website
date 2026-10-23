// UI-facing booking rules (WI-5/7/9/12): provider copy and badges, the
// preview banner headline, which return-page view a status gets (and that a
// paid booking is never offered "Try again"), polling plans, the own-engine
// URLs, the restriction-message classifier, the BOOKING_ENGINE switch as the
// pages see it, and the booking page's checkout attempts and guest-step copy
// for Stripe and the hold-first Beam modes (design S5.1).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isRestrictionMessage } from "./checkoutMessages.ts";
import { runAbandon } from "./abandon.ts";
import { BEAM_LIVE_ENV, BEAM_TEST_ENV, beamHeld, makeBeamKit, makeParityKit } from "./beamTestkit.ts";
import type { BeamKit } from "./beamTestkit.ts";
import { MAX_ATTEMPT_PAYABLE_MS, abandonVerdict, attemptMayStillBePaid, attemptOf, attemptPayableMs, cancelledAttemptOf, parseAttempt, tracksAttempts } from "./checkoutAttempt.ts";
import { getPublicBookingConfig, resolveBookingEngine, toPublicConfig } from "./config.ts";
import type { Env } from "./config.ts";
import { DEMO_COPY_CONFIG, guestStepCopy, joinList, modeKind, paymentMethodLabels, payWithText, previewHeadline, providerCopy } from "./paymentCopy.ts";
import { canRetryPayment, isPollingView, pollPlan, returnViewKind } from "./returnView.ts";
import { isBookingRef } from "./ref.ts";
import { RESTRICTION_MESSAGES } from "./stripeCheckout.ts";
import type { ProviderDepsFn } from "./stripeDeps.ts";
import { NOW, STRIPE_LIVE_ENV, STRIPE_TEST_ENV, checkout, makeKit, sessionIdOf } from "./testkit.ts";
import type { CheckoutSuccess, FulfilmentState, PaymentMode, PaymentStatus, PublicBookingConfig, StatusResponse } from "./types.ts";
import { homeSearchPath, resumePaymentPath, returnPagePath, safeBookingBasePath, stripeCancelUrl } from "./urls.ts";

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

test("badges: the demo keeps its full set (5 card brands + PromptPay); Beam shows Visa, Mastercard, JCB, Amex, PromptPay and its e-wallets", () => {
  const expected = ["Visa", "Mastercard", "JCB", "Amex", "UnionPay", "PromptPay"];
  // Beam (design S3.1): BEAM_CARD_BRANDS; its e-wallet badges as text chips (design S5.2).
  assert.deepEqual(paymentMethodLabels(config(BEAM_ENV)), ["Visa", "Mastercard", "JCB", "Amex", "PromptPay", "Alipay", "LINE Pay", "TrueMoney", "ShopeePay"]);
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
  // Design S5.1 (gap review 14): 2 s, then each wait x1.5 up to 15 s, for 15 minutes.
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(beam.nextMs), [3_000, 4_500, 6_750, 10_125, 15_000, 15_000]);
  assert.equal(beam.firstMs, 2_000);
  assert.equal(beam.maxMs, 900_000);
});

test("return view: beam-live polls as the playground does; the demo keeps its old backoff (1 s, then 2 s, 4 s ... 30 s, 2 minutes)", () => {
  const plan = (mode: PaymentMode) => {
    const p = pollPlan({ paymentMode: mode });
    return { firstMs: p.firstMs, next: [1, 2, 3, 4, 5, 6, 40].map(p.nextMs), maxMs: p.maxMs };
  };
  assert.deepEqual(plan("beam-live"), plan("beam-playground"));
  assert.deepEqual(plan("beam-live"), { firstMs: 2_000, next: [3_000, 4_500, 6_750, 10_125, 15_000, 15_000, 15_000], maxMs: 15 * 60_000 });
  assert.deepEqual(plan("demo"), { firstMs: 1_000, next: [2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000], maxMs: 120_000 });
  for (const mode of ["stripe-mock", "stripe-test", "stripe-live"] as const) {
    assert.deepEqual(plan(mode), { firstMs: 2_000, next: [3_000, 3_000, 3_000, 3_000, 3_000, 3_000, 3_000], maxMs: 180_000 }, mode);
  }
  // A Beam page checks about 63 times in its 15 minutes, never faster than every 2 s nor slower than every 15 s.
  const beam = pollPlan({ paymentMode: "beam-live" });
  let elapsed = beam.firstMs;
  let checks = 1;
  while (elapsed < beam.maxMs) {
    const wait = beam.nextMs(checks);
    assert.ok(wait >= 2_000 && wait <= 15_000, String(wait));
    elapsed += wait;
    checks += 1;
  }
  assert.ok(checks >= 60 && checks <= 66, String(checks));
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

/* ----------------------- checkout attempts (design S5.1) ----------------------- */

const MIN = 60_000;
const LOCKED_STRIPE_ENV: Env = { BOOKING_PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_live_abcdefghijkl" };
/** The routes' providerDeps for a Beam kit: Beam's deps and gateway, nothing for any other provider. */
const beamProviderDeps = (kit: BeamKit): ProviderDepsFn => (provider) => (provider === "beam" ? { deps: kit.deps, gw: kit.gw } : null);
/** POST /api/booking/abandon as the booking page sends it. */
const abandonOn = (kit: BeamKit, body: { t: string; l: string | null }) =>
  runAbandon(body, { config: kit.config, providerDeps: beamProviderDeps(kit), nowMs: kit.now.ms, log: kit.deps.log });
/** The public config the kit's booking page gets. */
const pageConfig = (kit: BeamKit, env: Env = BEAM_TEST_ENV) => toPublicConfig(kit.config, env);
/** Every GET of a Beam link answers HTTP 500 (Beam can't be read) while `on()`. */
function unreadableLinks(kit: BeamKit, on: () => boolean): void {
  const real = kit.deps.fetchImpl ?? kit.fakeBeam.fetch;
  kit.deps.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (on() && (init?.method ?? "GET").toUpperCase() === "GET" && url.pathname.startsWith("/api/v1/payment-links/")) {
      const body = { code: 500, message: "simulated outage", error: { errorCode: "INTERNAL_SERVER_ERROR", errorMessage: "simulated outage" } };
      return new Response(JSON.stringify(body), { status: 500, headers: { "content-type": "application/json" } });
    }
    return real(input, init);
  }) as typeof fetch;
}

test("attempts: every Stripe page tracks its checkout attempt as before (a locked one included), the hold-first Beam modes now too, never the demo", () => {
  for (const env of [MOCK_ENV, STRIPE_TEST_ENV, STRIPE_LIVE_ENV, LOCKED_STRIPE_ENV]) {
    const c = config(env);
    assert.equal(c.provider, "stripe");
    assert.equal(tracksAttempts(c), true, c.paymentMode);
    assert.equal(c.attemptPayableMinutes, undefined, "no Stripe config carries a Beam window");
    assert.equal(attemptPayableMs(c), 33 * MIN, "Stripe's window is unchanged");
  }
  const playground = config(BEAM_ENV);
  assert.equal(playground.paymentMode, "beam-playground");
  assert.equal(tracksAttempts(playground), true);
  const live = pageConfig(makeBeamKit({ env: BEAM_LIVE_ENV }), BEAM_LIVE_ENV);
  assert.equal(live.paymentMode, "beam-live");
  assert.equal(tracksAttempts(live), true);
  // The demo, also with BOOKING_PAYMENT_PROVIDER=beam and no Beam keys: no attempt flow, as before.
  for (const env of [{}, { BOOKING_PAYMENT_PROVIDER: "beam" }]) {
    const c = config(env);
    assert.equal(c.paymentMode, "demo");
    assert.equal(tracksAttempts(c), false, JSON.stringify(env));
    assert.equal(attemptPayableMs(c), 33 * MIN);
  }
  // A locked Beam page keeps the Beam shape (its window) but runs no attempt flow: Pay is off and its paymentMode is the demo's.
  const locked = config(BEAM_LIVE_ENV);
  assert.deepEqual([locked.paymentStatus, locked.provider, locked.paymentMode, locked.attemptPayableMinutes], ["locked", "beam", "demo", 53]);
  assert.equal(tracksAttempts(locked), false);
  // Every (provider, mode) pair, hand-made ones included: Stripe as before (the provider alone), Beam only in its hold-first modes.
  const modes: PaymentMode[] = ["demo", "beam-playground", "beam-live", "stripe-mock", "stripe-test", "stripe-live"];
  for (const provider of ["stripe", "beam", "demo"] as const) {
    for (const paymentMode of modes) {
      const expected = provider === "stripe" || (provider === "beam" && paymentMode.startsWith("beam-"));
      assert.equal(tracksAttempts({ provider, paymentMode }), expected, `${provider} / ${paymentMode}`);
    }
  }
});

test("attempts: a checkout answer starts an attempt for Stripe exactly as before and for Beam's hold-first link; never for the demo", async () => {
  const stripeKit = makeParityKit("stripe");
  const s = await stripeKit.held();
  // Byte for byte what BookingApp stored before: { ref, token: linkToken, startedAt }.
  assert.equal(JSON.stringify(attemptOf(s.body, NOW)), JSON.stringify({ ref: s.body.ref, token: s.body.linkToken, startedAt: NOW }));
  const kit = makeBeamKit();
  const b = await beamHeld(kit);
  assert.deepEqual(attemptOf(b.body, NOW), { ref: b.ref, token: b.body.linkToken, startedAt: NOW });
  assert.equal(b.body.provider, "beam");
  const demo: CheckoutSuccess = { ...b.body, provider: "demo", paymentMode: "demo", linkToken: null, holdReservationId: null };
  assert.equal(attemptOf(demo, NOW), null);
  assert.equal(attemptOf({ ...demo, linkToken: "tok" }, NOW), null, "the demo never, whatever it carries");
  assert.equal(attemptOf({ ...demo, provider: "beam", linkToken: "tok" }, NOW), null, "Beam in the demo mode never");
  assert.equal(attemptOf({ ...b.body, paymentMode: "stripe-live" }, NOW), null, "a Beam answer in a Stripe mode never (hand-made)");
  assert.equal(attemptOf({ ...b.body, provider: "demo" }, NOW), null, "a demo answer in a Beam mode never (hand-made)");
  assert.equal(attemptOf({ ...s.body, linkToken: null }, NOW), null, "no link token, no attempt (as before)");
});

test("a Beam attempt is released before a new Pay: abandon with its link token disables the link and cancels the hold; paid or pending goes to its return page", async () => {
  const kit = makeBeamKit();
  const cfg = pageConfig(kit);
  assert.equal(tracksAttempts(cfg), true);
  const a = await beamHeld(kit);
  const prior = attemptOf(a.body, kit.now.ms)!;
  // BookingApp: releaseAttempt({ ref: prior.ref, t: prior.token, l: prior.token }) before the new checkout.
  const released = await abandonOn(kit, { t: prior.token, l: prior.token });
  assert.deepEqual(released, { status: 200, body: { ok: true, state: "released" } });
  assert.equal(abandonVerdict(released.body), "forget");
  assert.equal(kit.fakeBeam.link(a.linkId).status, "DISABLED", "the first link can never be paid afterwards");
  assert.equal(kit.fakeCb.reservations.get(a.reservationId)?.status, "canceled");
  // Only now the new Pay opens the second link (the room is free again).
  const links = kit.fakeBeam.count(/^POST \/api\/v1\/payment-links$/);
  const b = await beamHeld(kit);
  assert.equal(kit.fakeBeam.count(/^POST \/api\/v1\/payment-links$/), links + 1);
  // Paid meanwhile (another tab): its return page, never a second link.
  kit.fakeBeam.pay(b.linkId, "CARD");
  const paid = await abandonOn(kit, { t: b.body.linkToken!, l: b.body.linkToken });
  assert.deepEqual(paid.body, { ok: true, state: "paid" });
  assert.equal(abandonVerdict(paid.body), "return-page");
  assert.equal(kit.fakeCb.reservations.get(b.reservationId)?.status, "confirmed");
  // A PromptPay payment the bank is still confirming: its return page; the link and the hold are kept.
  const c = await beamHeld(kit, "promptpay", [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }]);
  kit.fakeBeam.payPending(c.linkId);
  const pending = await abandonOn(kit, { t: c.body.linkToken!, l: c.body.linkToken });
  assert.deepEqual(pending.body, { ok: true, state: "pending" });
  assert.equal(abandonVerdict(pending.body), "return-page");
  assert.notEqual(kit.fakeCb.reservations.get(c.reservationId)?.status, "canceled");
  // Every other answer: closed and not_applicable forget the attempt, an error keeps it.
  assert.equal(abandonVerdict({ ok: true, state: "closed" }), "forget");
  assert.equal(abandonVerdict({ ok: true, state: "not_applicable" }), "forget");
  assert.equal(abandonVerdict({ ok: false, error: "upstream_error", message: "x" }), "error");
});

test("no second Beam link while the first may still be paid: 53 minutes (30 + the 20-minute pending grace + 3) when Beam can't be read; Stripe keeps 33", async () => {
  const kit = makeBeamKit();
  const cfg = pageConfig(kit);
  assert.equal(cfg.attemptPayableMinutes, 53);
  assert.equal(attemptPayableMs(cfg), 53 * MIN);
  const a = await beamHeld(kit);
  const prior = attemptOf(a.body, kit.now.ms)!;
  let down = true;
  unreadableLinks(kit, () => down);
  const failed = await abandonOn(kit, { t: prior.token, l: prior.token });
  assert.equal(failed.status, 502, JSON.stringify(failed.body));
  assert.equal(abandonVerdict(failed.body), "error");
  assert.equal(kit.fakeBeam.link(a.linkId).status, "ACTIVE", "nothing was closed: the attempt is kept");
  assert.notEqual(kit.fakeCb.reservations.get(a.reservationId)?.status, "canceled");
  // BookingApp refuses the new Pay while attemptMayStillBePaid(prior, now, attemptPayableMs(cfg)).
  const at = (ms: number) => attemptMayStillBePaid(prior, prior.startedAt + ms, attemptPayableMs(cfg));
  assert.deepEqual([0, 30 * MIN, 33 * MIN, 53 * MIN - 1, 53 * MIN, 60 * MIN].map(at), [true, true, true, true, false, false]);
  // Stripe: 33 minutes, as before (also the default when no window is passed).
  const stripe = config(STRIPE_LIVE_ENV);
  assert.deepEqual([33 * MIN - 1, 33 * MIN].map((ms) => attemptMayStillBePaid(prior, prior.startedAt + ms, attemptPayableMs(stripe))), [true, false]);
  assert.deepEqual([33 * MIN - 1, 33 * MIN].map((ms) => attemptMayStillBePaid(prior, prior.startedAt + ms)), [true, false]);
  assert.equal(attemptMayStillBePaid({ startedAt: 0 }, NOW, attemptPayableMs(cfg)), false, "an unknown start never blocks");
  // The window follows BEAM_PENDING_GRACE_MINUTES.
  assert.equal(attemptPayableMs(config({ ...BEAM_ENV, BEAM_PENDING_GRACE_MINUTES: "45" })), 78 * MIN);
  // Beam answers again: the retry releases the first link and the hold.
  down = false;
  assert.deepEqual((await abandonOn(kit, { t: prior.token, l: prior.token })).body, { ok: true, state: "released" });
  assert.equal(kit.fakeBeam.link(a.linkId).status, "DISABLED");
});

test("a Beam attempt keeps its page's payable window (round 7): after an abandon 502 the Stripe fallback page (owner decision 5) waits the Beam attempt's 53 minutes before a new checkout; a Stripe attempt is stored and timed exactly as before", async () => {
  const kit = makeBeamKit();
  const cfg = pageConfig(kit);
  const a = await beamHeld(kit);
  const t0 = kit.now.ms;
  // BookingApp: attemptOf(res, Date.now(), attemptPayableMs(cfg)), stored as JSON and read back by parseAttempt.
  const made = attemptOf(a.body, t0, attemptPayableMs(cfg));
  assert.deepEqual(made, { ref: a.ref, token: a.body.linkToken, startedAt: t0, payableMs: 53 * MIN });
  const prior = parseAttempt(JSON.parse(JSON.stringify(made)));
  assert.deepEqual(prior, made);
  assert.ok(prior);
  // Beam can't be read: abandon answers 502 and the attempt is kept.
  let down = true;
  unreadableLinks(kit, () => down);
  const failed = await abandonOn(kit, { t: prior.token, l: prior.token });
  assert.equal(failed.status, 502, JSON.stringify(failed.body));
  assert.equal(abandonVerdict(failed.body), "error");
  // The deployment fell back to Stripe: the page's own window is Stripe's 33 minutes, but the Beam attempt's own 53 count.
  const stripe = config(STRIPE_LIVE_ENV);
  assert.equal(attemptPayableMs(stripe), 33 * MIN);
  const onStripe = (ms: number) => attemptMayStillBePaid(prior, t0 + ms, attemptPayableMs(stripe));
  assert.deepEqual([0, 33 * MIN, 53 * MIN - 1, 53 * MIN].map(onStripe), [true, true, true, false]);
  // On the Beam page: 53 minutes, as before; the longer of the two windows counts.
  assert.deepEqual([53 * MIN - 1, 53 * MIN].map((ms) => attemptMayStillBePaid(prior, t0 + ms, attemptPayableMs(cfg))), [true, false]);
  assert.equal(attemptMayStillBePaid({ ...prior, payableMs: 10 * MIN }, t0 + 20 * MIN, attemptPayableMs(cfg)), true, "a shorter own window never shortens the page's");
  assert.equal(attemptMayStillBePaid({ startedAt: 0, payableMs: 53 * MIN }, t0, attemptPayableMs(stripe)), false, "an unknown start never blocks");
  // Beam answers again: released, so the new checkout may start.
  down = false;
  assert.deepEqual((await abandonOn(kit, { t: prior.token, l: prior.token })).body, { ok: true, state: "released" });
  // The window follows BEAM_PENDING_GRACE_MINUTES (at most 60: 93 minutes, under MAX_ATTEMPT_PAYABLE_MS).
  const longest = attemptPayableMs(config({ ...BEAM_ENV, BEAM_PENDING_GRACE_MINUTES: "60" }));
  assert.equal(longest, 93 * MIN);
  assert.ok(longest <= MAX_ATTEMPT_PAYABLE_MS);
  assert.equal(attemptOf(a.body, t0, longest)?.payableMs, 93 * MIN);
  // A window that is not a whole number of ms in (0, MAX_ATTEMPT_PAYABLE_MS] is never kept.
  for (const bad of [0, -1, 1.5, MAX_ATTEMPT_PAYABLE_MS + 1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    assert.equal("payableMs" in (attemptOf(a.body, t0, bad) ?? {}), false, String(bad));
  }
  assert.equal(attemptOf(a.body, t0, MAX_ATTEMPT_PAYABLE_MS)?.payableMs, MAX_ATTEMPT_PAYABLE_MS);
  // Stripe: byte for byte the attempt BookingApp stored before, whatever window the page passes.
  const s = await makeParityKit("stripe").held();
  const before = JSON.stringify({ ref: s.body.ref, token: s.body.linkToken, startedAt: NOW });
  for (const w of [undefined, 33 * MIN, 53 * MIN]) assert.equal(JSON.stringify(attemptOf(s.body, NOW, w)), before, String(w));
  const stripePrior = parseAttempt(JSON.parse(before));
  assert.equal(JSON.stringify(stripePrior), before);
  assert.ok(stripePrior);
  assert.deepEqual([33 * MIN - 1, 33 * MIN].map((ms) => attemptMayStillBePaid(stripePrior, NOW + ms, attemptPayableMs(stripe))), [true, false]);
});

test("parseAttempt reads every stored value without a Beam window exactly as readAttempt did before round 7; a valid window is kept, any other dropped", () => {
  // readAttempt's checks before round 7 (components/booking/attempt.ts at 0bcc14b), after JSON.parse.
  const before = (v: unknown) => {
    try {
      const a = v as Record<string, unknown>;
      if (!isBookingRef(a.ref) || typeof a.token !== "string" || a.token.length === 0 || a.token.length > 4096) return null;
      const startedAt = typeof a.startedAt === "number" && Number.isFinite(a.startedAt) && a.startedAt > 0 ? a.startedAt : 0;
      return { ref: a.ref, token: a.token, startedAt };
    } catch {
      return null;
    }
  };
  const ref = "MSV-20261023-7F3K";
  const values: unknown[] = [null, 5, "x", [], {}, true];
  for (const r of [ref, "MSV-1", "", 7, undefined]) {
    for (const token of ["signed.token", "", "x".repeat(4096), "x".repeat(4097), 42, null, undefined]) {
      for (const startedAt of [NOW, 0, -1, 1.5, "5", null, undefined, 1e20]) values.push({ ref: r, token, startedAt, extra: "kept out" });
    }
  }
  for (const v of values) {
    const json = JSON.parse(JSON.stringify(v ?? null));
    assert.equal(JSON.stringify(parseAttempt(json)), JSON.stringify(before(json)), JSON.stringify(v));
    // A window that is not a valid one changes nothing.
    if (json && typeof json === "object" && !Array.isArray(json)) {
      for (const payableMs of [0, -5, 1.5, MAX_ATTEMPT_PAYABLE_MS + 1, "3180000", null]) {
        assert.equal(JSON.stringify(parseAttempt({ ...json, payableMs })), JSON.stringify(before(json)), `${JSON.stringify(v)} ${String(payableMs)}`);
      }
    }
  }
  assert.deepEqual(parseAttempt({ ref, token: "signed.token", startedAt: NOW, payableMs: 53 * MIN }), { ref, token: "signed.token", startedAt: NOW, payableMs: 53 * MIN });
  assert.equal(parseAttempt({ ref, token: "", startedAt: NOW, payableMs: 53 * MIN }), null, "an invalid attempt stays invalid");
});

test("the Beam cancel landing calls abandon: Beam's Cancel URL gives the page the attempt to release, and abandon disables the link and cancels the hold", async () => {
  for (const storage of ["link token remembered", "storage blocked"] as const) {
    const kit = makeBeamKit();
    const cfg = pageConfig(kit);
    const h = await beamHeld(kit);
    const cancel = new URL(kit.fakeBeam.link(h.linkId).cancelUrl ?? "");
    assert.deepEqual([...cancel.searchParams.keys()].sort(), ["reason", "ref", "resume", "t"]);
    assert.equal(cancel.searchParams.get("reason"), "cancelled");
    // OwnBookingPage reads the landing exactly so.
    const sp = cancel.searchParams;
    const landing = cancelledAttemptOf(cfg, { resume: sp.get("resume") === "payment" ? "payment" : null, ref: sp.get("ref") ?? undefined, t: sp.get("t") ?? undefined });
    assert.deepEqual(landing, { ref: h.ref, t: sp.get("t") }, storage);
    // BookingApp's mount: postAbandon({ t: cancelledAttempt.t, l: recallLinkToken(cancelledAttempt.ref) }).
    const l = storage === "link token remembered" ? h.body.linkToken : null;
    const res = await abandonOn(kit, { t: landing!.t, l });
    assert.deepEqual(res, { status: 200, body: { ok: true, state: "released" } }, storage);
    assert.equal(abandonVerdict(res.body), "forget");
    assert.equal(kit.fakeBeam.link(h.linkId).status, "DISABLED", storage);
    assert.equal(kit.fakeCb.reservations.get(h.reservationId)?.status, "canceled", storage);
  }
  // The same landing elsewhere: a Stripe page as before (any resume=payment with a booking ref and a token), never the demo.
  const ref = "MSV-20261005-7F3K";
  const landing = { resume: "payment", ref, t: "signed.token" };
  for (const env of [MOCK_ENV, STRIPE_TEST_ENV, STRIPE_LIVE_ENV, LOCKED_STRIPE_ENV]) assert.deepEqual(cancelledAttemptOf(config(env), landing), { ref, t: "signed.token" });
  for (const env of [{}, { BOOKING_PAYMENT_PROVIDER: "beam" }, BEAM_LIVE_ENV]) assert.equal(cancelledAttemptOf(config(env), landing), null, JSON.stringify(env));
  const stripe = config(STRIPE_LIVE_ENV);
  for (const bad of [{ resume: null }, { resume: "pay" }, { ref: "MSV-1" }, { ref: undefined }, { t: "" }, { t: undefined }, { t: "x".repeat(4097) }]) {
    assert.equal(cancelledAttemptOf(stripe, { ...landing, ...bad }), null, JSON.stringify(bad));
  }
  assert.deepEqual(cancelledAttemptOf(stripe, { ...landing, t: "x".repeat(4096) }), { ref, t: "x".repeat(4096) });
});

test("booking page wiring (design S5.1): the attempt flow, its window and the cancel landing follow the mode", () => {
  const app = repoSrc("components/booking/BookingApp.tsx");
  assert.ok(app.includes("holdReleased: cancelledAttempt !== null || tracksAttempts(configRef.current),"));
  assert.match(app, /if \(tracksAttempts\(cfg\)\) \{\s*(\/\/[^\n]*\n\s*)*const prior = readAttempt\(\);/);
  assert.ok(app.includes("const released = await releaseAttempt({ ref: prior.ref, t: prior.token, l: prior.token });"));
  assert.ok(app.includes("if (attemptMayStillBePaid(prior, Date.now(), attemptPayableMs(cfg))) {"));
  // Round 7: a Beam attempt keeps the page's payable window (a Stripe attempt is the same as before).
  assert.match(app, /const attempt = attemptOf\(res, Date\.now\(\), attemptPayableMs\(cfg\)\);\s*if \(attempt\) rememberAttempt\(attempt\);/);
  assert.ok(app.includes("const verdict = abandonVerdict(res);"));
  // Round 7 (round-6 triage): finishRelease acts on the verdict - paid or pending: the return page; error: keep the attempt; else forget it.
  assert.match(
    app,
    /const verdict = abandonVerdict\(res\);\s*if \(verdict === "return-page"\) \{\s*window\.location\.assign\(returnPagePath\(configRef\.current\.bookingPath, attempt\.ref, attempt\.t, theme\)\);\s*return "left";\s*\}\s*setReleasing\(false\);\s*if \(verdict === "error"\) return "error";\s*(\/\/[^\n]*\n\s*)*clearAttempt\(attempt\.ref\);\s*return "continue";/,
  );
  // pay(): "left" stops; "error" while the earlier attempt may still be paid stops before any checkout; once it can't, carry on.
  assert.match(
    app,
    /if \(released === "left"\) return;\s*if \(released === "error"\) \{[\s\S]*?if \(attemptMayStillBePaid\(prior, Date\.now\(\), attemptPayableMs\(cfg\)\)\) \{[\s\S]*?type: "checkoutFailed",[\s\S]*?\}\);\s*return;\s*\}\s*clearAttempt\(prior\.ref\);\s*\}/,
  );
  assert.ok(app.indexOf("const released = await releaseAttempt(") < app.indexOf("const res = await postCheckout({"), "the release comes before the checkout");
  const store = repoSrc("components/booking/attempt.ts");
  assert.ok(store.includes("return parseAttempt(JSON.parse(raw));"), "readAttempt reads through parseAttempt");
  assert.ok(app.includes("void postAbandon({ t: cancelledAttempt.t, l: recallLinkToken(cancelledAttempt.ref) }).then((res) => finishRelease(cancelledAttempt, res));"));
  assert.doesNotMatch(app, /provider === "stripe"/, "no Stripe-only attempt rule is left in the booking page");
  const own = repoSrc("components/booking/OwnBookingPage.tsx");
  assert.ok(own.includes("const cancelledAttempt = cancelledAttemptOf(config, { resume, ref: one(sp.ref), t: one(sp.t) });"));
  assert.ok(own.includes("cancelledAttempt={cancelledAttempt}"));
  const guest = repoSrc("components/booking/checkout/GuestDetailsStep.tsx");
  assert.ok(guest.includes("const { emailHint: confirmationHint, detailsNote } = guestStepCopy(bookingConfig);"));
  assert.ok(guest.includes('hint={confirmationHint}') && guest.includes("{detailsNote}"));
});

test("guest step copy (design S5.1): Stripe and the demo word it exactly as before; a Beam page names no Stripe and promises no receipt", () => {
  const STRIPE_NOTE =
    "When you press Pay, your details go securely to our reservation system to hold your room, and your email to Stripe for your receipt. Nothing is charged until you pay.";
  const PREVIEW_NOTE = "Preview: your details stay in this browser and are not sent anywhere. Nothing is booked until you pay.";
  const BEAM_NOTE = "When you press Pay, your details go securely to our reservation system to hold your room. Nothing is charged until you pay.";
  assert.deepEqual(guestStepCopy(config(STRIPE_LIVE_ENV)), { emailHint: "Your payment receipt is sent here.", detailsNote: STRIPE_NOTE });
  assert.deepEqual(guestStepCopy(config({ ...STRIPE_LIVE_ENV, CLOUDBEDS_SEND_STATUS_EMAIL: "true" })), {
    emailHint: "Your payment receipt and booking confirmation are sent here.",
    detailsNote: STRIPE_NOTE,
  });
  for (const env of [STRIPE_TEST_ENV, MOCK_ENV, LOCKED_STRIPE_ENV]) {
    assert.deepEqual(guestStepCopy(config(env)), { emailHint: "In live mode your payment receipt is sent here.", detailsNote: STRIPE_NOTE }, JSON.stringify(env));
  }
  assert.deepEqual(guestStepCopy(config({ ...STRIPE_TEST_ENV, CLOUDBEDS_SEND_STATUS_EMAIL: "true" })).emailHint, "In live mode your payment receipt and booking confirmation are sent here.");
  for (const c of [config({}), config({ BOOKING_PAYMENT_PROVIDER: "beam" }), undefined]) {
    assert.deepEqual(guestStepCopy(c), { emailHint: "In live mode your booking confirmation is sent here.", detailsNote: PREVIEW_NOTE });
  }
  const live = pageConfig(makeBeamKit({ env: BEAM_LIVE_ENV }), BEAM_LIVE_ENV);
  assert.deepEqual(guestStepCopy(live), { emailHint: "Your booking confirmation is sent here.", detailsNote: BEAM_NOTE });
  const beamPages = [config(BEAM_ENV), config({ ...BEAM_ENV, CLOUDBEDS_SEND_STATUS_EMAIL: "true" }), pageConfig(makeBeamKit()), config(BEAM_LIVE_ENV)];
  for (const c of beamPages) {
    const copy = guestStepCopy(c);
    assert.deepEqual(copy, { emailHint: "In live mode your booking confirmation is sent here.", detailsNote: BEAM_NOTE }, c.paymentMode);
  }
  for (const c of [live, ...beamPages]) assert.doesNotMatch(Object.values(guestStepCopy(c)).join(" "), /Stripe|receipt/i);
});

test("booking page wiring (design S5.2): Pay sends the Beam method only and waits for one; the summary's button goes to the choice; results, room cards and the secure-payment window word the fee by method", () => {
  const app = repoSrc("components/booking/BookingApp.tsx");
  assert.match(
    app,
    /const payMethod = pagePayMethod\(cfg, s\.payMethod\);\s*if \(pageOffersMethodChoice\(cfg\) && payMethod === null\) \{\s*focusPayMethodChoice\(\);\s*return;\s*\}\s*analytics\.addPaymentInfo\(q, payMethod\);/,
  );
  assert.match(app, /postCheckout\(\{[\s\S]*?theme,\s*(\/\/[^\n]*\n\s*)*\.\.\.checkoutPayMethod\(cfg, s\.payMethod\),[\s\S]*?\}\);/, "in the checkout body, Beam only");
  assert.ok(app.includes('cta = { label: "Choose how to pay", barLabel: "Pay now", onClick: focusPayMethodChoice };'));
  assert.ok(app.includes("const choosePayMethod = pageOffersMethodChoice(config) && !locked && !paymentPaused && pagePayMethod(config, state.payMethod) === null;"));
  assert.ok(app.includes("config: configRef.current,\n") || app.includes("config: configRef.current,\r\n"), "the mount hydrate keeps a method only while it is offered");
  assert.ok(app.includes("resume: null, config: configRef.current, today };"), "so does the back/forward-cache hydrate");
  assert.ok(app.includes("payMethod={state.payMethod ?? null}") && app.includes("onPayMethodChange={actions.setPayMethod}"));
  assert.ok(app.includes("pricing: pagePricing(data.config, null) },"), "add_to_cart prices the card/e-wallet fee");
  assert.ok(app.includes('if (res.error === "unavailable" || res.error === "price_changed" || chooseAgain) runSearch(s.search, { fresh: true });'));
  // Round 7 (round-6 triage): the follow-up after a 'Please choose how to pay' answer, and the summary's choice button.
  assert.ok(app.includes('const chooseAgain = pageOffersMethodChoice(cfg) && res.error === "invalid_request" && res.fixStep === "payment";'));
  assert.match(app, /announce\(\s*chooseAgain\s*\? "Please choose how to pay\. Nothing was charged\."/);
  assert.ok(app.includes('} else if (step === "payment" && quote && choosePayMethod) {'));
  assert.ok(app.indexOf('} else if (step === "payment" && quote && choosePayMethod) {') < app.indexOf('} else if (step === "payment" && quote) {'), "before the Pay button");
  assert.ok(app.includes("if (q && payMethod !== s.payMethod) announce(`Total ${formatThbWithCode(q.totalSatang)}.`);"), "a method change announces the new total");
  const pay = repoSrc("components/booking/checkout/PaymentStep.tsx");
  assert.ok(pay.includes("disabled={locked || paused || needsMethod}"));
  assert.ok(pay.includes("const methodOptions = config && !locked ? payMethodOptions(config) : [];"));
  assert.ok(pay.includes("radio.focus({ preventScroll: true });"), "focusPayMethodChoice moves focus to the choice");
  const summary = repoSrc("components/booking/summary/ReservationSummary.tsx");
  assert.ok(summary.includes("const hideFee = Boolean(bookingConfig && quote && feeLineHidden(bookingConfig, quote));"));
  const results = repoSrc("components/booking/results/ResultsList.tsx");
  assert.ok(results.includes("const feePct = pagePricing(availability.config, null).cardFeePct;"));
  assert.ok(results.includes("const feeNotes = resultsFeeNotes(availability.config);"));
  assert.ok(results.includes("feeNote={feeNotes ? feeNotes.card : undefined}"));
  const card = repoSrc("components/booking/results/RoomOfferCard.tsx");
  assert.match(card, /\{feeNote !== undefined\s*\? feeNote && <p className="text-xs text-\(--bk-text-muted\)">\{feeNote\}<\/p>\s*: feePct > 0 && <p className="text-xs text-\(--bk-text-muted\)">\+ \{feePct\}% payment processing fee<\/p>\}/);
  const modal = repoSrc("components/booking/checkout/SecurePaymentModal.tsx");
  assert.ok(modal.includes("const beam = config ? beamSecurePayment(config) : null;"));
});

/* ----------------------------- restrictions ------------------------------- */

test("restriction refusals are recognised (so the page names the rule), sales are not", () => {
  const name = "Honeymoon Suite";
  for (const reason of ["closed_to_arrival", "closed_to_departure", "min_stay", "max_stay"]) {
    assert.equal(isRestrictionMessage(RESTRICTION_MESSAGES[reason](name, 3)), true, reason);
  }
  for (const reason of ["blocked", "sold_out", "derived_rate"]) assert.equal(isRestrictionMessage(RESTRICTION_MESSAGES[reason](name)), false, reason);
  assert.equal(isRestrictionMessage("Sorry - a room in your reservation was just booked by someone else. Please choose again."), false);
  assert.equal(isRestrictionMessage(undefined), false);
});

/* ---------------------------- homepage search ----------------------------- */

const repoSrc = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("homepage: the booking page's SearchBar under the own engine, the Cloudbeds widget otherwise", () => {
  const page = repoSrc("app/page.tsx");
  assert.ok(page.includes('const ownEngine = resolveBookingEngine() === "own";'));
  assert.match(page, /ownEngine \? \(\s*<OwnHomeSearch \/>\s*\) : \(\s*<CloudbedsDatePicker \/>\s*\)/);
  // From md up the bar sits inside the bottom of the hero video (the hero text moves up to make room), like the booking
  // page's bar over its photo; the Cloudbeds path keeps the old classes exactly.
  assert.ok(page.includes('ownEngine ? " md:pb-48" : ""'));
  assert.ok(page.includes('ownEngine ? "relative z-10 mx-auto -mt-9 max-w-3xl px-5 md:-mt-40" : "mx-auto -mt-9 max-w-3xl px-5"'));
  assert.ok(page.includes('import HomeSearch from "@/components/HomeSearchLazy";'));
  // Same limits, code pill and hint as BookingApp hands its SearchBar.
  for (const prop of [
    "maxNights={config.maxNights}",
    "bookingWindowMonths={config.bookingWindowMonths}",
    "maxAdults={config.maxSearchAdults}",
    "promoEnabled={promoInputOffered(config)}",
    "promoCodeHint={promoCodeHint(config)}",
  ]) {
    assert.ok(page.includes(prop), `homepage passes ${prop}`);
  }
  assert.doesNotMatch(page, /OwnDatePicker/);

  // Code-split twice: the default homepage ships only a loader; the bar (and booking.css) loads in the browser only.
  assert.match(repoSrc("components/HomeSearchLazy.tsx"), /dynamic<HomeSearchProps>\(\(\) => import\("\.\/HomeSearch"\)\);/);
  const shell = repoSrc("components/HomeSearch.tsx");
  assert.equal(shell.match(/dynamic<HomeSearchBarProps>\(\(\) => import\("\.\/HomeSearchBar"\), \{\s*ssr: false,/g)?.length, 2);
  assert.doesNotMatch(shell, /^import (?!type )[^;]*(HomeSearchBar|components\/booking|booking\.css)/m, "no static import of the booking engine");
  // Server HTML / no JavaScript: a placeholder link to /booking, at the bar's exact height.
  assert.ok(shell.includes('<a href="/booking" aria-label="Search availability"'));
  assert.ok(shell.includes("bk-home-search relative z-10 min-h-[240px] md:min-h-[116px]"));
  assert.ok(shell.includes("<PlaceholderOnError fallback={<HomeSearchPlaceholder"), "a chunk that fails to load leaves the link");
  assert.ok(shell.includes('track("date_picker_interact")'), "same GA4 event as the earlier form");

  const bar = repoSrc("components/HomeSearchBar.tsx");
  assert.ok(bar.includes('import SearchBar from "@/components/booking/search/SearchBar";'));
  assert.ok(bar.includes('variant="hero"') && bar.includes("promoResult={null}"), "hero look; no code is ever applied on the homepage");
  assert.ok(bar.includes('track("date_picker_submit")'), "same GA4 event as the earlier form");
  assert.ok(bar.includes("window.location.assign(homeSearchPath("));
  assert.ok(bar.includes('promo: "" }'), "the code starts empty");

  // booking.css's page-wide scroll padding stays off the homepage.
  assert.ok(repoSrc("components/booking/booking.css").includes("html:has(.booking-app):not(:has(.bk-home-search)) {"));
});

test("homepage search URL: exactly the parameters the booking page prefills, the code only when entered and offered", () => {
  const stay = { checkIn: "2026-11-02", checkOut: "2026-11-05", adults: 3, promo: "" };
  assert.equal(homeSearchPath(stay, true, "k1"), "/booking?checkin=2026-11-02&checkout=2026-11-05&adults=3&s=k1");
  assert.equal(homeSearchPath({ ...stay, promo: " direct " }, true, "k1"), "/booking?checkin=2026-11-02&checkout=2026-11-05&adults=3&promo=DIRECT&s=k1");
  assert.equal(homeSearchPath({ ...stay, promo: "DIRECT" }, false, "k1"), "/booking?checkin=2026-11-02&checkout=2026-11-05&adults=3&s=k1", "no code pill (Beam): no code");
  assert.equal(homeSearchPath({ ...stay, promo: "DI RECT!" }, true, "k1"), "/booking?checkin=2026-11-02&checkout=2026-11-05&adults=3&s=k1", "a code the page would drop");
  // Every homepage search gets a fresh one-shot id, so the same dates searched again are applied again on /booking.
  assert.notEqual(new URL(homeSearchPath(stay, true, "a"), "https://x").searchParams.get("s"), new URL(homeSearchPath(stay, true, "b"), "https://x").searchParams.get("s"));
  assert.match(new URL(homeSearchPath(stay, true), "https://x").searchParams.get("s") ?? "", /^[a-z0-9]{1,16}$/);
  const url = new URL(homeSearchPath({ ...stay, promo: "summer_26" }, true), "https://magicsamui.com");
  assert.equal(url.pathname, "/booking");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["adults", "checkin", "checkout", "promo", "s"]);
  assert.equal(url.searchParams.get("promo"), "SUMMER_26");
  // ...which are the one-shot landing parameters OwnBookingPage reads.
  const own = readFileSync(new URL("../../components/booking/OwnBookingPage.tsx", import.meta.url), "utf8");
  for (const k of ["checkin", "checkout", "adults", "promo"]) {
    assert.ok(own.includes(`one(sp.${k})`), `OwnBookingPage reads ?${k}`);
  }
  assert.ok(own.includes('const ONE_SHOT_PARAMS = ["checkin", "checkout", "adults", "promo", "s",'), "?s is a one-shot landing parameter (fingerprinted and cleaned from the address bar)");
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

test("own engine without the Direct rate (directCopySwapped): the DIRECT-code perk is swapped out; otherwise pages keep it", async () => {
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

test("date picker: paging months never moves the calendar, and a click that only closes it never follows a link (owner, 8 Oct)", () => {
  // Always six week rows, so a 6-week month (January 2027) is as tall as a 5-week one and nothing flips.
  const calendar = repoSrc("components/booking/search/RangeCalendar.tsx");
  assert.ok(calendar.includes("const WEEK_ROWS = 6;"));
  assert.ok(calendar.includes("const padRows = WEEK_ROWS - weeks.length;"));
  assert.ok(calendar.includes('<tr key={`pad-${pi}`} aria-hidden="true">'), "padding rows are hidden from screen readers");
  // Desktop months have a fixed width; a w-full table in the w-max popover stretched it across the screen.
  assert.ok(calendar.includes('density === "compact" ? "w-full" : "w-77"'));

  // The popover chooses its side on open, scroll and resize only; a content resize keeps it.
  const popover = repoSrc("components/booking/ui/Popover.tsx");
  assert.ok(popover.includes("const observer = new ResizeObserver(schedule);"));
  assert.ok(popover.includes('window.addEventListener("scroll", onScroll, true);'));
  // A clamped panel (short screens) stays scrollable: its own scroll never re-places it, and measuring never clears max-height.
  assert.ok(popover.includes("if (e.target instanceof Node && panel.contains(e.target)) return;"));
  assert.ok(popover.includes("const height = panel.scrollHeight + panel.offsetHeight - panel.clientHeight;"));
  assert.doesNotMatch(popover, /panel\.style\.maxHeight = "";/);
  assert.ok(popover.includes('window.addEventListener("resize", scheduleAndReconsider);'));
  assert.match(popover, /side !== null && !reconsiderSide \? side === "bottom"/);

  // The homepage hero photo is one big link to /rooms: closing the calendar by clicking it must not open /rooms.
  const overlay = repoSrc("components/booking/ui/overlay.ts");
  assert.match(overlay, /cur\.onClose\(\);[\s\S]{0,200}const plain = e\.button === 0 && !e\.ctrlKey && !e\.metaKey && !e\.shiftKey && !e\.altKey;\s*const link = [^\n]*closest\("a\[href\]"\);\s*if \(link && plain\) swallowNextClickOn\(link\);/);
  assert.ok(overlay.includes('document.addEventListener("click", onClick, true);'));
  // Only that one click: a press that became a scroll, menu or drag (or any new press or key) disarms it.
  assert.ok(overlay.includes('const PRESS_ENDED_WITHOUT_CLICK = ["pointerdown", "pointercancel", "contextmenu", "dragstart", "keydown"] as const;'));
  assert.ok(overlay.includes("for (const type of PRESS_ENDED_WITHOUT_CLICK) document.addEventListener(type, done, true);"));
});

test("closing a sheet or modal on an iPhone never scrolls to the footer (owner, 9 Oct)", () => {
  // Safari never focuses a tapped button, so the "opener" was <body> and returning focus to it scrolled to its bottom edge.
  const overlay = repoSrc("components/booking/ui/overlay.ts");
  assert.ok(overlay.includes("const previouslyFocused = currentOpener();"));
  assert.match(overlay, /function currentOpener\(\): HTMLElement \| null \{\s*const active = document\.activeElement;\s*if \(active instanceof HTMLElement && active !== document\.body && active !== document\.documentElement\) return active;/);
  assert.ok(overlay.includes("performance.now() - lastPress.at < OPENER_PRESS_MS"), "only a press from the last moment stands in for the opener");
  assert.doesNotMatch(overlay, /const previouslyFocused = document\.activeElement instanceof HTMLElement \? document\.activeElement : null;/);

  // The reveal never scrolls for the page itself or for a control inside a fixed bar or sheet.
  const bars = repoSrc("components/booking/bottomBars.ts");
  assert.ok(bars.includes("if (!el || el === document.body || el === document.documentElement || insideFixedBox(el)) return;"));
  assert.ok(bars.includes("const by = Math.min(rect.bottom - limit, rect.top - topClearance);"), "a tall block keeps its top in view");

  // Phone sheets opened from a pill go back to that pill.
  assert.ok(repoSrc("components/booking/ui/Sheet.tsx").includes("useOverlay({ open, containerRef: panelRef, onClose, initialFocusRef, returnFocusRef, lockScroll: true });"));
  assert.ok(repoSrc("components/booking/ui/PickerOverlay.tsx").includes("returnFocusRef={anchorRef}"));
  assert.match(repoSrc("components/booking/search/DateRangePicker.tsx"), /variant="fullscreen"\s*onClose=\{onClose\}\s*returnFocusRef=\{anchorRef\}/);
});

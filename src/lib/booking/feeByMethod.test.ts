// Beam design step S3.2: the fee per payment method, and payMethod in the checkout request, the booking token and the
// quote helpers. PayMethod (types.ts) is card_ewallet | promptpay; feePctFor (quote.ts) is the fee % a quote is priced
// with - on Beam the card/e-wallet fee (BOOKING_CARD_FEE_PCT, 3 when unset) or the PromptPay fee (BEAM_PROMPTPAY_FEE_PCT,
// 0 when unset: owner decision 1); on Stripe and the demo config.cardFeePct whatever is sent. Nothing uses payMethod in
// checkout yet (S4.6): a Stripe checkout is the same with or without one, and the golden snapshot is unchanged.
//
// Round 4: only the Beam modes read payMethod (ValidationLimits.payMethods, set by runCheckout when config.beam is set);
// Stripe and the demo ignore the field whatever it holds, exactly as production main. payMethodOffered (quote.ts) is the
// server half of the BEAM_PROMPTPAY switch and pagePayMethodOffered its browser half: the public feeByMethod carries
// exactly the groups the checkout takes (no promptpay while the switch is off).

import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildOffers } from "./availability.ts";
import { buildPaymentLinkRequest } from "./beam.ts";
import { runCheckout } from "./checkout.ts";
import { BEAM_LIVE_BASE, BEAM_PLAYGROUND_BASE, getBookingConfig, getFulfilmentConfig, getPublicBookingConfig, toPublicConfig } from "./config.ts";
import type { BookingConfig, Env } from "./config.ts";
import { addDays } from "./dates.ts";
import { demoInventory } from "./demoProvider.ts";
import { computeQuote, feePctFor, isPayMethod, pagePayMethodOffered, payMethodOffered, percentOf } from "./quote.ts";
import { runAbandon } from "./abandon.ts";
import { runStatus } from "./status.ts";
import { HONEYMOON, NOW as KIT_NOW, ORIGIN, STRIPE_LIVE_ENV, STRIPE_TEST_ENV, TOKEN_SECRET, checkout, makeKit, refCharSequence, request, serverQuote, sessionIdOf } from "./testkit.ts";
import { createBookingToken, isBookingSummary, verifyBookingToken } from "./token.ts";
import type { BookingSummary, CartItemInput, PayMethod, Quote, RoomOffer } from "./types.ts";
import { PAY_METHOD_UNREADABLE, parseCheckoutRequest } from "./validate.ts";

const KEYS = { BEAM_MERCHANT_ID: "m", BEAM_API_KEY: "k" };
/** beam-playground with no Cloudbeds variables (demo rates, the mock writer locally). */
const BEAM_PG: Env = { BOOKING_PAYMENT_PROVIDER: "beam", BEAM_API_BASE: BEAM_PLAYGROUND_BASE, ...KEYS, BOOKING_TOKEN_SECRET: TOKEN_SECRET };
/** beam-live with every beamLiveBlockers condition (the code switch is on since S7.1; READY is passed where it was before). */
const BEAM_LIVE: Env = {
  ...BEAM_PG,
  BEAM_API_BASE: BEAM_LIVE_BASE,
  CLOUDBEDS_API_KEY: "cbat_read_testkit",
  CLOUDBEDS_API_KEY_BOOKING: "cbat_write_testkit",
  CLOUDBEDS_PROPERTY_ID: "235064",
  UPSTASH_REDIS_REST_URL: "https://example-redis.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "token-testkit",
  BOOKING_ALLOW_LIVE_PAYMENTS: "true",
  VERCEL_ENV: "production",
  // Since design S3.4 (beamLiveBlockers): the webhook HMAC key, a sweep secret and the Cloudbeds confirmation email.
  BEAM_WEBHOOK_HMAC_KEY: Buffer.from("test-only-beam-hmac-key-01234567").toString("base64"),
  BOOKING_SWEEP_SECRET: "sweep-secret-testkit-0123456789",
  CLOUDBEDS_SEND_STATUS_EMAIL: "true",
};
const MOCK_ENV: Env = { BOOKING_PAYMENT_PROVIDER: "stripe", BOOKING_STRIPE_MOCK: "true" };
const METHODS: PayMethod[] = ["card_ewallet", "promptpay"];
const LIMITS = { today: "2026-10-05", maxNights: 30, bookingWindowMonths: 18, maxSearchAdults: 18, maxCartItems: 6 };
/** The limits runCheckout parses a Beam-mode request with (config.beam set). */
const BEAM_LIMITS = { ...LIMITS, payMethods: true };
/** Every kind of payMethod a hand-made request can carry: the two groups, the empty values and garbage. */
const ANY_PAY_METHOD: unknown[] = ["bogus", "CARD", 0, false, [], {}, null, "", "promptpay", "card_ewallet", " promptpay", "PROMPTPAY", true, 1, ["promptpay"]];
/** The code switch overridden (tests only): beam-live resolves (also without it since S7.1). */
const READY = { liveFulfilmentReady: true };
/** The emergency stop: a locked beam-live page (since S7.1 the code switch no longer locks it). */
const STOPPED: Env = { BOOKING_ALLOW_LIVE_PAYMENTS: "false" };

/** A config_warning (Beam with BOOKING_CARD_FEE_PCT set) is expected in some tests: keep it out of the output. */
function quiet(t: TestContext): void {
  t.mock.method(console, "warn", () => undefined);
}

/** The first 3-night demo stay (from Nov 2026) with the Garden Suite free, priced by `config`'s rate plans. */
function demoStay(config: BookingConfig): { checkIn: string; checkOut: string; offers: RoomOffer[]; items: CartItemInput[] } {
  for (let i = 0; i < 200; i++) {
    const checkIn = addDays("2026-11-02", i);
    const checkOut = addDays(checkIn, 3);
    const offers = buildOffers(demoInventory(checkIn, checkOut), 2, config.ratePlans);
    if (offers.find((o) => o.slug === "garden-suite")?.available) {
      return { checkIn, checkOut, offers, items: [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }] };
    }
  }
  throw new Error("no demo availability for garden-suite");
}

/** The quote a checkout prices for `payMethod` (feePctFor). */
function quoteFor(config: BookingConfig, payMethod: PayMethod | undefined): Quote {
  const { checkIn, checkOut, offers, items } = demoStay(config);
  return computeQuote({ checkIn, checkOut, items, promo: null, pricing: { cardFeePct: feePctFor(config, payMethod), depositPct: config.depositPct } }, offers);
}

/* ---------------------------------- feePctFor ---------------------------------- */

test("feePctFor on Beam: card_ewallet = the card fee (3), promptpay = BEAM_PROMPTPAY_FEE_PCT (0); no method yet = the card/e-wallet fee", () => {
  const config = getBookingConfig(BEAM_PG);
  assert.equal(config.paymentMode, "beam-playground");
  assert.equal(feePctFor(config, "card_ewallet"), 3);
  assert.equal(feePctFor(config, "promptpay"), 0, "owner decision 1");
  assert.equal(feePctFor(config, undefined), 3);
  assert.equal(feePctFor(config, null), 3);
  assert.equal(isPayMethod("card_ewallet"), true);
  assert.equal(isPayMethod("promptpay"), true);
  for (const v of ["", "PROMPTPAY", "card", "wallet", null, undefined, 1, {}, []]) assert.equal(isPayMethod(v), false, JSON.stringify(v));
});

test("quote per method on Beam: PromptPay 0% -> cardFeeSatang 0; card_ewallet 3%", () => {
  const config = getBookingConfig(BEAM_PG);
  const promptpay = quoteFor(config, "promptpay");
  assert.equal(promptpay.cardFeePct, 0);
  assert.equal(promptpay.cardFeeSatang, 0);
  assert.equal(promptpay.totalSatang, promptpay.feeBaseSatang);
  assert.equal(promptpay.dueNowSatang, promptpay.totalSatang, "100% up front on Beam");

  const card = quoteFor(config, "card_ewallet");
  assert.equal(card.cardFeePct, 3);
  assert.ok(card.cardFeeSatang > 0);
  assert.equal(card.cardFeeSatang, percentOf(card.feeBaseSatang, 3));
  assert.equal(card.totalSatang, card.feeBaseSatang + card.cardFeeSatang);
  assert.equal(card.feeBaseSatang, promptpay.feeBaseSatang, "the rooms are the same: only the fee differs");
  assert.deepEqual(quoteFor(config, undefined), card, "before a method is chosen: the card/e-wallet total");
});

test("BEAM_PROMPTPAY_FEE_PCT=3 -> 3% for both methods (the same quote)", () => {
  const config = getBookingConfig({ ...BEAM_PG, BEAM_PROMPTPAY_FEE_PCT: "3" });
  assert.equal(feePctFor(config, "promptpay"), 3);
  assert.equal(feePctFor(config, "card_ewallet"), 3);
  const promptpay = quoteFor(config, "promptpay");
  assert.equal(promptpay.cardFeePct, 3);
  assert.ok(promptpay.cardFeeSatang > 0);
  assert.deepEqual(promptpay, quoteFor(config, "card_ewallet"));
  // Two decimals, as the config reads it.
  assert.equal(feePctFor(getBookingConfig({ ...BEAM_PG, BEAM_PROMPTPAY_FEE_PCT: "1.256" }), "promptpay"), 1.26);
});

test("BOOKING_CARD_FEE_PCT=7 changes Stripe and Beam card_ewallet but not PromptPay", (t: TestContext) => {
  quiet(t);
  const stripe = getBookingConfig({ ...STRIPE_TEST_ENV, BOOKING_CARD_FEE_PCT: "7" });
  for (const m of [...METHODS, undefined, null]) assert.equal(feePctFor(stripe, m), 7, `Stripe ${String(m)}`);
  const beam = getBookingConfig({ ...BEAM_PG, BOOKING_CARD_FEE_PCT: "7" });
  assert.equal(feePctFor(beam, "card_ewallet"), 7);
  assert.equal(feePctFor(beam, "promptpay"), 0);
  assert.equal(quoteFor(beam, "card_ewallet").cardFeePct, 7);
  assert.equal(quoteFor(beam, "promptpay").cardFeeSatang, 0);
  // Both set: each follows its own variable.
  const both = getBookingConfig({ ...BEAM_PG, BOOKING_CARD_FEE_PCT: "7", BEAM_PROMPTPAY_FEE_PCT: "2" });
  assert.deepEqual([feePctFor(both, "card_ewallet"), feePctFor(both, "promptpay")], [7, 2]);
});

test("Stripe and the demo: config.cardFeePct whatever is sent (the quote is exactly today's)", () => {
  const envs: [string, Env][] = [
    ["stripe-test", STRIPE_TEST_ENV],
    ["stripe-live", STRIPE_LIVE_ENV],
    ["stripe-mock", MOCK_ENV],
    ["stripe-test with Beam variables", { ...STRIPE_TEST_ENV, BEAM_API_BASE: BEAM_PLAYGROUND_BASE, ...KEYS, BEAM_PROMPTPAY_FEE_PCT: "0" }],
    ["demo", {}],
    ["demo with a card fee", { BOOKING_CARD_FEE_PCT: "4.5" }],
    ["provider beam without keys (the demo)", { BOOKING_PAYMENT_PROVIDER: "beam", BEAM_PROMPTPAY_FEE_PCT: "0" }],
  ];
  for (const [name, env] of envs) {
    const config = getBookingConfig(env);
    assert.equal(config.beam, null, name);
    const { checkIn, checkOut, offers, items } = demoStay(config);
    // What checkout prices with today: config.cardFeePct.
    const today = computeQuote({ checkIn, checkOut, items, promo: null, pricing: { cardFeePct: config.cardFeePct, depositPct: config.depositPct } }, offers);
    for (const m of [...METHODS, undefined, null]) {
      assert.equal(feePctFor(config, m), config.cardFeePct, `${name} ${String(m)}`);
      assert.deepEqual(quoteFor(config, m ?? undefined), today, `${name} ${String(m)}`);
    }
  }
  assert.equal(feePctFor(getBookingConfig(STRIPE_LIVE_ENV), "promptpay"), 5, "Stripe's 5% even for PromptPay");
});

test("feePctFor agrees with the public feeByMethod on every Beam config, and Stripe and the demo carry none", (t: TestContext) => {
  quiet(t);
  const beamEnvs: [string, Env][] = [
    ["beam-playground", BEAM_PG],
    ["PromptPay fee 3", { ...BEAM_PG, BEAM_PROMPTPAY_FEE_PCT: "3" }],
    ["PromptPay fee 2.5, card fee 4", { ...BEAM_PG, BEAM_PROMPTPAY_FEE_PCT: "2.5", BOOKING_CARD_FEE_PCT: "4" }],
    ["clamped and unreadable values", { ...BEAM_PG, BEAM_PROMPTPAY_FEE_PCT: "50", BOOKING_CARD_FEE_PCT: "abc" }],
    ["PromptPay off", { ...BEAM_PG, BEAM_PROMPTPAY: "off" }],
    ["e-wallets off", { ...BEAM_PG, BEAM_EWALLETS: "off" }],
  ];
  for (const [name, env] of beamEnvs) {
    const config = getBookingConfig(env);
    const pub = toPublicConfig(config, env);
    assert.ok(pub.feeByMethod, name);
    assert.deepEqual(getPublicBookingConfig(env).feeByMethod, pub.feeByMethod, name);
    // Every group the checkout takes has its fee, equal to feePctFor; a group it does not take has no key (round 4:
    // PromptPay while BEAM_PROMPTPAY is off).
    for (const m of METHODS) {
      if (payMethodOffered(config, m)) assert.equal(pub.feeByMethod[m], feePctFor(config, m), `${name} ${m}`);
      else assert.equal(m in pub.feeByMethod, false, `${name} ${m}: not offered, no fee shown`);
    }
    assert.equal(feePctFor(config, "card_ewallet"), pub.cardFeePct, `${name}: the card/e-wallet fee is cardFeePct`);
  }
  assert.deepEqual(getPublicBookingConfig({ ...BEAM_PG, BEAM_PROMPTPAY: "off" }).feeByMethod, { card_ewallet: 3 });
  // A locked beam-live page (the emergency stop; since S7.1 the code switch locks nothing) shows the fees the unlocked config would charge.
  const locked = getPublicBookingConfig({ ...BEAM_LIVE, ...STOPPED, BEAM_PROMPTPAY_FEE_PCT: "1.5" });
  assert.equal(locked.paymentStatus, "locked");
  const unlocked = getBookingConfig({ ...BEAM_LIVE, BEAM_PROMPTPAY_FEE_PCT: "1.5" }, READY);
  assert.deepEqual(toPublicConfig(unlocked, BEAM_LIVE).feeByMethod, getPublicBookingConfig({ ...BEAM_LIVE, BEAM_PROMPTPAY_FEE_PCT: "1.5" }).feeByMethod, "the beam-live page itself");
  assert.equal(unlocked.paymentMode, "beam-live");
  assert.deepEqual(locked.feeByMethod, { card_ewallet: feePctFor(unlocked, "card_ewallet"), promptpay: feePctFor(unlocked, "promptpay") });
  // Both fee variables set (round-3 triage): the locked page follows BOOKING_CARD_FEE_PCT, not a hard-coded 3.
  const feesEnv = { ...BEAM_LIVE, BOOKING_CARD_FEE_PCT: "4", BEAM_PROMPTPAY_FEE_PCT: "1.5" };
  const lockedFees = getPublicBookingConfig({ ...feesEnv, ...STOPPED });
  const unlockedFees = getBookingConfig(feesEnv, READY);
  assert.equal(lockedFees.paymentStatus, "locked");
  assert.deepEqual(lockedFees.feeByMethod, { card_ewallet: 4, promptpay: 1.5 });
  assert.equal(lockedFees.cardFeePct, unlockedFees.cardFeePct);
  assert.equal(lockedFees.cardFeePct, 4);
  assert.deepEqual(lockedFees.feeByMethod, toPublicConfig(unlockedFees, feesEnv).feeByMethod);
  // A locked page with PromptPay switched off offers the card/e-wallet fee only.
  assert.deepEqual(getPublicBookingConfig({ ...feesEnv, ...STOPPED, BEAM_PROMPTPAY: "off" }).feeByMethod, { card_ewallet: 4 });

  for (const env of [STRIPE_TEST_ENV, STRIPE_LIVE_ENV, MOCK_ENV, {}]) {
    const pub = getPublicBookingConfig(env);
    assert.equal("feeByMethod" in pub, false);
    for (const m of METHODS) assert.equal(feePctFor(getBookingConfig(env), m), pub.cardFeePct);
  }
});

test("payMethodOffered (the server half of BEAM_PROMPTPAY): on Beam card_ewallet always, promptpay only while the switch is on; no method is never taken; Stripe and the demo offer none", () => {
  const on = getBookingConfig(BEAM_PG);
  assert.equal(payMethodOffered(on, "card_ewallet"), true);
  assert.equal(payMethodOffered(on, "promptpay"), true);
  for (const off of ["off", "OFF", "false", "0", "no"]) {
    const config = getBookingConfig({ ...BEAM_PG, BEAM_PROMPTPAY: off });
    assert.equal(config.beam?.promptPay, false, off);
    assert.equal(payMethodOffered(config, "card_ewallet"), true, off);
    assert.equal(payMethodOffered(config, "promptpay"), false, `${off}: the emergency switch refuses PromptPay on the server too`);
  }
  // The e-wallet switch narrows the card_ewallet link (beamLinkSettings), never the group itself.
  assert.equal(payMethodOffered(getBookingConfig({ ...BEAM_PG, BEAM_EWALLETS: "off" }), "card_ewallet"), true);
  assert.equal(payMethodOffered(getBookingConfig(BEAM_LIVE, READY), "promptpay"), true, "beam-live");
  assert.equal(payMethodOffered(getBookingConfig({ ...BEAM_LIVE, BEAM_PROMPTPAY: "off" }, READY), "promptpay"), false, "beam-live, switched off");
  // No method: the same refusal as a switched-off one (S4.6 answers both with 'Please choose how to pay').
  for (const none of [undefined, null]) assert.equal(payMethodOffered(on, none), false, String(none));
  for (const v of ["bitcoin", "PROMPTPAY", "", 1, {}]) assert.equal(payMethodOffered(on, v as PayMethod), false, JSON.stringify(v));
  // Stripe and the demo offer no choice (their checkout ignores payMethod).
  for (const env of [STRIPE_TEST_ENV, STRIPE_LIVE_ENV, MOCK_ENV, {}, { BOOKING_PAYMENT_PROVIDER: "beam" }]) {
    const config = getBookingConfig(env);
    for (const m of METHODS) assert.equal(payMethodOffered(config, m), false, `${config.paymentMode} ${m}`);
  }
});

test("the public config offers exactly what the server takes: no promptpay fee while BEAM_PROMPTPAY is off (ok and locked pages), pagePayMethodOffered agrees with payMethodOffered, and so does the PromptPay badge", () => {
  const cases: [string, Env, Env][] = [];
  for (const extra of [{}, { BEAM_PROMPTPAY: "off" }, { BEAM_PROMPTPAY: "no", BEAM_EWALLETS: "off" }, { BEAM_PROMPTPAY: "maybe" }, { BEAM_PROMPTPAY: "off", BEAM_PROMPTPAY_FEE_PCT: "2" }]) {
    // [label, the page's env, the env the server config is built from (the locked page's unlocked twin)]
    cases.push([`beam-playground ${JSON.stringify(extra)}`, { ...BEAM_PG, ...extra }, { ...BEAM_PG, ...extra }]);
    cases.push([`beam-live ${JSON.stringify(extra)}`, { ...BEAM_LIVE, ...extra }, { ...BEAM_LIVE, ...extra }]);
    cases.push([`locked beam-live (the emergency stop) ${JSON.stringify(extra)}`, { ...BEAM_LIVE, ...STOPPED, ...extra }, { ...BEAM_LIVE, ...extra }]);
  }
  for (const [label, pageEnv, serverEnv] of cases) {
    const page = getPublicBookingConfig(pageEnv);
    const server = getBookingConfig(serverEnv, READY);
    assert.ok(page.feeByMethod, label);
    for (const m of METHODS) {
      assert.equal(pagePayMethodOffered(page, m), payMethodOffered(server, m), `${label} ${m}`);
      assert.equal(page.paymentMethods.includes(m === "promptpay" ? "promptpay" : "card"), payMethodOffered(server, m), `${label} ${m}: the badge`);
    }
  }
  assert.deepEqual(getPublicBookingConfig({ ...BEAM_LIVE, ...STOPPED, BEAM_PROMPTPAY: "off" }).feeByMethod, { card_ewallet: 3 }, "a locked page too");
  assert.deepEqual(getPublicBookingConfig({ ...BEAM_LIVE, BEAM_PROMPTPAY: "off" }).feeByMethod, { card_ewallet: 3 }, "the beam-live page (since S7.1)");
  // A stored choice the page no longer offers is dropped; anything that is not one of the two groups never counts.
  const off = getPublicBookingConfig({ ...BEAM_PG, BEAM_PROMPTPAY: "off" });
  assert.equal(pagePayMethodOffered(off, "promptpay"), false);
  assert.equal(pagePayMethodOffered(off, "card_ewallet"), true);
  const on = getPublicBookingConfig(BEAM_PG);
  for (const v of [undefined, null, "", "PROMPTPAY", "card", 0, {}, ["promptpay"]]) assert.equal(pagePayMethodOffered(on, v), false, JSON.stringify(v));
  // Stripe and demo pages have no feeByMethod: nothing is offered there.
  for (const env of [STRIPE_TEST_ENV, STRIPE_LIVE_ENV, MOCK_ENV, {}, { ...STRIPE_LIVE_ENV, BOOKING_ALLOW_LIVE_PAYMENTS: "false" }]) {
    const page = getPublicBookingConfig(env);
    for (const m of METHODS) assert.equal(pagePayMethodOffered(page, m), false, `${page.paymentMode} ${m}`);
  }
});

test("the Beam link's fee guard follows feePctFor: a BEAM_PROMPTPAY_FEE_PCT override builds the PromptPay link; a quote for the other method is refused", () => {
  const link = (config: BookingConfig, group: PayMethod, quote: Quote) =>
    buildPaymentLinkRequest({
      ref: "MSV-20261005-7F3K",
      quote,
      merchantName: "Magic Suites & Villas",
      redirectUrl: "https://magicsamui.com/booking-preview/return?ref=MSV-20261005-7F3K&t=x",
      cancelUrl: "https://magicsamui.com/booking-preview?resume=payment&ref=MSV-20261005-7F3K&t=x",
      nowMs: Date.parse("2026-10-05T03:00:00Z"),
      ttlMinutes: 30,
      group,
      ewallets: config.beam?.ewallets ?? true,
      expectedFeePct: feePctFor(config, group),
      internalNote: "msv1|m=beam-playground|r=MSV-20261005-7F3K|s=abcdefghijklmnopqrstuvwxyz0",
    });
  const plain = getBookingConfig(BEAM_PG);
  for (const m of METHODS) {
    const body = link(plain, m, quoteFor(plain, m));
    assert.equal(body.order.netAmount, quoteFor(plain, m).dueNowSatang, m);
  }
  assert.throws(() => link(plain, "promptpay", quoteFor(plain, "card_ewallet")), RangeError, "the card fee never reaches a PromptPay link");
  assert.throws(() => link(plain, "card_ewallet", quoteFor(plain, "promptpay")), RangeError, "nor a card link the fee-free quote");

  const override = getBookingConfig({ ...BEAM_PG, BEAM_PROMPTPAY_FEE_PCT: "3" });
  const promptpay = link(override, "promptpay", quoteFor(override, "promptpay"));
  assert.deepEqual(promptpay.linkSettings, { qrPromptPay: { isEnabled: true } });
  assert.equal(promptpay.order.netAmount, quoteFor(override, "card_ewallet").dueNowSatang, "3% on both methods");
  assert.throws(() => link(override, "promptpay", quoteFor(plain, "promptpay")), RangeError, "the fee-free quote is refused under the override");
});

/* ----------------------------- the checkout request ----------------------------- */

const BODY = {
  checkIn: "2026-11-10",
  checkOut: "2026-11-13",
  items: [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }],
  expectedTotalSatang: 100_000,
  expectedDueNowSatang: 100_000,
};

test("parseCheckoutRequest in the Beam modes (limits.payMethods): an optional payMethod - kept when it is one of the two, no key at all when absent", () => {
  for (const m of METHODS) {
    const parsed = parseCheckoutRequest({ ...BODY, payMethod: m }, BEAM_LIMITS);
    assert.ok(parsed.ok, m);
    assert.equal(parsed.value.payMethod, m);
  }
  const without = parseCheckoutRequest(BODY, BEAM_LIMITS);
  assert.ok(without.ok);
  assert.equal("payMethod" in without.value, false);
  assert.deepEqual(without.value, { ...BODY, promo: undefined });
  assert.deepEqual(without, parseCheckoutRequest(BODY, LIMITS), "a request without one parses the same in every mode");
  // Not sent, as an empty field is read (null and "" are how a form says "none").
  for (const none of [undefined, null, ""]) assert.deepEqual(parseCheckoutRequest({ ...BODY, payMethod: none }, BEAM_LIMITS), without, String(none));
  // Everything else the request carries is read exactly as before.
  const full = { ...BODY, promo: "direct", theme: "classic", termsVersion: "2026-10-07" };
  const withMethod = parseCheckoutRequest({ ...full, payMethod: "promptpay" }, BEAM_LIMITS);
  const withoutMethod = parseCheckoutRequest(full, BEAM_LIMITS);
  assert.ok(withMethod.ok && withoutMethod.ok);
  const { payMethod, ...rest } = withMethod.value;
  assert.equal(payMethod, "promptpay");
  assert.deepEqual(rest, withoutMethod.value);
});

test("parseCheckoutRequest on Stripe and the demo (no limits.payMethods): payMethod is ignored completely - every value, valid or not, parses exactly as none", () => {
  for (const body of [BODY, { ...BODY, promo: "direct", theme: "classic", termsVersion: "2026-10-07" }, { ...BODY, checkIn: "2026-10-01" }, { ...BODY, items: [] }]) {
    const none = parseCheckoutRequest(body, LIMITS);
    for (const v of ANY_PAY_METHOD) {
      const parsed = parseCheckoutRequest({ ...body, payMethod: v }, LIMITS);
      assert.deepEqual(parsed, none, JSON.stringify(v));
      if (parsed.ok) assert.equal("payMethod" in parsed.value, false, `${JSON.stringify(v)}: no payMethod key`);
      else assert.equal(parsed.issues.includes(PAY_METHOD_UNREADABLE), false, `${JSON.stringify(v)}: no issue`);
    }
  }
  // An explicit false is the same as unset.
  assert.deepEqual(parseCheckoutRequest({ ...BODY, payMethod: "bogus" }, { ...LIMITS, payMethods: false }), parseCheckoutRequest(BODY, LIMITS));
});

/** A Beam-mode checkout's deps: nothing faked but the network, which records every call (none may be made here). */
function beamDeps(config: BookingConfig, calls: string[]) {
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    throw new Error("no network in this test");
  }) as typeof fetch;
  return { config, origin: ORIGIN, nowMs: KIT_NOW, fetchImpl, nonce: () => "nonce", pickRefChar: refCharSequence() };
}

test("a bad payMethod is a validation issue in the Beam modes (nothing is read, held or sent to Beam)", async () => {
  for (const bad of ["bitcoin", "PROMPTPAY", "card", " promptpay", 1, true, 0, false, {}, [], ["promptpay"]]) {
    const parsed = parseCheckoutRequest({ ...BODY, payMethod: bad }, BEAM_LIMITS);
    assert.deepEqual(parsed, { ok: false, issues: [PAY_METHOD_UNREADABLE] }, JSON.stringify(bad));
  }
  // With other problems, each is listed once.
  const many = parseCheckoutRequest({ ...BODY, checkIn: "2026-10-01", payMethod: "x" }, BEAM_LIMITS);
  assert.equal(many.ok, false);
  if (!many.ok) {
    assert.ok(many.issues.includes(PAY_METHOD_UNREADABLE));
    assert.equal(many.issues.filter((i) => i === PAY_METHOD_UNREADABLE).length, 1);
    assert.ok(many.issues.length >= 2);
  }

  // A Beam checkout with one (beam-playground, and beam-live with the code switch overridden): 400 invalid_request
  // before any Cloudbeds read or Beam call.
  for (const config of [getBookingConfig(BEAM_PG), getBookingConfig(BEAM_LIVE, READY)]) {
    const calls: string[] = [];
    const res = await runCheckout(request(HONEYMOON, { payMethod: "bitcoin" as PayMethod, expectedTotalSatang: 1, expectedDueNowSatang: 1 }), beamDeps(config, calls));
    assert.equal(res.status, 400, config.paymentMode);
    assert.deepEqual(res.body, { ok: false, error: "invalid_request", message: "Please check your booking details.", issues: [PAY_METHOD_UNREADABLE] }, config.paymentMode);
    assert.deepEqual(calls, [], config.paymentMode);
  }
});

test("Stripe live, Stripe test and the demo ignore payMethod completely: a bogus or a valid one gives exactly the answer, Cloudbeds calls, Stripe calls and logs of none", async () => {
  const run = async (env: Env, extra: Record<string, unknown>) => {
    const kit = makeKit({ env, pickRefChar: refCharSequence() });
    const stay = kit.config.dataSource === "demo" ? demoStay(kit.config) : null;
    const req = { ...request(stay ? stay.items : HONEYMOON, stay ? { checkIn: stay.checkIn, checkOut: stay.checkOut } : {}), ...extra };
    const first = await runCheckout({ ...req, expectedTotalSatang: 1, expectedDueNowSatang: 1 }, kit.checkoutDeps());
    const quote = first.body.ok ? null : first.body.quote;
    const second = quote ? await runCheckout({ ...req, expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang }, kit.checkoutDeps()) : null;
    const badDates = await runCheckout({ ...req, checkIn: "2020-01-01", checkOut: "2020-01-03" }, kit.checkoutDeps());
    return { status: second?.status, text: normalised(JSON.stringify({ first, second, badDates, cb: kit.fakeCb.calls, stripe: kit.fakeStripe.calls, alerts: kit.alerts, logs: kit.logs })) };
  };
  for (const [name, env] of [["stripe-live", STRIPE_LIVE_ENV], ["stripe-test", STRIPE_TEST_ENV], ["demo", {}]] as const) {
    assert.equal(getBookingConfig(env).beam, null, name);
    const none = await run(env, {});
    assert.equal(none.status, 200, `${name}: the checkout went through`);
    for (const v of ANY_PAY_METHOD) {
      const withValue = await run(env, { payMethod: v });
      assert.equal(withValue.text, none.text, `${name} ${JSON.stringify(v)}`);
    }
  }
});

test("a Stripe checkout carrying a payMethod is unaffected: the same answer, token, Cloudbeds calls and Stripe requests", async () => {
  const run = async (payMethod: PayMethod | undefined) => {
    const kit = makeKit({ pickRefChar: refCharSequence() });
    const req = request(HONEYMOON, payMethod ? { payMethod } : {});
    const quote = await serverQuote(kit, req);
    const res = await runCheckout({ ...req, expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang }, kit.checkoutDeps());
    const record = { res, quote, cb: kit.fakeCb.calls, stripe: kit.fakeStripe.calls, alerts: kit.alerts, logs: kit.logs };
    return { record, text: normalised(JSON.stringify(record)) };
  };
  const plain = await run(undefined);
  assert.equal(plain.record.res.status, 200);
  assert.equal(plain.record.quote.cardFeePct, 5);
  assert.ok(plain.record.cb.some((c) => c.method === "postReservation"), "the hold was written");
  assert.ok(plain.record.stripe.some((c) => c.method === "POST" && c.path === "/v1/checkout/sessions"), "a Checkout Session was created");
  assert.match(plain.text, /TOKEN\{/, "the booking tokens are compared decoded");
  for (const m of METHODS) {
    const withMethod = await run(m);
    assert.equal(withMethod.text, plain.text, m);
    // ("promptpay" itself is in Stripe's own allowed_payment_method_types, as before.)
    assert.doesNotMatch(withMethod.text, /payMethod|card_ewallet/i, `${m}: not in a token, a Stripe request, a Cloudbeds call or a log`);
  }
});

/**
 * A checkout record with what differs between two runs replaced: booking tokens by their decoded payload (signed at the
 * same time, they differ only by the ids inside), and the fakes' random ids (Cloudbeds reservations, Stripe sessions
 * and payment intents in test and live mode, request ids) numbered in the order they first appear.
 */
function normalised(json: string): string {
  const decoded = json.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, (tok) => `TOKEN${Buffer.from(tok.split(".")[0], "base64url").toString("utf8").replace(/"/g, "'")}`);
  const seen = new Map<string, string>();
  const counters = new Map<string, number>();
  return decoded.replace(/\b7\d{12}\b|cs_(?:test|live)_fake_[0-9a-f]+|pi_(?:test|live)_fake_[0-9a-f]+|fake-\d+/g, (id) => {
    const known = seen.get(id);
    if (known) return known;
    const kind = /^7\d{12}$/.test(id) ? "res" : id.startsWith("cs_") ? "cs" : id.startsWith("pi_") ? "pi" : "req";
    const n = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, n);
    seen.set(id, `${kind}_${n}`);
    return `${kind}_${n}`;
  });
}

/* ------------------------------- the booking token ------------------------------- */

const SUMMARY: BookingSummary = {
  ref: "MSV-20261005-7F3K",
  paymentMode: "beam-playground",
  checkIn: "2026-10-28",
  checkOut: "2026-10-31",
  nights: 3,
  items: [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }],
  itemRoomSatang: [1_395_000],
  promoCode: null,
  totalSatang: 1_395_000,
  cardFeeSatang: 0,
  dueNowSatang: 1_395_000,
  createdAt: "2026-10-05T03:00:00.000Z",
  linkExpiresAt: "2026-10-05T03:30:00.000Z",
};
const NOW = Date.parse("2026-10-05T03:00:00Z");

test("isBookingSummary: payMethod is optional and never judged by the token check (mode-blind, as on production main); a token carrying it round-trips", () => {
  assert.equal(isBookingSummary(SUMMARY), true);
  for (const m of METHODS) {
    const booking = { ...SUMMARY, payMethod: m };
    assert.equal(isBookingSummary(booking), true, m);
    const v = verifyBookingToken(createBookingToken(booking, "plink_1", TOKEN_SECRET, 3600, NOW), TOKEN_SECRET, NOW + 1000);
    assert.ok(v.ok, m);
    assert.deepEqual(v.payload.booking, booking);
  }
  // Round 6: a Beam booking's payMethod is judged only where Beam handles it (runStatus and runAbandon, once the Beam
  // deps or the Beam drain are found: beamReturn.test.ts), so the token check answers every deployment as main did.
  for (const bad of [null, "", "bitcoin", "PROMPTPAY", 1, {}, ["promptpay"]]) {
    const booking = { ...SUMMARY, payMethod: bad };
    assert.equal(isBookingSummary(booking), true, JSON.stringify(bad));
    const v = verifyBookingToken(createBookingToken(booking as unknown as BookingSummary, null, TOKEN_SECRET, 3600, NOW), TOKEN_SECRET, NOW + 1000);
    assert.ok(v.ok, JSON.stringify(bad));
    assert.deepEqual(v.payload.booking, booking, JSON.stringify(bad));
  }
});

test("old tokens without payMethod still verify: every booking token the golden Stripe snapshot recorded", () => {
  const golden = JSON.parse(readFileSync(new URL("./__golden__/stripe.json", import.meta.url), "utf8")) as unknown;
  const bookings: Record<string, unknown>[] = [];
  (function walk(node: unknown): void {
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key !== "tokens") walk(value);
      else for (const payload of Object.values(value as Record<string, { kind?: string; booking?: Record<string, unknown> }>)) if (payload.kind === "booking" && payload.booking) bookings.push(payload.booking);
    }
  })(golden);
  assert.ok(bookings.length >= 40, `${bookings.length} golden booking tokens`);
  for (const recorded of bookings) {
    assert.equal("payMethod" in recorded, false);
    // The route scenarios record their random refs normalised (MSV-20261005-ref_1): give those a real one back.
    const booking = { ...recorded, ref: /-ref_\d+$/.test(String(recorded.ref)) ? "MSV-20261005-7F3K" : recorded.ref };
    assert.equal(isBookingSummary(booking), true, String(recorded.ref));
    const v = verifyBookingToken(createBookingToken(booking as unknown as BookingSummary, null, TOKEN_SECRET, 3600, NOW), TOKEN_SECRET, NOW + 1000);
    assert.ok(v.ok, String(recorded.ref));
    assert.equal("payMethod" in v.payload.booking, false);
  }
});

test("a Stripe or demo token carrying any payMethod verifies, and status and abandon answer it exactly like one without (a Beam booking's payMethod is judged only where Beam handles it)", async () => {
  // The shape check: the field is never judged (production main had no such check at all).
  for (const paymentMode of ["stripe-live", "stripe-test", "stripe-mock", "demo"] as const) {
    for (const v of ANY_PAY_METHOD) {
      const booking = { ...SUMMARY, paymentMode, payMethod: v };
      assert.equal(isBookingSummary(booking), true, `${paymentMode} ${JSON.stringify(v)}`);
      assert.ok(verifyBookingToken(createBookingToken(booking as unknown as BookingSummary, null, TOKEN_SECRET, 3600, NOW), TOKEN_SECRET, NOW + 1000).ok, paymentMode);
    }
  }
  // Round 6: mode-blind for Beam tokens too (runStatus and runAbandon judge them once the Beam deps are found).
  for (const paymentMode of ["beam-playground", "beam-live"] as const) {
    assert.equal(isBookingSummary({ ...SUMMARY, paymentMode, payMethod: "bogus" }), true, `${paymentMode}: mode-blind`);
    assert.equal(isBookingSummary({ ...SUMMARY, paymentMode, payMethod: "promptpay" }), true, paymentMode);
  }

  /** The same token with `payMethod` added to its booking (signed as the server signed it). */
  const withPayMethod = (t: string, secret: string, payMethod: unknown): string => {
    const v = verifyBookingToken(t, secret, KIT_NOW);
    assert.ok(v.ok);
    const booking = { ...v.payload.booking, payMethod } as unknown as BookingSummary;
    return createBookingToken(booking, v.payload.paymentLinkId, secret, v.payload.exp - v.payload.iat, v.payload.iat * 1000);
  };
  /** An answer as compared: the status answer echoes the token's booking (as production main does), its payMethod aside. */
  const shown = (answer: unknown) => JSON.stringify(answer, (key, value: unknown) => (key === "payMethod" ? undefined : value));

  // A real Stripe hold (test and live): status, then abandon, each on its own kit with the same refs.
  for (const [name, env] of [["stripe-test", STRIPE_TEST_ENV], ["stripe-live", STRIPE_LIVE_ENV]] as const) {
    const runs: { status: string; abandon: string; cb: string[]; stripe: string[] }[] = [];
    for (const payMethod of [undefined, "bogus", null, 0] as const) {
      const kit = makeKit({ env, pickRefChar: refCharSequence() });
      const res = await checkout(kit);
      assert.equal(res.status, 200, name);
      const sessionId = sessionIdOf(res.body);
      const session = kit.fakeStripe.session(sessionId);
      assert.ok(session);
      const plain = new URL(session.success_url.replace("{CHECKOUT_SESSION_ID}", "x")).searchParams.get("t") ?? "";
      const t = payMethod === undefined ? plain : withPayMethod(plain, kit.config.tokenSecret, payMethod);
      const status = await runStatus({ t, p: null, l: null, s: sessionId }, { config: kit.config, stripe: kit.deps, nowMs: KIT_NOW });
      assert.equal(status.status, 200, `${name} ${String(payMethod)}: ${JSON.stringify(status.body)}`);
      const abandon = await runAbandon({ t }, { config: kit.config, stripe: kit.deps, nowMs: KIT_NOW });
      runs.push({
        status: shown(status),
        abandon: shown(abandon),
        cb: kit.fakeCb.calls.map((c) => c.method),
        stripe: kit.fakeStripe.calls.map((c) => `${c.method} ${c.path}`.replace(/cs_(?:test|live)_fake_[0-9a-f]+/, "{session}")),
      });
    }
    assert.deepEqual(JSON.parse(runs[0].abandon), { status: 200, body: { ok: true, state: "released" } }, name);
    for (const run of runs.slice(1)) assert.deepEqual(run, runs[0], name);
  }

  // The demo: no hold, the status comes from the token alone; abandon does not apply.
  const demo = getBookingConfig({ BOOKING_TOKEN_SECRET: TOKEN_SECRET });
  assert.equal(demo.paymentMode, "demo");
  const demoBooking: BookingSummary = { ...SUMMARY, paymentMode: "demo" };
  const demoRuns: string[] = [];
  for (const payMethod of [undefined, "bogus", ["promptpay"]] as const) {
    const t = createBookingToken((payMethod === undefined ? demoBooking : { ...demoBooking, payMethod }) as unknown as BookingSummary, null, TOKEN_SECRET, 3600, NOW);
    const status = await runStatus({ t, p: null, l: null }, { config: demo, nowMs: NOW + 1000 });
    assert.equal(status.status, 200, String(payMethod));
    const abandon = await runAbandon({ t }, { config: demo, nowMs: NOW + 1000 });
    demoRuns.push(shown({ status, abandon }));
  }
  for (const run of demoRuns.slice(1)) assert.equal(run, demoRuns[0]);
});

test("a Beam token with any payMethod, in a Stripe or demo deployment with no Beam config: status 409 and abandon not_applicable, exactly as production main answers it (round 6)", async () => {
  const deployments: [string, Env][] = [
    ["stripe-live", STRIPE_LIVE_ENV],
    ["stripe-test", STRIPE_TEST_ENV],
    ["stripe-mock", { ...MOCK_ENV, BOOKING_TOKEN_SECRET: TOKEN_SECRET }],
    ["demo", { BOOKING_TOKEN_SECRET: TOKEN_SECRET }],
  ];
  const DIFFERENT_MODE = { status: 409, body: { ok: false, error: "invalid_token", message: "This booking was made in a different payment mode." } };
  const NOT_APPLICABLE = { status: 200, body: { ok: true, state: "not_applicable" } };
  for (const [name, env] of deployments) {
    const config = getFulfilmentConfig(env);
    assert.equal(config.paymentMode, name);
    assert.equal(config.beam, null, `${name}: no Beam config`);
    for (const paymentMode of ["beam-playground", "beam-live"] as const) {
      for (const payMethod of [undefined, "promptpay", "card_ewallet", "bogus", 0, null, "", ["promptpay"], {}]) {
        const booking = (payMethod === undefined ? { ...SUMMARY, paymentMode } : { ...SUMMARY, paymentMode, payMethod }) as unknown as BookingSummary;
        const label = `${name} ${paymentMode} ${JSON.stringify(payMethod)}`;
        const t = createBookingToken(booking, null, TOKEN_SECRET, 3600, NOW);
        const l = createBookingToken(booking, "plink_1", TOKEN_SECRET, 3600, NOW);
        assert.deepEqual(await runStatus({ t, p: null, l }, { config, nowMs: NOW + 1000 }), DIFFERENT_MODE, label);
        assert.deepEqual(await runAbandon({ t, l }, { config, nowMs: NOW + 1000 }), NOT_APPLICABLE, label);
      }
    }
  }
});

// Beam design step S3.1: the Beam modes' hold-first configuration, the Beam settings (config.beam) and the config
// hardening - the mock Cloudbeds writer never on Vercel (money review 10) and no silent demo for
// BOOKING_PAYMENT_PROVIDER=beam where it matters (gap review 8).
//
// Every Stripe output is unchanged: stripeConfig.test.ts and the golden configs (stripeGolden.test.ts) still pass
// as they were, and here the Beam-only fields are checked absent from every Stripe and demo environment.
// isHoldFirstMode is NOT flipped by this step (S4.6): Beam checkout, status and abandon still run the old way.
//
// Step S3.3: Beam money's Cloudbeds payment method (CLOUDBEDS_BEAM_PAYMENT_METHOD, the custom 'Beam(website)' method;
// CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD outside live) - the Stripe matrix of moneyPath.test.ts copied for Beam. The Stripe
// cases there are unchanged.

import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getCartInventory, getInventory, promoAskFor } from "./availability.ts";
import { beamHostedHost } from "./beam.ts";
import { fail } from "./checkoutShared.ts";
import type { StripeCheckoutInput } from "./checkoutShared.ts";
import {
  ATTEMPT_PAYABLE_MARGIN_MINUTES,
  BEAM_DEEP_SCAN_DAYS,
  BEAM_LIVE_BASE,
  BEAM_PLAYGROUND_BASE,
  BEAM_SCAN_LOOKBACK_HOURS,
  BookingConfigError,
  DEFAULT_AUTO_DISCOUNT_PLANS,
  PAYMENT_LINK_TTL_MINUTES,
  getBookingConfig,
  getFulfilmentConfig,
  getInventoryConfig,
  getPublicBookingConfig,
  getStripeDrainConfig,
  resolveCloudbedsPaymentMethod,
  resolvePaymentMode,
  toPublicConfig,
} from "./config.ts";
import type { BeamSettings, Env } from "./config.ts";
import { addDays, todayInBangkok } from "./dates.ts";
import { startHoldFirstCheckout } from "./holdFirstCheckout.ts";
import type { CheckoutAdapter, HoldFirstCheckoutContext } from "./holdFirstCheckout.ts";
import { FAKE_DIRECT_PROMO_CODE, createFakeCloudbeds, fakeLongTermPlan } from "./mock/fakeCloudbeds.ts";
import type { FakeRoomType } from "./mock/fakeCloudbeds.ts";
import { BEAM_CARD_BRANDS, isHoldFirstMode } from "./payments/provider.ts";
import { FAR_CHECKIN, GUEST, HONEYMOON, NOW, ORIGIN, ROOM_TYPES, STRIPE_LIVE_ENV, STRIPE_TEST_ENV, TEST_ACCESS_KEY, TEST_EMAIL, makeKit, request, serverQuote } from "./testkit.ts";
import type { Kit } from "./testkit.ts";
import type { PublicBookingConfig } from "./types.ts";

const SECRET = { BOOKING_TOKEN_SECRET: "test-only-7f3K9qLm2xVw8RtY4pZn6bHc1dJe5gUa" };
const KEYS = { BEAM_MERCHANT_ID: "m", BEAM_API_KEY: "k" };
/** beam-playground with no Cloudbeds variables at all (the local Stage A setup). */
const BEAM_PG: Env = { BOOKING_PAYMENT_PROVIDER: "beam", BEAM_API_BASE: BEAM_PLAYGROUND_BASE, ...KEYS, ...SECRET };
/** Real Cloudbeds writes, as Stage B runs them (the same names and values as STRIPE_TEST_ENV's). */
const WRITES: Env = {
  CLOUDBEDS_API_KEY: "cbat_read_testkit",
  CLOUDBEDS_API_KEY_BOOKING: "cbat_write_testkit",
  CLOUDBEDS_PROPERTY_ID: "235064",
  UPSTASH_REDIS_REST_URL: "https://example-redis.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "token-testkit",
};
const BEAM_PG_WRITES: Env = { ...BEAM_PG, ...WRITES, BOOKING_TEST_GUEST_EMAIL: TEST_EMAIL, BOOKING_TEST_ACCESS_KEY: TEST_ACCESS_KEY };
/** beam-live with every condition today's code checks (the code switch is overridden where it is used). */
const BEAM_LIVE: Env = { ...BEAM_PG, ...WRITES, BEAM_API_BASE: BEAM_LIVE_BASE, BOOKING_ALLOW_LIVE_PAYMENTS: "true", VERCEL_ENV: "production" };
const READY = { liveFulfilmentReady: true };
const MOCK_ENV: Env = { BOOKING_PAYMENT_PROVIDER: "stripe", BOOKING_STRIPE_MOCK: "true" };
const BEAM_SETTING_VARS: Env = {
  BEAM_PROMPTPAY: "off",
  BEAM_PROMPTPAY_FEE_PCT: "4",
  BEAM_EWALLETS: "off",
  BEAM_WECHAT_PAY: "on",
  BEAM_PENDING_GRACE_MINUTES: "45",
  BEAM_LATE_WATCH_DAYS: "10",
};

/** What a call threw: its code and missing names, or null when it returned. */
function thrown(fn: () => unknown): { code: string; missing: string[] } | null {
  try {
    fn();
    return null;
  } catch (e) {
    assert.ok(e instanceof BookingConfigError, String(e));
    return { code: e.code, missing: e.missing };
  }
}

/* --------------------------------- the writer --------------------------------- */

test("beam-playground without a booking key: the mock writer (in memory, locally only) and no test guard", () => {
  const cfg = getBookingConfig(BEAM_PG);
  assert.equal(cfg.paymentMode, "beam-playground");
  assert.deepEqual(cfg.cloudbedsWrite, { mode: "mock" });
  assert.equal(cfg.redis, null, "the mock writer runs without Redis");
  assert.equal(cfg.testGuard, null);
  const pub = toPublicConfig(cfg, BEAM_PG);
  assert.equal(pub.cloudbedsWrites, "mock");
  assert.equal(pub.testGuard, null);
  assert.equal(cfg.stripe, null);
});

test("beam-playground with a booking key: the live writer with Stripe's requirements and errors, and the Stage B test guard", () => {
  const cfg = getBookingConfig(BEAM_PG_WRITES);
  assert.equal(cfg.paymentMode, "beam-playground");
  assert.deepEqual(cfg.cloudbedsWrite, { mode: "live", apiKey: "cbat_write_testkit", propertyId: "235064" });
  assert.deepEqual(cfg.testGuard, { guestEmail: TEST_EMAIL, minArrivalMonths: 12, accessKey: TEST_ACCESS_KEY });
  assert.deepEqual(cfg.testGuard, getBookingConfig(STRIPE_TEST_ENV).testGuard, "the same guard as stripe-test");
  const pub = getPublicBookingConfig(BEAM_PG_WRITES);
  assert.equal(pub.cloudbedsWrites, "live");
  assert.deepEqual(pub.testGuard, { minArrivalMonths: 12 });
  // Unset or unusable guard values: the guard still applies, and refuses every hold (holdFirstCheckout.ts).
  const bare = getBookingConfig({ ...BEAM_PG_WRITES, BOOKING_TEST_GUEST_EMAIL: undefined, BOOKING_TEST_ACCESS_KEY: "short" });
  assert.deepEqual(bare.testGuard, { guestEmail: null, minArrivalMonths: 12, accessKey: null });
  // The Vercel names of the Redis variables work too.
  const kvNames = { ...BEAM_PG_WRITES, UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined, KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_TOKEN: "t" };
  assert.equal(getBookingConfig(kvNames).cloudbedsWrite?.mode, "live");
  // Each requirement fails exactly as Stripe's does (same code, same missing names).
  for (const [label, change] of [
    ["a property id that is not numeric", { CLOUDBEDS_PROPERTY_ID: "abc" }],
    ["no property id", { CLOUDBEDS_PROPERTY_ID: undefined }],
    ["simulated prices", { BOOKING_DATA_SOURCE: "demo" }],
    ["no Redis", { UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined }],
  ] as const) {
    const beam = thrown(() => getBookingConfig({ ...BEAM_PG_WRITES, ...change }));
    assert.equal(beam?.code, "payment_misconfigured", label);
    assert.deepEqual(beam, thrown(() => getBookingConfig({ ...STRIPE_TEST_ENV, ...change })), label);
  }
  // beam-live (the code switch overridden, as tests only may): the live writer, and no test guard (not a test mode).
  const live = getBookingConfig(BEAM_LIVE, READY);
  assert.equal(live.paymentMode, "beam-live");
  assert.equal(live.cloudbedsWrite?.mode, "live");
  assert.equal(live.testGuard, null);
});

test("the mock writer is refused wherever VERCEL_ENV is set, so a Vercel deployment never writes fake holds into the shared Redis", () => {
  for (const VERCEL_ENV of ["preview", "development", "production"]) {
    const env = { ...BEAM_PG, VERCEL_ENV };
    assert.equal(resolvePaymentMode(env), "beam-playground", VERCEL_ENV);
    assert.deepEqual(thrown(() => getBookingConfig(env)), { code: "payment_misconfigured", missing: ["CLOUDBEDS_API_KEY_BOOKING"] }, VERCEL_ENV);
    assert.equal(thrown(() => getFulfilmentConfig(env))?.code, "payment_misconfigured", `${VERCEL_ENV}: fulfilment neither`);
    // ...even with Redis configured (the mock writer would use it).
    assert.equal(thrown(() => getBookingConfig({ ...env, UPSTASH_REDIS_REST_URL: WRITES.UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN: "t" }))?.code, "payment_misconfigured");
    const pub = getPublicBookingConfig(env);
    assert.equal(pub.paymentStatus, "locked", VERCEL_ENV);
    assert.equal(pub.cloudbedsWrites, "none");
    // With real writes the same deployment runs.
    assert.equal(getBookingConfig({ ...BEAM_PG_WRITES, VERCEL_ENV }).cloudbedsWrite?.mode, "live", VERCEL_ENV);
  }
  // A missing token secret is still reported first (config.test.ts: the demo secret is never accepted for Beam).
  assert.equal(thrown(() => getBookingConfig({ ...BEAM_PG, BOOKING_TOKEN_SECRET: undefined, VERCEL_ENV: "preview" }))?.code, "token_secret_missing");
  // Stripe's mock writer is unchanged: allowed on a preview (stripe-mock), as before.
  assert.deepEqual(getBookingConfig({ ...MOCK_ENV, VERCEL_ENV: "preview" }).cloudbedsWrite, { mode: "mock" });
});

/* ------------------------------ the hold-first shape ------------------------------ */

test("Beam is hold-first like Stripe: Standard only, 100% up front, no add-ons, the guest's details and the confirmation-email flag", () => {
  for (const extra of [{}, { CLOUDBEDS_SEND_STATUS_EMAIL: "true" }, { BOOKING_DEPOSIT_PCT: "30" }] as Env[]) {
    const beam = getBookingConfig({ ...BEAM_PG_WRITES, ...extra });
    const stripe = getBookingConfig({ ...STRIPE_TEST_ENV, ...extra });
    assert.deepEqual(beam.ratePlans, ["standard"]);
    assert.equal(beam.depositPct, 100, "BOOKING_DEPOSIT_PCT is not read for Beam");
    assert.equal(beam.addonsEnabled, false);
    for (const key of ["ratePlans", "depositPct", "addonsEnabled", "sendCloudbedsStatusEmail"] as const) {
      assert.deepEqual(beam[key], stripe[key], `${key} ${JSON.stringify(extra)}`);
    }
    const bp = toPublicConfig(beam, { ...BEAM_PG_WRITES, ...extra });
    const sp = toPublicConfig(stripe, { ...STRIPE_TEST_ENV, ...extra });
    for (const key of ["requiresGuestDetails", "collectPostcode", "ratePlans", "addonsEnabled", "holdMinutes", "sendsBookingConfirmationEmail", "depositPct"] as const) {
      assert.deepEqual(bp[key], sp[key], `${key} ${JSON.stringify(extra)}`);
    }
    assert.equal(bp.requiresGuestDetails, true);
    assert.equal(bp.sendsBookingConfirmationEmail, extra.CLOUDBEDS_SEND_STATUS_EMAIL === "true", "the Cloudbeds email is the guest's written confirmation (owner decision 6)");
  }
  // Without any Cloudbeds variable too (Stage A): the shape follows the mode, not the data.
  const local = getPublicBookingConfig(BEAM_PG);
  assert.equal(local.requiresGuestDetails, true);
  assert.deepEqual(local.ratePlans, ["standard"]);
  // A locked Beam config keeps the Beam shape (and the availability API the Beam rules).
  const locked = getPublicBookingConfig({ ...BEAM_LIVE, CLOUDBEDS_API_KEY_BOOKING: undefined });
  assert.equal(locked.paymentStatus, "locked");
  assert.equal(locked.provider, "beam");
  assert.equal(locked.requiresGuestDetails, true);
  assert.equal(locked.depositPct, 100);
  // Not flipped in this step: checkout, status and abandon still treat Beam the old way until S4.6.
  assert.equal(isHoldFirstMode("beam-playground"), false);
  assert.equal(isHoldFirstMode("beam-live"), false);
});

test("Beam with live Cloudbeds rates: the direct-rate promo, the automatic discount plans and baseRateOnly, in getBookingConfig and getInventoryConfig alike", () => {
  const env = { ...BEAM_PG, CLOUDBEDS_API_KEY: "cbat_read_testkit" };
  const cfg = getBookingConfig(env);
  const inv = getInventoryConfig(env);
  assert.deepEqual(cfg.promo, { mode: "direct-rate", code: "DIRECT", pct: 0, cloudbedsCode: "Direct" });
  assert.deepEqual(cfg.promo, getBookingConfig(STRIPE_TEST_ENV).promo, "the same promo settings as Stripe");
  assert.equal(cfg.promoPct, 0);
  assert.equal(cfg.cloudbeds?.baseRateOnly, true);
  assert.deepEqual(cfg.cloudbeds?.autoDiscountPlans, DEFAULT_AUTO_DISCOUNT_PLANS);
  // The availability API's config agrees with the checkout's.
  assert.deepEqual(inv.promo, cfg.promo);
  assert.deepEqual(inv.cloudbeds, cfg.cloudbeds);
  assert.deepEqual(inv.ratePlans, cfg.ratePlans);
  assert.equal(inv.provider, "beam");
  const pub = getPublicBookingConfig(env);
  assert.equal(pub.promoEnabled, true);
  assert.equal(pub.promoMode, "direct-rate");
  // The switches work as on Stripe.
  assert.equal(getBookingConfig({ ...env, BOOKING_DIRECT_PROMO: "off" }).promo.mode, "classic-only");
  assert.deepEqual(getBookingConfig({ ...env, BOOKING_AUTO_DISCOUNTS: "off" }).cloudbeds?.autoDiscountPlans, []);
  assert.deepEqual(getInventoryConfig({ ...env, BOOKING_AUTO_DISCOUNT_PLANS: "Long term" }).cloudbeds?.autoDiscountPlans, ["Long term"]);
  // No Cloudbeds rates: every code points to the classic booking page.
  assert.equal(getBookingConfig(BEAM_PG).promo.mode, "classic-only");
  // Locked (beam-live is switched off in code): availability still uses the Beam rules.
  const lockedEnv = { ...BEAM_LIVE };
  assert.throws(() => getBookingConfig(lockedEnv), BookingConfigError);
  assert.deepEqual(getInventoryConfig(lockedEnv).cloudbeds?.baseRateOnly, true);
  assert.deepEqual(getInventoryConfig(lockedEnv).promo.mode, "direct-rate");
});

test("availability: a Beam search sells exactly what a Stripe search sells (the base rate, the Long term plan, the Direct rate for DIRECT)", async () => {
  const roomTypes: Record<string, FakeRoomType> = {
    ...ROOM_TYPES,
    "462958": { ...ROOM_TYPES["462958"], directRateId: "rate-hm-direct", plans: [fakeLongTermPlan("rate-hm-lt")] },
  };
  const beamEnv = { ...BEAM_PG, CLOUDBEDS_API_KEY: "cbat_read_testkit", CLOUDBEDS_PROPERTY_ID: "235064" };
  const week = { checkIn: FAR_CHECKIN, checkOut: addDays(FAR_CHECKIN, 7) };
  const searchWith = async (env: Env, code: string | null) => {
    const config = getInventoryConfig(env);
    const fake = createFakeCloudbeds({ roomTypes, now: () => NOW });
    const ask = promoAskFor(code, config.promo);
    const result = await getInventory(week.checkIn, week.checkOut, config, {
      fetchImpl: fake.fetch,
      allowDemoFallback: false,
      cacheTtlMs: 0,
      ...(ask ? { promo: ask } : {}),
    });
    return { result, fake };
  };
  const stripe = await searchWith(STRIPE_TEST_ENV, null);
  const beam = await searchWith(beamEnv, null);
  assert.equal(beam.result.dataSource, "cloudbeds");
  assert.deepEqual(beam.result.inventory, stripe.result.inventory);
  assert.equal(beam.result.inventory.find((i) => i.slug === "honeymoon-suite")?.rateId, "rate-hm-lt", "7 nights: the Long term plan, as on Stripe");
  assert.equal(beam.fake.count("getRatePlans"), 1, "one rate-plan index read, as on Stripe");
  const stripeDirect = await searchWith(STRIPE_TEST_ENV, "DIRECT");
  const beamDirect = await searchWith(beamEnv, "direct");
  assert.deepEqual(beamDirect.result.inventory, stripeDirect.result.inventory);
  assert.ok(beamDirect.fake.calls.some((c) => c.method === "getAvailableRoomTypes" && c.params.promoCode === FAKE_DIRECT_PROMO_CODE), "Cloudbeds is asked with its Direct code");
});

/* ---------------------------------- the settings --------------------------------- */

test("fees per method: card/e-wallet = BOOKING_CARD_FEE_PCT (3 when unset), PromptPay = BEAM_PROMPTPAY_FEE_PCT (0 when unset), both clamped to 0-10", (t: TestContext) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => void warnings.push(args.map(String).join(" ")));
  // A Stripe deployment with the card fee set says nothing (and its fee is unchanged).
  assert.equal(getBookingConfig({ ...STRIPE_TEST_ENV, BOOKING_CARD_FEE_PCT: "7" }).cardFeePct, 7);
  assert.equal(getBookingConfig(STRIPE_TEST_ENV).cardFeePct, 5);
  assert.deepEqual(warnings, []);

  const fees = (env: Env) => getPublicBookingConfig(env).feeByMethod;
  assert.deepEqual(fees(BEAM_PG), { card_ewallet: 3, promptpay: 0 }, "owner decisions 1 and 2");
  assert.equal(getBookingConfig(BEAM_PG).cardFeePct, 3);
  assert.equal(getBookingConfig(BEAM_PG).beam?.promptPayFeePct, 0);
  assert.deepEqual(fees({ ...BEAM_PG, BEAM_PROMPTPAY_FEE_PCT: "3" }), { card_ewallet: 3, promptpay: 3 });
  assert.deepEqual(fees({ ...BEAM_PG, BEAM_PROMPTPAY_FEE_PCT: "1.256" }), { card_ewallet: 3, promptpay: 1.26 }, "two decimals at most");
  for (const [raw, pct] of [["50", 10], ["-2", 0], ["abc", 0], ["", 0], [" 2 ", 2]] as const) {
    assert.equal(fees({ ...BEAM_PG, BEAM_PROMPTPAY_FEE_PCT: raw })?.promptpay, pct, raw);
  }
  // BOOKING_CARD_FEE_PCT moves the card/e-wallet fee only (never PromptPay's), with a config_warning naming the variable.
  assert.deepEqual(fees({ ...BEAM_PG, BOOKING_CARD_FEE_PCT: "7" }), { card_ewallet: 7, promptpay: 0 });
  assert.equal(getBookingConfig({ ...BEAM_PG, BOOKING_CARD_FEE_PCT: "70" }).cardFeePct, 10);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /config_warning/);
  assert.match(warnings[0], /"name":"BOOKING_CARD_FEE_PCT"/);
  assert.doesNotMatch(warnings[0], /"7"|:7\b/, "the value is never logged");
  // The fee itself still follows the provider when unset: 5 on Stripe, 3 on Beam.
  assert.equal(getBookingConfig({ ...STRIPE_LIVE_ENV, ...BEAM_PG, ...WRITES }).cardFeePct, 3);
});

test("Beam settings: the defaults, the grace and late-watch clamps, the scan windows, and the hosted host of each base", () => {
  const cfg = getBookingConfig(BEAM_PG);
  const expected: BeamSettings = {
    apiBase: BEAM_PLAYGROUND_BASE,
    merchantId: "m",
    apiKey: "k",
    hostedHost: "playground-pay.beamcheckout.com",
    promptPay: true,
    promptPayFeePct: 0,
    ewallets: true,
    wechatPay: false,
    pendingGraceMinutes: 20,
    lateWatchDays: 7,
    scanLookbackHours: 72,
    deepScanDays: 7,
  };
  assert.deepEqual(cfg.beam, expected);
  assert.equal(BEAM_SCAN_LOOKBACK_HOURS, 72);
  assert.equal(BEAM_DEEP_SCAN_DAYS, 7);
  assert.equal(cfg.beam?.hostedHost, beamHostedHost(cfg.beam!.apiBase), "the same host beam.ts accepts for the base");
  const live = getBookingConfig(BEAM_LIVE, READY).beam!;
  assert.equal(live.apiBase, BEAM_LIVE_BASE);
  assert.equal(live.hostedHost, "pay.beamcheckout.com");
  assert.equal(live.hostedHost, beamHostedHost(live.apiBase));
  const grace = (raw: string | undefined) => getBookingConfig({ ...BEAM_PG, BEAM_PENDING_GRACE_MINUTES: raw }).beam?.pendingGraceMinutes;
  for (const [raw, minutes] of [[undefined, 20], ["", 20], ["45", 45], ["1", 5], ["90", 60], ["12.6", 13], ["soon", 20]] as const) {
    assert.equal(grace(raw), minutes, String(raw));
  }
  const watch = (raw: string | undefined) => getBookingConfig({ ...BEAM_PG, BEAM_LATE_WATCH_DAYS: raw }).beam?.lateWatchDays;
  for (const [raw, days] of [[undefined, 7], ["10", 10], ["1", 3], ["40", 30], ["x", 7]] as const) {
    assert.equal(watch(raw), days, String(raw));
  }
  // The client's payable window: the link's 30 minutes + the grace + 3 (53 by default; Stripe's client uses 33).
  assert.equal(getPublicBookingConfig(BEAM_PG).attemptPayableMinutes, 53);
  assert.equal(getPublicBookingConfig({ ...BEAM_PG, BEAM_PENDING_GRACE_MINUTES: "45" }).attemptPayableMinutes, PAYMENT_LINK_TTL_MINUTES + 45 + ATTEMPT_PAYABLE_MARGIN_MINUTES);
  // Every switch at once.
  const all = getBookingConfig({ ...BEAM_PG, ...BEAM_SETTING_VARS }).beam!;
  assert.deepEqual(
    { promptPay: all.promptPay, promptPayFeePct: all.promptPayFeePct, ewallets: all.ewallets, wechatPay: all.wechatPay, pendingGraceMinutes: all.pendingGraceMinutes, lateWatchDays: all.lateWatchDays },
    { promptPay: false, promptPayFeePct: 4, ewallets: false, wechatPay: true, pendingGraceMinutes: 45, lateWatchDays: 10 },
  );
});

test("payment methods: card, PromptPay and the e-wallets by default; BEAM_EWALLETS=off is cards only; BEAM_PROMPTPAY=off hides PromptPay; WeChat Pay only with BEAM_WECHAT_PAY=on", () => {
  const methods = (extra: Env) => getPublicBookingConfig({ ...BEAM_PG, ...extra }).paymentMethods;
  assert.deepEqual(methods({}), ["card", "promptpay", "alipay", "line_pay", "truemoney", "shopeepay"]);
  for (const off of ["off", "OFF", "false", "0", "no"]) {
    assert.deepEqual(methods({ BEAM_EWALLETS: off }), ["card", "promptpay"], off);
    assert.deepEqual(methods({ BEAM_PROMPTPAY: off }), ["card", "alipay", "line_pay", "truemoney", "shopeepay"], off);
  }
  assert.deepEqual(methods({ BEAM_PROMPTPAY: "off", BEAM_EWALLETS: "off" }), ["card"]);
  assert.deepEqual(methods({ BEAM_WECHAT_PAY: "on" }), ["card", "promptpay", "alipay", "line_pay", "truemoney", "shopeepay", "wechat_pay"]);
  assert.deepEqual(methods({ BEAM_WECHAT_PAY: "on", BEAM_EWALLETS: "off" }), ["card", "promptpay"], "WeChat Pay is one of the e-wallets");
  // An unreadable switch keeps its default (on for PromptPay and the wallets, off for WeChat Pay).
  assert.deepEqual(methods({ BEAM_PROMPTPAY: "maybe", BEAM_EWALLETS: "?", BEAM_WECHAT_PAY: "soon" }), methods({}));
  assert.equal(getBookingConfig({ ...BEAM_PG, BEAM_EWALLETS: "off" }).beam?.ewallets, false);
  // The card brands Beam pages name: Visa, Mastercard, JCB, Amex (no UnionPay).
  assert.deepEqual(getPublicBookingConfig(BEAM_PG).acceptedCardBrands, ["visa", "mastercard", "jcb", "amex"]);
  assert.deepEqual([...BEAM_CARD_BRANDS], ["visa", "mastercard", "jcb", "amex"]);
  // A locked Beam page shows the same.
  const locked = getPublicBookingConfig({ ...BEAM_LIVE, BEAM_EWALLETS: "off" });
  assert.equal(locked.paymentStatus, "locked");
  assert.deepEqual(locked.paymentMethods, ["card", "promptpay"]);
  assert.deepEqual(locked.acceptedCardBrands, ["visa", "mastercard", "jcb", "amex"]);
});

/* ------------------------------- Beam only ------------------------------- */

test("the Beam-only fields: present for Beam (ok and locked), absent in every Stripe and demo environment; config.beam is null outside the Beam modes", () => {
  const hasBeamFields = (pub: PublicBookingConfig) => "feeByMethod" in pub || "attemptPayableMinutes" in pub;
  assert.equal(hasBeamFields(getPublicBookingConfig(BEAM_PG)), true);
  assert.equal(hasBeamFields(getPublicBookingConfig(BEAM_PG_WRITES)), true);
  assert.equal(hasBeamFields(getPublicBookingConfig(BEAM_LIVE)), true, "locked");
  assert.equal(hasBeamFields(toPublicConfig(getBookingConfig(BEAM_LIVE, READY), BEAM_LIVE)), true);

  const stripeEnvs: [string, Env][] = [
    ["stripe-test", STRIPE_TEST_ENV],
    ["stripe-live", STRIPE_LIVE_ENV],
    ["stripe-mock", MOCK_ENV],
    ["stripe-live, emergency stop (locked)", { ...STRIPE_LIVE_ENV, BOOKING_ALLOW_LIVE_PAYMENTS: "false" }],
    ["stripe without a key (locked)", { BOOKING_PAYMENT_PROVIDER: "stripe" }],
    ["stripe-live with the Beam variables", { ...STRIPE_LIVE_ENV, BEAM_API_BASE: BEAM_LIVE_BASE, ...KEYS, BEAM_WEBHOOK_HMAC_KEY: "a2V5LWtleS1rZXkta2V5LWtleQ==", ...BEAM_SETTING_VARS }],
    ["stripe-test with the Beam settings", { ...STRIPE_TEST_ENV, ...BEAM_SETTING_VARS }],
  ];
  for (const [label, env] of stripeEnvs) {
    const pub = getPublicBookingConfig(env);
    assert.equal(hasBeamFields(pub), false, label);
    assert.deepEqual(pub.acceptedCardBrands, ["visa", "mastercard"], label);
    assert.deepEqual(pub.paymentMethods, ["card", "apple_pay", "google_pay", "promptpay"], label);
    // The full config where it resolves; the emergency stop's through the fulfilment config; a config without a key has none.
    for (const build of [getBookingConfig, getFulfilmentConfig]) {
      if (thrown(() => build(env)) === null) assert.equal(build(env).beam, null, label);
    }
  }
  assert.equal(getFulfilmentConfig({ ...STRIPE_LIVE_ENV, BOOKING_ALLOW_LIVE_PAYMENTS: "false" }).beam, null);
  const demoEnvs: [string, Env][] = [
    ["demo", {}],
    ["demo with Cloudbeds rates", { CLOUDBEDS_API_KEY: "k" }],
    ["demo with the Beam settings", { ...BEAM_SETTING_VARS }],
    ["BOOKING_PAYMENT_PROVIDER=beam without keys, locally", { BOOKING_PAYMENT_PROVIDER: "beam" }],
    ["the legacy BEAM_API_BASE rule without keys", { BEAM_API_BASE: BEAM_PLAYGROUND_BASE }],
  ];
  for (const [label, env] of demoEnvs) {
    const pub = getPublicBookingConfig(env);
    assert.equal(pub.paymentMode, "demo", label);
    assert.equal(hasBeamFields(pub), false, label);
    assert.deepEqual(pub.acceptedCardBrands, ["visa", "mastercard", "amex", "jcb", "unionpay"], label);
    assert.deepEqual(pub.paymentMethods, ["card", "promptpay"], label);
    assert.equal(getBookingConfig(env).beam, null, label);
  }
});

test("BOOKING_PAYMENT_PROVIDER=beam without a usable Beam config (gap review 8): payment_misconfigured on production or next to a booking key; elsewhere exactly the demo, as before", () => {
  const ALL_MISSING = ["BEAM_API_BASE (the Beam playground or live API base)", "BEAM_MERCHANT_ID", "BEAM_API_KEY"];
  const cases: [string, Env, string[]][] = [
    ["production, nothing set", { BOOKING_PAYMENT_PROVIDER: "beam", VERCEL_ENV: "production", ...SECRET }, ALL_MISSING],
    ["a booking key, nothing set", { BOOKING_PAYMENT_PROVIDER: "beam", ...WRITES }, ALL_MISSING],
    ["production, the playground base without keys", { BOOKING_PAYMENT_PROVIDER: "beam", BEAM_API_BASE: BEAM_PLAYGROUND_BASE, VERCEL_ENV: "production", ...SECRET }, ["BEAM_MERCHANT_ID", "BEAM_API_KEY"]],
    ["a booking key, one key missing", { BOOKING_PAYMENT_PROVIDER: " Beam ", BEAM_API_BASE: BEAM_PLAYGROUND_BASE, BEAM_MERCHANT_ID: "m", ...WRITES }, ["BEAM_API_KEY"]],
    ["production, an unknown base", { BOOKING_PAYMENT_PROVIDER: "beam", BEAM_API_BASE: "https://api.beamcheckout.com.evil.io", ...KEYS, VERCEL_ENV: "production", ...SECRET }, ["BEAM_API_BASE (the Beam playground or live API base)"]],
    ["the Stripe live deployment switched to beam with no Beam variables", { ...STRIPE_LIVE_ENV, BOOKING_PAYMENT_PROVIDER: "beam" }, ALL_MISSING],
  ];
  for (const [label, env, missing] of cases) {
    assert.deepEqual(thrown(() => resolvePaymentMode(env)), { code: "payment_misconfigured", missing }, label);
    assert.equal(thrown(() => getBookingConfig(env))?.code, "payment_misconfigured", label);
    const pub = getPublicBookingConfig(env);
    assert.equal(pub.paymentStatus, "locked", label);
    assert.equal(pub.live, false, label);
  }
  // The Stripe drain still finishes the Stripe bookings already started there.
  assert.equal(getStripeDrainConfig({ ...STRIPE_LIVE_ENV, BOOKING_PAYMENT_PROVIDER: "beam" })?.paymentMode, "stripe-live");
  // Unchanged: the live base keeps its own lock, an unknown base elsewhere is still invalid_beam_base, and the legacy
  // rule (no provider variable) is never refused this way.
  assert.equal(thrown(() => resolvePaymentMode({ BOOKING_PAYMENT_PROVIDER: "beam", BEAM_API_BASE: BEAM_LIVE_BASE, VERCEL_ENV: "production" }))?.code, "live_payments_locked");
  assert.equal(thrown(() => resolvePaymentMode({ BOOKING_PAYMENT_PROVIDER: "beam", BEAM_API_BASE: "https://beam.invalid" }))?.code, "invalid_beam_base");
  assert.equal(resolvePaymentMode({ BEAM_API_BASE: BEAM_PLAYGROUND_BASE, VERCEL_ENV: "production", ...WRITES }), "demo");
  // Locally without a booking key: the demo, exactly as before (only the provider says beam).
  for (const [env, demo] of [
    [{ BOOKING_PAYMENT_PROVIDER: "beam" }, {}],
    [{ BOOKING_PAYMENT_PROVIDER: "beam", ...KEYS }, {}],
    [{ BOOKING_PAYMENT_PROVIDER: "beam", BEAM_API_BASE: BEAM_PLAYGROUND_BASE }, {}],
    [{ BOOKING_PAYMENT_PROVIDER: "beam", CLOUDBEDS_API_KEY: "k" }, { CLOUDBEDS_API_KEY: "k" }],
    [{ BOOKING_PAYMENT_PROVIDER: "beam", VERCEL_ENV: "preview" }, { VERCEL_ENV: "preview" }],
  ] as [Env, Env][]) {
    const label = JSON.stringify(env);
    assert.deepEqual(getBookingConfig(env), { ...getBookingConfig(demo), provider: "beam" }, label);
    assert.deepEqual(getPublicBookingConfig(env), { ...getPublicBookingConfig(demo), provider: "beam" }, label);
    assert.deepEqual(getInventoryConfig(env), { ...getInventoryConfig(demo), provider: "beam" }, label);
  }
});

test("availability route: the no-base-rate alert for every hold-first provider, Stripe's alerter exactly as before", () => {
  const route = readFileSync(new URL("../../app/api/booking/availability/route.ts", import.meta.url), "utf8");
  assert.ok(route.includes('inventoryConfig.provider === "stripe" || inventoryConfig.provider === "beam"'));
  assert.ok(route.includes('inventoryConfig.provider === "stripe" ? getStripeDeps(bookingConfig) : getProviderDeps(bookingConfig)?.deps'));
});

/* ------------------------ the Cloudbeds payment method (S3.3) ------------------------ */

const BEAM_METHOD: Env = { CLOUDBEDS_BEAM_PAYMENT_METHOD: "Beam(website)" };
const BEAM_MODES = ["beam-playground", "beam-live"] as const;
const METHOD_ALERT = "Online bookings stopped: the Cloudbeds payment method is not set up";

test("Beam payment method: CLOUDBEDS_BEAM_PAYMENT_METHOD's exact custom value is kept (punctuation, case); whitespace, control characters, built-ins and unset are problems naming 'Beam(website)' and the WI-0 script - no default", () => {
  for (const mode of BEAM_MODES) {
    const resolve = (env: Env) => resolveCloudbedsPaymentMethod(env, mode);
    assert.deepEqual(resolve(BEAM_METHOD), { method: "Beam(website)", problem: null }, mode);
    assert.deepEqual(resolve({ CLOUDBEDS_BEAM_PAYMENT_METHOD: " Beam(website)\n" }), { method: "Beam(website)", problem: null }, `${mode}: trimmed`);
    assert.equal(resolve({ CLOUDBEDS_BEAM_PAYMENT_METHOD: "beam(Website)" }).method, "beam(Website)", `${mode}: case kept exactly`);
    assert.equal(resolve({ CLOUDBEDS_BEAM_PAYMENT_METHOD: "7" }).method, "7", `${mode}: a number Cloudbeds assigned`);
    assert.equal(resolve({ CLOUDBEDS_BEAM_PAYMENT_METHOD: "x".repeat(64) }).method, "x".repeat(64), mode);

    for (const bad of ["Beam website", "Beam\tTEST", "Beam\u0007", "Beam​", "x".repeat(65)]) {
      const r = resolve({ CLOUDBEDS_BEAM_PAYMENT_METHOD: bad });
      const label = `${mode} ${JSON.stringify(bad)}`;
      assert.equal(r.method, null, label);
      assert.match(r.problem ?? "", /^CLOUDBEDS_BEAM_PAYMENT_METHOD ".*" is not a Cloudbeds payment method value \(1-64 characters, no spaces\)\. /, label);
      assert.match(r.problem ?? "", /scripts\/cloudbeds-wi0-check\.mjs/, label);
      assert.match(r.problem ?? "", /the custom 'Beam\(website\)' payment method/, label);
    }
    // Built-ins would file Beam money as cash, a card, PayPal, a transfer... ("credit" also needs a cardType).
    for (const builtIn of ["credit", "cards", "Cash", "bank_transfer", "EBANKING", "pay_pal", "debit", "check", "check_true", "bill"]) {
      const r = resolve({ CLOUDBEDS_BEAM_PAYMENT_METHOD: builtIn });
      assert.equal(r.method, null, `${mode} ${builtIn}`);
      assert.ok(
        r.problem?.startsWith(
          `CLOUDBEDS_BEAM_PAYMENT_METHOD ${JSON.stringify(builtIn)} is a Cloudbeds built-in method: Beam money must be recorded under the property's own custom 'Beam(website)' method. `,
        ),
        r.problem ?? "",
      );
    }
    // Unset: a problem, no default. One method takes card, e-wallet and PromptPay money alike.
    const unset = resolve({});
    assert.equal(unset.method, null, mode);
    assert.equal(
      unset.problem,
      "CLOUDBEDS_BEAM_PAYMENT_METHOD is not set, so Beam payments can't be recorded in Cloudbeds. Copy the exact 'method' value that " +
        "scripts/cloudbeds-wi0-check.mjs prints for the custom 'Beam(website)' payment method (case included; the one method for card, " +
        "e-wallet and PromptPay money) and redeploy.",
      mode,
    );
    // Stripe's variables are never read for Beam money.
    const stripeVars = resolve({ CLOUDBEDS_STRIPE_PAYMENT_METHOD: "Stripe(website)", CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD: "Stripe_TEST" });
    assert.deepEqual(stripeVars, unset, `${mode}: the Stripe method is not Beam's`);
  }

  // The same validation as Stripe's: every value is accepted or refused alike (moneyPath.test.ts has Stripe's cases).
  for (const raw of ["Beam(website)", "beam(Website)", " x ", "1", "a b", "credit", "CASH", "Beam​", "", "x".repeat(64), "x".repeat(65)]) {
    const beam = resolveCloudbedsPaymentMethod({ CLOUDBEDS_BEAM_PAYMENT_METHOD: raw }, "beam-playground");
    const stripe = resolveCloudbedsPaymentMethod({ CLOUDBEDS_STRIPE_PAYMENT_METHOD: raw }, "stripe-test");
    assert.equal(beam.method, stripe.method, JSON.stringify(raw));
    assert.equal(beam.problem === null, stripe.problem === null, JSON.stringify(raw));
  }
  // Stripe and the demo never read Beam's variables: their answers are what they were.
  for (const mode of ["demo", "stripe-mock", "stripe-test", "stripe-live"] as const) {
    const r = resolveCloudbedsPaymentMethod({ ...BEAM_METHOD, CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD: "Beam_TEST" }, mode);
    assert.equal(r.method, null, mode);
    assert.match(r.problem ?? "", /^CLOUDBEDS_STRIPE_PAYMENT_METHOD is not set, so Stripe payments can't be recorded in Cloudbeds\. /, mode);
  }
  // Stripe's three problem texts, word for word as before (Beam's share their code).
  const stripeHint = "Copy the exact 'method' value that scripts/cloudbeds-wi0-check.mjs prints for the custom Stripe payment method (case included) and redeploy.";
  assert.deepEqual(resolveCloudbedsPaymentMethod({}, "stripe-live"), {
    method: null,
    problem: `CLOUDBEDS_STRIPE_PAYMENT_METHOD is not set, so Stripe payments can't be recorded in Cloudbeds. ${stripeHint}`,
  });
  assert.deepEqual(resolveCloudbedsPaymentMethod({ CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD: "a b" }, "stripe-test"), {
    method: null,
    problem: `CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD "a b" is not a Cloudbeds payment method value (1-64 characters, no spaces). ${stripeHint}`,
  });
  assert.deepEqual(resolveCloudbedsPaymentMethod({ CLOUDBEDS_STRIPE_PAYMENT_METHOD: "Credit" }, "stripe-live"), {
    method: null,
    problem: `CLOUDBEDS_STRIPE_PAYMENT_METHOD "Credit" is a Cloudbeds built-in method: Stripe money must be recorded under the property's own custom Stripe method. ${stripeHint}`,
  });
  assert.deepEqual(getBookingConfig({ ...STRIPE_TEST_ENV, ...BEAM_METHOD, CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD: "Beam_TEST" }), getBookingConfig(STRIPE_TEST_ENV));
  assert.equal(getBookingConfig({ ...STRIPE_LIVE_ENV, ...BEAM_METHOD }).cloudbedsPaymentMethod, "Stripe(website)");

  // Through the configs: Beam's own method, never the Stripe one a deployment also carries.
  const both = { ...BEAM_PG_WRITES, CLOUDBEDS_STRIPE_PAYMENT_METHOD: "Stripe(website)" };
  assert.equal(getBookingConfig(both).cloudbedsPaymentMethod, null);
  assert.match(getBookingConfig(both).cloudbedsPaymentMethodProblem ?? "", /^CLOUDBEDS_BEAM_PAYMENT_METHOD is not set/);
  assert.equal(getBookingConfig({ ...both, ...BEAM_METHOD }).cloudbedsPaymentMethod, "Beam(website)");
  assert.equal(getBookingConfig({ ...BEAM_LIVE, ...BEAM_METHOD }, READY).cloudbedsPaymentMethod, "Beam(website)");
  // A Stripe drain next to the Beam playground keeps Stripe's method for the Stripe money it finishes.
  const drainEnv = { ...STRIPE_LIVE_ENV, ...BEAM_PG, ...WRITES, ...BEAM_METHOD };
  assert.equal(getBookingConfig(drainEnv).cloudbedsPaymentMethod, "Beam(website)");
  assert.equal(getStripeDrainConfig(drainEnv)?.cloudbedsPaymentMethod, "Stripe(website)");
});

test("Beam payment method: beam-playground reads CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD first when set - an invalid one is a problem, never a fall-through to the live method; beam-live ignores it", () => {
  const playground = (extra: Env) => resolveCloudbedsPaymentMethod({ ...BEAM_METHOD, ...extra }, "beam-playground");
  assert.deepEqual(playground({ CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD: "Beam_TEST" }), { method: "Beam_TEST", problem: null });
  assert.equal(playground({ CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD: "" }).method, "Beam(website)");
  assert.equal(playground({ CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD: "  " }).method, "Beam(website)", "blank = unset");
  assert.equal(playground({ CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD: "beam_Test" }).method, "beam_Test", "case kept exactly");
  for (const bad of ["Beam TEST", "credit"]) {
    const invalid = playground({ CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD: bad });
    assert.equal(invalid.method, null, `${bad}: test money never falls through to the real method`);
    assert.ok(invalid.problem?.startsWith(`CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD ${JSON.stringify(bad)} `), invalid.problem ?? "");
    assert.match(invalid.problem ?? "", /'Beam\(website\)'/);
  }
  // Stripe's TEST variable is not Beam's.
  assert.equal(playground({ CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD: "Stripe_TEST" }).method, "Beam(website)");
  // beam-live: only the live variable, even when the test one is set or invalid.
  for (const testMethod of ["Beam_TEST", "Beam TEST", "credit"]) {
    assert.deepEqual(resolveCloudbedsPaymentMethod({ ...BEAM_METHOD, CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD: testMethod }, "beam-live"), { method: "Beam(website)", problem: null }, testMethod);
  }
  const onlyTest = resolveCloudbedsPaymentMethod({ CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD: "Beam_TEST" }, "beam-live");
  assert.equal(onlyTest.method, null);
  assert.match(onlyTest.problem ?? "", /^CLOUDBEDS_BEAM_PAYMENT_METHOD is not set, so Beam payments/);
  // Through the configs: Stage B records test money under the test method; beam-live never does.
  const testVars = { ...BEAM_METHOD, CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD: "Beam_TEST" };
  assert.equal(getBookingConfig({ ...BEAM_PG_WRITES, ...testVars }).cloudbedsPaymentMethod, "Beam_TEST");
  assert.equal(getFulfilmentConfig({ ...BEAM_PG_WRITES, ...testVars }).cloudbedsPaymentMethod, "Beam_TEST");
  assert.equal(getBookingConfig({ ...BEAM_LIVE, ...testVars }, READY).cloudbedsPaymentMethod, "Beam(website)");
});

/** A cart's checkout input, priced on Stripe's kit (the same fake property, and a Beam quote is the same hold-first quote). */
async function checkoutInput(): Promise<StripeCheckoutInput> {
  const kit = makeKit();
  const req = request(HONEYMOON);
  const quote = await serverQuote(kit, req);
  const inv = await getCartInventory(req.checkIn, req.checkOut, req.items, kit.config, { fetchImpl: kit.fakeCb.fetch, allowDemoFallback: false });
  return { checkIn: req.checkIn, checkOut: req.checkOut, items: req.items, guest: GUEST, quote, inventory: inv.inventory, dataSource: inv.dataSource, today: todayInBangkok(new Date(kit.now.ms)) };
}

function coreContext(kit: Kit): HoldFirstCheckoutContext {
  return { deps: kit.deps, origin: ORIGIN, nowMs: kit.now.ms, nonce: () => "nonce", testAccessToken: kit.checkoutDeps().testAccessToken, sleep: async () => undefined };
}

/** An adapter that records being asked (beforeHold, the provider's last word) and stops there; nothing else may run. */
function stopAdapter(reached: string[]): CheckoutAdapter {
  const never = async (): Promise<never> => {
    throw new Error("never reached");
  };
  return {
    provider: "beam",
    brand: "Beam",
    maxChargeSatang: 50_000_000,
    async beforeHold() {
      reached.push("beforeHold");
      return fail(503, { error: "payment_unavailable", message: "stopped by the test" });
    },
    createPage: never,
    isAllowedUrl: () => false,
    cancelPage: never,
    errorInfo: () => ({}),
    pageFailedAlert: () => ({ subject: "never", lines: [], key: "never" }),
  };
}

test("Beam payment method problems never lock the config: fulfilment, release and the sweeper keep loading it; checkout refuses with the existing 'payment-method-config' alert, its problem line on Beam", async () => {
  for (const [label, extra] of [
    ["unset", {}],
    ["a built-in", { CLOUDBEDS_BEAM_PAYMENT_METHOD: "credit" }],
    ["an invalid TEST variable", { ...BEAM_METHOD, CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD: "Beam TEST" }],
  ] as [string, Env][]) {
    const env = { ...BEAM_PG_WRITES, ...extra };
    assert.equal(getBookingConfig(env).paymentMode, "beam-playground", label);
    assert.match(getBookingConfig(env).cloudbedsPaymentMethodProblem ?? "", /^CLOUDBEDS_BEAM_(TEST_)?PAYMENT_METHOD /, label);
    assert.equal(getFulfilmentConfig(env).paymentMode, "beam-playground", `${label}: fulfilment`);
    assert.equal(getPublicBookingConfig(env).paymentStatus, getPublicBookingConfig({ ...BEAM_PG_WRITES, ...BEAM_METHOD }).paymentStatus, `${label}: the page is not locked by it`);
  }
  // beam-live (the code switch overridden, as tests only may): loads with the problem. Locked in code, it is locked the
  // same way with or without a usable method: the method is not a live-lock condition.
  const live = { ...BEAM_LIVE, CLOUDBEDS_BEAM_PAYMENT_METHOD: "Beam website" };
  assert.equal(getBookingConfig(live, READY).paymentMode, "beam-live");
  assert.match(getBookingConfig(live, READY).cloudbedsPaymentMethodProblem ?? "", /^CLOUDBEDS_BEAM_PAYMENT_METHOD "Beam website" is not a Cloudbeds payment method value/);
  assert.equal(getFulfilmentConfig(live, READY).paymentMode, "beam-live");
  const locked = thrown(() => getBookingConfig(live));
  assert.equal(locked?.code, "live_payments_locked");
  assert.deepEqual(locked, thrown(() => getBookingConfig({ ...BEAM_LIVE, ...BEAM_METHOD })));
  assert.ok(!locked?.missing.some((m) => m.includes("PAYMENT_METHOD")), JSON.stringify(locked));

  // Checkout with real Cloudbeds writes refuses before the provider is asked or anything is held, with the
  // existing alert: the subject and second line unchanged, the problem line naming Beam's variable and method.
  const input = await checkoutInput();
  const kit = makeKit({ env: { ...BEAM_PG_WRITES, CLOUDBEDS_STRIPE_PAYMENT_METHOD: "Stripe(website)" } });
  assert.equal(kit.config.paymentMode, "beam-playground");
  assert.equal(kit.deps.writer.mode, "live");
  const reached: string[] = [];
  for (let i = 0; i < 2; i++) {
    const res = await startHoldFirstCheckout(input, coreContext(kit), stopAdapter(reached));
    assert.equal(res.status, 503);
    assert.equal(res.body.ok ? "" : res.body.error, "payment_unavailable");
    assert.match(res.body.ok ? "" : res.body.message, /Nothing has been charged\. Message us on WhatsApp/);
  }
  assert.deepEqual(reached, [], "refused before the provider's own check");
  assert.deepEqual(kit.fakeCb.calls.filter((c) => c.verb !== "GET"), [], "no Cloudbeds write at all");
  const alerts = kit.alerts.filter((a) => a.subject === METHOD_ALERT);
  assert.equal(alerts.length, 1, "deduplicated");
  assert.equal(alerts[0].severity, "warning");
  assert.equal(alerts[0].lines[0], kit.config.cloudbedsPaymentMethodProblem);
  assert.match(alerts[0].lines[0], /^CLOUDBEDS_BEAM_PAYMENT_METHOD is not set, so Beam payments can't be recorded in Cloudbeds\. .*the custom 'Beam\(website\)' payment method/);
  assert.equal(alerts[0].lines[1], "Every online checkout is refused before anything is reserved or charged until this is fixed; guests are asked to message us on WhatsApp.");
  assert.ok(kit.logs.some((l) => l.message === "checkout_refused_payment_method" && l.data?.mode === "beam-playground"));

  // With the method set, the same checkout passes the check (and the test guard) and reaches the provider.
  const ok = makeKit({ env: { ...BEAM_PG_WRITES, ...BEAM_METHOD } });
  const res = await startHoldFirstCheckout(input, coreContext(ok), stopAdapter(reached));
  assert.equal(res.body.ok ? "" : res.body.message, "stopped by the test");
  assert.deepEqual(reached, ["beforeHold"]);
  assert.deepEqual(ok.alerts.filter((a) => a.subject === METHOD_ALERT), []);
});

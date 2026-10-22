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
//
// Step S3.4: beamLiveBlockers (the live-lock matrix), the Beam branch of getFulfilmentConfig (checkout-only conditions),
// getBeamDrainConfig (drains in both directions), finishesLivePayments and resolveBookingEngine for beam-live.
// LIVE_FULFILMENT_READY.beam stays false: the beam-live cases override it (READY), as tests only may.

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
  LIVE_FULFILMENT_READY,
  MIN_BEAM_WEBHOOK_HMAC_KEY_BYTES,
  PAYMENT_LINK_TTL_MINUTES,
  beamLiveBlockers,
  beamWebhookHmacKeyBytes,
  finishesLivePayments,
  finishesLiveStripePayments,
  getBeamDrainConfig,
  getBookingConfig,
  getFulfilmentConfig,
  getInventoryConfig,
  getPublicBookingConfig,
  getStripeDrainConfig,
  resolveBookingEngine,
  resolveCloudbedsPaymentMethod,
  resolvePaymentMode,
  resolveProvider,
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
/** What beamLiveBlockers requires beyond the writes (S3.4): the webhook HMAC key, a sweep secret and, for checkout, the Cloudbeds email. */
const LIVE_EXTRA: Env = {
  BEAM_WEBHOOK_HMAC_KEY: Buffer.from("test-only-beam-hmac-key-01234567").toString("base64"),
  BOOKING_SWEEP_SECRET: "sweep-secret-testkit-0123456789",
  CLOUDBEDS_SEND_STATUS_EMAIL: "true",
};
/** beam-live with every beamLiveBlockers condition (the code switch is overridden where it is used). */
const BEAM_LIVE: Env = { ...BEAM_PG, ...WRITES, ...LIVE_EXTRA, BEAM_API_BASE: BEAM_LIVE_BASE, BOOKING_ALLOW_LIVE_PAYMENTS: "true", VERCEL_ENV: "production" };
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

/* ------------- beam-live blockers, fulfilment unlock, drains and the booking engine (S3.4) ------------- */

const SWITCH_BLOCKER = "LIVE_FULFILMENT_READY.beam (code)";
const HMAC_BLOCKER = "BEAM_WEBHOOK_HMAC_KEY (base64, 16+ bytes decoded)";
const ALLOW_BLOCKER = "BOOKING_ALLOW_LIVE_PAYMENTS=true";
const EMAIL_BLOCKER = "CLOUDBEDS_SEND_STATUS_EMAIL=true (the guest's written confirmation)";
const SWEEP_BLOCKER = "BOOKING_SWEEP_SECRET or CRON_SECRET (16+ characters)";
const ALL_BLOCKERS = [
  "BOOKING_PAYMENT_PROVIDER=beam",
  "BEAM_API_BASE (https://api.beamcheckout.com)",
  "BEAM_MERCHANT_ID",
  "BEAM_API_KEY",
  HMAC_BLOCKER,
  ALLOW_BLOCKER,
  "VERCEL_ENV=production",
  "CLOUDBEDS_API_KEY_BOOKING",
  "CLOUDBEDS_PROPERTY_ID",
  "Upstash Redis (UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN)",
  "BOOKING_TOKEN_SECRET (32+ random characters)",
  "live Cloudbeds data (Cloudbeds key set, BOOKING_DATA_SOURCE not 'demo')",
  EMAIL_BLOCKER,
  SWEEP_BLOCKER,
  SWITCH_BLOCKER,
];
/** beamLiveBlockers' conditions for finishing payments (the checkout-only ones skipped). */
const FULFIL = { ...READY, fulfilment: true };
/** A base64 key of `bytes` bytes. */
const b64 = (bytes: number) => Buffer.alloc(bytes, 0xfb).toString("base64");
/** The Beam live variables a Stripe deployment carries for a Beam drain (base, keys, HMAC key). */
const BEAM_LIVE_VARS: Env = { BEAM_API_BASE: BEAM_LIVE_BASE, ...KEYS, BEAM_WEBHOOK_HMAC_KEY: LIVE_EXTRA.BEAM_WEBHOOK_HMAC_KEY };

/** The message a call threw (a BookingConfigError). */
function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof BookingConfigError, String(e));
    return e.message;
  }
  throw new Error("did not throw");
}

test("beamLiveBlockers names every beam-live condition, in order; fulfilment skips the emergency stop and the Cloudbeds email; the fixture lacks only the code switch", () => {
  assert.deepEqual(beamLiveBlockers({}), ALL_BLOCKERS);
  assert.deepEqual(
    beamLiveBlockers({}, { fulfilment: true }),
    ALL_BLOCKERS.filter((m) => m !== ALLOW_BLOCKER && m !== EMAIL_BLOCKER),
  );
  assert.deepEqual(beamLiveBlockers(BEAM_LIVE), [SWITCH_BLOCKER], "LIVE_FULFILMENT_READY.beam stays false");
  assert.deepEqual(beamLiveBlockers(BEAM_LIVE, READY), []);
  assert.deepEqual(beamLiveBlockers(BEAM_LIVE, FULFIL), []);
  // The same alternatives Stripe accepts: a trailing slash, Vercel's CRON_SECRET, the Vercel names of Redis.
  assert.deepEqual(beamLiveBlockers({ ...BEAM_LIVE, BEAM_API_BASE: ` ${BEAM_LIVE_BASE}/ ` }, READY), []);
  assert.deepEqual(beamLiveBlockers({ ...BEAM_LIVE, BOOKING_SWEEP_SECRET: undefined, CRON_SECRET: "cron-secret-0123456789" }, READY), []);
  const kvNames = { ...BEAM_LIVE, UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined, KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_TOKEN: "t" };
  assert.deepEqual(beamLiveBlockers(kvNames, READY), []);
  assert.deepEqual(beamLiveBlockers({ ...BEAM_LIVE, BOOKING_PAYMENT_PROVIDER: " BEAM " }, READY), [], "the provider is read as resolveProvider reads it");
  // The playground base is not the live one (that env is beam-playground, not a locked beam-live).
  assert.deepEqual(beamLiveBlockers({ ...BEAM_LIVE, BEAM_API_BASE: BEAM_PLAYGROUND_BASE }, READY), ["BEAM_API_BASE (https://api.beamcheckout.com)"]);
  assert.equal(getBookingConfig({ ...BEAM_LIVE, BEAM_API_BASE: BEAM_PLAYGROUND_BASE }).paymentMode, "beam-playground");
  // The Stripe live deployment with the Beam live variables, switched to beam: the Cloudbeds email (checkout) and the code switch.
  assert.deepEqual(beamLiveBlockers({ ...STRIPE_LIVE_ENV, ...BEAM_LIVE_VARS, BOOKING_PAYMENT_PROVIDER: "beam" }), [EMAIL_BLOCKER, SWITCH_BLOCKER]);
  assert.deepEqual(beamLiveBlockers({ ...STRIPE_LIVE_ENV, ...BEAM_LIVE_VARS, BOOKING_PAYMENT_PROVIDER: "beam" }, { fulfilment: true }), [SWITCH_BLOCKER]);
  // The Cloudbeds payment method is not a condition (S3.3): checkout refuses with an alert instead.
  assert.ok(!ALL_BLOCKERS.some((m) => m.includes("PAYMENT_METHOD")));
  assert.deepEqual(beamLiveBlockers({ ...BEAM_LIVE, CLOUDBEDS_BEAM_PAYMENT_METHOD: "credit" }, READY), []);
});

test("the beam-live lock matrix: each blocker alone locks checkout and names only itself; the emergency stop and the Cloudbeds email lock checkout but not fulfilment", () => {
  const cases: [string, Env, string, boolean][] = [
    ["no provider variable (the legacy rule)", { BOOKING_PAYMENT_PROVIDER: undefined }, "BOOKING_PAYMENT_PROVIDER=beam", false],
    ["no merchant id", { BEAM_MERCHANT_ID: undefined }, "BEAM_MERCHANT_ID", false],
    ["a blank API key", { BEAM_API_KEY: "  " }, "BEAM_API_KEY", false],
    ["no HMAC key", { BEAM_WEBHOOK_HMAC_KEY: undefined }, HMAC_BLOCKER, false],
    ["an HMAC key of 15 bytes", { BEAM_WEBHOOK_HMAC_KEY: b64(MIN_BEAM_WEBHOOK_HMAC_KEY_BYTES - 1) }, HMAC_BLOCKER, false],
    ["a raw-string HMAC key (not decoded first)", { BEAM_WEBHOOK_HMAC_KEY: "golden-beam-hmac-key-0123456789!" }, HMAC_BLOCKER, false],
    ["a URL-safe HMAC key", { BEAM_WEBHOOK_HMAC_KEY: b64(32).replace(/\+/g, "-").replace(/\//g, "_") }, HMAC_BLOCKER, false],
    ["the emergency stop", { BOOKING_ALLOW_LIVE_PAYMENTS: "false" }, ALLOW_BLOCKER, true],
    ["BOOKING_ALLOW_LIVE_PAYMENTS=TRUE (exactly 'true', as for Stripe)", { BOOKING_ALLOW_LIVE_PAYMENTS: "TRUE" }, ALLOW_BLOCKER, true],
    ["a preview deployment", { VERCEL_ENV: "preview" }, "VERCEL_ENV=production", false],
    ["no booking key", { CLOUDBEDS_API_KEY_BOOKING: undefined }, "CLOUDBEDS_API_KEY_BOOKING", false],
    ["a property id that is not numeric", { CLOUDBEDS_PROPERTY_ID: "abc" }, "CLOUDBEDS_PROPERTY_ID", false],
    ["no Redis", { UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined }, "Upstash Redis (UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN)", false],
    ["a weak token secret", { BOOKING_TOKEN_SECRET: "s".repeat(40) }, "BOOKING_TOKEN_SECRET (32+ random characters)", false],
    ["simulated prices", { BOOKING_DATA_SOURCE: "demo" }, "live Cloudbeds data (Cloudbeds key set, BOOKING_DATA_SOURCE not 'demo')", false],
    ["no Cloudbeds email", { CLOUDBEDS_SEND_STATUS_EMAIL: undefined }, EMAIL_BLOCKER, true],
    ["CLOUDBEDS_SEND_STATUS_EMAIL=false", { CLOUDBEDS_SEND_STATUS_EMAIL: "false" }, EMAIL_BLOCKER, true],
    ["no sweep secret", { BOOKING_SWEEP_SECRET: undefined }, SWEEP_BLOCKER, false],
    ["a short sweep secret", { BOOKING_SWEEP_SECRET: "short" }, SWEEP_BLOCKER, false],
  ];
  assert.equal(getBookingConfig(BEAM_LIVE, READY).paymentMode, "beam-live", "the full fixture is beam-live");
  for (const [label, patch, blocker, checkoutOnly] of cases) {
    const env = { ...BEAM_LIVE, ...patch };
    const locked = { code: "live_payments_locked", missing: [blocker] };
    assert.deepEqual(beamLiveBlockers(env, READY), [blocker], label);
    assert.deepEqual(thrown(() => resolvePaymentMode(env, READY)), locked, label);
    assert.deepEqual(thrown(() => getBookingConfig(env, READY)), locked, label);
    assert.match(messageOf(() => getBookingConfig(env, READY)), new RegExp(`live Beam payments are locked\\. Missing: ${blocker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.$`), label);
    const pub = getPublicBookingConfig(env);
    assert.equal(pub.paymentStatus, "locked", label);
    assert.equal(pub.live, false, label);
    if (checkoutOnly) {
      assert.deepEqual(beamLiveBlockers(env, FULFIL), [], label);
      assert.equal(getFulfilmentConfig(env, READY).paymentMode, "beam-live", `${label}: paid and started bookings are still finished`);
    } else {
      assert.deepEqual(beamLiveBlockers(env, FULFIL), [blocker], label);
      assert.deepEqual(thrown(() => getFulfilmentConfig(env, READY)), locked, `${label}: fulfilment too`);
    }
    // The code switch as it is (false): locked in code, checkout and fulfilment alike.
    assert.deepEqual(thrown(() => getBookingConfig(env)), { code: "live_payments_locked", missing: [] }, label);
    assert.equal(thrown(() => getFulfilmentConfig(env))?.code, "live_payments_locked", label);
  }
});

test("the code switch: while LIVE_FULFILMENT_READY.beam is false beam-live is locked in code for checkout and fulfilment; the error names only the switch (missing: [], the routes' log line) and its message the rest", () => {
  assert.equal(LIVE_FULFILMENT_READY.beam, false);
  const stopped: Env = { ...BEAM_LIVE, BOOKING_ALLOW_LIVE_PAYMENTS: "false" };
  const noEmail: Env = { ...BEAM_LIVE, CLOUDBEDS_SEND_STATUS_EMAIL: undefined };
  for (const env of [BEAM_LIVE, stopped, noEmail]) {
    const label = JSON.stringify({ allow: env.BOOKING_ALLOW_LIVE_PAYMENTS, email: env.CLOUDBEDS_SEND_STATUS_EMAIL ?? null });
    assert.deepEqual(thrown(() => resolvePaymentMode(env)), { code: "live_payments_locked", missing: [] }, label);
    assert.deepEqual(thrown(() => getBookingConfig(env)), { code: "live_payments_locked", missing: [] }, label);
    assert.deepEqual(thrown(() => getFulfilmentConfig(env)), { code: "live_payments_locked", missing: [] }, label);
    assert.equal(getPublicBookingConfig(env).paymentStatus, "locked", label);
    assert.equal(resolveBookingEngine({ ...env, BOOKING_ENGINE: "own" }), "cloudbeds", label);
    assert.equal(finishesLivePayments(env), false, label);
    assert.equal(getBeamDrainConfig({ ...env, BOOKING_PAYMENT_PROVIDER: "stripe" }), null, label);
  }
  assert.equal(
    messageOf(() => getBookingConfig(BEAM_LIVE)),
    "Live Beam payments are switched off in code (LIVE_FULFILMENT_READY.beam=false): Beam has no fulfilment, so a real payment could not be " +
      "turned into a reservation. Use BOOKING_PAYMENT_PROVIDER=stripe.",
  );
  const rest = messageOf(() => getBookingConfig({ ...BEAM_LIVE, BEAM_WEBHOOK_HMAC_KEY: undefined, CLOUDBEDS_SEND_STATUS_EMAIL: undefined }));
  assert.ok(rest.endsWith(` Also missing: ${HMAC_BLOCKER}; ${EMAIL_BLOCKER}.`), rest);
  // Names only, never a value.
  const all = messageOf(() => getBookingConfig({ ...BEAM_LIVE, BEAM_WEBHOOK_HMAC_KEY: "c2hvcnQ=", BOOKING_SWEEP_SECRET: "short-secret" }));
  for (const value of ["c2hvcnQ=", "short-secret", SECRET.BOOKING_TOKEN_SECRET, WRITES.UPSTASH_REDIS_REST_TOKEN ?? "", WRITES.CLOUDBEDS_API_KEY_BOOKING ?? ""]) {
    assert.ok(!all.includes(value), value);
  }
  // The golden route env 'provider beam live (locked in code), Stripe live credentials kept': the same lock for the
  // status and abandon routes (getFulfilmentConfig), missing [] (their log line, pinned by the golden record).
  const golden = { ...STRIPE_LIVE_ENV, ...BEAM_LIVE_VARS, BOOKING_PAYMENT_PROVIDER: "beam" };
  assert.deepEqual(thrown(() => getFulfilmentConfig(golden)), { code: "live_payments_locked", missing: [] });
  assert.equal(getStripeDrainConfig(golden)?.paymentMode, "stripe-live", "the Stripe drain finishes the Stripe bookings, as before");
});

test("the webhook HMAC key: base64 (the standard alphabet, padding optional), at least 16 bytes once decoded", () => {
  const VECTOR_KEY = "KOFELguf5L1ltuDlkDHGUkPPnQhrgYYijTR4Fqh7APc="; // Beam's published test vector (beam.test.ts)
  for (const [raw, bytes] of [
    [undefined, 0],
    ["", 0],
    ["   ", 0],
    [VECTOR_KEY, 32],
    [VECTOR_KEY.replace(/=+$/, ""), 32],
    [` ${VECTOR_KEY}\n`, 32],
    [b64(16), 16],
    [b64(16).replace(/=+$/, ""), 16],
    [b64(15), 15],
    [b64(64), 64],
    ["c2hvcnQ=", 5],
    ["short", 0],
    ["golden-beam-hmac-key-0123456789!", 0],
    [b64(32).replace(/\+/g, "-").replace(/\//g, "_"), 0],
    ["abc=", 2],
    ["ab=", 0],
    ["a===", 0],
    ["ab cd", 0],
  ] as [string | undefined, number][]) {
    assert.equal(beamWebhookHmacKeyBytes(raw), bytes, JSON.stringify(raw));
    // A key it accepts decodes to that many bytes, as verifyBeamSignature (beam.ts) decodes it.
    if (bytes > 0) assert.equal(Buffer.from((raw ?? "").trim(), "base64").length, bytes, JSON.stringify(raw));
  }
  assert.equal(MIN_BEAM_WEBHOOK_HMAC_KEY_BYTES, 16);
  assert.deepEqual(beamLiveBlockers({ ...BEAM_LIVE, BEAM_WEBHOOK_HMAC_KEY: b64(16) }, READY), []);
  assert.deepEqual(beamLiveBlockers({ ...BEAM_LIVE, BEAM_WEBHOOK_HMAC_KEY: VECTOR_KEY }, READY), []);
  assert.deepEqual(beamLiveBlockers({ ...BEAM_LIVE, BEAM_WEBHOOK_HMAC_KEY: b64(15) }, READY), [HMAC_BLOCKER]);
  // The config keeps the key as it was set (the webhook route decodes it); the blocker only checks it.
  assert.equal(getBookingConfig(BEAM_LIVE, READY).beamWebhookHmacKey, LIVE_EXTRA.BEAM_WEBHOOK_HMAC_KEY);
});

test("getFulfilmentConfig: beam-live locked only by the emergency stop or the Cloudbeds email is finished with the checkout's config (the real email flag); the Stripe branch is unchanged and runs first", () => {
  const full = getBookingConfig(BEAM_LIVE, READY);
  const stopped = { ...BEAM_LIVE, BOOKING_ALLOW_LIVE_PAYMENTS: "false" };
  const noEmail = { ...BEAM_LIVE, CLOUDBEDS_SEND_STATUS_EMAIL: undefined };
  const both = { ...stopped, CLOUDBEDS_SEND_STATUS_EMAIL: "false" };
  assert.deepEqual(thrown(() => getBookingConfig(stopped, READY)), { code: "live_payments_locked", missing: [ALLOW_BLOCKER] });
  assert.deepEqual(getFulfilmentConfig(stopped, READY), full, "the emergency stop blocks new charges only");
  assert.deepEqual(thrown(() => getBookingConfig(noEmail, READY)), { code: "live_payments_locked", missing: [EMAIL_BLOCKER] });
  // Nothing is overridden: a deployment that stopped sending the Cloudbeds email does not start sending it by itself.
  assert.deepEqual(getFulfilmentConfig(noEmail, READY), { ...full, sendCloudbedsStatusEmail: false });
  assert.deepEqual(thrown(() => getBookingConfig(both, READY)), { code: "live_payments_locked", missing: [ALLOW_BLOCKER, EMAIL_BLOCKER] });
  assert.deepEqual(getFulfilmentConfig(both, READY), { ...full, sendCloudbedsStatusEmail: false });
  for (const env of [stopped, noEmail, both]) {
    const pub = getPublicBookingConfig(env);
    assert.equal(pub.paymentStatus, "locked", "the page takes no new payment");
    assert.equal(resolveBookingEngine({ ...env, BOOKING_ENGINE: "own" }, READY), "cloudbeds", "/booking goes back to the classic engine");
    assert.equal(getFulfilmentConfig({ ...env, BOOKING_ENGINE: "own" }, READY).bookingEngine, "cloudbeds");
  }
  // A Stripe live key kept next to beam-live: the Stripe branch cannot unlock it (the provider is beam), the Beam one does.
  const withStripe = { ...STRIPE_LIVE_ENV, ...stopped };
  assert.equal(getFulfilmentConfig(withStripe, READY).paymentMode, "beam-live");
  assert.equal(getFulfilmentConfig(withStripe, READY).stripe, null);
  // Stripe's own emergency stop: exactly as before, whatever the Beam variables or the switch.
  const stripeStopped = { ...STRIPE_LIVE_ENV, BOOKING_ALLOW_LIVE_PAYMENTS: "false" };
  for (const env of [stripeStopped, { ...stripeStopped, ...BEAM_LIVE_VARS }, { ...stripeStopped, ...BEAM_LIVE_VARS, CLOUDBEDS_SEND_STATUS_EMAIL: "true" }]) {
    assert.equal(getFulfilmentConfig(env).paymentMode, "stripe-live");
    assert.deepEqual(getFulfilmentConfig(env, READY), getFulfilmentConfig(env));
    assert.equal(getFulfilmentConfig(env).beam, null);
  }
  // The demo and the playground are what getBookingConfig says.
  assert.deepEqual(getFulfilmentConfig(BEAM_PG_WRITES), getBookingConfig(BEAM_PG_WRITES));
  assert.deepEqual(getFulfilmentConfig({}), getBookingConfig({}));
});

test("getBeamDrainConfig: provider stripe (or demo, or an invalid value) with the Beam variables drains Beam once the switch is overridden; provider beam with Stripe variables keeps the unchanged Stripe drain", () => {
  const stripePrimary = { ...STRIPE_LIVE_ENV, ...BEAM_LIVE_VARS };
  assert.equal(getBookingConfig(stripePrimary).paymentMode, "stripe-live", "the active config is Stripe's");
  assert.equal(getBeamDrainConfig(stripePrimary), null, "while LIVE_FULFILMENT_READY.beam is false a beam-live drain is null");
  const drain = getBeamDrainConfig(stripePrimary, READY);
  assert.equal(drain?.paymentMode, "beam-live");
  assert.equal(drain?.provider, "beam");
  assert.equal(drain?.stripe, null);
  assert.equal(drain?.beam?.apiBase, BEAM_LIVE_BASE);
  assert.equal(drain?.bookingEngine, "cloudbeds");
  assert.deepEqual(drain, getFulfilmentConfig({ ...stripePrimary, BOOKING_PAYMENT_PROVIDER: "beam", BOOKING_ENGINE: "cloudbeds" }, READY));
  // The fulfilment conditions: no Cloudbeds email needed (STRIPE_LIVE_ENV sets none), and the emergency stop never blocks it.
  assert.equal(drain?.sendCloudbedsStatusEmail, false);
  assert.equal(getBeamDrainConfig({ ...stripePrimary, BOOKING_ALLOW_LIVE_PAYMENTS: "false" }, READY)?.paymentMode, "beam-live");
  // A drain never renders an engine, even where the same variables would unlock beam-live checkout with BOOKING_ENGINE=own.
  const ownEverything = { ...stripePrimary, BOOKING_ENGINE: "own", CLOUDBEDS_SEND_STATUS_EMAIL: "true" };
  assert.equal(resolveBookingEngine({ ...ownEverything, BOOKING_PAYMENT_PROVIDER: "beam" }, READY), "own");
  assert.equal(getBeamDrainConfig(ownEverything, READY)?.bookingEngine, "cloudbeds");
  for (const provider of ["demo", "paypal"]) {
    assert.equal(getBeamDrainConfig({ ...stripePrimary, BOOKING_PAYMENT_PROVIDER: provider }, READY)?.paymentMode, "beam-live", provider);
  }
  // A Stripe-test deployment on production with the Beam live variables: the drain alone finishes live Beam payments.
  const stripeTestPrimary = { ...STRIPE_TEST_ENV, ...BEAM_LIVE_VARS, VERCEL_ENV: "production", BOOKING_SWEEP_SECRET: LIVE_EXTRA.BOOKING_SWEEP_SECRET };
  assert.equal(getBeamDrainConfig(stripeTestPrimary, READY)?.paymentMode, "beam-live");
  // Every other fulfilment condition still applies: null, never a throw.
  for (const patch of [
    { VERCEL_ENV: "preview" },
    { BOOKING_SWEEP_SECRET: undefined },
    { BEAM_WEBHOOK_HMAC_KEY: "c2hvcnQ=" },
    { UPSTASH_REDIS_REST_URL: undefined },
    { CLOUDBEDS_API_KEY_BOOKING: undefined },
    { BOOKING_DATA_SOURCE: "demo" },
  ] as Env[]) {
    assert.equal(getBeamDrainConfig({ ...stripePrimary, ...patch }, READY), null, JSON.stringify(patch));
  }
  // The Beam base, both keys and the HMAC key must be set (a known base), or there is nothing to drain.
  for (const patch of [
    { BEAM_API_BASE: undefined },
    { BEAM_MERCHANT_ID: undefined },
    { BEAM_API_KEY: " " },
    { BEAM_WEBHOOK_HMAC_KEY: undefined },
    { BEAM_API_BASE: "https://beam.invalid" },
    { BEAM_API_BASE: "https://api.beamcheckout.com.evil.io" },
  ] as Env[]) {
    assert.equal(getBeamDrainConfig({ ...stripePrimary, ...patch }, READY), null, JSON.stringify(patch));
  }
  // provider beam (the active config covers Beam) with Stripe variables: no Beam drain, the Stripe drain as before.
  for (const beamPrimary of [{ ...STRIPE_LIVE_ENV, ...BEAM_LIVE_VARS, BOOKING_PAYMENT_PROVIDER: "beam" }, { ...STRIPE_LIVE_ENV, ...BEAM_PG_WRITES, BEAM_WEBHOOK_HMAC_KEY: b64(32) }]) {
    assert.equal(getBeamDrainConfig(beamPrimary, READY), null);
    assert.equal(getStripeDrainConfig(beamPrimary)?.paymentMode, "stripe-live");
    assert.deepEqual(getStripeDrainConfig(beamPrimary, READY), getStripeDrainConfig(beamPrimary));
  }
  // A Stripe deployment without Beam variables has no Beam drain.
  for (const env of [STRIPE_LIVE_ENV, STRIPE_TEST_ENV, MOCK_ENV, { ...STRIPE_LIVE_ENV, BOOKING_ALLOW_LIVE_PAYMENTS: "false" }, {}]) {
    assert.equal(getBeamDrainConfig(env, READY), null);
  }
});

test("getBeamDrainConfig: a beam-playground drain works on a preview; invalid Beam variables give no drain and it never throws (money review 11)", () => {
  const preview = { ...STRIPE_TEST_ENV, BEAM_API_BASE: BEAM_PLAYGROUND_BASE, ...KEYS, BEAM_WEBHOOK_HMAC_KEY: b64(32), VERCEL_ENV: "preview" };
  assert.equal(getBookingConfig(preview).paymentMode, "stripe-test");
  const pg = getBeamDrainConfig(preview);
  assert.equal(pg?.paymentMode, "beam-playground", "no code switch for the playground");
  assert.equal(pg?.provider, "beam");
  assert.equal(pg?.cloudbedsWrite?.mode, "live");
  assert.deepEqual(pg?.testGuard, getBookingConfig(STRIPE_TEST_ENV).testGuard, "Stage B's guard");
  assert.equal(pg?.beam?.hostedHost, "playground-pay.beamcheckout.com");
  assert.deepEqual(getBeamDrainConfig(preview, READY), pg);
  // Locally too, with the demo provider.
  assert.equal(getBeamDrainConfig({ ...BEAM_PG_WRITES, BEAM_WEBHOOK_HMAC_KEY: b64(32), BOOKING_PAYMENT_PROVIDER: "demo" })?.paymentMode, "beam-playground");
  // The base, both keys and the HMAC key must be set for the playground as well.
  for (const name of ["BEAM_API_BASE", "BEAM_MERCHANT_ID", "BEAM_API_KEY", "BEAM_WEBHOOK_HMAC_KEY"]) {
    assert.equal(getBeamDrainConfig({ ...preview, [name]: undefined }), null, name);
    assert.equal(getBeamDrainConfig({ ...preview, [name]: "  " }), null, `${name} blank`);
  }
  // Invalid or unusable: null, no throw.
  const invalid: [string, Env][] = [
    ["an unknown base, a short HMAC key", { ...STRIPE_LIVE_ENV, BEAM_API_BASE: "https://beam.invalid", BEAM_MERCHANT_ID: "x", BEAM_API_KEY: "y", BEAM_WEBHOOK_HMAC_KEY: "short" }],
    ["the mock writer on a preview (no booking key)", { ...preview, CLOUDBEDS_API_KEY_BOOKING: undefined }],
    ["a weak token secret", { ...preview, BOOKING_TOKEN_SECRET: "short" }],
    ["a property id that is not numeric", { ...preview, CLOUDBEDS_PROPERTY_ID: "abc" }],
    ["simulated prices with real writes", { ...preview, BOOKING_DATA_SOURCE: "demo" }],
    ["no Redis with real writes", { ...preview, UPSTASH_REDIS_REST_URL: undefined }],
    ["no token secret at all", { BOOKING_PAYMENT_PROVIDER: "stripe", BEAM_API_BASE: BEAM_PLAYGROUND_BASE, ...KEYS, BEAM_WEBHOOK_HMAC_KEY: b64(32) }],
    ["the legacy rule (no provider variable: the active config is Beam)", { ...BEAM_PG_WRITES, BOOKING_PAYMENT_PROVIDER: undefined, BEAM_WEBHOOK_HMAC_KEY: b64(32) }],
  ];
  for (const [label, env] of invalid) {
    assert.doesNotThrow(() => getBeamDrainConfig(env), label);
    assert.equal(getBeamDrainConfig(env), null, label);
    assert.equal(getBeamDrainConfig(env, READY), null, label);
  }
});

test("finishesLivePayments: finishesLiveStripePayments, or beam-live through the fulfilment config or the Beam drain; the layout measures the return page by it", () => {
  const stopped = { ...BEAM_LIVE, BOOKING_ALLOW_LIVE_PAYMENTS: "false" };
  const noEmail = { ...BEAM_LIVE, CLOUDBEDS_SEND_STATUS_EMAIL: undefined };
  // Every Stripe and demo answer is finishesLiveStripePayments' (the S3.4 config snapshot covers 750 more environments).
  for (const env of [
    STRIPE_LIVE_ENV,
    { ...STRIPE_LIVE_ENV, BOOKING_ALLOW_LIVE_PAYMENTS: "false" },
    { ...STRIPE_LIVE_ENV, BOOKING_PAYMENT_PROVIDER: "demo" },
    { ...STRIPE_LIVE_ENV, ...BEAM_LIVE_VARS },
    { ...STRIPE_LIVE_ENV, ...BEAM_LIVE_VARS, BOOKING_PAYMENT_PROVIDER: "beam" },
    STRIPE_TEST_ENV,
    MOCK_ENV,
    {},
    BEAM_PG_WRITES,
    BEAM_LIVE,
    stopped,
  ] as Env[]) {
    assert.equal(finishesLivePayments(env), finishesLiveStripePayments(env), JSON.stringify(env).slice(0, 120));
  }
  assert.equal(finishesLivePayments(BEAM_LIVE), false, "nothing live is finished on Beam while the code switch is off");
  // With the switch overridden: beam-live through fulfilment (also during the emergency stop, without the email) or the drain.
  for (const env of [BEAM_LIVE, stopped, noEmail]) assert.equal(finishesLivePayments(env, READY), true);
  const stripeTestPrimary = { ...STRIPE_TEST_ENV, ...BEAM_LIVE_VARS, VERCEL_ENV: "production", BOOKING_SWEEP_SECRET: LIVE_EXTRA.BOOKING_SWEEP_SECRET };
  assert.equal(finishesLiveStripePayments(stripeTestPrimary), false);
  assert.equal(finishesLivePayments(stripeTestPrimary, READY), true, "the Beam drain");
  assert.equal(finishesLivePayments({ ...BEAM_LIVE, VERCEL_ENV: "preview" }, READY), false);
  assert.equal(finishesLivePayments(BEAM_PG_WRITES, READY), false, "playground money is not live");
  // layout.tsx uses it; finishesLiveStripePayments stays exported.
  const layout = readFileSync(new URL("../../app/layout.tsx", import.meta.url), "utf8");
  assert.ok(layout.includes("const previewReturnTracked = previewTracked || finishesLivePayments();"));
  assert.ok(!layout.includes("finishesLiveStripePayments"));
  assert.equal(typeof finishesLiveStripePayments, "function");
});

test("resolveBookingEngine: 'own' on production once beam-live checkout is fully unlocked, as for stripe-live; every Stripe answer is unchanged", () => {
  const own = { ...BEAM_LIVE, BOOKING_ENGINE: "own" };
  assert.equal(resolveBookingEngine(own), "cloudbeds", "locked in code");
  assert.equal(resolveBookingEngine(own, READY), "own");
  assert.equal(getBookingConfig(own, READY).bookingEngine, "own");
  for (const patch of [{ BOOKING_ALLOW_LIVE_PAYMENTS: "false" }, { CLOUDBEDS_SEND_STATUS_EMAIL: undefined }, { BEAM_WEBHOOK_HMAC_KEY: undefined }, { BOOKING_SWEEP_SECRET: undefined }, { BEAM_API_BASE: BEAM_PLAYGROUND_BASE }] as Env[]) {
    assert.equal(resolveBookingEngine({ ...own, ...patch }, READY), "cloudbeds", JSON.stringify(patch));
  }
  assert.equal(resolveBookingEngine({ ...own, VERCEL_ENV: "preview" }), "own", "previews: as before");
  assert.equal(resolveBookingEngine({ ...BEAM_LIVE }, READY), "cloudbeds", "BOOKING_ENGINE unset: Cloudbeds");
  // Stripe, unchanged (stripeConfig.test.ts has the cases), also with the switch overridden.
  for (const env of [
    STRIPE_LIVE_ENV,
    STRIPE_TEST_ENV,
    MOCK_ENV,
    { ...STRIPE_LIVE_ENV, BOOKING_ALLOW_LIVE_PAYMENTS: "false" },
    { ...STRIPE_LIVE_ENV, ...BEAM_LIVE_VARS, CLOUDBEDS_SEND_STATUS_EMAIL: "true" },
    { ...STRIPE_LIVE_ENV, ...BEAM_LIVE_VARS, BOOKING_PAYMENT_PROVIDER: "beam" },
    {},
  ] as Env[]) {
    const e = { ...env, BOOKING_ENGINE: "own", VERCEL_ENV: "production" };
    assert.equal(resolveBookingEngine(e, READY), resolveBookingEngine(e), JSON.stringify(env).slice(0, 120));
  }
  assert.equal(resolveBookingEngine({ ...STRIPE_LIVE_ENV, BOOKING_ENGINE: "own" }), "own");
  assert.equal(resolveBookingEngine({ ...STRIPE_LIVE_ENV, ...BEAM_LIVE_VARS, BOOKING_PAYMENT_PROVIDER: "beam", BOOKING_ENGINE: "own" }), "cloudbeds");
});

test("the legacy no-provider rule is unchanged (BEAM_API_BASE alone picks Beam); beam-live needs BOOKING_PAYMENT_PROVIDER=beam, as stripe-live needs =stripe", () => {
  assert.equal(resolveProvider({ BEAM_API_BASE: BEAM_PLAYGROUND_BASE }), "beam");
  assert.equal(resolvePaymentMode({ BEAM_API_BASE: BEAM_PLAYGROUND_BASE, ...KEYS }), "beam-playground");
  assert.equal(resolvePaymentMode({ BEAM_API_BASE: BEAM_PLAYGROUND_BASE }), "demo");
  assert.equal(getBookingConfig({ ...BEAM_PG_WRITES, BOOKING_PAYMENT_PROVIDER: undefined }).paymentMode, "beam-playground");
  const legacy = { ...BEAM_LIVE, BOOKING_PAYMENT_PROVIDER: undefined };
  assert.equal(resolveProvider(legacy), "beam");
  assert.deepEqual(thrown(() => resolvePaymentMode(legacy)), { code: "live_payments_locked", missing: [] }, "locked, as before");
  assert.deepEqual(thrown(() => resolvePaymentMode(legacy, READY)), { code: "live_payments_locked", missing: ["BOOKING_PAYMENT_PROVIDER=beam"] });
  assert.deepEqual(thrown(() => getFulfilmentConfig({ ...legacy, BOOKING_ALLOW_LIVE_PAYMENTS: "false" }, READY)), {
    code: "live_payments_locked",
    missing: ["BOOKING_PAYMENT_PROVIDER=beam", ALLOW_BLOCKER],
  });
  assert.equal(getBeamDrainConfig(legacy, READY), null, "the legacy rule is Beam itself, not a drain");
  assert.equal(getPublicBookingConfig(legacy).provider, "beam");
  assert.equal(getPublicBookingConfig(legacy).paymentStatus, "locked");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BookingConfigError,
  LIVE_FULFILMENT_READY,
  getBookingConfig,
  getFulfilmentConfig,
  getInventoryConfig,
  getPublicBookingConfig,
  resolveBookingEngine,
  resolvePaymentMode,
  resolveProvider,
  stripeKeyKind,
  stripeLiveBlockers,
} from "./config.ts";
import type { Env } from "./config.ts";
import { STRIPE_LIVE_ENV, STRIPE_TEST_ENV, TOKEN_SECRET } from "./testkit.ts";

const locked = (e: unknown) => e instanceof BookingConfigError && e.code === "live_payments_locked";

test("DEFAULT BEHAVIOUR UNCHANGED: no env -> demo provider, Cloudbeds engine on /booking, preview path", () => {
  assert.equal(resolveProvider({}), "demo");
  assert.equal(resolvePaymentMode({}), "demo");
  assert.equal(resolveBookingEngine({}), "cloudbeds");
  const pub = getPublicBookingConfig({});
  assert.equal(pub.provider, "demo");
  assert.equal(pub.paymentMode, "demo");
  assert.equal(pub.live, false);
  assert.equal(pub.cardFeePct, 3);
  assert.equal(pub.cloudbedsWrites, "none");
  assert.equal(pub.requiresGuestDetails, false);
  assert.equal(pub.bookingPath, "/booking-preview");
  assert.deepEqual(pub.ratePlans, ["standard", "breakfast"]);
  assert.equal(pub.addonsEnabled, true);
  // Legacy Beam rule unchanged when BOOKING_PAYMENT_PROVIDER is unset.
  assert.equal(resolveProvider({ BEAM_API_BASE: "https://playground.api.beamcheckout.com" }), "beam");
  // Only the existing read key: still the demo provider, no writes.
  assert.equal(getBookingConfig({ CLOUDBEDS_API_KEY: "cbat_x" }).cloudbedsWrite, null);
});

test("provider switch: stripe | beam | demo; anything else is a config error", () => {
  assert.equal(resolveProvider({ BOOKING_PAYMENT_PROVIDER: "stripe" }), "stripe");
  assert.equal(resolveProvider({ BOOKING_PAYMENT_PROVIDER: " Beam " }), "beam");
  assert.equal(resolveProvider({ BOOKING_PAYMENT_PROVIDER: "demo", BEAM_API_BASE: "https://api.beamcheckout.com" }), "demo");
  assert.throws(() => resolveProvider({ BOOKING_PAYMENT_PROVIDER: "paypal" }), BookingConfigError);
  assert.equal(getPublicBookingConfig({ BOOKING_PAYMENT_PROVIDER: "paypal" }).paymentStatus, "locked");
});

test("Stripe test vs live comes from the key prefix", () => {
  assert.equal(stripeKeyKind("sk_test_abcdefgh123"), "test");
  assert.equal(stripeKeyKind("rk_test_abcdefgh123"), "test");
  assert.equal(stripeKeyKind("sk_live_abcdefgh123"), "live");
  assert.equal(stripeKeyKind("rk_live_abcdefgh123"), "live");
  assert.equal(stripeKeyKind("pk_live_abcdefgh123"), null, "a publishable key is not a secret key");
  assert.equal(stripeKeyKind("whsec_abcdefgh123"), null);
  assert.equal(resolvePaymentMode(STRIPE_TEST_ENV), "stripe-test");
  assert.throws(() => resolvePaymentMode({ BOOKING_PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "pk_test_abcdefgh123" }), BookingConfigError);
});

test("fee per provider: stripe 5%, beam 3%, demo 3%; BOOKING_CARD_FEE_PCT overrides", () => {
  assert.equal(getBookingConfig(STRIPE_TEST_ENV).cardFeePct, 5);
  assert.equal(getPublicBookingConfig(STRIPE_TEST_ENV).cardFeePct, 5);
  assert.equal(getBookingConfig({}).cardFeePct, 3);
  const beam = { BOOKING_PAYMENT_PROVIDER: "beam", BEAM_API_BASE: "https://playground.api.beamcheckout.com", BEAM_MERCHANT_ID: "m", BEAM_API_KEY: "k", BOOKING_TOKEN_SECRET: TOKEN_SECRET };
  assert.equal(getBookingConfig(beam).cardFeePct, 3);
  assert.equal(getBookingConfig({ ...STRIPE_TEST_ENV, BOOKING_CARD_FEE_PCT: "4.5" }).cardFeePct, 4.5);
  assert.equal(getBookingConfig({ ...beam, BOOKING_CARD_FEE_PCT: "0" }).cardFeePct, 0);
  // A locked stripe config still reports the stripe fee (the page shows prices).
  assert.equal(getPublicBookingConfig({ BOOKING_PAYMENT_PROVIDER: "stripe" }).cardFeePct, 5);
});

test("stripe modes: 100% up front, no site-side promo % (DIRECT sells Cloudbeds' Direct rate), Standard Rate only, no add-ons, guest details required", () => {
  const cfg = getBookingConfig({ ...STRIPE_TEST_ENV, BOOKING_DEPOSIT_PCT: "30" });
  assert.equal(cfg.depositPct, 100);
  assert.equal(cfg.promoPct, 0);
  assert.equal(cfg.promo.mode, "direct-rate");
  assert.deepEqual(cfg.ratePlans, ["standard"]);
  assert.equal(cfg.addonsEnabled, false);
  const pub = getPublicBookingConfig(STRIPE_TEST_ENV);
  assert.equal(pub.promoEnabled, true, "owner decision 2026-10-06: the own engine honours DIRECT");
  assert.equal(pub.promoMode, "direct-rate");
  assert.equal(pub.requiresGuestDetails, true);
  assert.equal(pub.collectPostcode, true);
  assert.deepEqual(pub.acceptedCardBrands, ["visa", "mastercard"], "Thai Stripe: no Amex/JCB/UnionPay");
  assert.deepEqual(pub.testGuard, { minArrivalMonths: 12 });
  assert.equal(pub.cloudbedsWrites, "live");
  assert.equal(pub.testMode, true);
  assert.deepEqual(getInventoryConfig(STRIPE_TEST_ENV).ratePlans, ["standard"]);
  // Public config never carries secrets or the test email.
  const text = JSON.stringify(pub);
  for (const secret of ["rk_test_", "whsec_", "cbat_", TOKEN_SECRET, "owner-test@"]) assert.equal(text.includes(secret), false, secret);
});

test("stripe-test WITHOUT the Cloudbeds write key uses the MOCK writer and says so; no test guard needed", () => {
  const env: Env = { ...STRIPE_TEST_ENV, CLOUDBEDS_API_KEY_BOOKING: undefined };
  const cfg = getBookingConfig(env);
  assert.deepEqual(cfg.cloudbedsWrite, { mode: "mock" });
  assert.equal(cfg.testGuard, null);
  assert.equal(getPublicBookingConfig(env).cloudbedsWrites, "mock");
  // Real holds need real prices.
  assert.throws(() => getBookingConfig({ ...STRIPE_TEST_ENV, BOOKING_DATA_SOURCE: "demo" }), BookingConfigError);
  // The write key needs the numeric property id.
  assert.throws(() => getBookingConfig({ ...STRIPE_TEST_ENV, CLOUDBEDS_PROPERTY_ID: "" }), BookingConfigError);
});

test("stripe-mock: only with BOOKING_STRIPE_MOCK=true and never on production", () => {
  const mock = { BOOKING_PAYMENT_PROVIDER: "stripe", BOOKING_STRIPE_MOCK: "true" };
  assert.equal(resolvePaymentMode(mock), "stripe-mock");
  const cfg = getBookingConfig(mock);
  assert.equal(cfg.stripe?.mock, true);
  assert.deepEqual(cfg.cloudbedsWrite, { mode: "mock" });
  assert.equal(getPublicBookingConfig(mock).mock, true);
  assert.throws(() => resolvePaymentMode({ ...mock, VERCEL_ENV: "production" }), BookingConfigError);
  assert.throws(() => resolvePaymentMode({ BOOKING_PAYMENT_PROVIDER: "stripe" }), BookingConfigError, "no key and no mock flag");
  // Even with a booking key, mock mode never writes to Cloudbeds.
  assert.deepEqual(getBookingConfig({ ...mock, CLOUDBEDS_API_KEY_BOOKING: "cbat_w", CLOUDBEDS_PROPERTY_ID: "1" }).cloudbedsWrite, { mode: "mock" });
});

test("LIVE-LOCK MATRIX: a live key works only when EVERY condition holds", () => {
  assert.equal(LIVE_FULFILMENT_READY.stripe, true);
  assert.deepEqual(stripeLiveBlockers(STRIPE_LIVE_ENV), []);
  assert.equal(resolvePaymentMode(STRIPE_LIVE_ENV), "stripe-live");
  const cfg = getBookingConfig(STRIPE_LIVE_ENV);
  assert.equal(cfg.paymentMode, "stripe-live");
  assert.equal(cfg.stripe?.livemode, true);
  assert.equal(cfg.testGuard, null, "no test guard in live");
  assert.equal(getPublicBookingConfig(STRIPE_LIVE_ENV).live, true);

  const breakers: [string, Env][] = [
    ["allow flag missing", { BOOKING_ALLOW_LIVE_PAYMENTS: undefined }],
    ["allow flag not exactly true", { BOOKING_ALLOW_LIVE_PAYMENTS: "TRUE" }],
    ["preview deployment", { VERCEL_ENV: "preview" }],
    ["local", { VERCEL_ENV: undefined }],
    ["no Cloudbeds write key", { CLOUDBEDS_API_KEY_BOOKING: undefined }],
    ["no property id", { CLOUDBEDS_PROPERTY_ID: undefined }],
    ["bad property id", { CLOUDBEDS_PROPERTY_ID: "abc" }],
    ["no webhook secret", { STRIPE_WEBHOOK_SECRET: undefined }],
    ["webhook secret malformed", { STRIPE_WEBHOOK_SECRET: "secret" }],
    ["no Redis url", { UPSTASH_REDIS_REST_URL: undefined }],
    ["no Redis token", { UPSTASH_REDIS_REST_TOKEN: undefined }],
    ["weak token secret", { BOOKING_TOKEN_SECRET: "short" }],
    ["demo token secret", { BOOKING_TOKEN_SECRET: "msv-booking-preview-DEMO-ONLY-not-a-real-secret" }],
    ["simulated data", { BOOKING_DATA_SOURCE: "demo" }],
    ["no Cloudbeds read data at all", { CLOUDBEDS_API_KEY: undefined, CLOUDBEDS_API_KEY_BOOKING: undefined }],
    ["mock flag set", { BOOKING_STRIPE_MOCK: "true" }],
  ];
  for (const [label, patch] of breakers) {
    const env = { ...STRIPE_LIVE_ENV, ...patch };
    assert.throws(() => getBookingConfig(env), locked, label);
    assert.equal(getPublicBookingConfig(env).paymentStatus, "locked", label);
    assert.equal(getPublicBookingConfig(env).live, false, label);
  }
  // Code-level switch.
  assert.throws(() => resolvePaymentMode(STRIPE_LIVE_ENV, { liveFulfilmentReady: false }), locked);
  // The error names what is missing (server logs only).
  try {
    getBookingConfig({ ...STRIPE_LIVE_ENV, STRIPE_WEBHOOK_SECRET: undefined });
  } catch (e) {
    assert.ok(e instanceof BookingConfigError && e.missing.includes("STRIPE_WEBHOOK_SECRET"));
  }
  // Kv-only alias of the Upstash vars works too.
  const kvNames = { ...STRIPE_LIVE_ENV, UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined, KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_TOKEN: "t" };
  assert.equal(resolvePaymentMode(kvNames), "stripe-live");
});

test("Beam live stays locked whatever the env says (no Beam fulfilment)", () => {
  const env = {
    BOOKING_PAYMENT_PROVIDER: "beam",
    BEAM_API_BASE: "https://api.beamcheckout.com",
    BEAM_MERCHANT_ID: "m",
    BEAM_API_KEY: "k",
    BOOKING_ALLOW_LIVE_PAYMENTS: "true",
    VERCEL_ENV: "production",
    BOOKING_TOKEN_SECRET: TOKEN_SECRET,
    CLOUDBEDS_API_KEY: "cbat_x",
  };
  assert.throws(() => getBookingConfig(env), locked);
});

test("BOOKING_ENGINE=own: works on previews; on production only once Stripe live is fully unlocked", () => {
  assert.equal(resolveBookingEngine({ BOOKING_ENGINE: "own" }), "own");
  assert.equal(resolveBookingEngine({ BOOKING_ENGINE: "own", VERCEL_ENV: "preview" }), "own");
  assert.equal(resolveBookingEngine({ BOOKING_ENGINE: "own", VERCEL_ENV: "production" }), "cloudbeds", "demo engine never replaces /booking in production");
  assert.equal(resolveBookingEngine({ ...STRIPE_TEST_ENV, BOOKING_ENGINE: "own", VERCEL_ENV: "production" }), "cloudbeds", "test mode never replaces /booking");
  assert.equal(resolveBookingEngine({ ...STRIPE_LIVE_ENV, BOOKING_ENGINE: "own" }), "own");
  assert.equal(resolveBookingEngine({ ...STRIPE_LIVE_ENV, BOOKING_ENGINE: "own", BOOKING_ALLOW_LIVE_PAYMENTS: "false" }), "cloudbeds", "emergency stop also restores /booking");
  assert.equal(resolveBookingEngine({ ...STRIPE_LIVE_ENV, BOOKING_ENGINE: "cloudbeds" }), "cloudbeds");
  assert.equal(getPublicBookingConfig({ ...STRIPE_LIVE_ENV, BOOKING_ENGINE: "own" }).bookingPath, "/booking");
  assert.equal(getBookingConfig({ ...STRIPE_LIVE_ENV, BOOKING_ENGINE: "own" }).bookingEngine, "own");
});

test("sweep secret: BOOKING_SWEEP_SECRET or Vercel CRON_SECRET (16+ chars); otherwise the sweeper is disabled", () => {
  assert.equal(getBookingConfig(STRIPE_TEST_ENV).sweepSecret, null);
  assert.equal(getBookingConfig({ ...STRIPE_TEST_ENV, BOOKING_SWEEP_SECRET: "short" }).sweepSecret, null);
  assert.equal(getBookingConfig({ ...STRIPE_TEST_ENV, CRON_SECRET: "cron-secret-0123456789" }).sweepSecret, "cron-secret-0123456789");
});

test("emergency stop blocks NEW charges only: paid bookings still get confirmed (fulfilment config)", () => {
  const stopped = { ...STRIPE_LIVE_ENV, BOOKING_ALLOW_LIVE_PAYMENTS: "false" };
  assert.throws(() => getBookingConfig(stopped), locked, "checkout is locked");
  assert.equal(getPublicBookingConfig(stopped).paymentStatus, "locked");
  assert.equal(resolveBookingEngine({ ...stopped, BOOKING_ENGINE: "own" }), "cloudbeds");
  const f = getFulfilmentConfig(stopped);
  assert.equal(f.paymentMode, "stripe-live", "webhook/sweeper/return page keep confirming paid sessions");
  // Every other live condition still applies.
  assert.throws(() => getFulfilmentConfig({ ...stopped, STRIPE_WEBHOOK_SECRET: undefined }), locked);
  assert.throws(() => getFulfilmentConfig({ ...stopped, UPSTASH_REDIS_REST_URL: undefined }), locked);
  assert.throws(() => getFulfilmentConfig({ ...stopped, VERCEL_ENV: "preview" }), locked);
  // Non-live configs behave exactly like getBookingConfig.
  assert.equal(getFulfilmentConfig(STRIPE_TEST_ENV).paymentMode, "stripe-test");
  assert.equal(getFulfilmentConfig({}).paymentMode, "demo");
});

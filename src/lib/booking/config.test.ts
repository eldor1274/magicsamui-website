import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BEAM_LIVE_BASE,
  BEAM_PLAYGROUND_BASE,
  BookingConfigError,
  DEMO_TOKEN_SECRET,
  getBookingConfig,
  getPublicBookingConfig,
  resolveDataSource,
  resolvePaymentMode,
} from "./config.ts";
import { isAllowedHost, resolveOrigin } from "./urls.ts";

const KEYS = { BEAM_MERCHANT_ID: "m", BEAM_API_KEY: "k" };
const SECRET = { BOOKING_TOKEN_SECRET: "x".repeat(40) };

test("demo is the default payment mode", () => {
  assert.equal(resolvePaymentMode({}), "demo");
  assert.equal(resolvePaymentMode({ ...KEYS }), "demo");
  assert.equal(resolvePaymentMode({ BEAM_API_BASE: BEAM_PLAYGROUND_BASE }), "demo"); // no keys
  const cfg = getBookingConfig({});
  assert.equal(cfg.paymentMode, "demo");
  assert.equal(cfg.tokenSecret, DEMO_TOKEN_SECRET);
  assert.equal(cfg.beam, null);
  assert.equal(cfg.cardFeePct, 3);
  assert.equal(cfg.depositPct, 100);
  assert.equal(cfg.promoPct, 10);
});

test("playground needs keys + the playground base URL", () => {
  assert.equal(resolvePaymentMode({ ...KEYS, BEAM_API_BASE: BEAM_PLAYGROUND_BASE }), "beam-playground");
  assert.equal(resolvePaymentMode({ ...KEYS, BEAM_API_BASE: `${BEAM_PLAYGROUND_BASE}/` }), "beam-playground");
});

test("live mode is locked unless every condition holds", () => {
  const base = { ...KEYS, BEAM_API_BASE: BEAM_LIVE_BASE };
  const locked = [
    base,
    { ...base, BOOKING_ALLOW_LIVE_PAYMENTS: "true" },
    { ...base, VERCEL_ENV: "production" },
    { ...base, BOOKING_ALLOW_LIVE_PAYMENTS: "true", VERCEL_ENV: "preview" },
    { ...base, BOOKING_ALLOW_LIVE_PAYMENTS: "TRUE", VERCEL_ENV: "production" },
    { BEAM_API_BASE: BEAM_LIVE_BASE, BOOKING_ALLOW_LIVE_PAYMENTS: "true", VERCEL_ENV: "production" },
  ];
  for (const env of locked) {
    assert.throws(
      () => resolvePaymentMode(env),
      (e: unknown) => e instanceof BookingConfigError && e.code === "live_payments_locked",
      JSON.stringify(env),
    );
  }
  assert.equal(resolvePaymentMode({ ...base, BOOKING_ALLOW_LIVE_PAYMENTS: "true", VERCEL_ENV: "production" }), "beam-live");
});

test("unknown Beam base URLs are refused, never treated as live", () => {
  assert.throws(() => resolvePaymentMode({ ...KEYS, BEAM_API_BASE: "https://api.beamcheckout.com.evil.io" }), BookingConfigError);
});

test("beam modes require a real token secret", () => {
  const env = { ...KEYS, BEAM_API_BASE: BEAM_PLAYGROUND_BASE };
  assert.throws(
    () => getBookingConfig(env),
    (e: unknown) => e instanceof BookingConfigError && e.code === "token_secret_missing",
  );
  const cfg = getBookingConfig({ ...env, ...SECRET });
  assert.equal(cfg.paymentMode, "beam-playground");
  assert.equal(cfg.beam?.apiBase, BEAM_PLAYGROUND_BASE);
  assert.equal(cfg.tokenSecretIsDemo, false);
});

test("public config never throws and reports a lock", () => {
  const pub = getPublicBookingConfig({ ...KEYS, BEAM_API_BASE: BEAM_LIVE_BASE });
  assert.equal(pub.paymentStatus, "locked");
  assert.equal(pub.paymentMode, "demo");
  assert.equal("apiKey" in pub, false);
});

test("percent env vars are clamped and parsed", () => {
  const cfg = getBookingConfig({ BOOKING_CARD_FEE_PCT: "3.5", BOOKING_DEPOSIT_PCT: "250", BOOKING_DEMO_PROMO_PCT: "abc" });
  assert.equal(cfg.cardFeePct, 3.5);
  assert.equal(cfg.depositPct, 100);
  assert.equal(cfg.promoPct, 10);
});

test("data source: cloudbeds only with a key and not forced to demo", () => {
  assert.equal(resolveDataSource({}), "demo");
  assert.equal(resolveDataSource({ CLOUDBEDS_API_KEY: "cbat_x" }), "cloudbeds");
  assert.equal(resolveDataSource({ CLOUDBEDS_API_KEY: "cbat_x", BOOKING_DATA_SOURCE: "demo" }), "demo");
});

test("redirect origins come from the allow-list only", () => {
  assert.equal(resolveOrigin("magicsamui.com", {}), "https://magicsamui.com");
  assert.equal(resolveOrigin("WWW.MagicSamui.com", {}), "https://www.magicsamui.com");
  assert.equal(resolveOrigin("localhost:3000", {}), "http://localhost:3000");
  assert.equal(resolveOrigin("localhost:3000", { VERCEL_ENV: "preview" }), "https://magicsamui.com");
  assert.equal(resolveOrigin("evil.example.com", {}), "https://magicsamui.com");
  assert.equal(resolveOrigin("magicsamui.com.evil.io", {}), "https://magicsamui.com");
  assert.equal(resolveOrigin(null, {}), "https://magicsamui.com");
  assert.equal(
    resolveOrigin("magicsamui-website-git-preview-own-booking-beam-eldor.vercel.app", {}),
    "https://magicsamui-website-git-preview-own-booking-beam-eldor.vercel.app",
  );
  assert.equal(isAllowedHost("someone-else.vercel.app", {}), false);
  assert.equal(isAllowedHost("abc123.vercel.app", { VERCEL_URL: "abc123.vercel.app" }), true);
});

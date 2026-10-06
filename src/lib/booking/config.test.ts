import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BEAM_LIVE_BASE,
  BEAM_PLAYGROUND_BASE,
  BookingConfigError,
  DEFAULT_CARD_FEE_PCT,
  DEMO_TOKEN_SECRET,
  LIVE_FULFILMENT_READY,
  getBookingConfig,
  getPublicBookingConfig,
  resolveDataSource,
  resolvePaymentMode,
} from "./config.ts";
import { allowListedSearch, isAllowedHost, resolveOrigin, resumePaymentPath } from "./urls.ts";

const KEYS = { BEAM_MERCHANT_ID: "m", BEAM_API_KEY: "k" };
const SECRET = { BOOKING_TOKEN_SECRET: "test-only-7f3K9qLm2xVw8RtY4pZn6bHc1dJe5gUa" };

test("demo is the default payment mode", () => {
  assert.equal(resolvePaymentMode({}), "demo");
  assert.equal(resolvePaymentMode({ ...KEYS }), "demo");
  assert.equal(resolvePaymentMode({ BEAM_API_BASE: BEAM_PLAYGROUND_BASE }), "demo"); // no keys
  const cfg = getBookingConfig({});
  assert.equal(cfg.paymentMode, "demo");
  assert.equal(cfg.tokenSecret, DEMO_TOKEN_SECRET);
  assert.equal(cfg.beam, null);
  assert.equal(cfg.cardFeePct, 3);
  assert.equal(DEFAULT_CARD_FEE_PCT, 3, "owner decision 5 Oct 2026: 3% payment processing fee, not 5%");
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
  const full = { ...base, BOOKING_ALLOW_LIVE_PAYMENTS: "true", VERCEL_ENV: "production" };
  assert.equal(resolvePaymentMode(full, { liveFulfilmentReady: true }), "beam-live");
});

test("beam live mode is hard-stopped in code (no Beam fulfilment)", () => {
  assert.equal(LIVE_FULFILMENT_READY.beam, false, "Beam has no fulfilment: beam-live stays locked");
  const full = { ...KEYS, ...SECRET, BEAM_API_BASE: BEAM_LIVE_BASE, BOOKING_ALLOW_LIVE_PAYMENTS: "true", VERCEL_ENV: "production", CLOUDBEDS_API_KEY: "cbat_x" };
  assert.throws(
    () => resolvePaymentMode(full),
    (e: unknown) => e instanceof BookingConfigError && e.code === "live_payments_locked",
  );
  assert.throws(() => getBookingConfig(full), BookingConfigError);
  assert.equal(getPublicBookingConfig(full).paymentStatus, "locked");
});

test("live mode needs live Cloudbeds data", () => {
  const full = { ...KEYS, ...SECRET, BEAM_API_BASE: BEAM_LIVE_BASE, BOOKING_ALLOW_LIVE_PAYMENTS: "true", VERCEL_ENV: "production" };
  const ready = { liveFulfilmentReady: true };
  for (const env of [full, { ...full, CLOUDBEDS_API_KEY: "cbat_x", BOOKING_DATA_SOURCE: "demo" }]) {
    assert.throws(
      () => getBookingConfig(env, ready),
      (e: unknown) => e instanceof BookingConfigError && e.code === "live_payments_locked",
    );
  }
  const live = getBookingConfig({ ...full, CLOUDBEDS_API_KEY: "cbat_x" }, ready);
  assert.equal(live.paymentMode, "beam-live");
  assert.equal(live.dataSource, "cloudbeds");
  assert.equal(live.promoPct, 0, "the demo DIRECT promo never applies to real money");
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
  for (const weak of [DEMO_TOKEN_SECRET, "s".repeat(40), "short"]) {
    assert.throws(
      () => getBookingConfig({ ...env, BOOKING_TOKEN_SECRET: weak }),
      (e: unknown) => e instanceof BookingConfigError && e.code === "token_secret_missing",
      weak,
    );
  }
  const cfg = getBookingConfig({ ...env, ...SECRET });
  assert.equal(cfg.promoPct, 0, "promos are demo-only");
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
  const branch = "magicsamui-website-git-preview-own-booking-beam-eldor.vercel.app";
  assert.equal(resolveOrigin(branch, { VERCEL_BRANCH_URL: branch }), `https://${branch}`);
  // A project-name prefix alone is not ours: any Vercel account can claim it.
  assert.equal(resolveOrigin(branch, {}), "https://magicsamui.com");
  assert.equal(resolveOrigin("magicsamui-website-evil.vercel.app", {}), "https://magicsamui.com");
  assert.equal(resolveOrigin("magicsamui-website.vercel.app", {}), "https://magicsamui.com");
  assert.equal(isAllowedHost("someone-else.vercel.app", {}), false);
  assert.equal(isAllowedHost("abc123.vercel.app", { VERCEL_URL: "abc123.vercel.app" }), true);
  // Optional team-slug suffix (only our team's preview URLs end with it).
  assert.equal(isAllowedHost("magicsamui-website-abc123-eldors-team.vercel.app", { BOOKING_VERCEL_TEAM_SLUG: "eldors-team" }), true);
  assert.equal(isAllowedHost("eldors-team.vercel.app", { BOOKING_VERCEL_TEAM_SLUG: "eldors-team" }), false);
  assert.equal(isAllowedHost("x-evil.vercel.app", { BOOKING_VERCEL_TEAM_SLUG: "" }), false);
});

test("the public demo token secret is refused on production; protected previews may use it in demo mode", () => {
  assert.equal(getBookingConfig({}).tokenSecretIsDemo, true, "local demo may use the built-in secret");
  for (const VERCEL_ENV of ["preview", "development"]) {
    const cfg = getBookingConfig({ VERCEL_ENV });
    assert.equal(cfg.paymentMode, "demo");
    assert.equal(cfg.tokenSecretIsDemo, true, `${VERCEL_ENV}: demo preview works without configuring a secret`);
    assert.equal(getPublicBookingConfig({ VERCEL_ENV }).paymentStatus, "ok");
    // ...but never once Beam is switched on, even for the playground.
    assert.throws(
      () => getBookingConfig({ VERCEL_ENV, ...KEYS, BEAM_API_BASE: BEAM_PLAYGROUND_BASE }),
      (e: unknown) => e instanceof BookingConfigError && e.code === "token_secret_missing",
    );
  }
  for (const VERCEL_ENV of ["production"]) {
    assert.throws(
      () => getBookingConfig({ VERCEL_ENV }),
      (e: unknown) => e instanceof BookingConfigError && e.code === "token_secret_missing",
    );
    assert.throws(
      () => getBookingConfig({ VERCEL_ENV, BOOKING_TOKEN_SECRET: DEMO_TOKEN_SECRET }),
      (e: unknown) => e instanceof BookingConfigError && e.code === "token_secret_missing",
    );
    const cfg = getBookingConfig({ VERCEL_ENV, ...SECRET });
    assert.equal(cfg.paymentMode, "demo");
    assert.equal(cfg.tokenSecretIsDemo, false);
    assert.equal(getPublicBookingConfig({ VERCEL_ENV }).paymentStatus, "locked");
  }
});

test("address-bar cleanup keeps only allow-listed params; recovery links are unique per attempt", () => {
  assert.equal(allowListedSearch("?t=abc.def&ref=MSV-20261005-ABCD&p=x&theme=classic&paymentLinkId=pl_1&status=PAID"), "?theme=classic");
  assert.equal(allowListedSearch("?staff=1&utm_source=x&gclid=g&resume=payment"), "?staff=1&utm_source=x&gclid=g");
  assert.equal(allowListedSearch("?checkin=2026-11-10&checkout=2026-11-13"), "");
  assert.equal(allowListedSearch(""), "");
  assert.equal(resumePaymentPath("failed", "classic", "MSV-20261005-ABCD"), "/booking-preview?resume=payment&reason=failed&ref=MSV-20261005-ABCD&theme=classic");
  assert.notEqual(resumePaymentPath("unverified", undefined, "MSV-20261005-ABCD"), resumePaymentPath("unverified", undefined, "MSV-20261005-EFGH"));
  // A malformed ref is never echoed into the URL.
  assert.equal(resumePaymentPath("unverified", undefined, "<script>"), "/booking-preview?resume=payment&reason=unverified");
});

// Server-side configuration for the own booking engine. Reads secrets from the
// environment, so import it ONLY from route handlers and server components
// (the browser gets PublicBookingConfig via toPublicConfig).
//
// Safety model (non-negotiable):
// - With NO new env vars the behaviour is unchanged: provider "demo" (or the
//   legacy Beam rule), nothing is charged, nothing is reserved, and /booking
//   keeps the Cloudbeds engine (BOOKING_ENGINE defaults to "cloudbeds").
// - Provider: BOOKING_PAYMENT_PROVIDER = stripe | beam | demo.
// - Stripe test vs live comes from the key prefix (sk_/rk_ + test_/live_).
//   A live key is only ever used when EVERY condition in stripeLiveBlockers()
//   holds; anything missing throws live_payments_locked (nothing charged).
// - beam-live stays locked in code (Beam has no fulfilment).
// - stripe-test with a Cloudbeds write key writes REAL reservations, so the
//   checkout refuses holds unless the arrival is 12+ months out and the guest
//   email is BOOKING_TEST_GUEST_EMAIL (see stripeCheckout.ts).

import { site } from "../../data/site.ts";
import { acceptedCardBrands, defaultCardFeePct, isLiveMode, isTestMode, paymentMethodBadges, providerOf } from "./payments/provider.ts";
import type { PaymentMode, PaymentProvider, PromoMode, PublicBookingConfig, RatePlanId } from "./types.ts";

export const BEAM_PLAYGROUND_BASE = "https://playground.api.beamcheckout.com";
export const BEAM_LIVE_BASE = "https://api.beamcheckout.com";

/**
 * Built-in token secret for demo runs only. It is public (it is in the repo),
 * so anyone could mint tokens with it and render a fake "Payment successful"
 * page. It is therefore NEVER accepted in beam-*, stripe-test/live modes or on
 * the production deployment. It is accepted in demo and stripe-mock mode
 * locally and on Vercel preview deployments (behind deployment protection,
 * moving no money).
 */
export const DEMO_TOKEN_SECRET = "msv-booking-preview-DEMO-ONLY-not-a-real-secret";

/** Webhook secret the in-repo fake Stripe signs with (stripe-mock only; public by design). */
export const MOCK_STRIPE_WEBHOOK_SECRET = "whsec_msv_MOCK_only_not_a_real_secret";
/** API key handed to the Stripe SDK in stripe-mock mode (all calls go to the in-repo fake). */
export const MOCK_STRIPE_SECRET_KEY = "sk_test_msv_MOCK_only";

export const MERCHANT_NAME = "Magic Suites & Villas";
/** The code guests type for the direct price (default of BOOKING_PROMO_CODE). */
export const PROMO_CODE = "DIRECT";
/**
 * The promo code of Cloudbeds' "Direct booking rate" plan (live, 2026-10-06: rateID 3195765 on the
 * Honeymoon Suite, 20% off the base rate, not synced to the OTAs). Default of CLOUDBEDS_PROMO_CODE.
 */
export const DEFAULT_CLOUDBEDS_PROMO_CODE = "Direct";
export const MAX_NIGHTS = 30;
export const BOOKING_WINDOW_MONTHS = 18;
export const MAX_SEARCH_ADULTS = 18;
export const MAX_CART_ITEMS = 6;
/** Payment link / Checkout Session lifetime = how long a hold blocks the room (Stripe's minimum is 30). */
export const PAYMENT_LINK_TTL_MINUTES = 30;
/** Booking token lifetime (return page may be revisited later). */
export const TOKEN_TTL_HOURS = 48;
/**
 * Payment processing fee for beam/demo when BOOKING_CARD_FEE_PCT is unset
 * (owner decision 5 Oct 2026: 3% on Beam). Stripe uses 5% - see
 * payments/provider.ts DEFAULT_FEE_PCT_BY_PROVIDER.
 */
export const DEFAULT_CARD_FEE_PCT = 3;
/** Minimum length of BOOKING_TOKEN_SECRET wherever real payments (test or live) are possible. */
export const MIN_TOKEN_SECRET_LENGTH = 32;
/** stripe-test with REAL Cloudbeds writes: arrival must be at least this many months ahead. */
export const TEST_MODE_MIN_ARRIVAL_MONTHS = 12;
/** Minimum length of BOOKING_TEST_ACCESS_KEY (the staff key for Stage B test holds). */
export const MIN_TEST_ACCESS_KEY_LENGTH = 16;
/** Minimum length of the sweeper secret (BOOKING_SWEEP_SECRET / CRON_SECRET). */
export const MIN_SWEEP_SECRET_LENGTH = 16;
/** guestZip sent when the guest leaves the postcode empty (WI-0: confirm Cloudbeds accepts it). */
export const DEFAULT_GUEST_ZIP_PLACEHOLDER = "00000";
/** postReservation paymentMethod enum (Cloudbeds v1.3). */
const RESERVATION_PAYMENT_METHODS = ["cash", "credit", "ebanking", "pay_pal"] as const;
export type ReservationPaymentMethod = (typeof RESERVATION_PAYMENT_METHODS)[number];

/**
 * Code-level switch per provider: is there fulfilment that turns a paid
 * session into a confirmed Cloudbeds reservation?
 * - stripe: yes (hold-first + webhook/return-page fulfil + sweeper).
 * - beam: no (its webhook only logs), so beam-live stays refused whatever the
 *   environment says.
 */
export const LIVE_FULFILMENT_READY: Record<"beam" | "stripe", boolean> = { beam: false, stripe: true };

export type Env = Record<string, string | undefined>;

export type BookingConfigErrorCode = "live_payments_locked" | "token_secret_missing" | "invalid_beam_base" | "payment_misconfigured";

export class BookingConfigError extends Error {
  readonly code: BookingConfigErrorCode;
  /** Non-secret names of what is missing (server logs only - never shown to guests). */
  readonly missing: string[];
  constructor(code: BookingConfigErrorCode, message: string, missing: string[] = []) {
    super(message);
    this.name = "BookingConfigError";
    this.code = code;
    this.missing = missing;
  }
}

export interface BeamCredentials {
  apiBase: string;
  merchantId: string;
  apiKey: string;
}

export interface StripeSettings {
  /** Secret or restricted key (MOCK_STRIPE_SECRET_KEY in stripe-mock). */
  secretKey: string;
  /** whsec_... (MOCK_STRIPE_WEBHOOK_SECRET in stripe-mock); null when not configured (test mode only). */
  webhookSecret: string | null;
  livemode: boolean;
  mock: boolean;
  /** Checkout allowed_payment_method_types filter; null = account defaults (dynamic). */
  allowedPaymentMethodTypes: string[] | null;
}

export type CloudbedsWriteSettings =
  | { mode: "live"; apiKey: string; propertyId: string }
  | { mode: "mock" };

export interface RedisSettings {
  url: string;
  token: string;
}

export interface BookingConfig {
  provider: PaymentProvider;
  paymentMode: PaymentMode;
  dataSource: "demo" | "cloudbeds";
  tokenSecret: string;
  tokenSecretIsDemo: boolean;
  beam: BeamCredentials | null;
  /** Base64 HMAC key from Lighthouse (webhook signature), if configured. */
  beamWebhookHmacKey: string | null;
  /**
   * Read-side Cloudbeds access (availability). baseRateOnly (Stripe): only the
   * base (BAR) row is sold, never another rate plan under the Standard label.
   */
  cloudbeds: { apiKey: string; propertyId: string | null; baseRateOnly: boolean } | null;
  /** Stripe modes only. */
  stripe: StripeSettings | null;
  /** Stripe modes only: where reservations are written. */
  cloudbedsWrite: CloudbedsWriteSettings | null;
  /** Upstash Redis (lock + idempotency markers); null = in-memory (refused in live). */
  redis: RedisSettings | null;
  /**
   * stripe-test with real Cloudbeds writes: the guard settings. A hold needs
   * the test guest email AND the staff access cookie (BOOKING_TEST_ACCESS_KEY,
   * see /api/booking/test-access) AND an arrival minArrivalMonths ahead.
   */
  testGuard: { guestEmail: string | null; minArrivalMonths: number; accessKey: string | null } | null;
  cardFeePct: number;
  depositPct: number;
  /** The demo's site-side DIRECT percentage; 0 outside demo mode (where Cloudbeds' own Direct rate is sold instead). */
  promoPct: number;
  /** How the guest's promo code works here (resolvePromoSettings). */
  promo: PromoSettings;
  ratePlans: RatePlanId[];
  addonsEnabled: boolean;
  /**
   * postPayment `type`: the exact `method` value of the property's custom Stripe payment method
   * (see resolveCloudbedsPaymentMethod). null = not usable: checkouts with real Cloudbeds writes are refused.
   */
  cloudbedsPaymentMethod: string | null;
  /** Why cloudbedsPaymentMethod is null (names the env var); null when it is usable. */
  cloudbedsPaymentMethodProblem: string | null;
  /** postReservation sourceID (CLOUDBEDS_SOURCE_ID, a fee-free primary source); null = Cloudbeds' default source. */
  cloudbedsSourceId: string | null;
  /** postReservation paymentMethod for the hold. */
  reservationPaymentMethod: ReservationPaymentMethod;
  /** putReservation sendStatusChangeEmail on confirm (Stage B test 12 decides). */
  sendCloudbedsStatusEmail: boolean;
  guestZipPlaceholder: string;
  bookingEngine: BookingEngine;
  /** Bearer secret for /api/booking/sweep (BOOKING_SWEEP_SECRET, or Vercel's CRON_SECRET). */
  sweepSecret: string | null;
  /** Where operational alerts go (sendSiteMail; our own address only). */
  alertEmail: string;
  /** True on the production deployment (VERCEL_ENV=production). */
  production: boolean;
}

export interface ModeOptions {
  /** Overrides LIVE_FULFILMENT_READY. Tests only - never pass it from app code. */
  liveFulfilmentReady?: boolean;
}

function trimmed(v: string | undefined): string {
  return (v ?? "").trim();
}

/** Parses a percentage env var, clamped to [min, max]; falls back on garbage. */
export function parsePct(raw: string | undefined, fallback: number, min: number, max: number): number {
  const s = trimmed(raw);
  if (s === "") return fallback;
  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;
  // Two decimals at most so satang arithmetic stays exact (basis points).
  const rounded = Math.round(n * 100) / 100;
  return Math.min(max, Math.max(min, rounded));
}

/* ------------------------------ provider ------------------------------ */

/**
 * BOOKING_PAYMENT_PROVIDER = stripe | beam | demo. Unset keeps the legacy
 * rule (beam when BEAM_API_BASE is set, else demo) so existing deployments
 * behave exactly as before.
 */
export function resolveProvider(env: Env): PaymentProvider {
  const raw = trimmed(env.BOOKING_PAYMENT_PROVIDER).toLowerCase();
  if (raw === "") return trimmed(env.BEAM_API_BASE) !== "" ? "beam" : "demo";
  if (raw === "stripe" || raw === "beam" || raw === "demo") return raw;
  throw new BookingConfigError("payment_misconfigured", "BOOKING_PAYMENT_PROVIDER must be stripe, beam or demo.", [
    "BOOKING_PAYMENT_PROVIDER",
  ]);
}

/** "test" | "live" from a Stripe secret/restricted key prefix; null when it is not a Stripe key. */
export function stripeKeyKind(key: string): "test" | "live" | null {
  if (/^(sk|rk)_test_[A-Za-z0-9_]{8,}$/.test(key)) return "test";
  if (/^(sk|rk)_live_[A-Za-z0-9_]{8,}$/.test(key)) return "live";
  return null;
}

/**
 * Every bearer secret the sweeper accepts: BOOKING_SWEEP_SECRET (the droplet
 * cron) AND Vercel's CRON_SECRET (a vercel.json cron), each when set and long
 * enough. Empty = the sweeper is disabled.
 */
export function sweepSecretsOf(env: Env): string[] {
  return [...new Set([trimmed(env.BOOKING_SWEEP_SECRET), trimmed(env.CRON_SECRET)])].filter((s) => s.length >= MIN_SWEEP_SECRET_LENGTH);
}

/** The first accepted sweeper secret (BOOKING_SWEEP_SECRET, else CRON_SECRET), or null when none is usable. */
export function sweepSecretOf(env: Env): string | null {
  return sweepSecretsOf(env)[0] ?? null;
}

/** Upstash Redis REST settings from either naming the Vercel integration uses. */
export function resolveRedis(env: Env): RedisSettings | null {
  const url = trimmed(env.UPSTASH_REDIS_REST_URL) || trimmed(env.KV_REST_API_URL);
  const token = trimmed(env.UPSTASH_REDIS_REST_TOKEN) || trimmed(env.KV_REST_API_TOKEN);
  return /^https:\/\/\S+$/.test(url) && token !== "" ? { url, token } : null;
}

/** True when a token secret is long, not the public demo secret, and not trivially repetitive. */
export function isStrongTokenSecret(secret: string): boolean {
  return secret.length >= MIN_TOKEN_SECRET_LENGTH && secret !== DEMO_TOKEN_SECRET && new Set(secret).size >= 10;
}

/** Read key for availability: the existing read key, else the booking key (which also has read scopes). */
function cloudbedsReadKey(env: Env): string {
  return trimmed(env.CLOUDBEDS_API_KEY) || trimmed(env.CLOUDBEDS_API_KEY_BOOKING);
}

export function resolveDataSource(env: Env): "demo" | "cloudbeds" {
  return cloudbedsReadKey(env) !== "" && env.BOOKING_DATA_SOURCE !== "demo" ? "cloudbeds" : "demo";
}

/**
 * Everything that must hold before a LIVE Stripe key may be used. Returns the
 * (non-secret) names of the missing conditions; empty = live allowed.
 */
export function stripeLiveBlockers(env: Env, options: ModeOptions = {}): string[] {
  const missing: string[] = [];
  if (trimmed(env.BOOKING_PAYMENT_PROVIDER).toLowerCase() !== "stripe") missing.push("BOOKING_PAYMENT_PROVIDER=stripe");
  if (stripeKeyKind(trimmed(env.STRIPE_SECRET_KEY)) !== "live") missing.push("STRIPE_SECRET_KEY (sk_live_/rk_live_)");
  if (env.BOOKING_ALLOW_LIVE_PAYMENTS !== "true") missing.push("BOOKING_ALLOW_LIVE_PAYMENTS=true");
  if (env.VERCEL_ENV !== "production") missing.push("VERCEL_ENV=production");
  if (trimmed(env.CLOUDBEDS_API_KEY_BOOKING) === "") missing.push("CLOUDBEDS_API_KEY_BOOKING");
  if (!/^\d{1,12}$/.test(trimmed(env.CLOUDBEDS_PROPERTY_ID))) missing.push("CLOUDBEDS_PROPERTY_ID");
  if (!/^whsec_\S{8,}$/.test(trimmed(env.STRIPE_WEBHOOK_SECRET))) missing.push("STRIPE_WEBHOOK_SECRET");
  if (resolveRedis(env) === null) missing.push("Upstash Redis (UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN)");
  if (!isStrongTokenSecret(trimmed(env.BOOKING_TOKEN_SECRET))) missing.push("BOOKING_TOKEN_SECRET (32+ random characters)");
  if (resolveDataSource(env) !== "cloudbeds") missing.push("live Cloudbeds data (Cloudbeds key set, BOOKING_DATA_SOURCE not 'demo')");
  if (env.BOOKING_STRIPE_MOCK === "true") missing.push("BOOKING_STRIPE_MOCK must not be 'true'");
  // The sweeper is the only recovery for lost holds once Stripe stops retrying: it must be callable.
  if (sweepSecretOf(env) === null) missing.push("BOOKING_SWEEP_SECRET or CRON_SECRET (16+ characters)");
  if (!(options.liveFulfilmentReady ?? LIVE_FULFILMENT_READY.stripe)) missing.push("LIVE_FULFILMENT_READY (code)");
  return missing;
}

function resolveBeamMode(env: Env, options: ModeOptions): PaymentMode {
  const base = trimmed(env.BEAM_API_BASE).replace(/\/+$/, "");
  const hasKeys = trimmed(env.BEAM_MERCHANT_ID) !== "" && trimmed(env.BEAM_API_KEY) !== "";

  if (base === BEAM_LIVE_BASE) {
    const allowed = hasKeys && env.BOOKING_ALLOW_LIVE_PAYMENTS === "true" && env.VERCEL_ENV === "production";
    if (!allowed) {
      throw new BookingConfigError(
        "live_payments_locked",
        "BEAM_API_BASE points at the live Beam API but live payments are not fully enabled " +
          "(needs BEAM_MERCHANT_ID, BEAM_API_KEY, BOOKING_ALLOW_LIVE_PAYMENTS=true and VERCEL_ENV=production).",
      );
    }
    if (!(options.liveFulfilmentReady ?? LIVE_FULFILMENT_READY.beam)) {
      throw new BookingConfigError(
        "live_payments_locked",
        "Live Beam payments are switched off in code (LIVE_FULFILMENT_READY.beam=false): Beam has no fulfilment, " +
          "so a real payment could not be turned into a reservation. Use BOOKING_PAYMENT_PROVIDER=stripe.",
      );
    }
    return "beam-live";
  }
  if (base === BEAM_PLAYGROUND_BASE && hasKeys) return "beam-playground";
  if (base !== "" && base !== BEAM_PLAYGROUND_BASE) {
    throw new BookingConfigError("invalid_beam_base", "BEAM_API_BASE is not a recognised Beam API base URL.");
  }
  return "demo";
}

function resolveStripeMode(env: Env, options: ModeOptions): PaymentMode {
  const key = trimmed(env.STRIPE_SECRET_KEY);
  if (key === "") {
    if (env.BOOKING_STRIPE_MOCK === "true" && env.VERCEL_ENV !== "production") return "stripe-mock";
    throw new BookingConfigError(
      "payment_misconfigured",
      "BOOKING_PAYMENT_PROVIDER=stripe but STRIPE_SECRET_KEY is not set (set BOOKING_STRIPE_MOCK=true for the local mock; never on production).",
      ["STRIPE_SECRET_KEY"],
    );
  }
  const kind = stripeKeyKind(key);
  if (kind === null) {
    throw new BookingConfigError("payment_misconfigured", "STRIPE_SECRET_KEY is not a Stripe secret or restricted key.", ["STRIPE_SECRET_KEY"]);
  }
  if (kind === "test") return "stripe-test";
  const missing = stripeLiveBlockers(env, options);
  if (missing.length > 0) {
    throw new BookingConfigError(
      "live_payments_locked",
      `A live Stripe key is configured but live payments are locked. Missing: ${missing.join("; ")}.`,
      missing,
    );
  }
  return "stripe-live";
}

/**
 * Derives the payment mode. Throws BookingConfigError when a live API is
 * configured without every live-mode condition, or the config is invalid.
 */
export function resolvePaymentMode(env: Env, options: ModeOptions = {}): PaymentMode {
  const provider = resolveProvider(env);
  if (provider === "demo") return "demo";
  if (provider === "beam") return resolveBeamMode(env, options);
  return resolveStripeMode(env, options);
}

/* --------------------------- booking engine --------------------------- */

export type BookingEngine = "own" | "cloudbeds";

/**
 * What /booking renders (BOOKING_ENGINE = own | cloudbeds, default cloudbeds).
 * On the production deployment "own" only takes effect when live payments
 * are fully unlocked (stripe-live): the public /booking page must never show a
 * demo, test-mode or locked engine. Otherwise it stays on Cloudbeds.
 */
export function resolveBookingEngine(env: Env = process.env): BookingEngine {
  if (trimmed(env.BOOKING_ENGINE).toLowerCase() !== "own") return "cloudbeds";
  if (env.VERCEL_ENV !== "production") return "own";
  try {
    return isLiveMode(resolvePaymentMode(env)) && providerOf(resolvePaymentMode(env)) === "stripe" ? "own" : "cloudbeds";
  } catch {
    return "cloudbeds";
  }
}

/** Path of the own booking page (and its /return) for this deployment. */
export function bookingBasePath(engine: BookingEngine): string {
  return engine === "own" ? "/booking" : "/booking-preview";
}

/* ------------------------------- config ------------------------------- */

/**
 * The demo's site-side DIRECT discount: only while payments are simulated.
 * Real money uses Cloudbeds' own Direct rate plan instead (resolvePromoSettings).
 */
function promoPctFor(env: Env, paymentMode: PaymentMode | null): number {
  return paymentMode === "demo" ? parsePct(env.BOOKING_DEMO_PROMO_PCT, 10, 0, 50) : 0;
}

export interface PromoSettings {
  mode: PromoMode;
  /** The code guests type (BOOKING_PROMO_CODE, default DIRECT), upper case; compared trimmed and case-insensitively. */
  code: string;
  /** discount: the demo's percentage; 0 otherwise. */
  pct: number;
  /** direct-rate: Cloudbeds' promo code (CLOUDBEDS_PROMO_CODE, default "Direct"), sent as is and matched case-insensitively. */
  cloudbedsCode: string;
}

const GUEST_PROMO_CODE_RE = /^[A-Z0-9_-]{1,32}$/;
const CLOUDBEDS_PROMO_CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * BOOKING_DIRECT_PROMO = on | off (default on): whether the own engine sells Cloudbeds' Direct
 * rate for the guest's code. "off" (or false/0/no) is the emergency switch when Cloudbeds does not
 * price holds at the Direct rate; guests with the code are then pointed to the classic booking page.
 */
export function directPromoOn(env: Env = process.env): boolean {
  const raw = trimmed(env.BOOKING_DIRECT_PROMO).toLowerCase();
  if (["off", "false", "0", "no"].includes(raw)) return false;
  if (!["", "on", "true", "1", "yes"].includes(raw)) configWarning("BOOKING_DIRECT_PROMO", "not on/off: treated as on");
  return true;
}

/**
 * How the guest's promo code works (see PromoMode). Stripe sells Cloudbeds' own Direct rate plan
 * (direct-rate) only with live Cloudbeds rates and BOOKING_DIRECT_PROMO on; otherwise a Stripe page
 * points the code to the classic booking page (classic-only). The demo keeps its site-side % discount;
 * Beam modes take no code (off). Never throws.
 */
export function resolvePromoSettings(env: Env, provider: PaymentProvider, paymentMode: PaymentMode | null, dataSource: "demo" | "cloudbeds"): PromoSettings {
  const rawCode = trimmed(env.BOOKING_PROMO_CODE).toUpperCase();
  if (rawCode !== "" && !GUEST_PROMO_CODE_RE.test(rawCode)) configWarning("BOOKING_PROMO_CODE", "not 1-32 letters, digits, - or _: DIRECT is used");
  const code = GUEST_PROMO_CODE_RE.test(rawCode) ? rawCode : PROMO_CODE;
  const rawCb = trimmed(env.CLOUDBEDS_PROMO_CODE);
  if (rawCb !== "" && !CLOUDBEDS_PROMO_CODE_RE.test(rawCb)) configWarning("CLOUDBEDS_PROMO_CODE", "not 1-32 letters, digits, - or _: Direct is used");
  const cloudbedsCode = CLOUDBEDS_PROMO_CODE_RE.test(rawCb) ? rawCb : DEFAULT_CLOUDBEDS_PROMO_CODE;
  const pct = promoPctFor(env, paymentMode);
  let mode: PromoMode;
  if (provider === "stripe") mode = dataSource === "cloudbeds" && directPromoOn(env) ? "direct-rate" : "classic-only";
  else mode = pct > 0 ? "discount" : "off";
  return { mode, code, pct: mode === "discount" ? pct : 0, cloudbedsCode };
}

/**
 * True while the DIRECT copy ("Best rate, always - Code DIRECT at checkout", the best-rate meta
 * descriptions) must be swapped out: the own engine serves /booking (BOOKING_ENGINE=own) but does
 * NOT honour the code with Cloudbeds' Direct rate (BOOKING_DIRECT_PROMO=off, or no live Cloudbeds
 * rates). While it honours DIRECT it shows the same copy as the classic engine; with the default
 * engine nothing changes.
 */
export function directCopySwapped(env: Env = process.env): boolean {
  if (resolveBookingEngine(env) !== "own") return false;
  return resolvePromoSettings(env, safeProvider(env), safePaymentMode(env), resolveDataSource(env)).mode !== "direct-rate";
}

function safePaymentMode(env: Env): PaymentMode | null {
  try {
    return resolvePaymentMode(env);
  } catch {
    return null;
  }
}

function safeProvider(env: Env): PaymentProvider {
  try {
    return resolveProvider(env);
  } catch {
    return "demo";
  }
}

function ratePlansFor(provider: PaymentProvider): RatePlanId[] {
  // Cloudbeds prices only its own rate plans: the synthetic Breakfast plan
  // and add-on would make the hold's grandTotal differ from the quote.
  return provider === "stripe" ? ["standard"] : ["standard", "breakfast"];
}

function cardFeeFor(env: Env, provider: PaymentProvider): number {
  return parsePct(env.BOOKING_CARD_FEE_PCT, defaultCardFeePct(provider), 0, 10);
}

function depositFor(env: Env, provider: PaymentProvider): number {
  // Stripe: always 100% up front (the folio is settled in one payment).
  return provider === "stripe" ? 100 : parsePct(env.BOOKING_DEPOSIT_PCT, 100, 1, 100);
}

/**
 * Cloudbeds' built-in payment methods (getPaymentMethods `method` and `code` values). Stripe money
 * recorded under one of them would be filed as cash, PayPal, a transfer...; "credit" also needs a
 * cardType, so postPayment would refuse it. Only the property's own custom method is accepted.
 */
const BUILT_IN_PAYMENT_METHODS = new Set(["credit", "cards", "cash", "bank_transfer", "ebanking", "pay_pal", "debit", "check", "check_true", "bill"]);
/** 1-64 characters, no whitespace, no control or invisible format characters (custom codes carry punctuation, e.g. "Stripe(website)"). */
const PAYMENT_METHOD_RE = /^[^\s\p{Cc}\p{Cf}]{1,64}$/u;
const COPY_METHOD_HINT =
  "Copy the exact 'method' value that scripts/cloudbeds-wi0-check.mjs prints for the custom Stripe payment method (case included) and redeploy.";

/**
 * postPayment `type` for Stripe money. stripe-live: CLOUDBEDS_STRIPE_PAYMENT_METHOD only. Otherwise
 * CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD when set (an invalid one is a problem: it never falls through to
 * the live method), else CLOUDBEDS_STRIPE_PAYMENT_METHOD. The value is kept exactly (case included);
 * there is no default. An unusable value is reported as `problem`, never thrown, so fulfilment,
 * release and the sweeper keep loading the config; checkout refuses instead (stripeCheckout.ts).
 * Deliberately NOT a live-lock condition: stripeLiveBlockers also gates the fulfilment and drain
 * configs, and holds must still be released while the value is fixed. Method values are not secrets.
 */
export function resolveCloudbedsPaymentMethod(env: Env, paymentMode: PaymentMode): { method: string | null; problem: string | null } {
  const name =
    paymentMode !== "stripe-live" && trimmed(env.CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD) !== ""
      ? "CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD"
      : "CLOUDBEDS_STRIPE_PAYMENT_METHOD";
  const value = trimmed(env[name]);
  if (value === "") return { method: null, problem: `${name} is not set, so Stripe payments can't be recorded in Cloudbeds. ${COPY_METHOD_HINT}` };
  const shown = JSON.stringify(value.slice(0, 80));
  if (!PAYMENT_METHOD_RE.test(value)) {
    return { method: null, problem: `${name} ${shown} is not a Cloudbeds payment method value (1-64 characters, no spaces). ${COPY_METHOD_HINT}` };
  }
  if (BUILT_IN_PAYMENT_METHODS.has(value.toLowerCase())) {
    return {
      method: null,
      problem: `${name} ${shown} is a Cloudbeds built-in method: Stripe money must be recorded under the property's own custom Stripe method. ${COPY_METHOD_HINT}`,
    };
  }
  return { method: value, problem: null };
}

/** A PRIMARY source id: s-{id} (v1.3 spec) or s-{id}-1 (Reservation FAQ). Never a third-party ss- source. */
const SOURCE_ID_RE = /^s-\d{1,12}(-1)?$/;

const warnedConfig = new Set<string>();

/** An optional value that is set but unusable: logged once per process, by NAME only (never the value). */
function configWarning(name: string, reason: string): void {
  if (warnedConfig.has(name)) return;
  warnedConfig.add(name);
  console.warn("[booking] config_warning", JSON.stringify({ name, reason }));
}

/**
 * postReservation sourceID: a primary source the owner created for the own booking page with NO
 * taxes or fees (Cloudbeds applies taxes/fees per source). null = unset or unusable: Cloudbeds then
 * files the hold under its default "Website / Booking engine" source, whose fees make the price
 * check refuse the hold. Not a live-lock condition.
 */
export function resolveCloudbedsSourceId(env: Env): string | null {
  const raw = trimmed(env.CLOUDBEDS_SOURCE_ID);
  if (raw === "") return null;
  if (SOURCE_ID_RE.test(raw)) return raw;
  configWarning("CLOUDBEDS_SOURCE_ID", "not a primary source id (s-<number> or s-<number>-1): ignored, holds get Cloudbeds' default source");
  return null;
}

const STRIPE_METHOD_TYPES_DEFAULT = ["card", "promptpay"];

function allowedMethodTypes(env: Env): string[] | null {
  const raw = trimmed(env.STRIPE_PAYMENT_METHOD_TYPES).toLowerCase();
  if (raw === "dynamic") return null;
  if (raw === "") return STRIPE_METHOD_TYPES_DEFAULT;
  const list = raw.split(",").map((s) => s.trim()).filter((s) => /^[a-z_]{2,40}$/.test(s));
  return list.length > 0 ? list : STRIPE_METHOD_TYPES_DEFAULT;
}

/** Full server config. Throws BookingConfigError on unsafe configuration. */
export function getBookingConfig(env: Env = process.env, options: ModeOptions = {}): BookingConfig {
  const provider = resolveProvider(env);
  const paymentMode = resolvePaymentMode(env, options);
  const dataSource = resolveDataSource(env);
  const production = trimmed(env.VERCEL_ENV) === "production";

  // Real money is only ever charged at real (Cloudbeds) prices for real availability.
  if (paymentMode === "beam-live" && dataSource !== "cloudbeds") {
    throw new BookingConfigError(
      "live_payments_locked",
      "Live payments need live Cloudbeds availability (CLOUDBEDS_API_KEY set and BOOKING_DATA_SOURCE not 'demo').",
    );
  }

  const bookingKey = trimmed(env.CLOUDBEDS_API_KEY_BOOKING);
  const propertyId = trimmed(env.CLOUDBEDS_PROPERTY_ID);
  let cloudbedsWrite: CloudbedsWriteSettings | null = null;
  if (provider === "stripe") {
    if (paymentMode !== "stripe-mock" && bookingKey !== "") {
      if (!/^\d{1,12}$/.test(propertyId)) {
        throw new BookingConfigError("payment_misconfigured", "CLOUDBEDS_PROPERTY_ID (numeric) is required with CLOUDBEDS_API_KEY_BOOKING.", [
          "CLOUDBEDS_PROPERTY_ID",
        ]);
      }
      cloudbedsWrite = { mode: "live", apiKey: bookingKey, propertyId };
    } else {
      cloudbedsWrite = { mode: "mock" };
    }
    if (cloudbedsWrite.mode === "live" && dataSource !== "cloudbeds") {
      throw new BookingConfigError(
        "payment_misconfigured",
        "Real Cloudbeds reservations need real Cloudbeds prices: BOOKING_DATA_SOURCE must not be 'demo' when CLOUDBEDS_API_KEY_BOOKING is set.",
        ["BOOKING_DATA_SOURCE"],
      );
    }
    // Real Cloudbeds writes (test keys too) need the shared lock: the webhook, the return page and
    // the sweeper run on different serverless instances, and an in-memory lock would let a
    // duplicate postPayment or fee line reach a real folio.
    if (cloudbedsWrite.mode === "live" && resolveRedis(env) === null) {
      throw new BookingConfigError(
        "payment_misconfigured",
        "Real Cloudbeds reservations (CLOUDBEDS_API_KEY_BOOKING) need Upstash Redis for the fulfilment lock, also with Stripe test keys.",
        ["Upstash Redis (UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN)"],
      );
    }
  }

  const secret = trimmed(env.BOOKING_TOKEN_SECRET);
  const relaxedSecret = (paymentMode === "demo" || paymentMode === "stripe-mock") && !production;
  if (!relaxedSecret && !isStrongTokenSecret(secret)) {
    throw new BookingConfigError(
      "token_secret_missing",
      "BOOKING_TOKEN_SECRET (32+ random characters, not the built-in demo secret) is required on the production deployment " +
        "and whenever Beam or Stripe test/live payments are enabled.",
      ["BOOKING_TOKEN_SECRET"],
    );
  }
  // Local demo/mock only: an unset secret falls back to the public built-in one.
  const tokenSecretIsDemo = secret === "";

  const beam: BeamCredentials | null =
    provider !== "beam" || paymentMode === "demo"
      ? null
      : {
          apiBase: paymentMode === "beam-live" ? BEAM_LIVE_BASE : BEAM_PLAYGROUND_BASE,
          merchantId: trimmed(env.BEAM_MERCHANT_ID),
          apiKey: trimmed(env.BEAM_API_KEY),
        };

  let stripe: StripeSettings | null = null;
  if (provider === "stripe") {
    const mock = paymentMode === "stripe-mock";
    const webhook = trimmed(env.STRIPE_WEBHOOK_SECRET);
    stripe = {
      secretKey: mock ? MOCK_STRIPE_SECRET_KEY : trimmed(env.STRIPE_SECRET_KEY),
      webhookSecret: mock ? MOCK_STRIPE_WEBHOOK_SECRET : webhook === "" ? null : webhook,
      livemode: paymentMode === "stripe-live",
      mock,
      allowedPaymentMethodTypes: allowedMethodTypes(env),
    };
  }

  const hmac = trimmed(env.BEAM_WEBHOOK_HMAC_KEY);
  const readKey = cloudbedsReadKey(env);
  const testGuardEmail = trimmed(env.BOOKING_TEST_GUEST_EMAIL).toLowerCase();
  const testAccessKey = trimmed(env.BOOKING_TEST_ACCESS_KEY);
  const reservationMethod = trimmed(env.CLOUDBEDS_RESERVATION_PAYMENT_METHOD) as ReservationPaymentMethod;
  // Outside live, CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD (a separate test method) keeps test money out of the real one.
  const paymentMethod = resolveCloudbedsPaymentMethod(env, paymentMode);
  const zip = trimmed(env.BOOKING_GUEST_ZIP_PLACEHOLDER);
  const alertEmail = trimmed(env.BOOKING_ALERT_EMAIL);
  const promo = resolvePromoSettings(env, provider, paymentMode, dataSource);

  return {
    provider,
    paymentMode,
    dataSource,
    tokenSecret: tokenSecretIsDemo ? DEMO_TOKEN_SECRET : secret,
    tokenSecretIsDemo,
    beam,
    beamWebhookHmacKey: hmac === "" ? null : hmac,
    cloudbeds: dataSource === "cloudbeds" ? { apiKey: readKey, propertyId: propertyId || null, baseRateOnly: provider === "stripe" } : null,
    stripe,
    cloudbedsWrite,
    redis: resolveRedis(env),
    testGuard:
      paymentMode === "stripe-test" && cloudbedsWrite?.mode === "live"
        ? {
            guestEmail: testGuardEmail === "" ? null : testGuardEmail,
            minArrivalMonths: TEST_MODE_MIN_ARRIVAL_MONTHS,
            accessKey: testAccessKey.length >= MIN_TEST_ACCESS_KEY_LENGTH ? testAccessKey : null,
          }
        : null,
    cardFeePct: cardFeeFor(env, provider),
    depositPct: depositFor(env, provider),
    promoPct: promo.pct,
    promo,
    ratePlans: ratePlansFor(provider),
    addonsEnabled: provider !== "stripe",
    cloudbedsPaymentMethod: paymentMethod.method,
    cloudbedsPaymentMethodProblem: paymentMethod.problem,
    cloudbedsSourceId: resolveCloudbedsSourceId(env),
    reservationPaymentMethod: RESERVATION_PAYMENT_METHODS.includes(reservationMethod) ? reservationMethod : "credit",
    sendCloudbedsStatusEmail: env.CLOUDBEDS_SEND_STATUS_EMAIL === "true",
    guestZipPlaceholder: /^[A-Za-z0-9 -]{1,12}$/.test(zip) ? zip : DEFAULT_GUEST_ZIP_PLACEHOLDER,
    bookingEngine: resolveBookingEngine(env),
    sweepSecret: sweepSecretOf(env),
    alertEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alertEmail) ? alertEmail : site.email,
    production,
  };
}

/**
 * Config for finishing payments ALREADY TAKEN (Stripe webhook, sweeper, return
 * page status, abandon). The emergency stop BOOKING_ALLOW_LIVE_PAYMENTS=false
 * must block NEW charges only - never the confirmation (or release) of
 * bookings guests have already paid or started. So when the only thing
 * locking a live Stripe config is that flag, this returns the live config
 * anyway; every other live condition (keys, webhook secret, Redis, ...) still
 * applies. Checkout must keep using getBookingConfig.
 */
export function getFulfilmentConfig(env: Env = process.env, options: ModeOptions = {}): BookingConfig {
  try {
    return getBookingConfig(env, options);
  } catch (e) {
    const liveKey = stripeKeyKind(trimmed(env.STRIPE_SECRET_KEY)) === "live";
    if (e instanceof BookingConfigError && e.code === "live_payments_locked" && liveKey && env.BOOKING_ALLOW_LIVE_PAYMENTS !== "true") {
      const unlocked = { ...env, BOOKING_ALLOW_LIVE_PAYMENTS: "true" };
      if (stripeLiveBlockers(unlocked, options).length === 0) return getBookingConfig(unlocked, options);
    }
    throw e;
  }
}

/**
 * DRAIN config: Stripe sessions already started must still be confirmed or
 * released after BOOKING_PAYMENT_PROVIDER is switched away from stripe (to
 * beam or demo). When the provider is no longer stripe but Stripe credentials
 * are still set, this returns the Stripe fulfilment config (as if the
 * provider were stripe) for the webhook, sweeper, return page and abandon
 * endpoints - never for checkout. null when the provider is stripe (the normal
 * config covers it), no Stripe key is set, or that config is not valid.
 */
export function getStripeDrainConfig(env: Env = process.env, options: ModeOptions = {}): BookingConfig | null {
  try {
    if (resolveProvider(env) === "stripe") return null;
  } catch {
    // An invalid provider value: still try to drain Stripe.
  }
  if (stripeKeyKind(trimmed(env.STRIPE_SECRET_KEY)) === null) return null;
  try {
    return getFulfilmentConfig({ ...env, BOOKING_PAYMENT_PROVIDER: "stripe", BOOKING_ENGINE: "cloudbeds" }, options);
  } catch {
    return null;
  }
}

/**
 * True while this deployment FINISHES live Stripe payments (the fulfilment
 * config, or the drain config after a provider switch, is stripe-live) - also
 * during an emergency stop, when new checkouts are locked. The soft-launch
 * return page (/booking-preview/return) stays measured then, so the purchases
 * of bookings already paid still reach GA4. Never throws.
 */
export function finishesLiveStripePayments(env: Env = process.env): boolean {
  try {
    if (getFulfilmentConfig(env).paymentMode === "stripe-live") return true;
  } catch {
    // locked or not Stripe: see the drain config
  }
  return getStripeDrainConfig(env)?.paymentMode === "stripe-live";
}

function publicFields(provider: PaymentProvider, paymentMode: PaymentMode, env: Env) {
  const stripe = provider === "stripe";
  const engine = resolveBookingEngine(env);
  return {
    provider,
    live: isLiveMode(paymentMode),
    testMode: isTestMode(paymentMode),
    mock: paymentMode === "stripe-mock",
    requiresGuestDetails: stripe,
    collectPostcode: stripe,
    ratePlans: ratePlansFor(provider),
    addonsEnabled: !stripe,
    acceptedCardBrands: acceptedCardBrands(provider),
    paymentMethods: paymentMethodBadges(provider),
    holdMinutes: PAYMENT_LINK_TTL_MINUTES,
    sendsBookingConfirmationEmail: stripe && env.CLOUDBEDS_SEND_STATUS_EMAIL === "true",
    bookingPath: bookingBasePath(engine),
    classicBookingPath: engine === "own" ? "/booking/classic" : "/booking",
    whatsappUrl: site.whatsapp,
    merchantName: MERCHANT_NAME,
    maxNights: MAX_NIGHTS,
    bookingWindowMonths: BOOKING_WINDOW_MONTHS,
    maxSearchAdults: MAX_SEARCH_ADULTS,
  };
}

/** The promo fields the browser reads: whether a code can change the price, how it works, and the code to suggest. */
function publicPromo(promo: PromoSettings): Pick<PublicBookingConfig, "promoEnabled" | "promoMode" | "promoCode"> {
  return { promoEnabled: promo.mode === "direct-rate" || (promo.mode === "discount" && promo.pct > 0), promoMode: promo.mode, promoCode: promo.code };
}

export function toPublicConfig(config: BookingConfig, env: Env = process.env): PublicBookingConfig {
  return {
    ...publicFields(config.provider, config.paymentMode, env),
    paymentMode: config.paymentMode,
    paymentStatus: "ok",
    dataSource: config.dataSource,
    cardFeePct: config.cardFeePct,
    depositPct: config.depositPct,
    ...publicPromo(config.promo),
    cloudbedsWrites: config.cloudbedsWrite?.mode ?? "none",
    testGuard: config.testGuard ? { minArrivalMonths: config.testGuard.minArrivalMonths } : null,
  };
}

/**
 * Never throws: on an unsafe payment configuration it reports
 * paymentStatus "locked" (and demo-shaped values) so pages can still render
 * a clear message plus the WhatsApp fallback instead of crashing.
 */
export function getPublicBookingConfig(env: Env = process.env): PublicBookingConfig {
  try {
    return toPublicConfig(getBookingConfig(env), env);
  } catch {
    const provider = safeProvider(env);
    return {
      ...publicFields(provider, "demo", env),
      live: false,
      paymentMode: "demo",
      paymentStatus: "locked",
      dataSource: resolveDataSource(env),
      cardFeePct: cardFeeFor(env, provider),
      depositPct: depositFor(env, provider),
      // Same rule the availability API applies (getInventoryConfig).
      ...publicPromo(resolvePromoSettings(env, provider, safePaymentMode(env), resolveDataSource(env))),
      cloudbedsWrites: "none",
      testGuard: null,
    };
  }
}

/** Inventory + pricing settings only; never throws (availability works even when payments are locked). */
export function getInventoryConfig(
  env: Env = process.env,
): Pick<BookingConfig, "dataSource" | "cloudbeds" | "promoPct" | "promo" | "ratePlans" | "provider"> {
  const dataSource = resolveDataSource(env);
  const provider = safeProvider(env);
  const promo = resolvePromoSettings(env, provider, safePaymentMode(env), dataSource);
  return {
    dataSource,
    provider,
    cloudbeds:
      dataSource === "cloudbeds"
        ? { apiKey: cloudbedsReadKey(env), propertyId: trimmed(env.CLOUDBEDS_PROPERTY_ID) || null, baseRateOnly: provider === "stripe" }
        : null,
    promoPct: promo.pct,
    promo,
    ratePlans: ratePlansFor(provider),
  };
}

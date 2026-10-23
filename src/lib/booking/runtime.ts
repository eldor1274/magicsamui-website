// Builds the Stripe-mode and Beam-mode dependencies for route handlers and
// server pages (server only): Stripe client, Cloudbeds writer, KV store,
// alerts, logging; for Beam (design S4.5) also Beam's settings, its fetch, the
// 429 counter and the caller's deadline (BeamGatewayDeps). getProviderDeps and
// getFulfilmentProviderDeps hand them out with the provider's PaymentGateway,
// so status and abandon pick them by the booking's provider.
//
// - stripe-live: real Stripe, real Cloudbeds writer, Upstash Redis (config
//   refuses live without Redis), alerts by email.
// - stripe-test: real Stripe (test keys); real Cloudbeds writer only when
//   CLOUDBEDS_API_KEY_BOOKING is set (guarded; config then requires Redis),
//   otherwise the MOCK writer with Redis if configured, else an in-memory
//   store with a loud warning.
// - stripe-mock: the in-repo fakes for Stripe AND Cloudbeds plus an in-memory
//   store, kept on globalThis so they survive dev-server module reloads.
//   Nothing leaves the process.
// - beam-playground / beam-live: as Stripe's test and live modes (the live
//   writer needs Redis), except that a Beam mode with the MOCK writer (local
//   runs only: config refuses it wherever VERCEL_ENV is set) always uses the
//   in-memory store, never Redis (money review 10). The Beam gateway the routes
//   get (beamGatewayOf) loads the Beam client (beam.ts) only when it calls Beam:
//   this file is loaded by the abandon, sweep and Stripe webhook routes, which
//   never load beam.ts through a static import (importGraph.test.ts).
// Building any of these deps writes nothing and logs nothing (a drain logs
// once that it is draining).

import { after } from "next/server";
import { site } from "../../data/site.ts";
import { sendSiteMail } from "../siteMail.ts";
import { getBeamDrainConfig, getFulfilmentConfig, getStripeDrainConfig } from "./config.ts";
import type { BookingConfig } from "./config.ts";
import { cloudbedsRestrictions } from "./cloudbedsProvider.ts";
import type { PromoRestrictionInput } from "./cloudbedsProvider.ts";
import { createCloudbedsWriter } from "./cloudbedsWrite.ts";
import type { CloudbedsWriter } from "./cloudbedsWrite.ts";
import { createMemoryKv } from "./kv.ts";
import type { KvStore } from "./kv.ts";
import { createUpstashKv } from "./kvUpstash.ts";
import { BEAM_RECORD_TTL_SECONDS, beamKeyOf, keyScope, keys, linkIdOf, parseBeamHoldIdentifier } from "./lock.ts";
import { ALERT_MAIL_TIMEOUT_MS, alertEmailEnabled, alertSubjectPrefix, createAlerter } from "./alerts.ts";
import { createFakeCloudbeds, mockHoldPricer } from "./mock/fakeCloudbeds.ts";
import type { FakeCloudbeds } from "./mock/fakeCloudbeds.ts";
import { createFakeStripe } from "./mock/fakeStripe.ts";
import type { FakeStripe } from "./mock/fakeStripe.ts";
import type { BeamGateway, BeamGatewayDeps } from "./payments/beamGateway.ts";
import { isBeamLinkId } from "./payments/beamIds.ts";
import { beamGatewayText } from "./payments/beamText.ts";
import { createStripeClient } from "./payments/stripe.ts";
import type { StripeClient } from "./payments/stripe.ts";
import { stripeGateway } from "./payments/stripeGateway.ts";
import { logEvent } from "./routeUtils.ts";
import type { AlertFn, ProviderDeps, ProviderDepsFn, StripeDeps } from "./stripeDeps.ts";

interface MockWorld {
  stripe: FakeStripe;
  cloudbeds: FakeCloudbeds;
  kv: KvStore;
}

interface RuntimeGlobals {
  mock?: MockWorld;
  memoryKv?: KvStore;
  mockWriterCloudbeds?: FakeCloudbeds;
  redisKv?: { url: string; kv: KvStore };
  warnedMemory?: boolean;
  warnedDrain?: boolean;
  warnedBeamDrain?: boolean;
  /** Test hook: Beam's fetch for every Beam deps built here (tests: the in-repo fake Beam). Unset: the global fetch. */
  beamFetch?: typeof fetch;
}

const g = globalThis as typeof globalThis & { __msvBookingRuntime?: RuntimeGlobals };
const globals: RuntimeGlobals = (g.__msvBookingRuntime ??= {});

/** The stripe-mock world (fake Stripe + fake Cloudbeds + memory KV), created once per process. */
export function mockWorld(config: BookingConfig): MockWorld {
  if (!globals.mock) {
    globals.mock = {
      stripe: createFakeStripe({ webhookSecret: config.stripe?.webhookSecret ?? "whsec_mock" }),
      // pricer: BOOKING_MOCK_HOLD_PRICE_DELTA_BAHT (read per hold) lets the price_changed path be clicked through.
      cloudbeds: createFakeCloudbeds({ lenient: true, pricer: mockHoldPricer(process.env) }),
      kv: createMemoryKv(),
    };
  }
  return globals.mock;
}

function kvFor(config: BookingConfig): KvStore {
  if (config.paymentMode === "stripe-mock") return mockWorld(config).kv;
  // A Beam mode with the mock writer never uses Redis, set or not: every Vercel deployment shares the production
  // Redis, and fake holds must never reach its index (money review 10). It is a local run (config refuses it
  // wherever VERCEL_ENV is set), so the in-memory store is what it is meant to use: no warning.
  if (config.beam && config.cloudbedsWrite?.mode !== "live") return (globals.memoryKv ??= createMemoryKv());
  if (config.redis) {
    if (!globals.redisKv || globals.redisKv.url !== config.redis.url) globals.redisKv = { url: config.redis.url, kv: createUpstashKv(config.redis) };
    return globals.redisKv.kv;
  }
  // config already refuses both of these
  if (config.paymentMode === "stripe-live" || config.cloudbedsWrite?.mode === "live") throw new Error("Redis is required with real Cloudbeds writes");
  if (!globals.warnedMemory) {
    globals.warnedMemory = true;
    console.warn(
      "[booking] WARNING: no Upstash Redis configured - the fulfilment lock and idempotency markers are IN MEMORY (per instance). " +
        "Acceptable for Stripe test mode only; live mode refuses to run without Redis.",
    );
  }
  return (globals.memoryKv ??= createMemoryKv());
}

function writerFor(config: BookingConfig): CloudbedsWriter {
  const w = config.cloudbedsWrite;
  if (w?.mode === "live") return createCloudbedsWriter({ apiKey: w.apiKey, propertyId: w.propertyId, mode: "live", log: logEvent });
  // MOCK writer: the in-repo fake, lenient so a webhook on another instance still succeeds.
  const fake = config.paymentMode === "stripe-mock" ? mockWorld(config).cloudbeds : (globals.mockWriterCloudbeds ??= createFakeCloudbeds({ lenient: true }));
  return createCloudbedsWriter({ apiKey: "mock", propertyId: "0", mode: "mock", fetchImpl: fake.fetch, budget: null, log: logEvent });
}

function stripeFor(config: BookingConfig): StripeClient {
  const s = config.stripe;
  if (!s) throw new Error("not a Stripe mode");
  return s.mock ? createStripeClient(s.secretKey, { fetchImpl: mockWorld(config).stripe.fetch }) : createStripeClient(s.secretKey);
}

/**
 * Operational alerts: email in live mode (or when BOOKING_ALERTS_IN_TEST=true),
 * log lines otherwise. Never guest PII. Delivery rules (retry on failure,
 * critical alerts stored until delivered, sent after the response) live in
 * alerts.ts.
 */
function alerterFor(config: BookingConfig, kv: KvStore): AlertFn {
  return createAlerter({
    kv,
    log: logEvent,
    emailEnabled: alertEmailEnabled(config.paymentMode, process.env),
    subjectPrefix: alertSubjectPrefix(config.paymentMode),
    footer: `Mode: ${config.paymentMode}. Sent by ${site.domain} booking engine.`,
    scope: keyScope(config.paymentMode),
    send: (mail) =>
      sendSiteMail({ to: config.alertEmail, subject: mail.subject, text: mail.text, fromName: "Magic Suites Booking Engine", timeoutMs: ALERT_MAIL_TIMEOUT_MS }),
    // After the response (still within the route's maxDuration): a slow mail relay never stalls a checkout or a webhook.
    // Outside a request scope after() throws and the alerter sends inline instead.
    defer: (task) => after(task),
  });
}

/** The live restriction check (getRatePlans) while availability is Cloudbeds', else nothing (CoreDeps.restrictions). */
function restrictionsFor(config: BookingConfig): Pick<StripeDeps, "restrictions"> {
  const cloudbeds = config.cloudbeds;
  return cloudbeds && config.dataSource === "cloudbeds"
    ? {
        restrictions: (roomTypeId: string, rateId: string | null, checkIn: string, checkOut: string, adults: number, promo?: PromoRestrictionInput | null) =>
          cloudbedsRestrictions(
            roomTypeId,
            rateId,
            checkIn,
            checkOut,
            adults,
            { apiKey: cloudbeds.apiKey, propertyId: cloudbeds.propertyId, budgetWaitMs: 3_000 },
            promo ?? null,
          ),
      }
    : {};
}

/** Stripe-mode dependencies, or null outside the Stripe modes. */
export function getStripeDeps(config: BookingConfig): StripeDeps | null {
  if (!config.stripe) return null;
  const kv = kvFor(config);
  return {
    config,
    stripe: stripeFor(config),
    writer: writerFor(config),
    kv,
    alert: alerterFor(config, kv),
    log: logEvent,
    ...restrictionsFor(config),
  };
}

/** HTTP 429 answers from Beam within one hour (keys.beamRateLimited, a fixed window) that tell the owner (money review 13). */
export const BEAM_RATE_LIMIT_ALERT_COUNT = 20;
const BEAM_RATE_LIMIT_WINDOW_SECONDS = 3600;

/**
 * BeamGatewayDeps.onRateLimited: counts every 429 in keys.beamRateLimited (per mode scope, one-hour window) and
 * tells the owner once, at the BEAM_RATE_LIMIT_ALERT_COUNT-th (alert key 'beam-rate-limited'; the alerter keeps
 * repeats out for 6 hours). Best effort: a failed count is dropped and never breaks the Beam call (beam.ts calls
 * it synchronously). Inside a request after() keeps the count alive past the response; outside one it just runs.
 */
function beamRateLimitCounter(config: BookingConfig, kv: KvStore, alert: AlertFn): () => void {
  const key = keys.beamRateLimited(keyScope(config.paymentMode));
  const count = async (): Promise<void> => {
    const n = await kv.incr(key, BEAM_RATE_LIMIT_WINDOW_SECONDS);
    if (n !== BEAM_RATE_LIMIT_ALERT_COUNT) return;
    await alert(
      "Beam is rate-limiting the booking engine",
      [
        `${n} requests were answered 429 in the last hour. Return pages may show 'couldn't check the payment just now'; webhooks and the sweeper still confirm bookings. Ask Beam for the limits if this repeats.`,
      ],
      { key: "beam-rate-limited", severity: "warning" },
    );
  };
  return () => {
    const task = count().catch(() => undefined);
    try {
      after(() => task);
    } catch {
      // Outside a request scope: the count runs on its own.
    }
  };
}

/** The caller's time limit for every Beam call (BeamGatewayDeps.deadlineMs and its clock): the route's, or the sweeper run's. */
export type BeamTiming = Pick<BeamGatewayDeps, "deadlineMs" | "clock">;

/**
 * Beam-mode dependencies (BeamGatewayDeps), or null outside the Beam modes: the KV store, writer, alerter and
 * restriction check as for Stripe, plus config.beam, Beam's fetch (the beamFetch test hook, else the global
 * fetch), the 429 counter and `timing` (the route's or the sweeper run's deadline and its clock; absent: beam.ts's
 * own budgets). nonce and sleep stay at their defaults. Building them writes nothing and logs nothing.
 */
export function getBeamDeps(config: BookingConfig, timing: BeamTiming = {}): BeamGatewayDeps | null {
  const beam = config.beam;
  if (!beam) return null;
  const kv = kvFor(config);
  const alert = alerterFor(config, kv);
  const fetchImpl = globals.beamFetch;
  return {
    config,
    beam,
    writer: writerFor(config),
    kv,
    alert,
    log: logEvent,
    ...restrictionsFor(config),
    ...(fetchImpl ? { fetchImpl } : {}),
    onRateLimited: beamRateLimitCounter(config, kv, alert),
    ...(timing.deadlineMs !== undefined ? { deadlineMs: timing.deadlineMs } : {}),
    ...(timing.clock ? { clock: timing.clock } : {}),
  };
}

/** What idOf throws for a key that is not a Beam payment key: missing, as a 404 is (the real gateway's BeamApiError 404). */
class NotABeamKeyError extends Error {
  constructor() {
    super("Not a Beam payment key");
    this.name = "NotABeamKeyError";
  }
}

/**
 * The Beam gateway (payments/beamGateway.ts) for deps built here, loading the Beam client only once it calls Beam.
 * This file is loaded by the abandon, sweep and Stripe webhook routes, which must never load beam.ts through a
 * static import (importGraph.test.ts): every member that calls Beam (get, cancel, sweepRecent, releaseGuard,
 * readLink), and isGone (asked only after a Beam call), imports payments/beamGateway.ts on first use and runs the
 * real gateway's; the members used without a
 * call are the real gateway's own values, taken from modules that do not load beam.ts (keyOf, parseHoldId and
 * doneTtlSeconds from lock.ts, isPaymentId from payments/beamIds.ts, text from payments/beamText.ts). Building it
 * loads nothing.
 */
function beamGatewayOf(deps: BeamGatewayDeps): BeamGateway {
  let loading: Promise<BeamGateway> | null = null;
  let loaded: BeamGateway | null = null;
  const real = (): Promise<BeamGateway> =>
    (loading ??= import("./payments/beamGateway.ts").then(
      (m) => (loaded = m.beamGateway(deps)),
      (e: unknown) => {
        // A failed load is tried again by the next call.
        loading = null;
        throw e;
      },
    ));
  return {
    provider: "beam",
    brand: "Beam",
    keyOf: beamKeyOf,
    idOf(key) {
      const linkId = linkIdOf(key);
      if (linkId === null) throw new NotABeamKeyError();
      return linkId;
    },
    get: async (key) => (await real()).get(key),
    cancel: async (key) => (await real()).cancel(key),
    // Every error of a Beam call comes after the load; before it only idOf throws.
    isMissing: (e) => e instanceof NotABeamKeyError || (loaded !== null && loaded.isMissing(e)),
    sweepRecent: async (sinceMs) => (await real()).sweepRecent(sinceMs),
    text: beamGatewayText(deps.beam),
    doneTtlSeconds: BEAM_RECORD_TTL_SECONDS,
    async releaseGuard(key) {
      const gw = await real();
      return gw.releaseGuard ? gw.releaseGuard(key) : false;
    },
    async isGone(key) {
      const gw = await real();
      return gw.isGone ? gw.isGone(key) : false;
    },
    parseHoldId: parseBeamHoldIdentifier,
    isPaymentId: isBeamLinkId,
    readLink: async (key) => (await real()).readLink(key),
  };
}

/**
 * Dependencies for FINISHING Stripe payments (webhook, sweeper, return page,
 * abandon): the normal fulfilment config's, or - when BOOKING_PAYMENT_PROVIDER
 * was switched away from stripe - the drain config's, so in-flight sessions
 * are still confirmed or released. null when Stripe is not configured at all.
 * Never use this for checkout.
 */
export function getStripeFulfilmentDeps(env: Record<string, string | undefined> = process.env): StripeDeps | null {
  let config: BookingConfig | null = null;
  try {
    config = getFulfilmentConfig(env);
  } catch {
    config = null;
  }
  const normal = config ? getStripeDeps(config) : null;
  if (normal) return normal;
  const drain = getStripeDrainConfig(env);
  if (!drain) return null;
  if (!globals.warnedDrain) {
    globals.warnedDrain = true;
    logEvent("stripe_drain_mode", { mode: drain.paymentMode });
  }
  return getStripeDeps(drain);
}

/**
 * Dependencies for FINISHING Beam payments (Beam webhook, sweeper, return
 * page, abandon), the mirror of getStripeFulfilmentDeps: the fulfilment
 * config's when it is a Beam mode (its beam-live branch included: emergency
 * stop, no Cloudbeds email), else the Beam drain config's (getBeamDrainConfig:
 * BOOKING_PAYMENT_PROVIDER switched away from beam), logging beam_drain_mode
 * once. null when Beam is not configured (a beam-live drain also needs
 * LIVE_FULFILMENT_READY.beam, true since S7.1, and every fulfilment condition).
 * `timing`: getBeamDeps'. Never use this for checkout.
 */
export function getBeamFulfilmentDeps(env: Record<string, string | undefined> = process.env, timing: BeamTiming = {}): BeamGatewayDeps | null {
  let config: BookingConfig | null = null;
  try {
    config = getFulfilmentConfig(env);
  } catch {
    config = null;
  }
  const normal = config ? getBeamDeps(config, timing) : null;
  if (normal) return normal;
  const drain = getBeamDrainConfig(env);
  if (!drain) return null;
  if (!globals.warnedBeamDrain) {
    globals.warnedBeamDrain = true;
    logEvent("beam_drain_mode", { mode: drain.paymentMode });
  }
  return getBeamDeps(drain, timing);
}

/**
 * The active config's deps with its provider's gateway (Stripe: getStripeDeps; Beam: getBeamDeps with `timing`,
 * and the Beam gateway), or null (demo). Building them writes nothing and logs nothing.
 */
export function getProviderDeps(config: BookingConfig, timing: BeamTiming = {}): ProviderDeps | null {
  const deps = getStripeDeps(config);
  if (deps) return { deps, gw: stripeGateway(deps) };
  const beam = getBeamDeps(config, timing);
  return beam ? { deps: beam, gw: beamGatewayOf(beam) } : null;
}

/**
 * Deps for FINISHING one provider's payments (return page, abandon), with its
 * gateway. Stripe: getStripeFulfilmentDeps (the normal config's, else the
 * drain config's). Beam: getBeamFulfilmentDeps (likewise, with `timing`).
 * null when that provider is not configured. Never use this for checkout.
 */
export function getFulfilmentProviderDeps(
  env: Record<string, string | undefined>,
  provider: ProviderDeps["gw"]["provider"],
  timing: BeamTiming = {},
): ProviderDeps | null {
  if (provider === "beam") {
    const beam = getBeamFulfilmentDeps(env, timing);
    return beam ? { deps: beam, gw: beamGatewayOf(beam) } : null;
  }
  if (provider !== "stripe") return null;
  const deps = getStripeFulfilmentDeps(env);
  return deps ? { deps, gw: stripeGateway(deps) } : null;
}

/**
 * providerDeps for the status and abandon routes and the return page's server
 * render: the active config's deps, built at once (as the routes always did),
 * for its own provider; any other provider's fulfilment deps (its drain) are
 * built only when a booking of that provider asks for them. `timing` bounds
 * every Beam call (Stripe ignores it).
 */
export function providerDepsFor(config: BookingConfig, env: Record<string, string | undefined> = process.env, timing: BeamTiming = {}): ProviderDepsFn {
  const active = getProviderDeps(config, timing);
  return (provider) => (active && active.gw.provider === provider ? active : getFulfilmentProviderDeps(env, provider, timing));
}

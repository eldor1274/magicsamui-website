// Builds the Stripe-mode dependencies for route handlers and server pages
// (server only): Stripe client, Cloudbeds writer, KV store, alerts, logging.
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

import { after } from "next/server";
import { site } from "../../data/site.ts";
import { sendSiteMail } from "../siteMail.ts";
import { getFulfilmentConfig, getStripeDrainConfig } from "./config.ts";
import type { BookingConfig } from "./config.ts";
import { cloudbedsRestrictions } from "./cloudbedsProvider.ts";
import type { PromoRestrictionInput } from "./cloudbedsProvider.ts";
import { createCloudbedsWriter } from "./cloudbedsWrite.ts";
import type { CloudbedsWriter } from "./cloudbedsWrite.ts";
import { createMemoryKv } from "./kv.ts";
import type { KvStore } from "./kv.ts";
import { createUpstashKv } from "./kvUpstash.ts";
import { keyScope } from "./lock.ts";
import { ALERT_MAIL_TIMEOUT_MS, createAlerter } from "./alerts.ts";
import { createFakeCloudbeds, mockHoldPricer } from "./mock/fakeCloudbeds.ts";
import type { FakeCloudbeds } from "./mock/fakeCloudbeds.ts";
import { createFakeStripe } from "./mock/fakeStripe.ts";
import type { FakeStripe } from "./mock/fakeStripe.ts";
import { createStripeClient } from "./payments/stripe.ts";
import type { StripeClient } from "./payments/stripe.ts";
import { logEvent } from "./routeUtils.ts";
import type { AlertFn, StripeDeps } from "./stripeDeps.ts";

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
    emailEnabled: config.paymentMode === "stripe-live" || process.env.BOOKING_ALERTS_IN_TEST === "true",
    subjectPrefix: config.paymentMode === "stripe-live" ? "" : `[${config.paymentMode}] `,
    footer: `Mode: ${config.paymentMode}. Sent by ${site.domain} booking engine.`,
    scope: keyScope(config.paymentMode),
    send: (mail) =>
      sendSiteMail({ to: config.alertEmail, subject: mail.subject, text: mail.text, fromName: "Magic Suites Booking Engine", timeoutMs: ALERT_MAIL_TIMEOUT_MS }),
    // After the response (still within the route's maxDuration): a slow mail relay never stalls a checkout or a webhook.
    // Outside a request scope after() throws and the alerter sends inline instead.
    defer: (task) => after(task),
  });
}

/** Stripe-mode dependencies, or null outside the Stripe modes. */
export function getStripeDeps(config: BookingConfig): StripeDeps | null {
  if (!config.stripe) return null;
  const kv = kvFor(config);
  const cloudbeds = config.cloudbeds;
  return {
    config,
    stripe: stripeFor(config),
    writer: writerFor(config),
    kv,
    alert: alerterFor(config, kv),
    log: logEvent,
    ...(cloudbeds && config.dataSource === "cloudbeds"
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
      : {}),
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

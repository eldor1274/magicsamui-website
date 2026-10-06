// Shared fixtures for the Stripe/Cloudbeds tests (not a test file itself).
// Builds a full StripeDeps from the in-repo fakes so tests exercise the real
// SDK, the real Cloudbeds writer and the real fulfil/release code paths.

import { createAlerter } from "./alerts.ts";
import { POLICY_VERSION } from "./catalogue.ts";
import { runCheckout } from "./checkout.ts";
import type { CheckoutDeps } from "./checkout.ts";
import { cloudbedsRestrictions } from "./cloudbedsProvider.ts";
import { createCloudbedsWriter } from "./cloudbedsWrite.ts";
import { getBookingConfig } from "./config.ts";
import type { BookingConfig, Env } from "./config.ts";
import type { GuestDetails } from "./guest.ts";
import { createMemoryKv } from "./kv.ts";
import type { KvStore } from "./kv.ts";
import { keyScope } from "./lock.ts";
import { createFakeCloudbeds } from "./mock/fakeCloudbeds.ts";
import type { FakeCloudbedsOptions, FakeRoomType } from "./mock/fakeCloudbeds.ts";
import { createFakeStripe } from "./mock/fakeStripe.ts";
import { createStripeClient } from "./payments/stripe.ts";
import type { StripeDeps } from "./stripeDeps.ts";
import { testAccessCookieValue } from "./testAccess.ts";
import type { CartItemInput, CheckoutRequest, CheckoutResponse, CheckoutSuccess, Quote } from "./types.ts";

export const TOKEN_SECRET = "test-only-7f3K9qLm2xVw8RtY4pZn6bHc1dJe5gUa";
export const WEBHOOK_SECRET = "whsec_testkit_0123456789abcdef";
export const TEST_EMAIL = "owner-test@example.com";
export const TEST_ACCESS_KEY = "stage-b-staff-key-0123456789";
/** 10:00 Bangkok, 5 Oct 2026. */
export const NOW = Date.parse("2026-10-05T03:00:00Z");
export const ORIGIN = "https://magicsamui.com";
/** 13 months ahead: passes the stripe-test 12-month guard. */
export const FAR_CHECKIN = "2027-11-10";
export const FAR_CHECKOUT = "2027-11-13";

export const STRIPE_TEST_ENV: Env = {
  BOOKING_PAYMENT_PROVIDER: "stripe",
  STRIPE_SECRET_KEY: "rk_test_testkit0123456789",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  BOOKING_TOKEN_SECRET: TOKEN_SECRET,
  CLOUDBEDS_API_KEY: "cbat_read_testkit",
  CLOUDBEDS_API_KEY_BOOKING: "cbat_write_testkit",
  CLOUDBEDS_PROPERTY_ID: "235064",
  BOOKING_TEST_GUEST_EMAIL: TEST_EMAIL,
  BOOKING_TEST_ACCESS_KEY: TEST_ACCESS_KEY,
  // The owner's custom Cloudbeds method, exactly as getPaymentMethods lists it (the fake's postPayment refuses others).
  CLOUDBEDS_STRIPE_PAYMENT_METHOD: "Stripe(website)",
  // Real Cloudbeds writes need the shared lock (the kit itself uses an in-memory store).
  UPSTASH_REDIS_REST_URL: "https://example-redis.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "token-testkit",
};

export const STRIPE_LIVE_ENV: Env = {
  ...STRIPE_TEST_ENV,
  STRIPE_SECRET_KEY: "rk_live_testkit0123456789",
  BOOKING_ALLOW_LIVE_PAYMENTS: "true",
  VERCEL_ENV: "production",
  BOOKING_SWEEP_SECRET: "sweep-secret-testkit-0123456789",
};

/** Fake property: a few real room type ids with nightly baht rates. */
export const ROOM_TYPES: Record<string, FakeRoomType> = {
  "462958": { rate: 9000, rateId: "rate-hm", units: 1 }, // honeymoon-suite
  "462961": { rate: 3000, rateId: "rate-gs", units: 1 }, // garden-suite
  "462960": { rate: 4500.5, rateId: "rate-sr", units: 1 }, // sunrise-suite (satang edge)
  "462964": { rate: 6000, rateId: "rate-sv2", units: 1, minLos: 5 }, // seaview-2br (min stay 5)
};

export const GUEST: GuestDetails = {
  firstName: "Test",
  lastName: "Owner",
  country: "TH",
  email: TEST_EMAIL,
  dialCode: "+66",
  phone: "95 246 6011",
  postcode: "84320",
  arrivalTime: "15:00",
  specialRequests: "Late dinner please",
  agreedToPolicy: true,
};

export interface Kit {
  config: BookingConfig;
  fakeStripe: ReturnType<typeof createFakeStripe>;
  fakeCb: ReturnType<typeof createFakeCloudbeds>;
  deps: StripeDeps;
  /** Alerts that were DELIVERED (through the real alerter: dedupe, retry, critical store). */
  alerts: { subject: string; lines: string[]; severity: string }[];
  /** Set false to make alert mail fail (alert delivery tests). */
  mail: { ok: boolean; attempts: number };
  logs: { message: string; data?: Record<string, unknown> }[];
  /** Everything logged, as one string (PII checks). */
  logText(): string;
  checkoutDeps(): CheckoutDeps;
  now: { ms: number };
}

export function makeKit(options: { env?: Env; cb?: FakeCloudbedsOptions; livemode?: boolean; kv?: KvStore; now?: { ms: number } } = {}): Kit {
  const now = options.now ?? { ms: NOW };
  const env = options.env ?? STRIPE_TEST_ENV;
  const config = getBookingConfig(env);
  const fakeStripe = createFakeStripe({
    webhookSecret: config.stripe?.webhookSecret ?? WEBHOOK_SECRET,
    now: () => now.ms,
    livemode: options.livemode ?? config.paymentMode === "stripe-live",
    // Like the real thing: the hosted page lives on checkout.stripe.com.
    checkoutUrl: (s) => `https://checkout.stripe.com/c/pay/${s.id}`,
  });
  const fakeCb = createFakeCloudbeds({ roomTypes: ROOM_TYPES, createdStatus: "confirmed", now: () => now.ms, ...options.cb });
  const alerts: Kit["alerts"] = [];
  const logs: Kit["logs"] = [];
  const log = (message: string, data?: Record<string, unknown>) => logs.push({ message, data });
  const writer = createCloudbedsWriter({
    apiKey: "cbat_write_testkit",
    propertyId: "235064",
    mode: config.cloudbedsWrite?.mode === "live" ? "live" : "mock",
    fetchImpl: fakeCb.fetch,
    budget: null,
    log,
    sleep: async () => undefined,
  });
  // Two kits may share one store (a Stage B and a live deployment on the same Redis).
  const kv = options.kv ?? createMemoryKv(() => now.ms);
  const mail = { ok: true, attempts: 0 };
  const alert = createAlerter({
    kv,
    log,
    emailEnabled: true,
    subjectPrefix: "",
    footer: "",
    scope: keyScope(config.paymentMode),
    now: () => now.ms,
    send: async (m) => {
      mail.attempts++;
      if (!mail.ok) return false;
      const parsed = /^\[Booking (\w+)\] ([\s\S]*)$/.exec(m.subject);
      alerts.push({ subject: parsed?.[2] ?? m.subject, lines: m.text.split("\n").slice(0, -2), severity: parsed?.[1] ?? "warning" });
      return true;
    },
  });
  const deps: StripeDeps = {
    config,
    stripe: createStripeClient(config.stripe?.secretKey ?? "sk_test_x", { fetchImpl: fakeStripe.fetch }),
    writer,
    kv,
    alert,
    log,
    restrictions: (roomTypeId, rateId, checkIn, checkOut, adults, promo) =>
      cloudbedsRestrictions(roomTypeId, rateId, checkIn, checkOut, adults, { apiKey: "cbat_read_testkit", propertyId: "235064", fetchImpl: fakeCb.fetch }, promo ?? null),
    now: () => now.ms,
  };
  return {
    config,
    fakeStripe,
    fakeCb,
    deps,
    alerts,
    mail,
    logs,
    logText: () => JSON.stringify(logs),
    checkoutDeps: () => ({
      config,
      origin: ORIGIN,
      nowMs: now.ms,
      fetchImpl: fakeCb.fetch,
      log,
      stripe: deps,
      nonce: () => "nonce",
      // The Stage B staff cookie (only checked when the test guard is active).
      testAccessToken: config.testGuard?.accessKey ? testAccessCookieValue(config.tokenSecret, config.testGuard.accessKey) : null,
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
    }),
    now,
  };
}

export function request(items: CartItemInput[], extra: Partial<CheckoutRequest> = {}): CheckoutRequest & { guest: GuestDetails } {
  return {
    checkIn: FAR_CHECKIN,
    checkOut: FAR_CHECKOUT,
    items,
    expectedTotalSatang: 0,
    expectedDueNowSatang: 0,
    // The terms version the booking page showed (Stripe modes refuse any other).
    termsVersion: POLICY_VERSION,
    guest: GUEST,
    ...extra,
  } as CheckoutRequest & { guest: GuestDetails };
}

export const HONEYMOON: CartItemInput[] = [{ slug: "honeymoon-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];

/** The server's quote for a cart (asks with a wrong total, reads the price_changed answer). */
export async function serverQuote(kit: Kit, req: CheckoutRequest): Promise<Quote> {
  const res = await runCheckout({ ...req, expectedTotalSatang: 1, expectedDueNowSatang: 1 }, kit.checkoutDeps());
  if (res.body.ok || res.body.error !== "price_changed" || !res.body.quote) throw new Error(`no quote: ${JSON.stringify(res.body)}`);
  return res.body.quote;
}

/** Runs a checkout at the correct (server) price. */
export async function checkout(kit: Kit, items: CartItemInput[] = HONEYMOON, extra: Partial<CheckoutRequest> = {}): Promise<{ status: number; body: CheckoutResponse }> {
  const req = request(items, extra);
  const quote = await serverQuote(kit, req);
  return runCheckout({ ...req, expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang }, kit.checkoutDeps());
}

export function sessionIdOf(body: CheckoutResponse): string {
  const ok = body as CheckoutSuccess;
  if (!ok.ok) throw new Error(`checkout failed: ${JSON.stringify(body)}`);
  const id = new URL(ok.redirectUrl).pathname.split("/").pop();
  if (!id) throw new Error("no session id in the redirect URL");
  return id;
}

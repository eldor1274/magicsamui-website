// Shared fixtures for the Beam tests (not a test file itself; design S4.1). testkit.ts is left as it is (the
// golden snapshot imports it): makeBeamKit mirrors makeKit with the in-repo fake Beam (mock/fakeBeam.ts) in
// place of the fake Stripe, the fake Cloudbeds with the property's custom 'Beam(website)' payment method added,
// a memory KV and the real alerter, Cloudbeds writer and Beam gateway (payments/beamGateway.ts). Nothing leaves
// the process.
//
// beamCheckout runs the real Beam checkout (beamCheckout.ts startBeamCheckout: the hold-first core with
// payments/beamCheckoutAdapter.ts, design S4.3): the link of the guest's method group with our signed note,
// created on the fake Beam, its PaymentRecord and its links-open entry (which the sweeper reads: S4.2), behind
// the circuit breaker. beamHeld gives the gateway, sweep and flow tests a real Beam hold to fulfil, release,
// abandon and sweep. beamRunCheckout runs the checkout route's own path (checkout.ts runCheckout with the kit's
// checkoutDeps, design S4.6): the request's validation, the payment method refusal, the re-quote with the method's
// fee, then startBeamCheckout.

import { createAlerter } from "./alerts.ts";
import { getCartInventory, buildOffers } from "./availability.ts";
import { startBeamCheckout } from "./beamCheckout.ts";
import type { BeamCheckoutContext } from "./beamCheckout.ts";
import { runCheckout } from "./checkout.ts";
import type { CheckoutDeps, CheckoutResult } from "./checkout.ts";
import { cloudbedsRestrictions } from "./cloudbedsProvider.ts";
import { createCloudbedsWriter } from "./cloudbedsWrite.ts";
import { BEAM_LIVE_BASE, BEAM_PLAYGROUND_BASE, getBookingConfig } from "./config.ts";
import type { BeamSettings, BookingConfig, Env } from "./config.ts";
import { todayInBangkok } from "./dates.ts";
import type { GuestDetails } from "./guest.ts";
import { createMemoryKv } from "./kv.ts";
import type { KvStore } from "./kv.ts";
import { beamKeyOf, keyScope } from "./lock.ts";
import { createFakeBeam } from "./mock/fakeBeam.ts";
import type { FakeBeam, FakeBeamOptions } from "./mock/fakeBeam.ts";
import { FAKE_PAYMENT_METHODS, createFakeCloudbeds } from "./mock/fakeCloudbeds.ts";
import type { FakeCloudbeds, FakeCloudbedsOptions } from "./mock/fakeCloudbeds.ts";
import { beamGateway } from "./payments/beamGateway.ts";
import type { BeamGateway, BeamGatewayDeps } from "./payments/beamGateway.ts";
import { computeQuote, feePctFor } from "./quote.ts";
import type { StripeCheckoutResult } from "./checkoutShared.ts";
import { testAccessCookieValue } from "./testAccess.ts";
import { FAR_CHECKIN, FAR_CHECKOUT, GUEST, HONEYMOON, NOW, ORIGIN, ROOM_TYPES, TEST_ACCESS_KEY, TEST_EMAIL, TOKEN_SECRET, request } from "./testkit.ts";
import type { CartItemInput, CheckoutRequest, CheckoutSuccess, DataSource, PayMethod, Quote, RoomInventory } from "./types.ts";

/** The property's custom Cloudbeds method for Beam money, as getPaymentMethods lists it (the fake refuses any other type). */
export const BEAM_CLOUDBEDS_METHOD = "Beam(website)";
export const BEAM_MERCHANT_ID = "m_BeamTestkitMerchant0000000";
export const BEAM_API_KEY = "beam-testkit-api-key-0123456789";
/** Lighthouse's webhook HMAC key (base64, 32 bytes decoded). */
export const BEAM_HMAC_KEY_B64 = Buffer.from("test-only-beam-webhook-hmac-key!").toString("base64");

/** beam-playground with real (fake) Cloudbeds writes: Stage B's shape, the test guard included. */
export const BEAM_TEST_ENV: Env = {
  BOOKING_PAYMENT_PROVIDER: "beam",
  BEAM_API_BASE: BEAM_PLAYGROUND_BASE,
  BEAM_MERCHANT_ID,
  BEAM_API_KEY,
  BEAM_WEBHOOK_HMAC_KEY: BEAM_HMAC_KEY_B64,
  BOOKING_TOKEN_SECRET: TOKEN_SECRET,
  CLOUDBEDS_API_KEY: "cbat_read_testkit",
  CLOUDBEDS_API_KEY_BOOKING: "cbat_write_testkit",
  CLOUDBEDS_PROPERTY_ID: "235064",
  BOOKING_TEST_GUEST_EMAIL: TEST_EMAIL,
  BOOKING_TEST_ACCESS_KEY: TEST_ACCESS_KEY,
  // S3.3: a Beam config reads only the Beam names (beam-playground: the TEST name, then this one).
  CLOUDBEDS_BEAM_PAYMENT_METHOD: BEAM_CLOUDBEDS_METHOD,
  UPSTASH_REDIS_REST_URL: "https://example-redis.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "token-testkit",
};

/** beam-live with every beamLiveBlockers condition; LIVE_FULFILMENT_READY.beam is overridden by makeBeamKit (tests only). */
export const BEAM_LIVE_ENV: Env = {
  ...BEAM_TEST_ENV,
  BEAM_API_BASE: BEAM_LIVE_BASE,
  BOOKING_ALLOW_LIVE_PAYMENTS: "true",
  VERCEL_ENV: "production",
  BOOKING_SWEEP_SECRET: "sweep-secret-testkit-0123456789",
  CLOUDBEDS_SEND_STATUS_EMAIL: "true",
};

export interface BeamKit {
  config: BookingConfig;
  beam: BeamSettings;
  fakeBeam: FakeBeam;
  fakeCb: FakeCloudbeds;
  deps: BeamGatewayDeps;
  gw: BeamGateway;
  /** Alerts that were DELIVERED (through the real alerter: dedupe, retry, critical store). */
  alerts: { subject: string; lines: string[]; severity: string }[];
  /** Set false to make alert mail fail. */
  mail: { ok: boolean; attempts: number };
  logs: { message: string; data?: Record<string, unknown> }[];
  /** Everything logged, as one string (PII checks). */
  logText(): string;
  now: { ms: number };
  /** The Beam checkout's context (the hold-first core's, with the gateway deps) for a checkout at the kit's time. */
  checkoutContext(): BeamCheckoutContext;
  /** runCheckout's deps as the checkout route builds them (Cloudbeds reads on the fake, the Beam deps), at the kit's time. */
  checkoutDeps(): CheckoutDeps;
}

export function makeBeamKit(
  options: {
    env?: Env;
    cb?: FakeCloudbedsOptions;
    beam?: FakeBeamOptions;
    kv?: KvStore;
    now?: { ms: number };
    /** Booking-ref characters (default: random). */
    pickRefChar?: (max: number) => number;
    /** Extra gateway deps (a deadline, a clock, a nonce). */
    gateway?: Partial<Pick<BeamGatewayDeps, "deadlineMs" | "clock" | "nonce" | "onRateLimited">>;
  } = {},
): BeamKit {
  const now = options.now ?? { ms: NOW };
  const env = options.env ?? BEAM_TEST_ENV;
  // beam-live stays locked in code (LIVE_FULFILMENT_READY.beam = false); tests unlock it here only.
  const config = getBookingConfig(env, { liveFulfilmentReady: true });
  const beam = config.beam;
  if (!beam) throw new Error(`makeBeamKit: ${config.paymentMode} is not a Beam mode`);
  const fakeBeam = createFakeBeam({
    now: () => now.ms,
    merchantId: beam.merchantId,
    apiKey: beam.apiKey,
    ...(config.beamWebhookHmacKey ? { hmacKeyB64: config.beamWebhookHmacKey } : {}),
    base: config.paymentMode === "beam-live" ? "live" : "playground",
    ...options.beam,
  });
  const fakeCb = createFakeCloudbeds({
    roomTypes: ROOM_TYPES,
    createdStatus: "confirmed",
    now: () => now.ms,
    paymentMethods: [...FAKE_PAYMENT_METHODS, { method: BEAM_CLOUDBEDS_METHOD, code: BEAM_CLOUDBEDS_METHOD, name: "Beam (website)" }],
    ...options.cb,
  });
  const alerts: BeamKit["alerts"] = [];
  const logs: BeamKit["logs"] = [];
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
  const deps: BeamGatewayDeps = {
    config,
    beam,
    writer,
    kv,
    alert,
    log,
    restrictions: (roomTypeId, rateId, checkIn, checkOut, adults, promo) =>
      cloudbedsRestrictions(roomTypeId, rateId, checkIn, checkOut, adults, { apiKey: "cbat_read_testkit", propertyId: "235064", fetchImpl: fakeCb.fetch }, promo ?? null),
    now: () => now.ms,
    fetchImpl: fakeBeam.fetch,
    sleep: async () => undefined,
    ...options.gateway,
  };
  const gw = beamGateway(deps);
  let nonces = 0;
  return {
    config,
    beam,
    fakeBeam,
    fakeCb,
    deps,
    gw,
    alerts,
    mail,
    logs,
    logText: () => JSON.stringify(logs),
    now,
    checkoutContext: () => ({
      deps,
      origin: ORIGIN,
      nowMs: now.ms,
      ...(options.pickRefChar ? { pickRefChar: options.pickRefChar } : {}),
      nonce: () => `kit-nonce-${++nonces}`,
      testAccessToken: config.testGuard?.accessKey ? testAccessCookieValue(config.tokenSecret, config.testGuard.accessKey) : null,
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
    }),
    checkoutDeps: () => ({
      config,
      origin: ORIGIN,
      nowMs: now.ms,
      fetchImpl: fakeCb.fetch,
      log,
      beam: deps,
      ...(options.pickRefChar ? { pickRefChar: options.pickRefChar } : {}),
      nonce: () => `kit-nonce-${++nonces}`,
      testAccessToken: config.testGuard?.accessKey ? testAccessCookieValue(config.tokenSecret, config.testGuard.accessKey) : null,
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
    }),
  };
}

/** A Beam checkout request body (testkit.ts request: the far stay, the guest, the terms version) with a method group. */
export function beamRequest(items: CartItemInput[] = HONEYMOON, extra: Partial<CheckoutRequest> = {}): CheckoutRequest & { guest: GuestDetails } {
  return request(items, { payMethod: "card_ewallet", ...extra });
}

/** The server's quote for a Beam request through runCheckout (asked with a wrong total: the price_changed answer). */
export async function beamServerQuote(kit: BeamKit, req: CheckoutRequest): Promise<Quote> {
  const res = await runCheckout({ ...req, expectedTotalSatang: 1, expectedDueNowSatang: 1 }, kit.checkoutDeps());
  if (res.body.ok || res.body.error !== "price_changed" || !res.body.quote) throw new Error(`no quote: ${JSON.stringify(res.body)}`);
  return res.body.quote;
}

/** runCheckout (the checkout route's path) at the server's price for the request's method group. */
export async function beamRunCheckout(kit: BeamKit, items: CartItemInput[] = HONEYMOON, extra: Partial<CheckoutRequest> = {}): Promise<CheckoutResult> {
  const req = beamRequest(items, extra);
  const quote = await beamServerQuote(kit, req);
  return runCheckout({ ...req, expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang }, kit.checkoutDeps());
}

/** The server's quote for a cart, priced with the fee of the guest's method group (feePctFor, design S3.2). */
export async function beamQuote(
  kit: BeamKit,
  payMethod: PayMethod,
  items: CartItemInput[] = HONEYMOON,
): Promise<{ quote: Quote; inventory: RoomInventory[]; dataSource: DataSource }> {
  const { inventory, dataSource } = await getCartInventory(FAR_CHECKIN, FAR_CHECKOUT, items, kit.config, { fetchImpl: kit.fakeCb.fetch, allowDemoFallback: false });
  const quote = computeQuote(
    {
      checkIn: FAR_CHECKIN,
      checkOut: FAR_CHECKOUT,
      items,
      promo: null,
      pricing: { cardFeePct: feePctFor(kit.config, payMethod), depositPct: kit.config.depositPct },
    },
    buildOffers(inventory, 1, kit.config.ratePlans),
  );
  return { quote, inventory, dataSource };
}

/** A Beam checkout through the real hold-first core (startBeamCheckout) at the server's price for `payMethod`. */
export async function beamCheckout(
  kit: BeamKit,
  payMethod: PayMethod = "card_ewallet",
  items: CartItemInput[] = HONEYMOON,
  guest: GuestDetails = GUEST,
): Promise<StripeCheckoutResult> {
  const { quote, inventory, dataSource } = await beamQuote(kit, payMethod, items);
  return startBeamCheckout(
    { checkIn: FAR_CHECKIN, checkOut: FAR_CHECKOUT, items, guest, quote, inventory, dataSource, today: todayInBangkok(new Date(kit.now.ms)) },
    kit.checkoutContext(),
    payMethod,
  );
}

/** A Beam hold awaiting payment: the checkout's answer, the link and its payment key. */
export interface BeamHeld {
  ref: string;
  reservationId: string;
  linkId: string;
  key: string;
  quote: Quote;
  body: CheckoutSuccess;
}

/**
 * Whether a card's last digits show in `text` the way a leak would show them: standing alone, not inside a longer id
 * or number. The booking refs, the fake Cloudbeds' request ids and UUID-shaped keys, where four digits could stand
 * alone by chance, are blanked first, so the privacy checks can never collide with a random id (round-4 triage:
 * '4729' inside reservationId 7000000047298 or requestId fake-467264729 failed 5 runs in 400).
 */
export function cardDigitsShown(text: string, digits: string): boolean {
  if (!/^\d{4}$/.test(digits)) throw new RangeError("cardDigitsShown: four digits");
  const blanked = text
    .replace(/MSV-\d{8}-[A-Z0-9]{4}/g, "MSV-REF")
    .replace(/fake-\d+/g, "fake-ID")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "UUID");
  return new RegExp(`(?<![0-9A-Za-z])${digits}(?![0-9A-Za-z])`).test(blanked);
}

/** beamCheckout that must succeed. */
export async function beamHeld(kit: BeamKit, payMethod: PayMethod = "card_ewallet", items: CartItemInput[] = HONEYMOON): Promise<BeamHeld> {
  const res = await beamCheckout(kit, payMethod, items);
  if (res.status !== 200 || !res.body.ok) throw new Error(`Beam checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
  const body = res.body;
  const linkId = new URL(body.redirectUrl).pathname.split("/").pop() ?? "";
  if (!kit.fakeBeam.links.has(linkId)) throw new Error(`no fake Beam link ${linkId}`);
  return { ref: body.ref, reservationId: body.holdReservationId as string, linkId, key: beamKeyOf(linkId), quote: body.quote, body };
}

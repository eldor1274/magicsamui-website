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
//
// forEachProvider (design S4.10) hands providerParity.test.ts one ParityKit per provider: testkit.ts makeKit (the
// fake Stripe) or makeBeamKit (the fake Beam) behind one interface - the checkout route's path (runCheckout), the
// guest paying or leaving on the provider's page, and the core's fulfil, release, abandon, status and sweep with
// that provider's gateway - so each money invariant is asserted once, in the same words, for both providers.

import { runAbandon } from "./abandon.ts";
import type { AbandonResult } from "./abandon.ts";
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
import { fulfilPayment, releaseHold, releasePayment } from "./fulfil.ts";
import type { FulfilOutcome, ReleaseOutcome } from "./fulfil.ts";
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
import type { GatewayPayment, PaymentGateway } from "./payments/gateway.ts";
import { stripeGateway } from "./payments/stripeGateway.ts";
import { computeQuote, feePctFor } from "./quote.ts";
import type { StripeCheckoutResult } from "./checkoutShared.ts";
import { runStatus } from "./status.ts";
import type { StatusResult } from "./status.ts";
import type { CoreDeps, ProviderDepsFn, StripeDeps } from "./stripeDeps.ts";
import { runSweep } from "./sweep.ts";
import type { SweepSummary } from "./sweep.ts";
import { testAccessCookieValue } from "./testAccess.ts";
import {
  FAR_CHECKIN,
  FAR_CHECKOUT,
  GUEST,
  HONEYMOON,
  NOW,
  ORIGIN,
  ROOM_TYPES,
  STRIPE_LIVE_ENV,
  STRIPE_TEST_ENV,
  TEST_ACCESS_KEY,
  TEST_EMAIL,
  TOKEN_SECRET,
  makeKit,
  request,
} from "./testkit.ts";
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

/** beam-live with every beamLiveBlockers condition (LIVE_FULFILMENT_READY.beam is true since S7.1). */
export const BEAM_LIVE_ENV: Env = {
  ...BEAM_TEST_ENV,
  BEAM_API_BASE: BEAM_LIVE_BASE,
  BOOKING_ALLOW_LIVE_PAYMENTS: "true",
  VERCEL_ENV: "production",
  BOOKING_SWEEP_SECRET: "sweep-secret-testkit-0123456789",
  CLOUDBEDS_SEND_STATUS_EMAIL: "true",
};

/**
 * BEAM_LIVE_ENV emergency-stopped (BOOKING_ALLOW_LIVE_PAYMENTS=false): a locked beam-live page (checkout), while
 * fulfilment still runs. Since S7.1 the code switch no longer locks beam-live, so this is the tests' locked Beam page.
 */
export const BEAM_LIVE_STOPPED_ENV: Env = { ...BEAM_LIVE_ENV, BOOKING_ALLOW_LIVE_PAYMENTS: "false" };

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
    /** A fake Cloudbeds to share (e.g. a Stripe kit's, design S4.8): used as it is, and `cb` is ignored. It must list BEAM_CLOUDBEDS_METHOD. */
    fakeCb?: FakeCloudbeds;
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
  // The code switch is passed explicitly (true, as in code since S7.1): a kit's beam-live never depends on it.
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
  const fakeCb =
    options.fakeCb ??
    createFakeCloudbeds({
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

/* ----------------------------------------- provider parity (design S4.10) ----------------------------------------- */

export type ParityProvider = "stripe" | "beam";

export interface ParityOptions {
  /** The provider's live mode (stripe-live, beam-live) instead of its test mode (stripe-test, beam-playground). */
  live?: boolean;
  /** Env entries over the mode's testkit env (STRIPE_TEST_ENV / STRIPE_LIVE_ENV, BEAM_TEST_ENV / BEAM_LIVE_ENV). */
  env?: Env;
  kv?: KvStore;
  now?: { ms: number };
  /** Options for the kit's own fake Cloudbeds (not used with fakeCb). Beam's lists BEAM_CLOUDBEDS_METHOD unless cb.paymentMethods says otherwise. */
  cb?: FakeCloudbedsOptions;
  /** Another parity kit's fake Cloudbeds: this kit's writer, Cloudbeds reads and checkout run on it (one property, as live). */
  fakeCb?: FakeCloudbeds;
  /** Booking-ref characters (default: random). */
  pickRefChar?: (max: number) => number;
  /** Wraps the fake provider's fetch (Stripe: what the SDK talks to; Beam: what the gateway and the checkout call), e.g. to make its API slow or hang. */
  providerFetch?: (fake: typeof fetch) => typeof fetch;
}

/** A hold awaiting payment, made through the checkout route's path (runCheckout), in either provider's terms. */
export interface ParityHeld {
  ref: string;
  reservationId: string;
  /** The payment's Redis key (Stripe: the Checkout Session id; Beam: "beam:" + the link id). */
  key: string;
  /** The provider's id of the payment page, as the tokens carry it (Stripe: the session id; Beam: the link id). */
  paymentId: string;
  /** The booking token of the provider's return and cancel URLs (`t`). */
  t: string;
  /** The checkout's link token (`l`: the booking token that also carries the payment id). */
  l: string;
  quote: Quote;
  body: CheckoutSuccess;
}

export interface ParityKit {
  provider: ParityProvider;
  /** The provider's brand in notes and alerts ("Stripe", "Beam"). */
  brand: string;
  config: BookingConfig;
  fakeCb: FakeCloudbeds;
  /** The core's deps: the very object the checkout runs on (a test may replace its log). */
  deps: CoreDeps;
  /** The provider's gateway, as the routes build it (stripeGateway(deps), beamGateway(deps)); see refund for Stripe. */
  readonly gw: PaymentGateway;
  /** keyScope of the kit's mode (keys.alerted, keys.lastSweep, keys.pendingAlertIndex). */
  scope: string;
  /** Alerts that were DELIVERED (through the real alerter). */
  alerts: { subject: string; lines: string[]; severity: string }[];
  /** Set ok false to make alert mail fail. */
  mail: { ok: boolean; attempts: number };
  logs: { message: string; data?: Record<string, unknown> }[];
  logText(): string;
  now: { ms: number };
  /** The routes' ProviderDepsFn for this kit (status, abandon): its deps and gateway for its own provider, nothing else. */
  providerDeps: ProviderDepsFn;
  checkoutDeps(): CheckoutDeps;
  /**
   * runCheckout (the checkout route's path) at the server's price: asked once with a wrong total (its price_changed
   * answer carries the quote; any other answer is returned as it is), then at that price. Beam: the card_ewallet
   * group unless extra.payMethod says otherwise.
   */
  checkout(items?: CartItemInput[], extra?: Partial<CheckoutRequest>): Promise<CheckoutResult>;
  /** checkout that must succeed. */
  held(items?: CartItemInput[], extra?: Partial<CheckoutRequest>): Promise<ParityHeld>;
  /** The guest pays the whole amount by card on the provider's page (Stripe: the session completes paid; Beam: a SUCCEEDED CARD charge). */
  pay(h: Pick<ParityHeld, "paymentId">): void;
  /** Whether the guest can still pay on the provider's page (Stripe: the session is open; Beam: the link is ACTIVE). */
  pageOpen(h: Pick<ParityHeld, "paymentId">): boolean;
  /** Payment pages created so far (Stripe: POST /v1/checkout/sessions; Beam: POST /api/v1/payment-links). */
  pagesCreated(): number;
  /** How many calls were made to the provider's API so far. */
  providerCalls(): number;
  /** Every call made to the provider's API so far, as its fake recorded it. */
  providerCallLog(): readonly unknown[];
  /**
   * The guest tried to pay and it failed for good. Stripe: a delayed payment (complete, unpaid) whose payment then
   * failed - the session can't be paid any more. Beam: a declined card; the link stays ACTIVE until it expires.
   */
  failAttempt(h: ParityHeld): void;
  /**
   * While on, the provider answers HTTP 500 to every reading of this one payment (Stripe: GET the session - step 1
   * reads one by itself only when the listing can't tell its state, a complete but unpaid session; Beam: GET the link).
   */
  unreadable(h: ParityHeld, on?: boolean): void;
  /**
   * The paid payment is refunded at the provider before it was confirmed. Beam: a full Lighthouse refund of its
   * charge (the link reads REFUNDED). Stripe's gateway never reports a refund (a refunded Checkout Session still
   * reads paid), so from then on this kit's gateway is the Stripe gateway with that session read as refunded: the
   * shared core (fulfil, release, abandon, status, sweep) meets a refunded payment in Stripe's words.
   */
  refund(h: ParityHeld): void;
  /**
   * The holds, all still payable, are released unpaid, each provider's way. Beam: the links expire, the sweeper
   * releases their holds and its next run watches the links for a late payment (the kit's clock ends about 42
   * minutes after the last link was made). Stripe: a Checkout Session can't be paid once it expired, so the core's
   * release (releaseHold) cancels each hold while its session is still open - a release racing the guest's payment.
   */
  releaseUnpaid(holds: ParityHeld[]): Promise<void>;
  /**
   * The guest's payment succeeds after releaseUnpaid (owner decision 3). Beam: a card payment begun just before the
   * link closed is confirmed now (payAfterClose; the link stays closed). Stripe: the guest pays the open session.
   */
  payLate(h: ParityHeld): void;
  fulfil(h: ParityHeld): Promise<FulfilOutcome>;
  release(h: ParityHeld, reason?: string): Promise<ReleaseOutcome>;
  /** runStatus as the return page asks it (t and l; Stripe also s, the success_url's session id). */
  status(h: ParityHeld): Promise<StatusResult>;
  /** runAbandon as the booking page posts it ({t, l}). */
  abandon(h: ParityHeld): Promise<AbandonResult>;
  /** runSweep(deps, gw): one sweeper run of this provider alone (Stripe: what the route runs without a Beam config). */
  sweep(): Promise<SweepSummary>;
}

/** One provider's fixture: its name and a factory of fresh kits. */
export interface ProviderFixture {
  provider: ParityProvider;
  /** A fresh kit of this provider (its test mode unless options.live). */
  kit(options?: ParityOptions): ParityKit;
}

/** Calls `body` once per provider, in the order given, with that provider's fixture (the parity tests register their tests in it). */
export function forEachProvider(providers: readonly ParityProvider[], body: (fixture: ProviderFixture) => void): void {
  for (const provider of providers) body({ provider, kit: (options = {}) => makeParityKit(provider, options) });
}

/** A fresh parity kit of `provider`. */
export function makeParityKit(provider: ParityProvider, options: ParityOptions = {}): ParityKit {
  return provider === "stripe" ? stripeParityKit(options) : beamParityKit(options);
}

/** The id at the end of a payment page's URL (Stripe: /c/pay/{session id}; Beam: /{merchant}/{link id}). */
function pageIdOf(redirectUrl: string): string {
  const id = new URL(redirectUrl).pathname.split("/").pop();
  if (!id) throw new Error(`no payment id in ${redirectUrl}`);
  return id;
}

/** `fake` with the GETs of `prefix` + one of `ids` answering HTTP 500 with `body`. */
function failingReads(fake: typeof fetch, prefix: string, ids: ReadonlySet<string>, body: unknown): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method === "GET" && url.pathname.startsWith(prefix) && ids.has(url.pathname.slice(prefix.length))) {
      return new Response(JSON.stringify(body), { status: 500, headers: { "content-type": "application/json" } });
    }
    return fake(input, init);
  }) as typeof fetch;
}

/** The Stripe gateway reading the paid sessions of `refunded` as refunded (every other answer unchanged). */
function stripeRefundView(base: PaymentGateway, refunded: ReadonlySet<string>): PaymentGateway {
  const view = (p: GatewayPayment): GatewayPayment => (refunded.has(p.key) && p.state === "paid" ? { ...p, state: "refunded" } : p);
  return {
    ...base,
    get: async (key) => view(await base.get(key)),
    sweepRecent: async (sinceMs) => (await base.sweepRecent(sinceMs)).map((listed) => ({ ...listed, read: async () => view(await listed.read()) })),
  };
}

function mustBeOpen(open: boolean, h: ParityHeld): void {
  if (!open) throw new Error(`releaseUnpaid: the payment page of ${h.ref} is no longer open`);
}

/** What each provider's kit adds to the shared parts of a ParityKit. */
interface ParityParts {
  provider: ParityProvider;
  brand: string;
  config: BookingConfig;
  fakeCb: FakeCloudbeds;
  deps: CoreDeps;
  gw: () => PaymentGateway;
  alerts: ParityKit["alerts"];
  mail: ParityKit["mail"];
  logs: ParityKit["logs"];
  logText(): string;
  now: { ms: number };
  checkoutDeps(): CheckoutDeps;
  request(items: CartItemInput[], extra: Partial<CheckoutRequest>): CheckoutRequest;
  /** The payment page's id and the booking token of its return URL. */
  page(body: CheckoutSuccess): { paymentId: string; t: string };
  statusExtra(h: ParityHeld): { s?: string };
  provide: Pick<ParityKit, "pay" | "pageOpen" | "pagesCreated" | "providerCalls" | "providerCallLog" | "failAttempt" | "unreadable" | "refund" | "releaseUnpaid" | "payLate">;
}

function parityKit(p: ParityParts): ParityKit {
  const log = (message: string, data?: Record<string, unknown>) => p.deps.log(message, data);
  const providerDeps: ProviderDepsFn = (provider) => (provider === p.provider ? { deps: p.deps, gw: p.gw() } : null);
  const kit: ParityKit = {
    provider: p.provider,
    brand: p.brand,
    config: p.config,
    fakeCb: p.fakeCb,
    deps: p.deps,
    get gw() {
      return p.gw();
    },
    scope: keyScope(p.config.paymentMode),
    alerts: p.alerts,
    mail: p.mail,
    logs: p.logs,
    logText: p.logText,
    now: p.now,
    providerDeps,
    checkoutDeps: p.checkoutDeps,
    async checkout(items = HONEYMOON, extra = {}) {
      const req = p.request(items, extra);
      const quoted = await runCheckout({ ...req, expectedTotalSatang: 1, expectedDueNowSatang: 1 }, p.checkoutDeps());
      if (quoted.body.ok || quoted.body.error !== "price_changed" || !quoted.body.quote) return quoted;
      const quote = quoted.body.quote;
      return runCheckout({ ...req, expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang }, p.checkoutDeps());
    },
    async held(items = HONEYMOON, extra = {}) {
      const res = await kit.checkout(items, extra);
      if (res.status !== 200 || !res.body.ok) throw new Error(`${p.provider} checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
      const body = res.body;
      if (!body.linkToken || !body.holdReservationId) throw new Error(`${p.provider} checkout: no link token or hold`);
      const { paymentId, t } = p.page(body);
      return { ref: body.ref, reservationId: body.holdReservationId, key: p.gw().keyOf(paymentId), paymentId, t, l: body.linkToken, quote: body.quote, body };
    },
    ...p.provide,
    fulfil: (h) => fulfilPayment(h.key, p.deps, p.gw()),
    release: (h, reason = "parity release") => releasePayment(h.key, p.deps, p.gw(), reason),
    status: (h) => runStatus({ t: h.t, p: null, l: h.l, ...p.statusExtra(h) }, { config: p.config, providerDeps, nowMs: p.now.ms, log }),
    abandon: (h) => runAbandon({ t: h.t, l: h.l }, { config: p.config, providerDeps, nowMs: p.now.ms, log }),
    sweep: () => runSweep(p.deps, p.gw()),
  };
  return kit;
}

const STRIPE_SESSIONS = "/v1/checkout/sessions/";
const BEAM_LINKS = "/api/v1/payment-links/";

function stripeParityKit(o: ParityOptions): ParityKit {
  const unreadable = new Set<string>();
  const base = makeKit({
    env: { ...(o.live ? STRIPE_LIVE_ENV : STRIPE_TEST_ENV), ...o.env },
    ...(o.kv ? { kv: o.kv } : {}),
    ...(o.now ? { now: o.now } : {}),
    ...(o.cb ? { cb: o.cb } : {}),
    ...(o.pickRefChar ? { pickRefChar: o.pickRefChar } : {}),
    stripeFetch: (fake) => failingReads(o.providerFetch ? o.providerFetch(fake) : fake, STRIPE_SESSIONS, unreadable, { error: { type: "api_error", message: "simulated outage" } }),
  });
  const fakeCb = o.fakeCb ?? base.fakeCb;
  // On a shared Cloudbeds: makeKit's writer and restriction reads, on that one (makeKit's own fake stays unused).
  const deps: StripeDeps = o.fakeCb
    ? {
        ...base.deps,
        writer: createCloudbedsWriter({
          apiKey: "cbat_write_testkit",
          propertyId: "235064",
          mode: base.config.cloudbedsWrite?.mode === "live" ? "live" : "mock",
          fetchImpl: fakeCb.fetch,
          budget: null,
          log: base.deps.log,
          sleep: async () => undefined,
        }),
        restrictions: (roomTypeId, rateId, checkIn, checkOut, adults, promo) =>
          cloudbedsRestrictions(roomTypeId, rateId, checkIn, checkOut, adults, { apiKey: "cbat_read_testkit", propertyId: "235064", fetchImpl: fakeCb.fetch }, promo ?? null),
      }
    : base.deps;
  const fake = base.fakeStripe;
  const plain = stripeGateway(deps);
  const refunded = new Set<string>();
  const viewed = stripeRefundView(plain, refunded);
  const session = (id: string) => {
    const s = fake.session(id);
    if (!s) throw new Error(`no fake Stripe session ${id}`);
    return s;
  };
  return parityKit({
    provider: "stripe",
    brand: "Stripe",
    config: base.config,
    fakeCb,
    deps,
    gw: () => (refunded.size > 0 ? viewed : plain),
    alerts: base.alerts,
    mail: base.mail,
    logs: base.logs,
    logText: base.logText,
    now: base.now,
    checkoutDeps: () => ({ ...base.checkoutDeps(), fetchImpl: fakeCb.fetch, stripe: deps }),
    request: (items, extra) => request(items, extra),
    page(body) {
      const paymentId = pageIdOf(body.redirectUrl);
      const t = new URL(session(paymentId).success_url.replace("{CHECKOUT_SESSION_ID}", paymentId)).searchParams.get("t") ?? "";
      return { paymentId, t };
    },
    statusExtra: (h) => ({ s: h.paymentId }),
    provide: {
      pay: (h) => void fake.complete(h.paymentId),
      pageOpen: (h) => session(h.paymentId).status === "open",
      pagesCreated: () => fake.calls.filter((c) => c.method === "POST" && c.path === "/v1/checkout/sessions").length,
      providerCalls: () => fake.calls.length,
      providerCallLog: () => fake.calls,
      failAttempt(h) {
        fake.completeDelayed(h.paymentId);
        fake.asyncFail(h.paymentId);
      },
      unreadable: (h, on = true) => void (on ? unreadable.add(h.paymentId) : unreadable.delete(h.paymentId)),
      refund(h) {
        if (session(h.paymentId).payment_status !== "paid") throw new Error(`refund: Stripe session ${h.paymentId} is not paid`);
        refunded.add(h.key);
      },
      async releaseUnpaid(holds) {
        for (const h of holds) {
          mustBeOpen(session(h.paymentId).status === "open", h);
          await releaseHold(h.reservationId, deps, "parity: released while its payment page was open");
        }
      },
      payLate: (h) => void fake.complete(h.paymentId),
    },
  });
}

function beamParityKit(o: ParityOptions): ParityKit {
  const unreadable = new Set<string>();
  const k = makeBeamKit({
    env: { ...(o.live ? BEAM_LIVE_ENV : BEAM_TEST_ENV), ...o.env },
    ...(o.kv ? { kv: o.kv } : {}),
    ...(o.now ? { now: o.now } : {}),
    ...(o.cb ? { cb: o.cb } : {}),
    ...(o.fakeCb ? { fakeCb: o.fakeCb } : {}),
    ...(o.pickRefChar ? { pickRefChar: o.pickRefChar } : {}),
  });
  const fake = k.fakeBeam;
  // The gateway and the checkout read deps.fetchImpl on every call.
  k.deps.fetchImpl = failingReads(o.providerFetch ? o.providerFetch(fake.fetch) : fake.fetch, BEAM_LINKS, unreadable, {
    code: 500,
    message: "simulated outage",
    error: { errorCode: "INTERNAL_SERVER_ERROR", errorMessage: "simulated outage" },
  });
  return parityKit({
    provider: "beam",
    brand: "Beam",
    config: k.config,
    fakeCb: k.fakeCb,
    deps: k.deps,
    gw: () => k.gw,
    alerts: k.alerts,
    mail: k.mail,
    logs: k.logs,
    logText: k.logText,
    now: k.now,
    checkoutDeps: k.checkoutDeps,
    request: (items, extra) => beamRequest(items, extra),
    page(body) {
      const paymentId = pageIdOf(body.redirectUrl);
      const t = new URL(fake.link(paymentId).redirectUrl ?? "").searchParams.get("t") ?? "";
      return { paymentId, t };
    },
    statusExtra: () => ({}),
    provide: {
      pay: (h) => void fake.pay(h.paymentId, "CARD"),
      pageOpen: (h) => fake.link(h.paymentId).status === "ACTIVE",
      pagesCreated: () => fake.count(/^POST \/api\/v1\/payment-links$/),
      providerCalls: () => fake.calls.length,
      providerCallLog: () => fake.calls,
      failAttempt: (h) => void fake.decline(h.paymentId, "CARD"),
      unreadable: (h, on = true) => void (on ? unreadable.add(h.paymentId) : unreadable.delete(h.paymentId)),
      refund(h) {
        const charge = fake.chargesOf(h.paymentId).find((c) => c.status === "SUCCEEDED");
        if (!charge) throw new Error(`refund: Beam link ${h.paymentId} has no SUCCEEDED charge`);
        fake.refund(charge.chargeId);
      },
      async releaseUnpaid(holds) {
        let expiry = k.now.ms;
        for (const h of holds) {
          const link = fake.link(h.paymentId);
          mustBeOpen(link.status === "ACTIVE", h);
          expiry = Math.max(expiry, link.expiresAtMs ?? k.now.ms);
        }
        // Two minutes past the last link's expiry the sweeper releases the holds; ten minutes on, it watches the links.
        k.now.ms = expiry + 2 * 60_000;
        await runSweep(k.deps, k.gw);
        k.now.ms += 10 * 60_000;
        await runSweep(k.deps, k.gw);
      },
      payLate: (h) => void fake.payAfterClose(h.paymentId, "CARD"),
    },
  });
}

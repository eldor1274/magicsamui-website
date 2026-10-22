// Beam design step S3.2: the fee per payment method, and payMethod in the checkout request, the booking token and the
// quote helpers. PayMethod (types.ts) is card_ewallet | promptpay; feePctFor (quote.ts) is the fee % a quote is priced
// with - on Beam the card/e-wallet fee (BOOKING_CARD_FEE_PCT, 3 when unset) or the PromptPay fee (BEAM_PROMPTPAY_FEE_PCT,
// 0 when unset: owner decision 1); on Stripe and the demo config.cardFeePct whatever is sent. Nothing uses payMethod in
// checkout yet (S4.6): a Stripe checkout is the same with or without one, and the golden snapshot is unchanged.

import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildOffers } from "./availability.ts";
import { buildPaymentLinkRequest } from "./beam.ts";
import { runCheckout } from "./checkout.ts";
import { BEAM_LIVE_BASE, BEAM_PLAYGROUND_BASE, getBookingConfig, getPublicBookingConfig, toPublicConfig } from "./config.ts";
import type { BookingConfig, Env } from "./config.ts";
import { addDays } from "./dates.ts";
import { demoInventory } from "./demoProvider.ts";
import { computeQuote, feePctFor, isPayMethod, percentOf } from "./quote.ts";
import { HONEYMOON, STRIPE_LIVE_ENV, STRIPE_TEST_ENV, TOKEN_SECRET, makeKit, refCharSequence, request, serverQuote } from "./testkit.ts";
import { createBookingToken, isBookingSummary, verifyBookingToken } from "./token.ts";
import type { BookingSummary, CartItemInput, PayMethod, Quote, RoomOffer } from "./types.ts";
import { PAY_METHOD_UNREADABLE, parseCheckoutRequest } from "./validate.ts";

const KEYS = { BEAM_MERCHANT_ID: "m", BEAM_API_KEY: "k" };
/** beam-playground with no Cloudbeds variables (demo rates, the mock writer locally). */
const BEAM_PG: Env = { BOOKING_PAYMENT_PROVIDER: "beam", BEAM_API_BASE: BEAM_PLAYGROUND_BASE, ...KEYS, BOOKING_TOKEN_SECRET: TOKEN_SECRET };
/** beam-live with every beamLiveBlockers condition (the code switch is overridden where it is used). */
const BEAM_LIVE: Env = {
  ...BEAM_PG,
  BEAM_API_BASE: BEAM_LIVE_BASE,
  CLOUDBEDS_API_KEY: "cbat_read_testkit",
  CLOUDBEDS_API_KEY_BOOKING: "cbat_write_testkit",
  CLOUDBEDS_PROPERTY_ID: "235064",
  UPSTASH_REDIS_REST_URL: "https://example-redis.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "token-testkit",
  BOOKING_ALLOW_LIVE_PAYMENTS: "true",
  VERCEL_ENV: "production",
  // Since design S3.4 (beamLiveBlockers): the webhook HMAC key, a sweep secret and the Cloudbeds confirmation email.
  BEAM_WEBHOOK_HMAC_KEY: Buffer.from("test-only-beam-hmac-key-01234567").toString("base64"),
  BOOKING_SWEEP_SECRET: "sweep-secret-testkit-0123456789",
  CLOUDBEDS_SEND_STATUS_EMAIL: "true",
};
const MOCK_ENV: Env = { BOOKING_PAYMENT_PROVIDER: "stripe", BOOKING_STRIPE_MOCK: "true" };
const METHODS: PayMethod[] = ["card_ewallet", "promptpay"];
const LIMITS = { today: "2026-10-05", maxNights: 30, bookingWindowMonths: 18, maxSearchAdults: 18, maxCartItems: 6 };

/** A config_warning (Beam with BOOKING_CARD_FEE_PCT set) is expected in some tests: keep it out of the output. */
function quiet(t: TestContext): void {
  t.mock.method(console, "warn", () => undefined);
}

/** The first 3-night demo stay (from Nov 2026) with the Garden Suite free, priced by `config`'s rate plans. */
function demoStay(config: BookingConfig): { checkIn: string; checkOut: string; offers: RoomOffer[]; items: CartItemInput[] } {
  for (let i = 0; i < 200; i++) {
    const checkIn = addDays("2026-11-02", i);
    const checkOut = addDays(checkIn, 3);
    const offers = buildOffers(demoInventory(checkIn, checkOut), 2, config.ratePlans);
    if (offers.find((o) => o.slug === "garden-suite")?.available) {
      return { checkIn, checkOut, offers, items: [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }] };
    }
  }
  throw new Error("no demo availability for garden-suite");
}

/** The quote a checkout prices for `payMethod` (feePctFor). */
function quoteFor(config: BookingConfig, payMethod: PayMethod | undefined): Quote {
  const { checkIn, checkOut, offers, items } = demoStay(config);
  return computeQuote({ checkIn, checkOut, items, promo: null, pricing: { cardFeePct: feePctFor(config, payMethod), depositPct: config.depositPct } }, offers);
}

/* ---------------------------------- feePctFor ---------------------------------- */

test("feePctFor on Beam: card_ewallet = the card fee (3), promptpay = BEAM_PROMPTPAY_FEE_PCT (0); no method yet = the card/e-wallet fee", () => {
  const config = getBookingConfig(BEAM_PG);
  assert.equal(config.paymentMode, "beam-playground");
  assert.equal(feePctFor(config, "card_ewallet"), 3);
  assert.equal(feePctFor(config, "promptpay"), 0, "owner decision 1");
  assert.equal(feePctFor(config, undefined), 3);
  assert.equal(feePctFor(config, null), 3);
  assert.equal(isPayMethod("card_ewallet"), true);
  assert.equal(isPayMethod("promptpay"), true);
  for (const v of ["", "PROMPTPAY", "card", "wallet", null, undefined, 1, {}, []]) assert.equal(isPayMethod(v), false, JSON.stringify(v));
});

test("quote per method on Beam: PromptPay 0% -> cardFeeSatang 0; card_ewallet 3%", () => {
  const config = getBookingConfig(BEAM_PG);
  const promptpay = quoteFor(config, "promptpay");
  assert.equal(promptpay.cardFeePct, 0);
  assert.equal(promptpay.cardFeeSatang, 0);
  assert.equal(promptpay.totalSatang, promptpay.feeBaseSatang);
  assert.equal(promptpay.dueNowSatang, promptpay.totalSatang, "100% up front on Beam");

  const card = quoteFor(config, "card_ewallet");
  assert.equal(card.cardFeePct, 3);
  assert.ok(card.cardFeeSatang > 0);
  assert.equal(card.cardFeeSatang, percentOf(card.feeBaseSatang, 3));
  assert.equal(card.totalSatang, card.feeBaseSatang + card.cardFeeSatang);
  assert.equal(card.feeBaseSatang, promptpay.feeBaseSatang, "the rooms are the same: only the fee differs");
  assert.deepEqual(quoteFor(config, undefined), card, "before a method is chosen: the card/e-wallet total");
});

test("BEAM_PROMPTPAY_FEE_PCT=3 -> 3% for both methods (the same quote)", () => {
  const config = getBookingConfig({ ...BEAM_PG, BEAM_PROMPTPAY_FEE_PCT: "3" });
  assert.equal(feePctFor(config, "promptpay"), 3);
  assert.equal(feePctFor(config, "card_ewallet"), 3);
  const promptpay = quoteFor(config, "promptpay");
  assert.equal(promptpay.cardFeePct, 3);
  assert.ok(promptpay.cardFeeSatang > 0);
  assert.deepEqual(promptpay, quoteFor(config, "card_ewallet"));
  // Two decimals, as the config reads it.
  assert.equal(feePctFor(getBookingConfig({ ...BEAM_PG, BEAM_PROMPTPAY_FEE_PCT: "1.256" }), "promptpay"), 1.26);
});

test("BOOKING_CARD_FEE_PCT=7 changes Stripe and Beam card_ewallet but not PromptPay", (t: TestContext) => {
  quiet(t);
  const stripe = getBookingConfig({ ...STRIPE_TEST_ENV, BOOKING_CARD_FEE_PCT: "7" });
  for (const m of [...METHODS, undefined, null]) assert.equal(feePctFor(stripe, m), 7, `Stripe ${String(m)}`);
  const beam = getBookingConfig({ ...BEAM_PG, BOOKING_CARD_FEE_PCT: "7" });
  assert.equal(feePctFor(beam, "card_ewallet"), 7);
  assert.equal(feePctFor(beam, "promptpay"), 0);
  assert.equal(quoteFor(beam, "card_ewallet").cardFeePct, 7);
  assert.equal(quoteFor(beam, "promptpay").cardFeeSatang, 0);
  // Both set: each follows its own variable.
  const both = getBookingConfig({ ...BEAM_PG, BOOKING_CARD_FEE_PCT: "7", BEAM_PROMPTPAY_FEE_PCT: "2" });
  assert.deepEqual([feePctFor(both, "card_ewallet"), feePctFor(both, "promptpay")], [7, 2]);
});

test("Stripe and the demo: config.cardFeePct whatever is sent (the quote is exactly today's)", () => {
  const envs: [string, Env][] = [
    ["stripe-test", STRIPE_TEST_ENV],
    ["stripe-live", STRIPE_LIVE_ENV],
    ["stripe-mock", MOCK_ENV],
    ["stripe-test with Beam variables", { ...STRIPE_TEST_ENV, BEAM_API_BASE: BEAM_PLAYGROUND_BASE, ...KEYS, BEAM_PROMPTPAY_FEE_PCT: "0" }],
    ["demo", {}],
    ["demo with a card fee", { BOOKING_CARD_FEE_PCT: "4.5" }],
    ["provider beam without keys (the demo)", { BOOKING_PAYMENT_PROVIDER: "beam", BEAM_PROMPTPAY_FEE_PCT: "0" }],
  ];
  for (const [name, env] of envs) {
    const config = getBookingConfig(env);
    assert.equal(config.beam, null, name);
    const { checkIn, checkOut, offers, items } = demoStay(config);
    // What checkout prices with today: config.cardFeePct.
    const today = computeQuote({ checkIn, checkOut, items, promo: null, pricing: { cardFeePct: config.cardFeePct, depositPct: config.depositPct } }, offers);
    for (const m of [...METHODS, undefined, null]) {
      assert.equal(feePctFor(config, m), config.cardFeePct, `${name} ${String(m)}`);
      assert.deepEqual(quoteFor(config, m ?? undefined), today, `${name} ${String(m)}`);
    }
  }
  assert.equal(feePctFor(getBookingConfig(STRIPE_LIVE_ENV), "promptpay"), 5, "Stripe's 5% even for PromptPay");
});

test("feePctFor agrees with the public feeByMethod on every Beam config, and Stripe and the demo carry none", (t: TestContext) => {
  quiet(t);
  const beamEnvs: [string, Env][] = [
    ["beam-playground", BEAM_PG],
    ["PromptPay fee 3", { ...BEAM_PG, BEAM_PROMPTPAY_FEE_PCT: "3" }],
    ["PromptPay fee 2.5, card fee 4", { ...BEAM_PG, BEAM_PROMPTPAY_FEE_PCT: "2.5", BOOKING_CARD_FEE_PCT: "4" }],
    ["clamped and unreadable values", { ...BEAM_PG, BEAM_PROMPTPAY_FEE_PCT: "50", BOOKING_CARD_FEE_PCT: "abc" }],
    ["PromptPay off", { ...BEAM_PG, BEAM_PROMPTPAY: "off" }],
    ["e-wallets off", { ...BEAM_PG, BEAM_EWALLETS: "off" }],
  ];
  for (const [name, env] of beamEnvs) {
    const config = getBookingConfig(env);
    const pub = toPublicConfig(config, env);
    assert.ok(pub.feeByMethod, name);
    assert.deepEqual(getPublicBookingConfig(env).feeByMethod, pub.feeByMethod, name);
    for (const m of METHODS) assert.equal(feePctFor(config, m), pub.feeByMethod[m], `${name} ${m}`);
    assert.equal(feePctFor(config, "card_ewallet"), pub.cardFeePct, `${name}: the card/e-wallet fee is cardFeePct`);
  }
  // A locked beam-live page shows the fees the unlocked config would charge.
  const locked = getPublicBookingConfig({ ...BEAM_LIVE, BEAM_PROMPTPAY_FEE_PCT: "1.5" });
  assert.equal(locked.paymentStatus, "locked");
  const unlocked = getBookingConfig({ ...BEAM_LIVE, BEAM_PROMPTPAY_FEE_PCT: "1.5" }, { liveFulfilmentReady: true });
  assert.equal(unlocked.paymentMode, "beam-live");
  assert.deepEqual(locked.feeByMethod, { card_ewallet: feePctFor(unlocked, "card_ewallet"), promptpay: feePctFor(unlocked, "promptpay") });

  for (const env of [STRIPE_TEST_ENV, STRIPE_LIVE_ENV, MOCK_ENV, {}]) {
    const pub = getPublicBookingConfig(env);
    assert.equal("feeByMethod" in pub, false);
    for (const m of METHODS) assert.equal(feePctFor(getBookingConfig(env), m), pub.cardFeePct);
  }
});

test("the Beam link's fee guard follows feePctFor: a BEAM_PROMPTPAY_FEE_PCT override builds the PromptPay link; a quote for the other method is refused", () => {
  const link = (config: BookingConfig, group: PayMethod, quote: Quote) =>
    buildPaymentLinkRequest({
      ref: "MSV-20261005-7F3K",
      quote,
      merchantName: "Magic Suites & Villas",
      redirectUrl: "https://magicsamui.com/booking-preview/return?ref=MSV-20261005-7F3K&t=x",
      cancelUrl: "https://magicsamui.com/booking-preview?resume=payment&ref=MSV-20261005-7F3K&t=x",
      nowMs: Date.parse("2026-10-05T03:00:00Z"),
      ttlMinutes: 30,
      group,
      ewallets: config.beam?.ewallets ?? true,
      expectedFeePct: feePctFor(config, group),
      internalNote: "msv1|m=beam-playground|r=MSV-20261005-7F3K|s=abcdefghijklmnopqrstuvwxyz0",
    });
  const plain = getBookingConfig(BEAM_PG);
  for (const m of METHODS) {
    const body = link(plain, m, quoteFor(plain, m));
    assert.equal(body.order.netAmount, quoteFor(plain, m).dueNowSatang, m);
  }
  assert.throws(() => link(plain, "promptpay", quoteFor(plain, "card_ewallet")), RangeError, "the card fee never reaches a PromptPay link");
  assert.throws(() => link(plain, "card_ewallet", quoteFor(plain, "promptpay")), RangeError, "nor a card link the fee-free quote");

  const override = getBookingConfig({ ...BEAM_PG, BEAM_PROMPTPAY_FEE_PCT: "3" });
  const promptpay = link(override, "promptpay", quoteFor(override, "promptpay"));
  assert.deepEqual(promptpay.linkSettings, { qrPromptPay: { isEnabled: true } });
  assert.equal(promptpay.order.netAmount, quoteFor(override, "card_ewallet").dueNowSatang, "3% on both methods");
  assert.throws(() => link(override, "promptpay", quoteFor(plain, "promptpay")), RangeError, "the fee-free quote is refused under the override");
});

/* ----------------------------- the checkout request ----------------------------- */

const BODY = {
  checkIn: "2026-11-10",
  checkOut: "2026-11-13",
  items: [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }],
  expectedTotalSatang: 100_000,
  expectedDueNowSatang: 100_000,
};

test("parseCheckoutRequest: an optional payMethod - kept when it is one of the two, no key at all when absent (a Stripe request's parse result is unchanged)", () => {
  for (const m of METHODS) {
    const parsed = parseCheckoutRequest({ ...BODY, payMethod: m }, LIMITS);
    assert.ok(parsed.ok, m);
    assert.equal(parsed.value.payMethod, m);
  }
  const without = parseCheckoutRequest(BODY, LIMITS);
  assert.ok(without.ok);
  assert.equal("payMethod" in without.value, false);
  assert.deepEqual(without.value, { ...BODY, promo: undefined });
  // Not sent, as an empty field is read (null and "" are how a form says "none").
  for (const none of [undefined, null, ""]) assert.deepEqual(parseCheckoutRequest({ ...BODY, payMethod: none }, LIMITS), without, String(none));
  // Everything else the request carries is read exactly as before.
  const full = { ...BODY, promo: "direct", theme: "classic", termsVersion: "2026-10-07" };
  const withMethod = parseCheckoutRequest({ ...full, payMethod: "promptpay" }, LIMITS);
  const withoutMethod = parseCheckoutRequest(full, LIMITS);
  assert.ok(withMethod.ok && withoutMethod.ok);
  const { payMethod, ...rest } = withMethod.value;
  assert.equal(payMethod, "promptpay");
  assert.deepEqual(rest, withoutMethod.value);
});

test("a bad payMethod is a validation issue (in every mode: nothing is held)", async () => {
  for (const bad of ["bitcoin", "PROMPTPAY", "card", " promptpay", 1, true, {}, ["promptpay"]]) {
    const parsed = parseCheckoutRequest({ ...BODY, payMethod: bad }, LIMITS);
    assert.deepEqual(parsed, { ok: false, issues: [PAY_METHOD_UNREADABLE] }, JSON.stringify(bad));
  }
  // With other problems, each is listed once.
  const many = parseCheckoutRequest({ ...BODY, checkIn: "2026-10-01", payMethod: "x" }, LIMITS);
  assert.equal(many.ok, false);
  if (!many.ok) {
    assert.ok(many.issues.includes(PAY_METHOD_UNREADABLE));
    assert.equal(many.issues.filter((i) => i === PAY_METHOD_UNREADABLE).length, 1);
    assert.ok(many.issues.length >= 2);
  }

  // A Stripe checkout with one: 400 invalid_request before any Cloudbeds or Stripe call.
  const kit = makeKit();
  const res = await runCheckout(request(HONEYMOON, { payMethod: "bitcoin" as PayMethod, expectedTotalSatang: 1, expectedDueNowSatang: 1 }), kit.checkoutDeps());
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { ok: false, error: "invalid_request", message: "Please check your booking details.", issues: [PAY_METHOD_UNREADABLE] });
  assert.equal(kit.fakeCb.calls.length, 0);
  assert.equal(kit.fakeStripe.calls.length, 0);
});

test("a Stripe checkout carrying a payMethod is unaffected: the same answer, token, Cloudbeds calls and Stripe requests", async () => {
  const run = async (payMethod: PayMethod | undefined) => {
    const kit = makeKit({ pickRefChar: refCharSequence() });
    const req = request(HONEYMOON, payMethod ? { payMethod } : {});
    const quote = await serverQuote(kit, req);
    const res = await runCheckout({ ...req, expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang }, kit.checkoutDeps());
    const record = { res, quote, cb: kit.fakeCb.calls, stripe: kit.fakeStripe.calls, alerts: kit.alerts, logs: kit.logs };
    return { record, text: normalised(JSON.stringify(record)) };
  };
  const plain = await run(undefined);
  assert.equal(plain.record.res.status, 200);
  assert.equal(plain.record.quote.cardFeePct, 5);
  assert.ok(plain.record.cb.some((c) => c.method === "postReservation"), "the hold was written");
  assert.ok(plain.record.stripe.some((c) => c.method === "POST" && c.path === "/v1/checkout/sessions"), "a Checkout Session was created");
  assert.match(plain.text, /TOKEN\{/, "the booking tokens are compared decoded");
  for (const m of METHODS) {
    const withMethod = await run(m);
    assert.equal(withMethod.text, plain.text, m);
    // ("promptpay" itself is in Stripe's own allowed_payment_method_types, as before.)
    assert.doesNotMatch(withMethod.text, /payMethod|card_ewallet/i, `${m}: not in a token, a Stripe request, a Cloudbeds call or a log`);
  }
});

/**
 * A checkout record with what differs between two runs replaced: booking tokens by their decoded payload (signed at the
 * same time, they differ only by the ids inside), and the fakes' random ids (Cloudbeds reservations, Stripe sessions,
 * request ids) numbered in the order they first appear.
 */
function normalised(json: string): string {
  const decoded = json.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, (tok) => `TOKEN${Buffer.from(tok.split(".")[0], "base64url").toString("utf8").replace(/"/g, "'")}`);
  const seen = new Map<string, string>();
  const counters = new Map<string, number>();
  return decoded.replace(/\b7\d{12}\b|cs_test_fake_[0-9a-f]+|pi_test_fake_[0-9a-f]+|fake-\d+/g, (id) => {
    const known = seen.get(id);
    if (known) return known;
    const kind = /^7\d{12}$/.test(id) ? "res" : id.startsWith("cs_") ? "cs" : id.startsWith("pi_") ? "pi" : "req";
    const n = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, n);
    seen.set(id, `${kind}_${n}`);
    return `${kind}_${n}`;
  });
}

/* ------------------------------- the booking token ------------------------------- */

const SUMMARY: BookingSummary = {
  ref: "MSV-20261005-7F3K",
  paymentMode: "beam-playground",
  checkIn: "2026-10-28",
  checkOut: "2026-10-31",
  nights: 3,
  items: [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }],
  itemRoomSatang: [1_395_000],
  promoCode: null,
  totalSatang: 1_395_000,
  cardFeeSatang: 0,
  dueNowSatang: 1_395_000,
  createdAt: "2026-10-05T03:00:00.000Z",
  linkExpiresAt: "2026-10-05T03:30:00.000Z",
};
const NOW = Date.parse("2026-10-05T03:00:00Z");

test("isBookingSummary: payMethod is optional, one of the two when present; a token carrying it round-trips", () => {
  assert.equal(isBookingSummary(SUMMARY), true);
  for (const m of METHODS) {
    const booking = { ...SUMMARY, payMethod: m };
    assert.equal(isBookingSummary(booking), true, m);
    const v = verifyBookingToken(createBookingToken(booking, "plink_1", TOKEN_SECRET, 3600, NOW), TOKEN_SECRET, NOW + 1000);
    assert.ok(v.ok, m);
    assert.deepEqual(v.payload.booking, booking);
  }
  for (const bad of [null, "", "bitcoin", "PROMPTPAY", 1, {}, ["promptpay"]]) {
    const booking = { ...SUMMARY, payMethod: bad };
    assert.equal(isBookingSummary(booking), false, JSON.stringify(bad));
    assert.deepEqual(
      verifyBookingToken(createBookingToken(booking as unknown as BookingSummary, null, TOKEN_SECRET, 3600, NOW), TOKEN_SECRET, NOW + 1000),
      { ok: false, reason: "malformed" },
      JSON.stringify(bad),
    );
  }
});

test("old tokens without payMethod still verify: every booking token the golden Stripe snapshot recorded", () => {
  const golden = JSON.parse(readFileSync(new URL("./__golden__/stripe.json", import.meta.url), "utf8")) as unknown;
  const bookings: Record<string, unknown>[] = [];
  (function walk(node: unknown): void {
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key !== "tokens") walk(value);
      else for (const payload of Object.values(value as Record<string, { kind?: string; booking?: Record<string, unknown> }>)) if (payload.kind === "booking" && payload.booking) bookings.push(payload.booking);
    }
  })(golden);
  assert.ok(bookings.length >= 40, `${bookings.length} golden booking tokens`);
  for (const recorded of bookings) {
    assert.equal("payMethod" in recorded, false);
    // The route scenarios record their random refs normalised (MSV-20261005-ref_1): give those a real one back.
    const booking = { ...recorded, ref: /-ref_\d+$/.test(String(recorded.ref)) ? "MSV-20261005-7F3K" : recorded.ref };
    assert.equal(isBookingSummary(booking), true, String(recorded.ref));
    const v = verifyBookingToken(createBookingToken(booking as unknown as BookingSummary, null, TOKEN_SECRET, 3600, NOW), TOKEN_SECRET, NOW + 1000);
    assert.ok(v.ok, String(recorded.ref));
    assert.equal("payMethod" in v.payload.booking, false);
  }
});

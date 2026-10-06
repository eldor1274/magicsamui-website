import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOffers, getCartInventory, getInventory, InventoryUnavailableError } from "./availability.ts";
import { runCheckout } from "./checkout.ts";
import { BEAM_LIVE_BASE, BEAM_PLAYGROUND_BASE, getBookingConfig } from "./config.ts";
import { addDays } from "./dates.ts";
import { runDemoPay } from "./demoPay.ts";
import { demoInventory } from "./demoProvider.ts";
import { computeQuote } from "./quote.ts";
import { runStatus } from "./status.ts";
import { verifyBookingToken } from "./token.ts";
import type { CartItemInput, CheckoutRequest, RoomOffer } from "./types.ts";
import { parseCheckoutRequest, parseSearch } from "./validate.ts";

const TEST_SECRET = "test-only-7f3K9qLm2xVw8RtY4pZn6bHc1dJe5gUa";
const NOW = Date.parse("2026-10-05T03:00:00Z"); // 10:00 in Bangkok
const ORIGIN = "https://magicsamui.com";
const demoConfig = getBookingConfig({});
const LIMITS = { today: "2026-10-05", maxNights: 30, bookingWindowMonths: 18, maxSearchAdults: 18, maxCartItems: 6 };

/** First 3-night window (from Nov 2026) where `slug` is available in the demo calendar. */
function findStay(slug: string): { checkIn: string; checkOut: string; offers: RoomOffer[] } {
  for (let i = 0; i < 200; i++) {
    const checkIn = addDays("2026-11-02", i);
    const checkOut = addDays(checkIn, 3);
    const offers = buildOffers(demoInventory(checkIn, checkOut), 2);
    if (offers.find((o) => o.slug === slug)?.available) return { checkIn, checkOut, offers };
  }
  throw new Error(`no availability for ${slug}`);
}

function requestFor(slug: string, items?: CartItemInput[]): CheckoutRequest {
  const { checkIn, checkOut, offers } = findStay(slug);
  const cart = items ?? [{ slug, ratePlanId: "standard", adults: 2, addonIds: [] }];
  const quote = computeQuote({ checkIn, checkOut, items: cart, promo: null, pricing: { cardFeePct: demoConfig.cardFeePct, depositPct: demoConfig.depositPct } }, offers);
  return { checkIn, checkOut, items: cart, expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang };
}

test("demo checkout re-quotes on the server and returns the simulated Beam page", async () => {
  const req = requestFor("sunrise-suite");
  const res = await runCheckout(req, { config: demoConfig, origin: ORIGIN, nowMs: NOW });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  if (!res.body.ok) return;
  assert.match(res.body.ref, /^MSV-20261005-[A-Z2-9]{4}$/);
  assert.match(res.body.redirectUrl, /^https:\/\/magicsamui\.com\/booking-preview\/beam-demo\?t=/);
  assert.equal(res.body.paymentMode, "demo");
  assert.equal(res.body.linkToken, null);
  assert.equal(res.body.quote.totalSatang, req.expectedTotalSatang);
  const t = new URL(res.body.redirectUrl).searchParams.get("t");
  const v = verifyBookingToken(t, demoConfig.tokenSecret, NOW);
  assert.equal(v.ok, true);
});

test("client-sent prices are ignored: a different expected total -> price_changed with the new quote", async () => {
  const req = { ...requestFor("garden-suite"), expectedTotalSatang: 100 };
  const res = await runCheckout(req, { config: demoConfig, origin: ORIGIN, nowMs: NOW });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  if (res.body.ok) return;
  assert.equal(res.body.error, "price_changed");
  assert.ok(res.body.quote && res.body.quote.totalSatang > 100);
  // Extra price fields from the browser have no effect.
  const sneaky = { ...requestFor("garden-suite"), totalSatang: 1, items: [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [], price: 1 }] };
  const parsed = parseCheckoutRequest(sneaky, LIMITS);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(Object.keys(parsed.value.items[0]).sort(), ["addonIds", "adults", "ratePlanId", "slug"]);
});

test("validation: occupancy, bookable slugs, unit conflicts, add-on rules, dates", () => {
  const base = { checkIn: "2026-11-11", checkOut: "2026-11-14", expectedTotalSatang: 0, expectedDueNowSatang: 0 };
  const bad = (items: unknown[]) => parseCheckoutRequest({ ...base, items }, LIMITS).ok;
  assert.equal(bad([{ slug: "garden-suite", ratePlanId: "standard", adults: 3, addonIds: [] }]), false);
  assert.equal(bad([{ slug: "garden-suite", ratePlanId: "standard", adults: 0, addonIds: [] }]), false);
  assert.equal(bad([{ slug: "tuxedo-3br", ratePlanId: "standard", adults: 2, addonIds: [] }]), false);
  assert.equal(bad([{ slug: "nope", ratePlanId: "standard", adults: 2, addonIds: [] }]), false);
  assert.equal(bad([{ slug: "garden-suite", ratePlanId: "deluxe", adults: 2, addonIds: [] }]), false);
  assert.equal(
    bad([
      { slug: "magic-1-villa", ratePlanId: "standard", adults: 8, addonIds: [] },
      { slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] },
    ]),
    false,
  );
  assert.equal(bad([{ slug: "garden-suite", ratePlanId: "breakfast", adults: 2, addonIds: ["breakfast-pp"] }]), false);
  assert.equal(bad([{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: ["breakfast-pp"] }]), true); // Wed-Fri
  const weekendOnly = parseCheckoutRequest(
    { checkIn: "2026-11-07", checkOut: "2026-11-09", expectedTotalSatang: 0, expectedDueNowSatang: 0, items: [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: ["breakfast-pp"] }] },
    LIMITS,
  );
  assert.equal(weekendOnly.ok, false);
  assert.equal(bad([]), false);
  assert.equal(parseCheckoutRequest({ ...base, checkIn: "2026-10-01", items: [{ slug: "garden-suite", ratePlanId: "standard", adults: 2 }] }, LIMITS).ok, false);
  assert.equal(parseCheckoutRequest({ ...base, checkOut: "2026-12-20", items: [{ slug: "garden-suite", ratePlanId: "standard", adults: 2 }] }, LIMITS).ok, false);
});

test("search parsing defaults adults and rejects bad input", () => {
  const ok = parseSearch({ checkin: "2026-11-11", checkout: "2026-11-14" }, LIMITS);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.adults, 2);
  assert.equal(parseSearch({ checkin: "2026-11-11", checkout: "2026-11-14", adults: "99" }, LIMITS).ok, false);
  assert.equal(parseSearch({ checkin: "x", checkout: "2026-11-14", adults: "2" }, LIMITS).ok, false);
});

test("sold-out rooms are refused at checkout", async () => {
  // Find a window where honeymoon-suite is sold out in the demo calendar.
  let checkIn = "";
  for (let i = 0; i < 200 && !checkIn; i++) {
    const d = addDays("2026-11-02", i);
    if (!buildOffers(demoInventory(d, addDays(d, 3)), 2).find((o) => o.slug === "honeymoon-suite")?.available) checkIn = d;
  }
  const res = await runCheckout(
    { checkIn, checkOut: addDays(checkIn, 3), items: [{ slug: "honeymoon-suite", ratePlanId: "standard", adults: 2, addonIds: [] }], expectedTotalSatang: 1, expectedDueNowSatang: 1 },
    { config: demoConfig, origin: ORIGIN, nowMs: NOW },
  );
  assert.equal(res.status, 409);
  if (!res.body.ok) {
    assert.equal(res.body.error, "unavailable");
    assert.deepEqual(res.body.unavailableSlugs, ["honeymoon-suite"]);
  }
});

test("unknown promo codes fail with a friendly error", async () => {
  const res = await runCheckout({ ...requestFor("garden-suite"), promo: "FREE" }, { config: demoConfig, origin: ORIGIN, nowMs: NOW });
  assert.equal(res.status, 400);
  if (!res.body.ok) assert.equal(res.body.error, "promo_invalid");
});

test("demo pay -> signed proof -> status paid; no proof -> pending then expired", async () => {
  const res = await runCheckout(requestFor("sunrise-suite"), { config: demoConfig, origin: ORIGIN, nowMs: NOW });
  assert.ok(res.body.ok);
  if (!res.body.ok) return;
  const t = new URL(res.body.redirectUrl).searchParams.get("t") as string;

  const pending = await runStatus({ t, p: null, l: null }, { config: demoConfig, nowMs: NOW + 60_000 });
  assert.equal(pending.body.ok && pending.body.status, "pending");
  const expired = await runStatus({ t, p: null, l: null }, { config: demoConfig, nowMs: NOW + 31 * 60_000 });
  assert.equal(expired.body.ok && expired.body.status, "expired");

  const declined = runDemoPay({ t, outcome: "declined" }, { config: demoConfig, origin: ORIGIN, nowMs: NOW });
  assert.deepEqual(declined.body, { ok: true, status: "failed", failureCode: "CH_CARD_DECLINED" });

  const paid = runDemoPay({ t, outcome: "paid" }, { config: demoConfig, origin: ORIGIN, nowMs: NOW });
  assert.equal(paid.status, 200);
  assert.ok(paid.body.ok && paid.body.status === "paid");
  if (!(paid.body.ok && paid.body.status === "paid")) return;
  const ret = new URL(paid.body.returnUrl);
  assert.equal(ret.origin + ret.pathname, "https://magicsamui.com/booking-preview/return");
  const status = await runStatus({ t, p: ret.searchParams.get("p"), l: null }, { config: demoConfig, nowMs: NOW + 1000 });
  assert.equal(status.body.ok && status.body.status, "paid");
  if (status.body.ok) assert.equal(status.body.booking.ref, res.body.ref);
});

test("demo pay never accepts card data and is 404 outside demo mode", async () => {
  const res = await runCheckout(requestFor("garden-suite"), { config: demoConfig, origin: ORIGIN, nowMs: NOW });
  if (!res.body.ok) throw new Error("checkout failed");
  const t = new URL(res.body.redirectUrl).searchParams.get("t") as string;
  const withCard = runDemoPay({ t, outcome: "paid", cardNumber: "4111111111111111" }, { config: demoConfig, origin: ORIGIN, nowMs: NOW });
  assert.equal(withCard.status, 400);
  const pg = getBookingConfig({ BEAM_API_BASE: BEAM_PLAYGROUND_BASE, BEAM_MERCHANT_ID: "m", BEAM_API_KEY: "k", BOOKING_TOKEN_SECRET: TEST_SECRET });
  assert.equal(runDemoPay({ t, outcome: "paid" }, { config: pg, origin: ORIGIN, nowMs: NOW }).status, 404);
});

test("beam-playground checkout creates a payment link from the server quote", async () => {
  const pg = getBookingConfig({ BEAM_API_BASE: BEAM_PLAYGROUND_BASE, BEAM_MERCHANT_ID: "m1", BEAM_API_KEY: "k1", BOOKING_TOKEN_SECRET: TEST_SECRET });
  const req = requestFor("sunrise-suite");
  let sent: Record<string, unknown> | null = null;
  let headers: Record<string, string> = {};
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    headers = init.headers as Record<string, string>;
    return new Response(JSON.stringify({ id: "pl_1", url: "https://playground-pay.beamcheckout.com/m1/pl_1" }), { status: 201 });
  }) as unknown as typeof fetch;
  const res = await runCheckout(req, { config: pg, origin: ORIGIN, nowMs: NOW, fetchImpl: fakeFetch });
  assert.equal(res.status, 200);
  assert.ok(res.body.ok);
  if (!res.body.ok || !sent) return;
  const body = sent as { order: { netAmount: number; referenceId: string }; redirectUrl: string; cancelUrl: string };
  assert.equal(body.order.netAmount, req.expectedTotalSatang);
  assert.equal(body.order.referenceId, res.body.ref);
  assert.match(body.redirectUrl, /^https:\/\/magicsamui\.com\/booking-preview\/return\?ref=MSV-/);
  assert.match(body.cancelUrl, /^https:\/\/magicsamui\.com\/booking-preview\?resume=payment&ref=MSV-/);
  assert.match(headers["x-beam-idempotency-key"], /^[0-9a-f-]{36}$/);
  assert.equal(res.body.redirectUrl, "https://playground-pay.beamcheckout.com/m1/pl_1");
  const link = verifyBookingToken(res.body.linkToken, pg.tokenSecret, NOW);
  assert.equal(link.ok && link.payload.paymentLinkId, "pl_1");

  // Status asks Beam for the link and checks amount + reference.
  const t = new URL(body.redirectUrl).searchParams.get("t");
  const statusFetch = (async () =>
    new Response(
      JSON.stringify({ paymentLinkId: "pl_1", status: "PAID", order: { netAmount: req.expectedTotalSatang, currency: "THB", referenceId: res.body.ok ? res.body.ref : "" } }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const st = await runStatus({ t, p: null, l: res.body.linkToken }, { config: pg, nowMs: NOW + 5000, fetchImpl: statusFetch });
  assert.equal(st.body.ok && st.body.status, "paid");

  const wrongAmount = (async () =>
    new Response(JSON.stringify({ paymentLinkId: "pl_1", status: "PAID", order: { netAmount: 100, currency: "THB" } }), { status: 200 })) as unknown as typeof fetch;
  const st2 = await runStatus({ t, p: null, l: res.body.linkToken }, { config: pg, nowMs: NOW + 5000, fetchImpl: wrongAmount });
  assert.equal(st2.body.ok && st2.body.status, "failed");
});

test("status: no terminal 'expired' without Beam's own link status; a paid charge on a closed link wins", async () => {
  const pg = getBookingConfig({ BEAM_API_BASE: BEAM_PLAYGROUND_BASE, BEAM_MERCHANT_ID: "m1", BEAM_API_KEY: "k1", BOOKING_TOKEN_SECRET: TEST_SECRET });
  const req = requestFor("sunrise-suite");
  let sent: { redirectUrl: string } | null = null;
  const create = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body)) as { redirectUrl: string };
    return new Response(JSON.stringify({ id: "pl_9", url: "https://playground-pay.beamcheckout.com/m1/pl_9" }), { status: 201 });
  }) as unknown as typeof fetch;
  const res = await runCheckout(req, { config: pg, origin: ORIGIN, nowMs: NOW, fetchImpl: create });
  if (!res.body.ok || !sent) throw new Error("checkout failed");
  const t = new URL((sent as { redirectUrl: string }).redirectUrl).searchParams.get("t");
  const ref = res.body.ref;
  const linkToken = res.body.linkToken;
  const afterExpiry = NOW + 30 * 60_000 + 1000;

  // Server render of the return page (no link id): the charges list is empty
  // (not listed yet, or no referenceId on the charge) -> still pending.
  const asked: string[] = [];
  const nothing = (async (url: string) => {
    asked.push(url);
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const fallback = await runStatus({ t, p: null, l: null }, { config: pg, nowMs: afterExpiry, fetchImpl: nothing });
  assert.equal(fallback.body.ok && fallback.body.status, "pending");
  assert.match(asked[0], /referenceId=MSV-/);

  // With the link id: Beam says EXPIRED, but a charge on this link succeeded -> paid (looked up by sourceId).
  const due = req.expectedDueNowSatang;
  const lookedUp: string[] = [];
  const closedButPaid = (async (url: string) => {
    lookedUp.push(url);
    if (url.includes("/payment-links/")) {
      return new Response(JSON.stringify({ paymentLinkId: "pl_9", status: "EXPIRED", order: { netAmount: due, currency: "THB", referenceId: ref } }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({ data: [{ chargeId: "ch_1", status: "SUCCEEDED", amount: due, currency: "THB", source: "PAYMENT_LINK", sourceId: "pl_9" }] }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const paid = await runStatus({ t, p: null, l: linkToken }, { config: pg, nowMs: afterExpiry, fetchImpl: closedButPaid });
  assert.equal(paid.body.ok && paid.body.status, "paid");
  assert.ok(lookedUp.some((u) => u.includes("sourceId=pl_9")));

  // EXPIRED and no successful charge on the link -> expired.
  const closed = (async (url: string) =>
    url.includes("/payment-links/")
      ? new Response(JSON.stringify({ paymentLinkId: "pl_9", status: "EXPIRED", order: { netAmount: due, currency: "THB", referenceId: ref } }), { status: 200 })
      : new Response(JSON.stringify({ data: [{ chargeId: "ch_2", status: "FAILED", amount: due, currency: "THB" }] }), { status: 200 })) as unknown as typeof fetch;
  const expired = await runStatus({ t, p: null, l: linkToken }, { config: pg, nowMs: afterExpiry, fetchImpl: closed });
  assert.equal(expired.body.ok && expired.body.status, "expired");
});

test("Beam outage -> 502 upstream_error, nothing charged", async () => {
  const pg = getBookingConfig({ BEAM_API_BASE: BEAM_PLAYGROUND_BASE, BEAM_MERCHANT_ID: "m1", BEAM_API_KEY: "k1", BOOKING_TOKEN_SECRET: TEST_SECRET });
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const res = await runCheckout(requestFor("garden-suite"), { config: pg, origin: ORIGIN, nowMs: NOW, fetchImpl: down });
  assert.equal(res.status, 502);
  if (!res.body.ok) assert.equal(res.body.error, "upstream_error");
});

test("Cloudbeds failure falls back to demo data and says so", async () => {
  const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  let reported = false;
  const result = await getInventory(
    "2026-11-11",
    "2026-11-14",
    { dataSource: "cloudbeds", cloudbeds: { apiKey: "cbat_x", propertyId: null, baseRateOnly: false } },
    { fetchImpl: failing, onFallback: () => (reported = true) },
  );
  assert.equal(result.dataSource, "demo-fallback");
  assert.equal(reported, true);
  assert.deepEqual(result.inventory, demoInventory("2026-11-11", "2026-11-14"));
});

test("Cloudbeds failure in a Beam mode never falls back and never reaches Beam", async () => {
  const pg = getBookingConfig({
    BEAM_API_BASE: BEAM_PLAYGROUND_BASE,
    BEAM_MERCHANT_ID: "m1",
    BEAM_API_KEY: "k1",
    BOOKING_TOKEN_SECRET: TEST_SECRET,
    CLOUDBEDS_API_KEY: "cbat_x",
  });
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url.includes("beamcheckout")) {
      return new Response(JSON.stringify({ id: "pl_1", url: "https://playground-pay.beamcheckout.com/m1/pl_1" }), { status: 201 });
    }
    return new Response("down", { status: 500 });
  }) as unknown as typeof fetch;
  const logs: string[] = [];
  const res = await runCheckout(requestFor("garden-suite"), { config: pg, origin: ORIGIN, nowMs: NOW, fetchImpl, log: (m) => logs.push(m) });
  assert.equal(res.status, 503);
  if (!res.body.ok) assert.equal(res.body.error, "payment_unavailable");
  assert.equal(calls.some((u) => u.includes("beamcheckout")), false, "Beam must not be called");
  assert.ok(calls.every((u) => u.startsWith("https://api.cloudbeds.com/")));
  assert.ok(logs.includes("checkout_refused_cloudbeds_down"));

  await assert.rejects(
    getInventory("2026-11-11", "2026-11-14", pg, { fetchImpl, allowDemoFallback: false }),
    InventoryUnavailableError,
  );
});

test("beam-live refuses simulated inventory at checkout (defence in depth)", async () => {
  const live = getBookingConfig(
    {
      BEAM_API_BASE: BEAM_LIVE_BASE,
      BEAM_MERCHANT_ID: "m1",
      BEAM_API_KEY: "k1",
      BOOKING_TOKEN_SECRET: TEST_SECRET,
      BOOKING_ALLOW_LIVE_PAYMENTS: "true",
      VERCEL_ENV: "production",
      CLOUDBEDS_API_KEY: "cbat_x",
    },
    { liveFulfilmentReady: true },
  );
  // A config whose data source drifted to demo must still be refused before any call.
  const drifted = { ...live, dataSource: "demo" as const, cloudbeds: null };
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}", { status: 201 });
  }) as unknown as typeof fetch;
  const res = await runCheckout(requestFor("garden-suite"), { config: drifted, origin: ORIGIN, nowMs: NOW, fetchImpl });
  assert.equal(res.status, 503);
  assert.equal(called, false);
});

test("checkout asks Cloudbeds once per party size and prices each room at its occupancy", async () => {
  const cfg = getBookingConfig({ CLOUDBEDS_API_KEY: "cbat_x" });
  const asked: string[] = [];
  const nights = ["2026-11-11", "2026-11-12", "2026-11-13"];
  const fetchImpl = (async (url: string) => {
    const adults = new URL(url).searchParams.get("adults") ?? "";
    asked.push(adults);
    return new Response(
      JSON.stringify({
        success: true,
        data: [
          {
            propertyCurrency: [{ currencyCode: "THB" }],
            propertyRooms: [
              { roomTypeID: "462960", roomsAvailable: 1, adultsIncluded: 2, adultsExtraCharge: [], roomRateDetailed: nights.map((date) => ({ date, rate: 5000 })) },
              {
                roomTypeID: "462964",
                roomsAvailable: 1,
                adultsIncluded: 2,
                adultsExtraCharge: { "3": 1500, "4": 3000 },
                roomRateDetailed: nights.map((date) => ({ date, rate: 9000 })),
              },
            ],
          },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const items: CartItemInput[] = [
    { slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] },
    { slug: "seaview-2br", ratePlanId: "standard", adults: 4, addonIds: [] },
  ];
  const { inventory, dataSource } = await getCartInventory("2026-11-11", "2026-11-14", items, cfg, { fetchImpl });
  assert.equal(dataSource, "cloudbeds");
  // adults=1 is the price source (same as search); 2 and 4 only gate availability.
  assert.deepEqual(asked.sort(), ["1", "2", "4"]);
  const quote = computeQuote(
    { checkIn: "2026-11-11", checkOut: "2026-11-14", items, promo: null, pricing: { cardFeePct: 0, depositPct: 100 } },
    buildOffers(inventory, 1),
  );
  assert.equal(quote.lines[0].roomSatang, 15_000_00);
  assert.equal(quote.lines[1].occupancyExtraSatang, 3_000_00);
  assert.equal(quote.lines[1].roomSatang, 27_000_00 + 3_000_00);
});

/** Fake Cloudbeds whose roomRateDetailed DOES vary with the party size (surcharge folded into the rate). */
function occupancySensitiveCloudbeds(asked: string[], options: { hideAtAdults?: number } = {}): typeof fetch {
  const nights = ["2026-11-11", "2026-11-12", "2026-11-13"];
  return (async (url: string) => {
    const adults = Number(new URL(url).searchParams.get("adults") ?? "1");
    asked.push(String(adults));
    const rooms = [
      { roomTypeID: "462960", roomsAvailable: 1, adultsIncluded: 2, adultsExtraCharge: [], roomRateDetailed: nights.map((date) => ({ date, rate: 5000 })) },
    ];
    if (options.hideAtAdults !== adults) {
      rooms.push({
        roomTypeID: "462964",
        roomsAvailable: 1,
        adultsIncluded: 2,
        adultsExtraCharge: { "3": 1500, "4": 3000 } as unknown as never[],
        roomRateDetailed: nights.map((date) => ({ date, rate: 9000 + 500 * Math.max(0, adults - 2) })),
      });
    }
    return new Response(JSON.stringify({ success: true, data: [{ propertyCurrency: [{ currencyCode: "THB" }], propertyRooms: rooms }] }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
}

test("Cloudbeds rate varying with adults: search and checkout totals agree (no price_changed loop)", async () => {
  const cfg = getBookingConfig({ CLOUDBEDS_API_KEY: "cbat_x" });
  const asked: string[] = [];
  const fetchImpl = occupancySensitiveCloudbeds(asked);
  // What the browser prices from: the search answer (adults=1).
  const search = await getInventory("2026-11-11", "2026-11-14", cfg, { fetchImpl });
  const items: CartItemInput[] = [{ slug: "seaview-2br", ratePlanId: "standard", adults: 4, addonIds: [] }];
  const clientQuote = computeQuote(
    { checkIn: "2026-11-11", checkOut: "2026-11-14", items, promo: null, pricing: { cardFeePct: cfg.cardFeePct, depositPct: cfg.depositPct } },
    buildOffers(search.inventory, 4),
  );
  const logs: { message: string; data?: Record<string, unknown> }[] = [];
  const req: CheckoutRequest = {
    checkIn: "2026-11-11",
    checkOut: "2026-11-14",
    items,
    expectedTotalSatang: clientQuote.totalSatang,
    expectedDueNowSatang: clientQuote.dueNowSatang,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await runCheckout(req, { config: cfg, origin: ORIGIN, nowMs: NOW, fetchImpl, log: (message, data) => logs.push({ message, data }) });
    assert.equal(res.status, 200, `attempt ${attempt + 1}`);
    if (res.body.ok) assert.equal(res.body.quote.totalSatang, clientQuote.totalSatang);
  }
  // The divergence is reported so the open question gets answered from traffic.
  const note = logs.find((l) => l.message === "cloudbeds_occupancy_rate_differs");
  assert.ok(note);
  assert.equal(note.data?.slug, "seaview-2br");
  assert.equal(note.data?.base1Satang, 27_000_00);
  assert.equal(note.data?.baseNSatang, 30_000_00);
  assert.equal(note.data?.rateIncludesExtra, true);
});

test("a room Cloudbeds does not offer at the party size is refused at checkout", async () => {
  const cfg = getBookingConfig({ CLOUDBEDS_API_KEY: "cbat_x" });
  const asked: string[] = [];
  const fetchImpl = occupancySensitiveCloudbeds(asked, { hideAtAdults: 4 });
  const items: CartItemInput[] = [{ slug: "seaview-2br", ratePlanId: "standard", adults: 4, addonIds: [] }];
  const res = await runCheckout(
    { checkIn: "2026-11-11", checkOut: "2026-11-14", items, expectedTotalSatang: 1, expectedDueNowSatang: 1 },
    { config: cfg, origin: ORIGIN, nowMs: NOW, fetchImpl },
  );
  assert.equal(res.status, 409);
  if (!res.body.ok) {
    assert.equal(res.body.error, "unavailable");
    assert.deepEqual(res.body.unavailableSlugs, ["seaview-2br"]);
    // An occupancy limit, not a sale: the guest is told to try fewer guests.
    assert.deepEqual(res.body.occupancySlugs, ["seaview-2br"]);
    assert.match(res.body.message, /can't be booked online for 4 guests/);
  }
});

test("party-size checks run one after another, and Cloudbeds maxGuests caps the party", async () => {
  const cfg = getBookingConfig({ CLOUDBEDS_API_KEY: "cbat_x" });
  const nights = ["2026-11-11", "2026-11-12", "2026-11-13"];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = (async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    const room = (roomTypeID: string, maxGuests: number) => ({
      roomTypeID,
      roomsAvailable: 1,
      maxGuests,
      adultsIncluded: 2,
      adultsExtraCharge: [],
      roomRateDetailed: nights.map((date) => ({ date, rate: 5000 })),
    });
    return new Response(
      JSON.stringify({
        success: true,
        data: [{ propertyCurrency: [{ currencyCode: "THB" }], propertyRooms: [room("462958", 2), room("462961", 2), room("464009", 3)] }],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const items: CartItemInput[] = [
    { slug: "honeymoon-suite", ratePlanId: "standard", adults: 1, addonIds: [] },
    { slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] },
    { slug: "tuxedo", ratePlanId: "standard", adults: 4, addonIds: [] },
  ];
  const { inventory } = await getCartInventory("2026-11-11", "2026-11-14", items, cfg, { fetchImpl });
  assert.equal(maxInFlight, 1);
  assert.equal(buildOffers(inventory, 4).find((o) => o.slug === "tuxedo")?.maxAdults, 3);

  const res = await runCheckout(
    { checkIn: "2026-11-11", checkOut: "2026-11-14", items: [items[2]], expectedTotalSatang: 1, expectedDueNowSatang: 1 },
    { config: cfg, origin: ORIGIN, nowMs: NOW, fetchImpl },
  );
  assert.equal(res.status, 409);
  if (!res.body.ok) assert.deepEqual(res.body.occupancySlugs, ["tuxedo"]);
});

test("a changed amount due now (deposit) is a price change even when the total matches", async () => {
  const req = requestFor("garden-suite");
  const res = await runCheckout({ ...req, expectedDueNowSatang: Math.round(req.expectedDueNowSatang * 0.3) }, { config: demoConfig, origin: ORIGIN, nowMs: NOW });
  assert.equal(res.status, 409);
  if (!res.body.ok) {
    assert.equal(res.body.error, "price_changed");
    assert.equal(res.body.quote?.dueNowSatang, req.expectedDueNowSatang);
  }
  assert.equal(parseCheckoutRequest({ ...req, expectedDueNowSatang: undefined }, LIMITS).ok, false);
});

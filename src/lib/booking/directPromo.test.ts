// The DIRECT code on the own engine (owner decision 1, 2026-10-06): the guest's
// code sells Cloudbeds' own "Direct booking rate" plan (a derived, promo-code
// plan that is not synced to the OTAs) instead of being ignored. Covers the
// config switch (BOOKING_DIRECT_PROMO / BOOKING_PROMO_CODE /
// CLOUDBEDS_PROMO_CODE), availability with and without the code, the combined
// base + derived stay rules, the hold (roomRateID + promoCode), Cloudbeds
// pricing the hold at the base rate, the classic-page note when the code can't
// be applied, the DIRECT copy swap, GA4 coupon, and the demo staying as it was.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NO_BASE_RATE_ERROR_WINDOW_MS, buildOffers, getInventory, promoVerdictForInventory } from "./availability.ts";
import { runCheckout } from "./checkout.ts";
import { couponOf, purchaseParams } from "./clientAnalytics.ts";
import { evaluateRestrictions, mergePromoAnswer, parseAvailableRoomTypes, parsePromoRatePlans } from "./cloudbedsProvider.ts";
import type { PromoRateIndex } from "./cloudbedsProvider.ts";
import { directCopySwapped, getBookingConfig, getInventoryConfig, getPublicBookingConfig } from "./config.ts";
import type { Env } from "./config.ts";
import { ROOM_TYPE_TO_SLUG } from "../../data/cloudbeds.ts";
import { addDays } from "./dates.ts";
import { demoInventory } from "./demoProvider.ts";
import { FAKE_DIRECT_PROMO_CODE } from "./mock/fakeCloudbeds.ts";
import type { FakeRoomType } from "./mock/fakeCloudbeds.ts";
import { QuoteError, computeQuote, promoCodeHint, promoInputOffered, resolvePromo, resolvePromoFor } from "./quote.ts";
import { DIRECT_AT_BASE_ALERT, classifyHoldTotal } from "./stripeCheckout.ts";
import { handleStripeWebhook } from "./stripeWebhook.ts";
import { FAR_CHECKIN, FAR_CHECKOUT, HONEYMOON, NOW, ORIGIN, ROOM_TYPES, STRIPE_LIVE_ENV, STRIPE_TEST_ENV, checkout, makeKit, sessionIdOf } from "./testkit.ts";
import type { Kit } from "./testkit.ts";
import { verifyBookingToken } from "./token.ts";
import type { CartItemInput, CheckoutRequest, CheckoutSuccess, RoomInventory } from "./types.ts";

const MOCK_ENV: Env = { BOOKING_PAYMENT_PROVIDER: "stripe", BOOKING_STRIPE_MOCK: "true" };
const BEAM_ENV: Env = {
  BOOKING_PAYMENT_PROVIDER: "beam",
  BEAM_API_BASE: "https://playground.api.beamcheckout.com",
  BEAM_MERCHANT_ID: "m",
  BEAM_API_KEY: "k",
  BOOKING_TOKEN_SECRET: "test-only-7f3K9qLm2xVw8RtY4pZn6bHc1dJe5gUa",
};

/** The fake property with a Direct plan on the Honeymoon Suite and the Garden Suite (not on the Sunrise Suite). */
const DIRECT_ROOM_TYPES: Record<string, FakeRoomType> = {
  ...ROOM_TYPES,
  "462958": { ...ROOM_TYPES["462958"], directRateId: "rate-hm-direct" },
  "462961": { ...ROOM_TYPES["462961"], directRateId: "rate-gs-direct" },
};
const SUNRISE: CartItemInput[] = [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
/** 3 nights of the Honeymoon Suite: base 9,000/night, Direct 80% = 7,200/night. */
const HM_BASE = 3 * 900_000;
const HM_DIRECT = 3 * 720_000;

function directKit(options: { env?: Env; roomTypes?: Record<string, FakeRoomType>; directPricedAtBase?: boolean } = {}): Kit {
  return makeKit({ env: options.env, cb: { roomTypes: options.roomTypes ?? DIRECT_ROOM_TYPES, directPricedAtBase: options.directPricedAtBase } });
}

const postOf = (kit: Kit) => kit.fakeCb.calls.find((c) => c.method === "postReservation");
const unfilteredRatePlanReads = (kit: Kit) => kit.fakeCb.calls.filter((c) => c.method === "getRatePlans" && c.params.roomTypeID === undefined).length;

/* --------------------------------- config --------------------------------- */

test("promo settings: Stripe with live Cloudbeds rates sells the Direct rate (default on); off / no Cloudbeds rates point to the classic page; Beam takes no code", () => {
  const on = getBookingConfig(STRIPE_TEST_ENV).promo;
  assert.deepEqual(on, { mode: "direct-rate", code: "DIRECT", pct: 0, cloudbedsCode: "Direct" });
  assert.equal(getBookingConfig({ ...STRIPE_TEST_ENV, BOOKING_DIRECT_PROMO: "on" }).promo.mode, "direct-rate");
  assert.equal(getBookingConfig({ ...STRIPE_TEST_ENV, BOOKING_DIRECT_PROMO: "" }).promo.mode, "direct-rate", "empty = unset = on");
  for (const off of ["off", "OFF", " false ", "0", "no"]) {
    assert.equal(getBookingConfig({ ...STRIPE_TEST_ENV, BOOKING_DIRECT_PROMO: off }).promo.mode, "classic-only", off);
  }
  assert.equal(getBookingConfig(MOCK_ENV).promo.mode, "classic-only", "MOCK: demo prices, no Cloudbeds Direct rows to sell");
  assert.equal(getBookingConfig(BEAM_ENV).promo.mode, "off");
  // The code guests type (trimmed, upper case) and Cloudbeds' code (kept as is); bad values fall back.
  const custom = getBookingConfig({ ...STRIPE_TEST_ENV, BOOKING_PROMO_CODE: " summer26 ", CLOUDBEDS_PROMO_CODE: "DirectWeb" }).promo;
  assert.equal(custom.code, "SUMMER26");
  assert.equal(custom.cloudbedsCode, "DirectWeb");
  const bad = getBookingConfig({ ...STRIPE_TEST_ENV, BOOKING_PROMO_CODE: "no spaces!", CLOUDBEDS_PROMO_CODE: "a b" }).promo;
  assert.equal(bad.code, "DIRECT");
  assert.equal(bad.cloudbedsCode, "Direct");
  // Inventory config (availability API) agrees with the full config, and never throws.
  assert.deepEqual(getInventoryConfig(STRIPE_TEST_ENV).promo, on);
});

test("public config: the code pill and hint follow the promo mode (the hint only where the code lowers the price)", () => {
  const direct = getPublicBookingConfig(STRIPE_TEST_ENV);
  assert.equal(direct.promoMode, "direct-rate");
  assert.equal(direct.promoCode, "DIRECT");
  assert.equal(promoInputOffered(direct), true);
  assert.equal(promoCodeHint(direct), "DIRECT");
  const classic = getPublicBookingConfig({ ...STRIPE_TEST_ENV, BOOKING_DIRECT_PROMO: "off" });
  assert.equal(classic.promoEnabled, false);
  assert.equal(promoInputOffered(classic), true, "the code can still be entered, and is answered with the classic-page note");
  assert.equal(promoCodeHint(classic), null, "never suggests a code this page can't apply");
  const beam = getPublicBookingConfig(BEAM_ENV);
  assert.equal(promoInputOffered(beam), false);
  // A locked config (nobody can pay) still reports the mode its pages would have.
  assert.equal(getPublicBookingConfig({ BOOKING_PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_live_abcdefghijkl", CLOUDBEDS_API_KEY: "k" }).promoMode, "direct-rate");
});

/* ------------------------------ code verdicts ------------------------------ */

test("resolvePromoFor: direct-rate accepts the code (any case, trimmed) with no site-side %; another code only as the rate-plan index finds it (promoCodes.test.ts)", () => {
  const s = getBookingConfig(STRIPE_TEST_ENV).promo;
  assert.deepEqual(resolvePromoFor(" direct ", s, "/booking"), { code: "DIRECT", valid: true, pct: 0, label: "Direct rate" });
  // Without the rate-plan index's lookup, any other code fails closed.
  assert.deepEqual(resolvePromoFor("FREE", s, "/booking"), { code: "FREE", valid: false, message: "Code FREE isn't valid for these dates." });
  assert.equal(resolvePromoFor("<b>", s, "/booking")?.valid, false);
  assert.equal(resolvePromoFor("", s, "/booking"), null);
});

test("flag off (or no Cloudbeds rates): the code gets a clear note linking the classic booking page instead of being ignored", () => {
  for (const env of [
    { ...STRIPE_TEST_ENV, BOOKING_DIRECT_PROMO: "off" },
    { ...MOCK_ENV, BOOKING_ENGINE: "own" },
  ]) {
    const pub = getPublicBookingConfig(env);
    const r = resolvePromoFor("direct", getInventoryConfig(env).promo, pub.classicBookingPath);
    assert.ok(r && !r.valid);
    if (r && !r.valid) {
      assert.equal(r.note, true);
      assert.match(r.message, /can't be applied on this page/);
      assert.deepEqual(r.link, { href: pub.classicBookingPath, text: "Book with code DIRECT on our classic booking page" });
    }
  }
  assert.equal(getPublicBookingConfig({ ...MOCK_ENV, BOOKING_ENGINE: "own" }).classicBookingPath, "/booking/classic");
  // The switch turns EVERY code off (owner decision, 2026-10-07: any Cloudbeds code works on the own page while it is on):
  // any other code gets the same classic-page note, never checked against Cloudbeds.
  const r = resolvePromoFor("free", getInventoryConfig({ ...STRIPE_TEST_ENV, BOOKING_DIRECT_PROMO: "off" }).promo, "/booking/classic");
  assert.ok(r && !r.valid && r.note === true);
  if (r && !r.valid) assert.deepEqual(r.link, { href: "/booking/classic", text: "Book with code FREE on our classic booking page" });
});

test("demo mode is unchanged: the site-side DIRECT % (default 10), the same verdicts as before, no Direct rate", async () => {
  const demo = getBookingConfig({});
  assert.deepEqual(demo.promo, { mode: "discount", code: "DIRECT", pct: 10, cloudbedsCode: "Direct" });
  assert.equal(demo.promoPct, 10);
  for (const code of ["direct", "DIRECT", "FREE", "", "<x>"]) {
    assert.deepEqual(resolvePromoFor(code, demo.promo, "/booking"), resolvePromo(code, 10), code);
  }
  assert.equal(getPublicBookingConfig({}).promoEnabled, true);
  assert.equal(promoCodeHint(getPublicBookingConfig({})), "DIRECT");
  // A demo checkout with DIRECT: 10% off the rooms, as before; nothing about Cloudbeds' Direct rate.
  let checkIn = "2026-11-02";
  while (!buildOffers(demoInventory(checkIn, addDays(checkIn, 3)), 2).find((o) => o.slug === "garden-suite")?.available) checkIn = addDays(checkIn, 1);
  const body = { checkIn, checkOut: addDays(checkIn, 3), promo: "direct", items: [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }], expectedTotalSatang: 1, expectedDueNowSatang: 1 };
  const res = await runCheckout(body, { config: demo, origin: ORIGIN, nowMs: NOW });
  assert.equal(res.body.ok ? "" : res.body.error, "price_changed", JSON.stringify(res.body));
  const quote = res.body.ok ? null : res.body.quote;
  assert.equal(quote?.promo?.pct, 10);
  assert.equal(quote?.directRate ?? null, null);
  const unknown = await runCheckout({ ...body, promo: "FREE" }, { config: demo, origin: ORIGIN, nowMs: NOW });
  assert.equal(unknown.body.ok ? "" : unknown.body.error, "promo_invalid", "an unknown code is still refused in the demo");
});

/* ------------------------------- availability ------------------------------ */

test("availability with the code: Cloudbeds is asked with its promo code and the Direct rows (found by rateID) are sold next to their base row", async () => {
  const kit = directKit();
  const without = await getInventory(FAR_CHECKIN, FAR_CHECKOUT, kit.config, { fetchImpl: kit.fakeCb.fetch, allowDemoFallback: false });
  const hm0 = without.inventory.find((i) => i.slug === "honeymoon-suite")!;
  assert.equal(hm0.rateId, "rate-hm");
  assert.equal(hm0.discount, undefined);
  assert.equal(hm0.promoNotApplied, undefined, "without a code nothing changes");
  assert.equal(kit.fakeCb.calls.find((c) => c.method === "getAvailableRoomTypes")?.params.promoCode, undefined);
  // The one rate-plan index read is the automatic discounts' (on by default); it finds none on these room types.
  assert.equal(unfilteredRatePlanReads(kit), 1);

  const withCode = await getInventory(FAR_CHECKIN, FAR_CHECKOUT, kit.config, { fetchImpl: kit.fakeCb.fetch, allowDemoFallback: false, promo: { cloudbedsCode: "Direct" } });
  // Live, Cloudbeds' answer WITH the code has no base rows (Stage B 2026-10-07), so the search asks twice: plain and with the code.
  const withCodeReads = kit.fakeCb.calls.filter((c) => c.method === "getAvailableRoomTypes").slice(1);
  assert.deepEqual(withCodeReads.map((c) => c.params.promoCode ?? null).sort(), ["Direct", null]);
  assert.equal(unfilteredRatePlanReads(kit) - 1, 1, "one getRatePlans read for every room type (the Direct rows and the automatic discounts alike)");
  const hm = withCode.inventory.find((i) => i.slug === "honeymoon-suite")!;
  assert.equal(hm.rateId, "rate-hm-direct");
  assert.deepEqual(hm.baseNightly.map((n) => n.amountSatang), [720_000, 720_000, 720_000]);
  assert.equal(hm.discount?.kind, "direct");
  assert.equal(hm.discount?.baseRateId, "rate-hm");
  assert.deepEqual(hm.discount?.baseNightly.map((n) => n.amountSatang), [900_000, 900_000, 900_000]);
  // Each room type has its own Direct rateID.
  assert.equal(withCode.inventory.find((i) => i.slug === "garden-suite")?.rateId, "rate-gs-direct");
  // No Direct plan on the Sunrise Suite: its base row, marked so the page says the code doesn't apply.
  const sr = withCode.inventory.find((i) => i.slug === "sunrise-suite")!;
  assert.equal(sr.rateId, "rate-sr");
  assert.equal(sr.discount, undefined);
  assert.equal(sr.promoNotApplied, true);

  // Offers: the Direct price, with the base price as the struck-through list price; the quote holds the Direct total.
  const offers = buildOffers(withCode.inventory, 2, ["standard"]);
  const hmOffer = offers.find((o) => o.slug === "honeymoon-suite")!;
  assert.equal(hmOffer.rates[0].totalSatang, HM_DIRECT);
  assert.ok(hmOffer.rates[0].list);
  assert.equal(offers.find((o) => o.slug === "sunrise-suite")?.promoNotApplied, true);
  const q = computeQuote(
    { checkIn: FAR_CHECKIN, checkOut: FAR_CHECKOUT, items: HONEYMOON, promo: { code: "DIRECT", pct: 0, label: "Direct rate" }, pricing: { cardFeePct: 5, depositPct: 100 } },
    offers,
  );
  assert.equal(q.roomsSubtotalSatang, HM_DIRECT);
  assert.equal(q.lines[0].listRoomSatang, HM_BASE);
  assert.deepEqual(q.directRate, { code: "DIRECT", label: "Direct rate - code DIRECT", baseRoomsSatang: HM_BASE, savingSatang: HM_BASE - HM_DIRECT });
  assert.equal(q.promo, null, "nothing deducted again below the rooms");
  assert.equal(q.cardFeeSatang, Math.round(HM_DIRECT * 0.05), "the 5% fee is on the Direct total");
  assert.equal(q.totalSatang, HM_DIRECT + Math.round(HM_DIRECT * 0.05));
});

const NIGHTS = [{ date: "2027-11-10" }, { date: "2027-11-11" }, { date: "2027-11-12" }];
function answer(rows: Record<string, unknown>[]) {
  return { success: true, data: [{ propertyCurrency: { currencyCode: "THB" }, propertyRooms: rows }] };
}
function row(roomTypeID: string, roomRateID: string, rate: number, extra: Record<string, unknown> = {}) {
  return { roomTypeID, roomRateID, roomsAvailable: 1, roomRateDetailed: NIGHTS.map((n) => ({ ...n, rate })), ratePlanNamePublic: "default", derivedType: null, ...extra };
}

test("Direct rows are matched by rateID only: never by name, never from another room type, never when not derived from the base row or not cheaper", () => {
  const rates: PromoRateIndex = { "462958": [{ rateId: "hm-direct", parentRateId: "hm-base" }], "462961": [{ rateId: "gs-direct", parentRateId: "other" }] };
  const logs: string[] = [];
  const inv = parseAvailableRoomTypes(
    answer([
      row("462958", "hm-base", 9000),
      // Named like the Direct plan but not a promo rateID: a derived row, never sold.
      row("462958", "hm-lookalike", 5000, { ratePlanNamePublic: "Direct booking rate", derivedType: "percentage" }),
      row("462958", "hm-direct", 7200, { ratePlanNamePublic: "Direct booking rate", derivedType: "percentage" }),
      row("462961", "gs-base", 3000),
      row("462961", "gs-direct", 2400, { derivedType: "percentage" }),
      row("462960", "sr-base", 4500),
      // The Honeymoon's Direct rateID on another room type means nothing there.
      row("462960", "hm-direct", 1000, { derivedType: "percentage" }),
      row("462962", "sv1-base", 5000),
      row("462962", "sv1-direct", 6000, { derivedType: "percentage" }),
      // A Direct row with no base row sells nothing.
      row("462964", "sv2-direct", 4000, { derivedType: "percentage" }),
    ]),
    FAR_CHECKIN,
    FAR_CHECKOUT,
    { baseRateOnly: true, promo: { rates: { ...rates, "462962": [{ rateId: "sv1-direct", parentRateId: null }], "462964": [{ rateId: "sv2-direct", parentRateId: null }] } }, log: (m) => logs.push(m) },
  );
  const by = (slug: string) => inv.find((i) => i.slug === slug)!;
  assert.equal(by("honeymoon-suite").rateId, "hm-direct");
  assert.equal(by("garden-suite").rateId, "gs-base", "derived from another rate: not sold as Direct");
  assert.equal(by("garden-suite").promoNotApplied, true);
  assert.equal(by("sunrise-suite").rateId, "sr-base");
  assert.equal(by("seaview-suite").rateId, "sv1-base", "not cheaper than the base rate: base sold");
  assert.equal(by("seaview-2br").available, false);
  assert.equal(logs.filter((m) => m === "cloudbeds_promo_row_unused").length, 2);
  assert.equal(ROOM_TYPE_TO_SLUG["462962"], "seaview-suite");

  // getRatePlans rows: the promo code is compared case-insensitively; other codes and rows without a room type are skipped.
  const index = parsePromoRatePlans(
    {
      success: true,
      data: [
        { rateID: 3195765, roomTypeID: "462958", promoCode: "DIRECT", parentRateID: 1375281 },
        { rateID: 1, roomTypeID: "462958", promoCode: "SabaiTravel2026" },
        { rateID: 2, roomTypeID: "462961", promoCode: null },
        { rateID: 3, promoCode: "Direct" },
      ],
    },
    "Direct",
  );
  assert.deepEqual(index, { "462958": [{ rateId: "3195765", parentRateId: "1375281" }] });
});

test("a DIRECT search whose answer lost the base rows (only the Direct row back) is flagged cloudbeds_no_base_rate and alerts the owner, never a silent sell-out (Stage B case 24 (0))", async (t) => {
  const errors = t.mock.method(console, "error", () => undefined);
  const infos = t.mock.method(console, "info", () => undefined);
  const rates: PromoRateIndex = { "462958": [{ rateId: "hm-direct", parentRateId: "hm-base" }] };
  // No base row and no Breakfast row: the Direct row is the only thing that can mark the room.
  const directOnly = answer([row("462958", "hm-direct", 7200, { ratePlanNamePublic: "Direct booking rate", derivedType: "percentage" })]);
  const noBase: string[] = [];
  const inv = parseAvailableRoomTypes(directOnly, FAR_CHECKIN, FAR_CHECKOUT, { baseRateOnly: true, promo: { rates }, onNoBaseRate: (s) => noBase.push(s) });
  assert.deepEqual(noBase, ["honeymoon-suite"]);
  assert.equal(inv.find((i) => i.slug === "honeymoon-suite")?.available, false);

  // Through the search: the log lines and the owner alert the runbook tells the owner to look for (then BOOKING_DIRECT_PROMO=off).
  const called: string[][] = [];
  const r = await getInventory(FAR_CHECKIN, FAR_CHECKOUT, { dataSource: "cloudbeds", cloudbeds: { apiKey: "k", propertyId: null, baseRateOnly: true } }, {
    fetchImpl: (async () => Response.json(directOnly)) as unknown as typeof fetch,
    // Long before goLiveRound3's searches: `node --test src/lib/booking` runs every file in one process, and the window is per instance.
    nowMs: NOW - 100 * NO_BASE_RATE_ERROR_WINDOW_MS,
    promo: { cloudbedsCode: "Direct", rates },
    onNoBaseRateAll: (slugs) => void called.push(slugs),
  });
  assert.equal(r.inventory.some((i) => i.available), false);
  assert.ok(infos.mock.calls.some((c) => c.arguments[0] === "[booking] cloudbeds_no_base_rate" && String(c.arguments[1]).includes("honeymoon-suite")));
  assert.equal(errors.mock.calls[0]?.arguments[0], "[booking] cloudbeds_no_base_rate_all");
  assert.deepEqual(called, [["honeymoon-suite"]]);
});

test("a Direct row sold next to its base row: the lower occupancy limit of the two rows, and at most 1 unit", () => {
  const parse = (baseMax: number, directMax: number) =>
    parseAvailableRoomTypes(
      answer([
        row("462958", "hm-base", 9000, { maxGuests: baseMax, roomsAvailable: 3 }),
        row("462958", "hm-direct", 7200, { maxGuests: directMax, roomsAvailable: 3, derivedType: "percentage" }),
      ]),
      FAR_CHECKIN,
      FAR_CHECKOUT,
      { baseRateOnly: true, promo: { rates: { "462958": [{ rateId: "hm-direct", parentRateId: "hm-base" }] } } },
    ).find((i) => i.slug === "honeymoon-suite")!;
  const higherDirect = parse(2, 4);
  assert.equal(higherDirect.rateId, "hm-direct");
  assert.equal(higherDirect.maxGuests, 2, "never more guests than the base row allows");
  assert.equal(higherDirect.remaining, 1, "one unit per cart line, however many Cloudbeds has free");
  assert.equal(parse(4, 2).maxGuests, 2, "nor more than the Direct row allows");
});

test("the search verdict: a valid code that no available room gets the Direct rate for becomes a note, never 'applied' over standard prices", () => {
  const valid = { code: "DIRECT", valid: true as const, pct: 0, label: "Direct rate" };
  const base: RoomInventory = { slug: "sunrise-suite", available: true, remaining: 1, baseNightly: [], promoNotApplied: true };
  const direct: RoomInventory = { ...base, slug: "honeymoon-suite", promoNotApplied: undefined, discount: { kind: "direct", name: "Direct booking rate", baseRateId: "b", baseNightly: [], baseAdultsExtraSatang: {} } };
  const none = promoVerdictForInventory(valid, "direct-rate", [base]);
  assert.ok(none && !none.valid && none.note === true);
  assert.match(none && !none.valid ? none.message : "", /^Code DIRECT doesn't apply to these dates/);
  assert.equal(promoVerdictForInventory(valid, "direct-rate", [base, direct]), valid);
  assert.equal(promoVerdictForInventory(valid, "direct-rate", [{ ...base, available: false }]), valid, "nothing available: nothing to say about the code");
  assert.equal(promoVerdictForInventory(valid, "discount", [base]), valid, "the demo is unchanged");
});

test("computeQuote: a Direct rate whose struck-through base price (or own price) covers another number of nights is refused, never shown", () => {
  const nightly = (count: number, amountSatang: number) => Array.from({ length: count }, (_, i) => ({ date: addDays(FAR_CHECKIN, i), amountSatang }));
  const hm = (directNights: number, baseNights: number): RoomInventory => ({
    slug: "honeymoon-suite",
    available: true,
    remaining: 1,
    baseNightly: nightly(directNights, 720_000),
    discount: { kind: "direct", name: "Direct booking rate", baseRateId: "hm-base", baseNightly: nightly(baseNights, 900_000), baseAdultsExtraSatang: {} },
  });
  const quote = (inv: RoomInventory) =>
    computeQuote(
      { checkIn: FAR_CHECKIN, checkOut: FAR_CHECKOUT, items: HONEYMOON, promo: { code: "DIRECT", pct: 0, label: "Direct rate" }, pricing: { cardFeePct: 5, depositPct: 100 } },
      buildOffers([inv], 2, ["standard"]),
    );
  assert.equal(quote(hm(3, 3)).lines[0].listRoomSatang, HM_BASE);
  for (const [directNights, baseNights] of [[3, 2], [2, 3]]) {
    assert.throws(() => quote(hm(directNights, baseNights)), (e) => e instanceof QuoteError && /Rate nights mismatch/.test(e.message), `${directNights}/${baseNights} nights`);
  }
});

/* ------------------------------ stay rules ------------------------------ */

function ratePlansAnswer(baseDays: Record<string, unknown>[], directDays: Record<string, unknown>[], directExtra: Record<string, unknown> = {}) {
  const days = (overrides: Record<string, unknown>[]) =>
    ["2027-11-10", "2027-11-11", "2027-11-12", "2027-11-13"].map((date, i) => ({ date, minLos: 0, maxLos: 0, closedToArrival: false, closedToDeparture: false, blocked: false, roomsAvailable: 1, ...(overrides[i] ?? {}) }));
  return {
    success: true,
    data: [
      { rateID: "hm-breakfast", isDerived: true, ratePlanID: "p-bf", ratePlanNamePublic: "Breakfast", promoCode: null, roomRateDetailed: days([]) },
      { rateID: "hm-direct", isDerived: true, ratePlanID: "484584", ratePlanNamePublic: "Direct booking rate", promoCode: "Direct", parentRateID: "hm-base", roomRateDetailed: days(directDays), ...directExtra },
      { rateID: "hm-base", isDerived: false, ratePlanID: null, ratePlanNamePublic: null, roomRateDetailed: days(baseDays) },
    ],
  };
}
const PROMO = { cloudbedsCode: "Direct", baseRateId: "hm-base" };
const check = (json: unknown, checkOut = "2027-11-13", rateId = "hm-direct", promo: typeof PROMO | null = PROMO) =>
  evaluateRestrictions(json, "462958", rateId, "2027-11-10", checkOut, { promo });

test("stay rules for the Direct rate: the derived row AND its base row over every stay night (strictest wins; 0 = no limit)", () => {
  // Base minLos 2 blocks a 1-night Direct stay, though the Direct row itself says 0.
  const minBase = ratePlansAnswer([{ minLos: 2 }], []);
  assert.deepEqual(check(minBase, "2027-11-11"), { ok: false, reason: "min_stay", minNights: 2, promo: true });
  assert.deepEqual(check(minBase, "2027-11-11", "hm-direct", null), { ok: true, checked: true, derived: true }, "the Direct row alone would pass (and is refused as derived)");
  // The highest positive minLos of either row, on any stay night.
  assert.deepEqual(check(ratePlansAnswer([{}, { minLos: 2 }], [{}, {}, { minLos: 4 }])), { ok: false, reason: "min_stay", minNights: 4, promo: true });
  // The lowest positive maxLos of either row (0 = no limit).
  assert.deepEqual(check(ratePlansAnswer([{ maxLos: 0 }], [{ maxLos: 2 }])), { ok: false, reason: "max_stay", maxNights: 2, promo: true });
  // Closed to arrival on either row's arrival day; closed to departure on either row's departure-day row.
  assert.equal(check(ratePlansAnswer([{ closedToArrival: true }], [])).ok, false);
  assert.deepEqual(check(ratePlansAnswer([], [{}, {}, {}, { closedToDeparture: true }])), { ok: false, reason: "closed_to_departure", promo: true });
  // Blocked / no room left on either row.
  assert.deepEqual(check(ratePlansAnswer([{}, { blocked: true }], [])), { ok: false, reason: "blocked", promo: true });
  assert.deepEqual(check(ratePlansAnswer([], [{}, {}, { roomsAvailable: 0 }])), { ok: false, reason: "sold_out", promo: true });
  // Nothing set: checked and allowed, marked as the Direct rate (never as a refused derived row).
  assert.deepEqual(check(ratePlansAnswer([], [])), { ok: true, checked: true, promo: true });
});

test("stay rules: any derived rate other than the Direct rate selected for this booking is still refused", () => {
  const ok = ratePlansAnswer([], []);
  // A tampered rateId (the Breakfast package) presented as the Direct rate.
  assert.deepEqual(check(ok, "2027-11-13", "hm-breakfast"), { ok: true, checked: false, derived: true });
  // The rate isn't listed at all.
  assert.deepEqual(check(ok, "2027-11-13", "999"), { ok: true, checked: false, derived: true });
  // Another promo code, a parent that isn't the base row, a base row other than the one priced.
  assert.deepEqual(check(ok, "2027-11-13", "hm-direct", { ...PROMO, cloudbedsCode: "Other" }), { ok: true, checked: false, derived: true });
  assert.deepEqual(check(ratePlansAnswer([], [], { parentRateID: "hm-breakfast" })), { ok: true, checked: false, derived: true });
  assert.deepEqual(check(ok, "2027-11-13", "hm-direct", { ...PROMO, baseRateId: "hm-other" }), { ok: true, checked: false, derived: true });
  // getRatePlans sends no parentRateID: allowed next to the base row it was priced with, refused next to another.
  assert.deepEqual(check(ratePlansAnswer([], [], { parentRateID: null })), { ok: true, checked: true, promo: true });
  assert.deepEqual(check(ratePlansAnswer([], [], { parentRateID: null }), "2027-11-13", "hm-direct", { ...PROMO, baseRateId: "hm-other" }), { ok: true, checked: false, derived: true });
  // Without a selected Direct rate a derived row stays refused, as before.
  assert.equal(check(ok, "2027-11-13", "hm-direct", null).derived, true);
});

test("stay rules for the Direct rate: either row missing the arrival day means 'not checked' (alerted), never 'checked'", () => {
  for (const rateId of ["hm-base", "hm-direct"]) {
    const json = ratePlansAnswer([], []);
    const r = json.data.find((x) => x.rateID === rateId)!;
    r.roomRateDetailed = r.roomRateDetailed.filter((d) => d.date !== "2027-11-10");
    assert.deepEqual(check(json), { ok: true, checked: false, promo: true }, `${rateId} without the arrival day`);
  }
});

/* --------------------------------- checkout -------------------------------- */

test("happy path: DIRECT books the Direct rate - hold on its roomRateID with the promo code, Direct total + 5% fee, paid, folio balance 0", async () => {
  const kit = directKit();
  const res = await checkout(kit, HONEYMOON, { promo: "direct" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  const fee = Math.round(HM_DIRECT * 0.05);
  assert.equal(body.quote.roomsSubtotalSatang, HM_DIRECT);
  assert.equal(body.quote.directRate?.baseRoomsSatang, HM_BASE);
  assert.equal(body.quote.cardFeeSatang, fee);
  assert.equal(body.quote.totalSatang, HM_DIRECT + fee);

  const post = postOf(kit)!;
  assert.equal(post.params["rooms[0][roomRateID]"], "rate-hm-direct");
  assert.equal(post.params.promoCode, FAKE_DIRECT_PROMO_CODE);
  // The gate read (2 adults) reuses the promo-rate index: one getRatePlans read per inventory read, not per party size.
  assert.equal(unfilteredRatePlanReads(kit), 2, "quote and re-quote; the re-check under the lock reuses the re-quote's index");
  // Under the lock: the stay-rule read (getRatePlans for the room type) re-confirms the Direct row on fresh data, so the
  // availability re-check after it makes no second promo-rate read (it would only eat into the time left for the hold).
  const restrictionsAt = kit.fakeCb.calls.findIndex((c) => c.method === "getRatePlans" && c.params.roomTypeID !== undefined);
  assert.ok(restrictionsAt >= 0, "the stay-rule read under the lock");
  const afterLock = kit.fakeCb.calls.slice(restrictionsAt + 1);
  assert.equal(afterLock.some((c) => c.method === "getRatePlans" && c.params.roomTypeID === undefined), false, "no promo-rate read in the re-check");
  const recheckReads = afterLock.filter((c) => c.method === "getAvailableRoomTypes");
  assert.equal(recheckReads.length, 2, "the re-check: adults=1 and the 2-adult gate, availability only");
  assert.equal(recheckReads.some((c) => c.params.promoCode !== undefined), false, "the re-check reads without the code (the stay-rule read re-confirms the Direct row)");
  const reservation = kit.fakeCb.reservations.get(body.holdReservationId!)!;
  assert.match(reservation.notes.join("\n"), /Direct rate \(code DIRECT\)\./);

  const sessionId = sessionIdOf(body);
  const session = kit.fakeStripe.session(sessionId)!;
  assert.equal(session.amount_total, HM_DIRECT + fee);
  assert.deepEqual(session.line_items_input.map((l) => l.unit_amount), [HM_DIRECT, fee]);
  assert.match(session.line_items_input[0].name, /^Honeymoon .+ - Standard Rate \(Direct rate\)$/);
  const token = new URL(session.success_url.replace("{CHECKOUT_SESSION_ID}", "x")).searchParams.get("t");
  const v = verifyBookingToken(token, kit.config.tokenSecret, NOW);
  assert.ok(v.ok);
  if (v.ok) assert.equal(v.payload.booking.promoCode, "DIRECT", "the return page and the GA4 purchase coupon");

  kit.fakeStripe.complete(sessionId);
  const { payload, header } = kit.fakeStripe.signedEvent("checkout.session.completed", sessionId);
  const done = await handleStripeWebhook(payload, header, kit.deps, { nowMs: NOW });
  assert.equal(done.body, "confirmed");
  assert.equal(kit.fakeCb.calls.find((c) => c.method === "postPayment")?.params.amount, "22680.00");
  assert.equal(kit.fakeCb.calls.find((c) => c.method === "postCustomItem")?.params["items[0][itemPrice]"], "1080.00");
  assert.equal(reservation.status, "confirmed");
  assert.equal(kit.fakeCb.balance(body.holdReservationId!), 0);
});

test("without the code nothing changes: base roomRateID, no promo code sent, no Direct lookup (the one index read per re-quote is the automatic discounts')", async () => {
  const kit = directKit();
  const res = await checkout(kit, HONEYMOON);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  assert.equal(body.quote.roomsSubtotalSatang, HM_BASE);
  assert.equal(body.quote.directRate ?? null, null);
  assert.equal(postOf(kit)?.params["rooms[0][roomRateID]"], "rate-hm");
  assert.equal(postOf(kit)?.params.promoCode, undefined);
  assert.equal(unfilteredRatePlanReads(kit), 2, "quote and re-quote: the automatic discounts' rate-plan index, none for the code");
  assert.equal(kit.fakeCb.calls.some((c) => c.method === "getAvailableRoomTypes" && c.params.promoCode !== undefined), false);
  // With the automatic discounts off too, no getRatePlans index read at all (as before them).
  const off = directKit({ env: { ...STRIPE_TEST_ENV, BOOKING_AUTO_DISCOUNTS: "off" } });
  assert.equal((await checkout(off, HONEYMOON)).status, 200);
  assert.equal(unfilteredRatePlanReads(off), 0);
});

test("automatic discounts off (the emergency switch): DIRECT still sells the Direct rate, with its own single rate-plan read", async () => {
  const env = { ...STRIPE_TEST_ENV, BOOKING_AUTO_DISCOUNTS: "off" };
  const kit = directKit({ env });
  const search = (promo?: { cloudbedsCode: string }) =>
    getInventory(FAR_CHECKIN, FAR_CHECKOUT, kit.config, { fetchImpl: kit.fakeCb.fetch, allowDemoFallback: false, ...(promo ? { promo } : {}) });
  const hm = (await search({ cloudbedsCode: FAKE_DIRECT_PROMO_CODE })).inventory.find((i) => i.slug === "honeymoon-suite");
  assert.equal(hm?.rateId, "rate-hm-direct");
  assert.equal(hm?.discount?.kind, "direct");
  assert.equal(unfilteredRatePlanReads(kit), 1, "the code's own index read");
  await search();
  assert.equal(unfilteredRatePlanReads(kit), 1, "a plain search reads none");

  const kit2 = directKit({ env });
  const res = await checkout(kit2, HONEYMOON, { promo: "DIRECT" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  assert.equal(body.quote.roomsSubtotalSatang, HM_DIRECT);
  assert.equal(body.quote.directRate?.baseRoomsSatang, HM_BASE);
  assert.equal(postOf(kit2)?.params["rooms[0][roomRateID]"], "rate-hm-direct");
  assert.equal(postOf(kit2)?.params.promoCode, FAKE_DIRECT_PROMO_CODE);
  assert.equal(unfilteredRatePlanReads(kit2), 2, "quote and re-quote; none in the re-check under the lock");
});

test("code not applicable to the room: the base rate is booked as without it, and no promo code goes with the hold", async () => {
  const kit = directKit();
  const res = await checkout(kit, SUNRISE, { promo: "DIRECT" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  assert.equal(body.quote.directRate ?? null, null);
  assert.equal(body.quote.lines[0].listRoomSatang, undefined);
  assert.equal(postOf(kit)?.params["rooms[0][roomRateID]"], "rate-sr");
  assert.equal(postOf(kit)?.params.promoCode, undefined);
});

/** 3 nights of the Sunrise Suite at its base rate (no Direct plan): 4,500.50/night. */
const SR_BASE = 3 * 450_050;
const HM_AND_SUNRISE: CartItemInput[] = [...HONEYMOON, ...SUNRISE];

test("mixed cart (a Direct room + a room without a Direct plan): Direct rate id only on the Direct room, one top-level promo code, paid, balance 0", async () => {
  // Cloudbeds' handling of one reservation-level promoCode over rooms on different rate ids is Stage B case 24 (d);
  // this pins what we send: a promo code whenever ANY room is on the Direct rate (stripeCheckout.ts directRooms).
  const kit = directKit();
  const res = await checkout(kit, HM_AND_SUNRISE, { promo: "DIRECT" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  assert.equal(body.quote.roomsSubtotalSatang, HM_DIRECT + SR_BASE);
  assert.equal(body.quote.directRate?.baseRoomsSatang, HM_BASE + SR_BASE, "the base total covers every room, the Sunrise Suite included");
  assert.deepEqual(body.quote.lines.map((l) => l.listRoomSatang), [HM_BASE, undefined]);

  const post = postOf(kit)!;
  assert.equal(post.params["rooms[0][roomTypeID]"], "462958");
  assert.equal(post.params["rooms[0][roomRateID]"], "rate-hm-direct");
  assert.equal(post.params["rooms[1][roomTypeID]"], "462960");
  assert.equal(post.params["rooms[1][roomRateID]"], "rate-sr", "the room without a Direct plan stays on its base rate id");
  assert.equal(post.params.promoCode, FAKE_DIRECT_PROMO_CODE);
  assert.deepEqual(Object.keys(post.params).filter((k) => /promo/i.test(k)), ["promoCode"], "one reservation-level promo code, none per room");

  const sessionId = sessionIdOf(body);
  assert.equal(kit.fakeStripe.session(sessionId)!.amount_total, body.quote.totalSatang);
  kit.fakeStripe.complete(sessionId);
  const { payload, header } = kit.fakeStripe.signedEvent("checkout.session.completed", sessionId);
  assert.equal((await handleStripeWebhook(payload, header, kit.deps, { nowMs: NOW })).body, "confirmed");
  assert.equal(kit.fakeCb.balance(body.holdReservationId!), 0);
});

test("mixed cart priced at the base rate for every room: the DIRECT alert (promo_at_base), not a price change; nothing charged", async () => {
  const kit = directKit({ directPricedAtBase: true });
  const res = await checkout(kit, HM_AND_SUNRISE, { promo: "DIRECT" });
  assert.equal(res.status, 503, JSON.stringify(res.body));
  assert.equal(res.body.ok ? "" : res.body.error, "payment_unavailable");
  assert.match(res.body.ok ? "" : res.body.message, /code DIRECT on our classic booking page/);
  assert.equal(kit.fakeStripe.sessions.size, 0, "no Stripe call");
  assert.ok([...kit.fakeCb.reservations.values()].every((r) => r.status === "canceled"), "the hold given back");
  assert.equal(kit.alerts.filter((a) => a.subject === DIRECT_AT_BASE_ALERT).length, 1);
  assert.equal(kit.alerts.some((a) => a.subject.startsWith("Booking stopped: Cloudbeds price differs")), false);
  assert.equal(kit.logs.filter((l) => l.message === "hold_direct_at_base").length, 1);
});

test("checkout enforces the base row's stay rules on the Direct rate: base minLos 2 refuses a 1-night Direct stay before any hold", async () => {
  const kit = directKit({ roomTypes: { ...DIRECT_ROOM_TYPES, "462958": { ...DIRECT_ROOM_TYPES["462958"], minLos: 2, directMinLos: 0 } } });
  const res = await checkout(kit, HONEYMOON, { promo: "DIRECT", checkOut: "2027-11-11" });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.ok ? "" : res.body.message, /minimum stay of 2 nights/);
  assert.equal(kit.fakeCb.count("postReservation"), 0);
});

test("never trust the client: a rateId sent by the browser is ignored, and a derived rate that isn't the selected Direct rate is refused", async () => {
  // (1) The browser can't pick a rate: unknown fields are dropped, the server prices the base row.
  const kit = directKit();
  const tampered = [{ ...HONEYMOON[0], rateId: "rate-hm-direct", roomRateID: "rate-hm-direct" }] as unknown as CartItemInput[];
  const res = await checkout(kit, tampered, { rateId: "rate-hm-direct" } as Partial<CheckoutRequest>);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(postOf(kit)?.params["rooms[0][roomRateID]"], "rate-hm");
  assert.equal(postOf(kit)?.params.promoCode, undefined);
  assert.equal((res.body as CheckoutSuccess).quote.roomsSubtotalSatang, HM_BASE);

  // (2) A rate other than the Direct rate selected for this booking reaching the locked check is refused (alert, no hold).
  const kit2 = directKit();
  const original = kit2.deps.restrictions!;
  kit2.deps.restrictions = (roomTypeId, _rateId, checkIn, checkOut, adults, promo) => original(roomTypeId, "rate-hm-breakfast", checkIn, checkOut, adults, promo);
  const refused = await checkout(kit2, HONEYMOON, { promo: "DIRECT" });
  assert.equal(refused.status, 409);
  assert.match(refused.body.ok ? "" : refused.body.message, /can't be booked online/);
  assert.equal(kit2.fakeCb.count("postReservation"), 0);
  const alert = kit2.alerts.find((a) => a.subject.includes("derived rate"));
  assert.match(alert?.lines[0] ?? "", /offered as the Direct rate \(promo code Direct\)/);
});

test("the Direct plan gone between the re-quote and the lock: the stay-rule read under the lock refuses it (the re-check reuses the re-quote's index)", async () => {
  const roomTypes = { ...DIRECT_ROOM_TYPES };
  const kit = directKit({ roomTypes });
  const original = kit.deps.restrictions!;
  kit.deps.restrictions = (...args) => {
    // Changed in Cloudbeds after the guest's re-quote: the Honeymoon Suite has no Direct plan any more.
    roomTypes["462958"] = { ...DIRECT_ROOM_TYPES["462958"], directRateId: undefined };
    return original(...args);
  };
  const res = await checkout(kit, HONEYMOON, { promo: "DIRECT" });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.ok ? "" : res.body.message, /can't be booked online/);
  assert.equal(kit.fakeCb.count("postReservation"), 0);
});

test("Cloudbeds prices the Direct hold at the BASE rate: hold cancelled, nothing charged, one fixed alert, the guest offered the classic page or WhatsApp", async () => {
  const kit = directKit({ directPricedAtBase: true });
  for (let i = 0; i < 2; i++) {
    const res = await checkout(kit, HONEYMOON, { promo: "DIRECT" });
    assert.equal(res.status, 503);
    assert.equal(res.body.ok ? "" : res.body.error, "payment_unavailable");
    const message = res.body.ok ? "" : res.body.message;
    assert.match(message, /Direct rate/);
    assert.match(message, /Nothing has been charged\./);
    assert.match(message, /code DIRECT on our classic booking page/);
    assert.match(message, /WhatsApp/);
  }
  assert.equal(kit.fakeStripe.sessions.size, 0, "no Stripe call");
  const holds = [...kit.fakeCb.reservations.values()];
  assert.equal(holds.length, 2);
  assert.ok(holds.every((r) => r.status === "canceled"), "each hold given back");
  const alerts = kit.alerts.filter((a) => a.subject === DIRECT_AT_BASE_ALERT);
  assert.equal(alerts.length, 1, "one fixed-key alert, not one per booking");
  assert.equal(DIRECT_AT_BASE_ALERT, "DIRECT bookings blocked: Cloudbeds priced the Direct rate at the base rate - set BOOKING_DIRECT_PROMO=off and redeploy");
  assert.equal(kit.alerts.some((a) => a.subject.startsWith("Booking stopped: Cloudbeds price differs")), false, "classified apart from a price change");
  assert.equal(kit.logs.filter((l) => l.message === "hold_direct_at_base").length, 2);
});

test("classifyHoldTotal: the base-rate total of a Direct quote is its own kind; fees and other differences keep theirs", () => {
  const folio = (total: number, fees = 0) => ({ grandTotalSatang: total + fees, subTotalSatang: total, taxesFeesSatang: fees, additionalItemsSatang: 0 });
  assert.deepEqual(classifyHoldTotal({ quotedRoomsSatang: HM_DIRECT, holdTotalSatang: HM_BASE, folio: folio(HM_BASE), baseRoomsSatang: HM_BASE }), { kind: "promo_at_base", totalSatang: HM_BASE });
  assert.deepEqual(classifyHoldTotal({ quotedRoomsSatang: HM_DIRECT, holdTotalSatang: HM_DIRECT, folio: folio(HM_DIRECT), baseRoomsSatang: HM_BASE }), { kind: "match" });
  assert.equal(classifyHoldTotal({ quotedRoomsSatang: HM_DIRECT, holdTotalSatang: HM_BASE, folio: folio(HM_BASE) }).kind, "price_changed", "no Direct quote: a price change");
  assert.equal(classifyHoldTotal({ quotedRoomsSatang: HM_DIRECT, holdTotalSatang: null, folio: folio(HM_BASE, 100), baseRoomsSatang: HM_BASE }).kind, "cloudbeds_fees");
  assert.equal(classifyHoldTotal({ quotedRoomsSatang: HM_DIRECT, holdTotalSatang: HM_BASE + 1, folio: folio(HM_BASE + 1), baseRoomsSatang: HM_BASE }).kind, "price_changed");
});

test("flag off: the code is not applied (base rate, no promo code, no lookup) - the page points it to the classic booking page instead", async () => {
  const kit = directKit({ env: { ...STRIPE_TEST_ENV, BOOKING_DIRECT_PROMO: "off" } });
  const res = await checkout(kit, HONEYMOON, { promo: "DIRECT" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((res.body as CheckoutSuccess).quote.directRate ?? null, null);
  assert.equal(postOf(kit)?.params["rooms[0][roomRateID]"], "rate-hm");
  assert.equal(postOf(kit)?.params.promoCode, undefined);
  assert.equal(unfilteredRatePlanReads(kit), 2, "only the automatic discounts' index (quote and re-quote)");
  assert.equal(kit.fakeCb.calls.some((c) => c.method === "getAvailableRoomTypes" && c.params.promoCode !== undefined), false);
  const bothOff = directKit({ env: { ...STRIPE_TEST_ENV, BOOKING_DIRECT_PROMO: "off", BOOKING_AUTO_DISCOUNTS: "off" } });
  assert.equal((await checkout(bothOff, HONEYMOON, { promo: "DIRECT" })).status, 200);
  assert.equal(unfilteredRatePlanReads(bothOff), 0);
});

/* --------------------------------- analytics ------------------------------- */

test("GA4 coupon carries the code on the Direct rate (begin_checkout / add_payment_info / purchase)", async () => {
  const kit = directKit();
  const body = (await checkout(kit, HONEYMOON, { promo: "DIRECT" })).body as CheckoutSuccess;
  assert.equal(couponOf(body.quote), "DIRECT");
  assert.equal(couponOf({ promo: null, directRate: null }), "");
  assert.equal(couponOf({ promo: { code: "DIRECT", pct: 10, label: "x", discountSatang: 1 } }), "DIRECT", "the demo's code as before");
  const session = kit.fakeStripe.session(sessionIdOf(body))!;
  const v = verifyBookingToken(new URL(session.success_url.replace("{CHECKOUT_SESSION_ID}", "x")).searchParams.get("t"), kit.config.tokenSecret, NOW);
  assert.ok(v.ok);
  if (v.ok) assert.equal(purchaseParams(v.payload.booking).coupon, "DIRECT");
});

/* ----------------------------------- copy ---------------------------------- */

test("DIRECT copy: the own engine keeps it while it honours DIRECT; swapped only with the flag off (or no Cloudbeds rates); default pages unchanged", () => {
  const own = { ...STRIPE_LIVE_ENV, BOOKING_ENGINE: "own" };
  assert.equal(directCopySwapped({}), false, "public default (BOOKING_ENGINE unset)");
  assert.equal(directCopySwapped({ ...STRIPE_LIVE_ENV, BOOKING_DIRECT_PROMO: "off" }), false, "the classic engine always keeps DIRECT");
  assert.equal(directCopySwapped(own), false, "own engine honouring DIRECT: same copy as the classic engine");
  assert.equal(directCopySwapped({ ...own, BOOKING_DIRECT_PROMO: "off" }), true);
  assert.equal(directCopySwapped({ ...MOCK_ENV, BOOKING_ENGINE: "own" }), true, "own engine without Cloudbeds rates");
  assert.equal(directCopySwapped({ ...own, BOOKING_ALLOW_LIVE_PAYMENTS: "false" }), false, "emergency stop: /booking is the classic engine again");
});

test("every page that swaps the DIRECT copy asks directCopySwapped() (not just 'is the own engine on')", () => {
  const src = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  const pages = ["app/page.tsx", "app/booking/page.tsx", "app/layout.tsx", "components/LocalizedLanding.tsx", ...["he", "ru", "fr", "de", "zh", "es", "th"].map((c) => `app/${c}/page.tsx`)];
  for (const p of pages) {
    const s = src(p);
    assert.ok(s.includes("directCopySwapped()"), `${p} uses directCopySwapped()`);
    assert.doesNotMatch(s, /(perksForEngine|descriptionForEngine)\([^)]*resolveBookingEngine/, `${p}: no engine-only swap`);
  }
  assert.doesNotMatch(src("app/page.tsx"), /resolveBookingEngine\(\) === "own"\s*\?\s*\/\/ Promo/, "homepage perks follow directCopySwapped");
  assert.match(src("app/booking/page.tsx"), /description:\s*\r?\n\s*directCopySwapped\(\)/);
  assert.match(src("app/layout.tsx"), /description:\s*\r?\n\s*directCopySwapped\(\)/);
});

/* ------------------------------------ UI ----------------------------------- */

test("booking page UI: Direct prices struck through with the label, the not-applicable note, the classic-page link, and the code sent where offered", () => {
  const ui = (path: string) => readFileSync(new URL(`../../components/booking/${path}`, import.meta.url), "utf8");
  const card = ui("results/RoomOfferCard.tsx");
  // The label ("Direct rate - code X") and the note come from quote.ts helpers (tested in autoDiscounts.test.ts).
  assert.ok(card.includes("listTotalForAdults(rate, defaultAdults)") && card.includes("rateDiscountLabel(rate.list, directCode)"));
  assert.ok(card.includes("offer.promoNotApplied") && card.includes("promoNotAppliedNote(directCode"));
  // The demo's % row is only for a real percentage: a Direct rate (pct 0) must never show "-0%".
  assert.ok(ui("results/ResultsList.tsx").includes("availability.promo.pct > 0"));
  assert.ok(ui("summary/ReservationSummary.tsx").includes("line.listRoomSatang") && ui("checkout/PaymentStep.tsx").includes("line.listRoomSatang"));
  assert.ok(ui("search/SearchBar.tsx").includes("promoVerdict.link") && ui("search/PromoPopover.tsx").includes("note.link"));
  // The DIRECT hint and the "Best direct rate" perk only where the code lowers the price (never on the classic-only note page).
  assert.ok(ui("search/PromoPopover.tsx").includes("Use code ${hint} for our best direct rate."));
  assert.ok(ui("search/SearchStep.tsx").includes("!props.promoCodeHint ? OWNER_PERK : promoPerk(props.promoCodeHint)"));
  // The Direct plan is confirmed on the Honeymoon Suite only: the perk must not promise the code works on every room.
  assert.ok(ui("search/SearchStep.tsx").includes("Use code ${code} for our best direct rate."));
  assert.doesNotMatch(ui("search/SearchStep.tsx"), /every room/i, "the DIRECT perk must not promise every room");
  assert.ok(ui("BookingApp.tsx").includes("promoInputOffered(config)") && ui("OwnBookingPage.tsx").includes("promoInputOffered(config)"));
  const route = readFileSync(new URL("../../app/api/booking/availability/route.ts", import.meta.url), "utf8");
  // The route asks Cloudbeds as promoAskFor says (DIRECT -> CLOUDBEDS_PROMO_CODE, any other code looked up first) and
  // answers with searchPromoVerdict (resolvePromoFor with the lookup, then promoVerdictForInventory).
  assert.ok(route.includes("promoAskFor(search.promo, promoSettings)") && route.includes("{ promo: promoAsk }"));
  assert.ok(route.includes("searchPromoVerdict(search.promo, promoSettings, config.classicBookingPath, result)"));
});

test("results step: with no code entered, the bar above the results invites the DIRECT code (arrivals with dates skip the search step's perk)", () => {
  const ui = (path: string) => readFileSync(new URL(`../../components/booking/${path}`, import.meta.url), "utf8");
  const bar = ui("search/SearchBar.tsx");
  // Only while no code is typed, and only where a code lowers the price (promoCodeHint is null in Beam and classic-only modes).
  assert.ok(bar.includes('codeHint={promoEnabled && promoCode === "" ? promoCodeHint : null}'));
  assert.match(bar, /\} else if \(compact && codeHint\) \{[\s\S]{0,300}?content = `Have code \$\{codeHint\}\? Add it above for our best direct rate\.`;/);
  // It goes after the code verdicts and the missing-dates prompts (an applied or refused code says so instead).
  assert.ok(bar.indexOf("compact && codeHint") > bar.indexOf('"Choose your dates to see prices."'));
  assert.doesNotMatch(bar, /Have code[^`]*at checkout/, "the code is entered in this bar, not at a later step");
  const app = ui("BookingApp.tsx");
  assert.ok(app.includes("promoCodeHint: promoCodeHint(config),") && app.includes('<SearchBar {...searchBarProps} variant="compact" />'));
});

test("production wiring: runtime.ts passes the selected Direct rate into the stay-rule check under the lock", () => {
  // testkit.ts builds its own restrictions function, so no checkout test runs this code (runtime.ts imports next/server).
  // Dropping the promo here would refuse every DIRECT checkout in production as a derived rate, with every test still green.
  const rt = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");
  assert.match(rt, /restrictions:\s*\([^)]*promo\?:\s*PromoRestrictionInput \| null\)\s*=>/);
  assert.match(rt, /cloudbedsRestrictions\(\s*roomTypeId,\s*rateId,\s*checkIn,\s*checkOut,\s*adults,\s*\{[^}]*\},\s*promo \?\? null,?\s*\)/);
});

test("mergePromoAnswer: the plain answer's base rows plus the rows only the promo-code answer has (live: no base rows with the code); a failed promo answer fails the read", () => {
  const plain = { success: true, data: [{ propertyID: "235064", propertyRooms: [{ roomTypeID: "462958", roomRateID: "hm-base" }, { roomTypeID: "462960", roomRateID: "sr-base" }] }] };
  const withCode = { success: true, data: [{ propertyID: "235064", propertyRooms: [{ roomTypeID: "462958", roomRateID: "hm-direct" }, { roomTypeID: "462958", roomRateID: "hm-base" }] }] };
  const logged: unknown[] = [];
  const merged = mergePromoAnswer(plain, withCode, (_m, d) => void logged.push(d)) as typeof plain;
  assert.deepEqual(merged.data[0].propertyRooms.map((r) => r.roomRateID), ["hm-base", "sr-base", "hm-direct"]);
  assert.deepEqual(logged, [{ added: 1 }]);
  assert.deepEqual(plain.data[0].propertyRooms.length, 2, "the plain answer itself is not modified");
  // An empty promo answer (the code applies to nothing) leaves the base rows.
  assert.deepEqual((mergePromoAnswer(plain, { success: true, data: [] }) as typeof plain).data[0].propertyRooms.length, 2);
  assert.throws(() => mergePromoAnswer(plain, { success: false, message: "Invalid promo code" }), /promo code\) failed: Invalid promo code/);
});

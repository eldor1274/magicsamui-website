// Automatic discounts on the own engine (owner decision, 2026-10-07): Cloudbeds' public discount plans
// "Last minute 10% off" and "Long term booking" (and any "Early bird..." plan the owner creates) are sold
// without a code, next to the base rate, whenever Cloudbeds offers them for the stay and they are cheaper.
// Never "Non-refundable 10% discount" (other refund terms), never a package, never a promo-code plan (the
// Direct rate keeps its own path). Covers the config switch, the one rate-plan index read, the row choice
// (cheapest of base / Direct / automatic), the combined stay rules, the hold on the plan's roomRateID, the
// "priced at the base rate" refusal, the "rate not open to the source" fix line, the booking token, GA4 and
// the UI wiring.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SEARCH_CACHE_TTL_MS, buildOffers, getInventory, promoVerdictForInventory } from "./availability.ts";
import { purchaseParams, itemFromQuoteLine } from "./clientAnalytics.ts";
import { runCheckout } from "./checkout.ts";
import { CloudbedsBudgetError, RATE_PLAN_FAIL_TTL_MS, cloudbedsInventory, cloudbedsRateIndex, createTokenBucket, evaluateRestrictions, isAutoDiscountName, parseAvailableRoomTypes, parseRatePlanIndex, planDisplayName } from "./cloudbedsProvider.ts";
import type { AutoDiscountIndex, PromoRateIndex, RatePlanIndex } from "./cloudbedsProvider.ts";
import { DEFAULT_AUTO_DISCOUNT_PLANS, getBookingConfig, getInventoryConfig, resolveAutoDiscountPlans } from "./config.ts";
import type { Env } from "./config.ts";
import { addDays } from "./dates.ts";
import { demoInventory } from "./demoProvider.ts";
import { FAKE_DIRECT_PROMO_CODE, fakeLastMinutePlan, fakeLongTermPlan, fakeNonRefundablePlan, rateNotForSourceMessage } from "./mock/fakeCloudbeds.ts";
import type { FakeCloudbedsOptions, FakeRoomType } from "./mock/fakeCloudbeds.ts";
import { computeQuote, lineDiscountLabel, promoNotAppliedNote, rateDiscountLabel } from "./quote.ts";
import { AUTO_AT_BASE_ALERT_PREFIX, DIRECT_AT_BASE_ALERT, autoAtBaseAlert, classifyHoldTotal, rateNotForSourceFix, rateSourceFixLine } from "./stripeCheckout.ts";
import { handleStripeWebhook } from "./stripeWebhook.ts";
import { FAR_CHECKIN, HONEYMOON, NOW, STRIPE_TEST_ENV, checkout, makeKit, request, serverQuote, sessionIdOf } from "./testkit.ts";
import { ROOM_TYPES } from "./testkit.ts";
import type { Kit } from "./testkit.ts";
import { createBookingToken, verifyBookingToken } from "./token.ts";
import type { BookingSummary, CartItemInput, CheckoutRequest, CheckoutSuccess, RoomInventory } from "./types.ts";

/** Honeymoon: base 9,000/night; Direct 80% (code only); Last minute 90% (within 7 days of arrival); Long term 94% (7+ nights); Non-refundable 90% (always offered). */
const HM_PLANS = [fakeLastMinutePlan("rate-hm-lm"), fakeLongTermPlan("rate-hm-lt"), fakeNonRefundablePlan("rate-hm-nr")];
const AUTO_ROOM_TYPES: Record<string, FakeRoomType> = {
  ...ROOM_TYPES,
  "462958": { ...ROOM_TYPES["462958"], directRateId: "rate-hm-direct", plans: HM_PLANS },
  // Sunrise: base 4,500.50/night, Long term only (no Direct plan). Garden: base only.
  "462960": { ...ROOM_TYPES["462960"], plans: [fakeLongTermPlan("rate-sr-lt")] },
};
const FAR_7_OUT = addDays(FAR_CHECKIN, 7);
const SEVEN_NIGHTS = { checkIn: FAR_CHECKIN, checkOut: FAR_7_OUT };
const HM_BASE_7 = 7 * 900_000;
const HM_LT_7 = 7 * 846_000;
const HM_DIRECT_7 = 7 * 720_000;
const SR_BASE_7 = 7 * 450_050;
const SR_LT_7 = 7 * 423_047; // 4,500.50 x 94% = 4,230.47
const GS_BASE_7 = 7 * 300_000;
const SUNRISE: CartItemInput[] = [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
const GARDEN: CartItemInput[] = [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
/** Stripe test keys with the MOCK writer: no 12-month test guard, so a near arrival can be booked (Last minute). */
const NEAR_ENV: Env = { ...STRIPE_TEST_ENV, CLOUDBEDS_API_KEY_BOOKING: "" };
/** 3 days after NOW (5 Oct 2026, Bangkok): inside the Last minute plan's 7-day window. */
const NEAR = { checkIn: "2026-10-08", checkOut: "2026-10-11" };

function autoKit(options: { env?: Env; roomTypes?: Record<string, FakeRoomType>; cb?: FakeCloudbedsOptions } = {}): Kit {
  return makeKit({ env: options.env, cb: { roomTypes: options.roomTypes ?? AUTO_ROOM_TYPES, ...options.cb } });
}

const postOf = (kit: Kit) => kit.fakeCb.calls.find((c) => c.method === "postReservation");
const unfilteredRatePlanReads = (kit: Kit) => kit.fakeCb.calls.filter((c) => c.method === "getRatePlans" && c.params.roomTypeID === undefined).length;
const search = (kit: Kit, stay: { checkIn: string; checkOut: string }, extra: Parameters<typeof getInventory>[3] = {}) =>
  getInventory(stay.checkIn, stay.checkOut, kit.config, { fetchImpl: kit.fakeCb.fetch, allowDemoFallback: false, ...extra });
const hmOf = (inv: RoomInventory[]) => inv.find((i) => i.slug === "honeymoon-suite")!;

/* --------------------------------- config --------------------------------- */

test("config: BOOKING_AUTO_DISCOUNTS on by default (empty = on, off/false/0/no = off); plans default to Last minute, Long term, Early bird; Stripe with Cloudbeds data only", () => {
  assert.deepEqual(DEFAULT_AUTO_DISCOUNT_PLANS, ["Last minute", "Long term", "Early bird"]);
  assert.deepEqual(getBookingConfig(STRIPE_TEST_ENV).cloudbeds?.autoDiscountPlans, DEFAULT_AUTO_DISCOUNT_PLANS);
  for (const on of ["", "on", "ON", " true ", "1", "yes"]) {
    assert.deepEqual(getBookingConfig({ ...STRIPE_TEST_ENV, BOOKING_AUTO_DISCOUNTS: on }).cloudbeds?.autoDiscountPlans, DEFAULT_AUTO_DISCOUNT_PLANS, JSON.stringify(on));
  }
  for (const off of ["off", "OFF", " false ", "0", "no"]) {
    assert.deepEqual(getBookingConfig({ ...STRIPE_TEST_ENV, BOOKING_AUTO_DISCOUNTS: off }).cloudbeds?.autoDiscountPlans, [], off);
  }
  // The plans: comma-separated, trimmed, whitespace collapsed; entries that are not plain names are dropped.
  assert.deepEqual(resolveAutoDiscountPlans({ BOOKING_AUTO_DISCOUNT_PLANS: " Long  term , Early bird,," }), ["Long term", "Early bird"]);
  assert.deepEqual(resolveAutoDiscountPlans({ BOOKING_AUTO_DISCOUNT_PLANS: "Last minute,<script>,x" }), ["Last minute"]);
  assert.deepEqual(resolveAutoDiscountPlans({ BOOKING_AUTO_DISCOUNT_PLANS: "" }), DEFAULT_AUTO_DISCOUNT_PLANS);
  assert.deepEqual(resolveAutoDiscountPlans({ BOOKING_AUTO_DISCOUNT_PLANS: "   " }), DEFAULT_AUTO_DISCOUNT_PLANS);
  assert.deepEqual(getBookingConfig({ ...STRIPE_TEST_ENV, BOOKING_AUTO_DISCOUNT_PLANS: "Early bird" }).cloudbeds?.autoDiscountPlans, ["Early bird"]);
  // Narrowing the list by hand (runbook: `Last minute,Long term` drops an early bird plan): quotes around the value or
  // an entry and `;` as the separator are read as meant - never as "nothing valid, sell the default again".
  for (const value of [`"Last minute,Long term"`, `'Last minute,Long term'`, "Last minute;Long term", ` "Last minute" ; 'Long term' `, `"Last minute","Long term"`, "`Last minute,Long term`"]) {
    assert.deepEqual(resolveAutoDiscountPlans({ BOOKING_AUTO_DISCOUNT_PLANS: value }), ["Last minute", "Long term"], value);
  }
  assert.deepEqual(resolveAutoDiscountPlans({ BOOKING_AUTO_DISCOUNT_PLANS: `"Owner's deal,Long term"` }), ["Owner's deal", "Long term"], "an apostrophe inside a name stays");
  // Set, but no entry is a plan name: fail closed - NO automatic discount (never the default, which would bring back the plan dropped).
  for (const value of ["<b>", "Long term (7+ nights)", "-", ",,", `""`, `"Last minute|Long term"`]) {
    assert.deepEqual(resolveAutoDiscountPlans({ BOOKING_AUTO_DISCOUNT_PLANS: value }), [], value);
  }
  assert.deepEqual(getBookingConfig({ ...STRIPE_TEST_ENV, BOOKING_AUTO_DISCOUNT_PLANS: "Long term (7+ nights)" }).cloudbeds?.autoDiscountPlans, [], "the flag on, no plan sold");
  assert.deepEqual(getInventoryConfig({ ...STRIPE_TEST_ENV, BOOKING_AUTO_DISCOUNT_PLANS: "<b>" }).cloudbeds?.autoDiscountPlans, []);
  // The availability API's config agrees, and never throws.
  assert.deepEqual(getInventoryConfig(STRIPE_TEST_ENV).cloudbeds?.autoDiscountPlans, DEFAULT_AUTO_DISCOUNT_PLANS);
  assert.deepEqual(getInventoryConfig({ ...STRIPE_TEST_ENV, BOOKING_AUTO_DISCOUNTS: "off" }).cloudbeds?.autoDiscountPlans, []);
  // Demo and Beam (with a Cloudbeds read key): unchanged, no automatic discounts. MOCK without Cloudbeds data: nothing to read.
  assert.deepEqual(getBookingConfig({ CLOUDBEDS_API_KEY: "k" }).cloudbeds?.autoDiscountPlans, []);
  assert.deepEqual(getInventoryConfig({ CLOUDBEDS_API_KEY: "k" }).cloudbeds?.autoDiscountPlans, []);
  assert.deepEqual(
    getBookingConfig({ BOOKING_PAYMENT_PROVIDER: "beam", BEAM_API_BASE: "https://playground.api.beamcheckout.com", BEAM_MERCHANT_ID: "m", BEAM_API_KEY: "k", BOOKING_TOKEN_SECRET: "test-only-7f3K9qLm2xVw8RtY4pZn6bHc1dJe5gUa", CLOUDBEDS_API_KEY: "k" }).cloudbeds?.autoDiscountPlans,
    [],
  );
  assert.equal(getBookingConfig({ BOOKING_PAYMENT_PROVIDER: "stripe", BOOKING_STRIPE_MOCK: "true" }).cloudbeds, null);
});

/* --------------------------------- the index -------------------------------- */

/** getRatePlans rows (not filtered by room type) like the live Honeymoon answer of 2026-10-06. */
const LIVE_PLANS = {
  success: true,
  data: [
    { rateID: 1375281, roomTypeID: "462958", isDerived: false, ratePlanID: null, ratePlanNamePublic: null, promoCode: null, parentRateID: null },
    { rateID: 3195765, roomTypeID: "462958", isDerived: true, ratePlanID: 484584, ratePlanNamePublic: "Direct booking rate", promoCode: "Direct", parentRateID: 1375281 },
    { rateID: 3195766, roomTypeID: "462958", isDerived: true, ratePlanNamePublic: "Non-refundable 10% discount", promoCode: null, parentRateID: 1375281 },
    { rateID: 3195767, roomTypeID: "462958", isDerived: true, ratePlanNamePublic: "Long term booking", promoCode: null, parentRateID: 1375281 },
    { rateID: 3195768, roomTypeID: "462958", isDerived: true, ratePlanNamePublic: "bookings max 7 day stay", promoCode: null, parentRateID: 1375281 },
    { rateID: 3195769, roomTypeID: "462958", isDerived: true, ratePlanNamePublic: "Breakfast", promoCode: null, parentRateID: 1375281 },
    { rateID: 3195770, roomTypeID: "462958", isDerived: true, ratePlanNamePublic: "Last minute 10% off", promoCode: null, parentRateID: 1375281 },
    { rateID: 3195771, roomTypeID: "462958", isDerived: true, ratePlanNamePublic: "SabaiTravel2026", promoCode: "SabaiTravel2026", parentRateID: 1375281 },
    // A plan named like a discount but needing a code, one not derived, one saying non refundable, and an Early bird plan.
    { rateID: 3195772, roomTypeID: "462958", isDerived: true, ratePlanNamePublic: "Long term VIP", promoCode: "VIP", parentRateID: 1375281 },
    { rateID: 3195773, roomTypeID: "462958", isDerived: false, ratePlanNamePublic: "Last minute (manual)", promoCode: null, parentRateID: null },
    { rateID: 3195774, roomTypeID: "462958", isDerived: "true", ratePlanNamePublic: "LAST MINUTE non refundable", promoCode: "", parentRateID: 1375281 },
    { rateID: 3195775, roomTypeID: "462960", isDerived: 1, ratePlanNamePublic: "  early   BIRD 15% off ", promoCode: "", parentRateID: 1375283 },
    // No room type: skipped (the index is per room type).
    { rateID: 3195776, isDerived: true, ratePlanNamePublic: "Long term booking", promoCode: null },
  ],
};

test("the rate-plan index: one getRatePlans answer gives the Direct rows (by promo code) and the automatic discount rows - derived, no promo code, a configured name prefix (any case), never non-refundable", () => {
  const index = parseRatePlanIndex(LIVE_PLANS, { cloudbedsCode: "Direct", autoPlans: DEFAULT_AUTO_DISCOUNT_PLANS });
  assert.deepEqual(index.promo, { "462958": [{ rateId: "3195765", parentRateId: "1375281", name: "Direct booking rate" }] });
  assert.deepEqual(index.auto, {
    "462958": [
      { rateId: "3195767", parentRateId: "1375281", name: "Long term booking" },
      { rateId: "3195770", parentRateId: "1375281", name: "Last minute 10% off" },
    ],
    "462960": [{ rateId: "3195775", parentRateId: "1375283", name: "early BIRD 15% off" }],
  });
  // Without a code no Direct rows; without plans no automatic ones; only the configured prefixes.
  assert.deepEqual(parseRatePlanIndex(LIVE_PLANS, { cloudbedsCode: null, autoPlans: [] }), { promo: {}, auto: {} });
  assert.deepEqual(Object.values(parseRatePlanIndex(LIVE_PLANS, { cloudbedsCode: null, autoPlans: ["long term"] }).auto).flat().map((r) => r.name), ["Long term booking"]);
  // Even when the owner lists them: Non-refundable is never automatic (other refund terms); a promo-code plan never.
  const asked = parseRatePlanIndex(LIVE_PLANS, { cloudbedsCode: null, autoPlans: ["Non-refundable", "Direct", "Sabai", "Breakfast", "bookings max"] });
  assert.deepEqual(Object.values(asked.auto).flat().map((r) => r.name), ["bookings max 7 day stay", "Breakfast"], "a plain plan name can be listed (and must still be cheaper to be sold)");
  for (const name of ["Non-refundable 10% discount", "Long term NON REFUNDABLE", "Last minute nonrefundable", "Last minute non_refundable"]) {
    assert.equal(isAutoDiscountName(name, DEFAULT_AUTO_DISCOUNT_PLANS), false, name);
  }
  assert.equal(isAutoDiscountName("Early bird 20%", DEFAULT_AUTO_DISCOUNT_PLANS), true);
  assert.equal(isAutoDiscountName("The Long term booking", DEFAULT_AUTO_DISCOUNT_PLANS), false, "a prefix, not anywhere in the name");
  assert.throws(() => parseRatePlanIndex({ success: false, message: "no" }, { cloudbedsCode: "Direct", autoPlans: [] }), /getRatePlans failed: no/);
});

/* --------------------------- the row sold per room --------------------------- */

const NIGHTS3 = ["2027-11-10", "2027-11-11", "2027-11-12"];
function answer(rows: Record<string, unknown>[]) {
  return { success: true, data: [{ propertyCurrency: { currencyCode: "THB" }, propertyRooms: rows }] };
}
function row(roomTypeID: string, roomRateID: string, rate: number, extra: Record<string, unknown> = {}) {
  return { roomTypeID, roomRateID, roomsAvailable: 1, roomRateDetailed: NIGHTS3.map((date) => ({ date, rate })), ratePlanNamePublic: "default", derivedType: null, ...extra };
}
const derivedRow = (roomTypeID: string, roomRateID: string, rate: number, name: string, extra: Record<string, unknown> = {}) =>
  row(roomTypeID, roomRateID, rate, { ratePlanNamePublic: name, derivedType: "percentage", ...extra });
const AUTO_INDEX: AutoDiscountIndex = {
  "462958": [
    { rateId: "hm-lm", parentRateId: "hm-base", name: "Last minute 10% off" },
    { rateId: "hm-lt", parentRateId: "hm-base", name: "Long term booking" },
  ],
  "462961": [{ rateId: "gs-lm", parentRateId: "other", name: "Last minute 10% off" }],
  "462960": [{ rateId: "sr-lt", parentRateId: null, name: "Long term booking" }],
  "462962": [{ rateId: "sv1-lm", parentRateId: "sv1-base", name: "Last minute 10% off" }],
  "462964": [{ rateId: "sv2-lm", parentRateId: null, name: "Last minute 10% off" }],
};

test("per room the CHEAPEST of the base row and its usable discounted rows is sold; a discounted row must be derived from the base row and cheaper; no base row sells nothing", () => {
  const logs: { m: string; d?: Record<string, unknown> }[] = [];
  const noBase: string[] = [];
  const inv = parseAvailableRoomTypes(
    answer([
      row("462958", "hm-base", 9000),
      derivedRow("462958", "hm-lm", 8100, "Last minute 10% off"),
      derivedRow("462958", "hm-lt", 8460, "Long term booking"),
      // Cheaper still, but not in the index (Non-refundable): a derived row, never sold.
      derivedRow("462958", "hm-nr", 7000, "Non-refundable 10% discount"),
      row("462961", "gs-base", 3000),
      derivedRow("462961", "gs-lm", 2700, "Last minute 10% off"), // derived from another rate
      row("462960", "sr-base", 4500),
      derivedRow("462960", "sr-lt", 4230, "Long term booking"), // no parentRateID sent: the base row is the parent
      row("462962", "sv1-base", 5000),
      derivedRow("462962", "sv1-lm", 5000, "Last minute 10% off"), // not cheaper
      derivedRow("462964", "sv2-lm", 5400, "Last minute 10% off"), // no base row
    ]),
    FAR_CHECKIN,
    addDays(FAR_CHECKIN, 3),
    { baseRateOnly: true, auto: { rates: AUTO_INDEX }, onNoBaseRate: (s) => noBase.push(s), log: (m, d) => logs.push({ m, d }) },
  );
  const by = (slug: string) => inv.find((i) => i.slug === slug)!;
  const hm = by("honeymoon-suite");
  assert.equal(hm.rateId, "hm-lm", "Last minute (8,100) beats Long term (8,460) and the base (9,000)");
  assert.deepEqual(hm.discount && { kind: hm.discount.kind, name: hm.discount.name, baseRateId: hm.discount.baseRateId }, { kind: "auto", name: "Last minute 10% off", baseRateId: "hm-base" });
  assert.deepEqual(hm.baseNightly.map((n) => n.amountSatang), [810_000, 810_000, 810_000]);
  assert.deepEqual(hm.discount?.baseNightly.map((n) => n.amountSatang), [900_000, 900_000, 900_000]);
  assert.equal(hm.promoNotApplied, undefined, "no code asked: nothing to say about one");
  assert.equal(by("garden-suite").rateId, "gs-base");
  assert.equal(by("garden-suite").discount, undefined);
  assert.equal(by("sunrise-suite").rateId, "sr-lt");
  assert.equal(by("seaview-suite").rateId, "sv1-base");
  assert.equal(by("seaview-2br").available, false);
  assert.deepEqual(noBase, ["seaview-2br"]);
  const unused = logs.filter((l) => l.m === "cloudbeds_auto_discount_row_unused").map((l) => `${l.d?.rateId}: ${l.d?.reason}`);
  assert.deepEqual(unused.sort(), ["gs-lm: derived from another rate", "hm-lt: a cheaper rate was sold (Last minute 10% off)", "sv1-lm: not cheaper than the base rate"]);
  assert.equal(logs.some((l) => l.m === "cloudbeds_promo_row_unused"), false, "the Direct rate's own log line is for Direct rows only");

  // Offers: the discount's price with the base rate struck through, its kind and plan name (the label).
  const offer = buildOffers(inv, 2, ["standard"]).find((o) => o.slug === "honeymoon-suite")!;
  assert.equal(offer.rates[0].totalSatang, 3 * 810_000);
  assert.deepEqual({ ...offer.rates[0].list, baseNightly: undefined }, { baseNightly: undefined, adultsExtraSatang: {}, kind: "auto", name: "Last minute 10% off" });
  assert.equal(rateDiscountLabel(offer.rates[0].list, null), "Last minute 10% off");
  assert.equal(rateDiscountLabel(offer.rates[0].list, "DIRECT"), "Last minute 10% off", "an automatic discount keeps its own name next to a code");
});

test("cheapest wins between the Direct rate and an automatic discount: Direct on a tie; the losing Direct row marks the room promoNotApplied", () => {
  const promo: PromoRateIndex = { "462958": [{ rateId: "hm-direct", parentRateId: "hm-base", name: "Direct booking rate" }] };
  const parse = (direct: number, lastMinute: number) => {
    const logs: string[] = [];
    const hm = hmOf(
      parseAvailableRoomTypes(
        // The automatic row first in the answer, so a tie is decided by the rule, not by the order.
        answer([row("462958", "hm-base", 9000), derivedRow("462958", "hm-lm", lastMinute, "Last minute 10% off"), derivedRow("462958", "hm-direct", direct, "Direct booking rate")]),
        FAR_CHECKIN,
        addDays(FAR_CHECKIN, 3),
        { baseRateOnly: true, promo: { rates: promo }, auto: { rates: AUTO_INDEX }, log: (m) => logs.push(m) },
      ),
    );
    return { hm, logs };
  };
  const directWins = parse(7200, 8100);
  assert.equal(directWins.hm.rateId, "hm-direct");
  assert.equal(directWins.hm.discount?.kind, "direct");
  assert.equal(directWins.hm.discount?.name, "Direct booking rate");
  assert.equal(directWins.hm.promoNotApplied, undefined);
  const autoWins = parse(8100, 7000);
  assert.equal(autoWins.hm.rateId, "hm-lm");
  assert.equal(autoWins.hm.discount?.kind, "auto");
  assert.equal(autoWins.hm.promoNotApplied, true, "the code's rate is not the one shown");
  assert.ok(autoWins.logs.includes("cloudbeds_promo_row_unused"), "the Direct row not sold keeps its own log line");
  const tie = parse(8100, 8100);
  assert.equal(tie.hm.rateId, "hm-direct", "a tie goes to the rate the guest asked for");
  // The search verdict: rooms on an automatic discount are not "standard rates".
  const valid = { code: "DIRECT", valid: true as const, pct: 0, label: "Direct rate" };
  const note = promoVerdictForInventory(valid, "direct-rate", [autoWins.hm]);
  assert.ok(note && !note.valid);
  assert.equal(note && !note.valid ? note.message : "", "Code DIRECT doesn't apply to these dates - the prices shown are our best rates for them.");
  assert.equal(promoVerdictForInventory(valid, "direct-rate", [directWins.hm]), valid);
});

/* ------------------------------- availability ------------------------------- */

test("Long term booking: shown for 7 nights (6% off, the base price as list price), not offered for 3; Non-refundable never, though cheaper and offered", async () => {
  const kit = autoKit();
  const week = await search(kit, SEVEN_NIGHTS);
  const hm = hmOf(week.inventory);
  assert.equal(hm.rateId, "rate-hm-lt");
  assert.equal(hm.discount?.name, "Long term booking");
  assert.equal(hm.baseNightly.reduce((s, n) => s + n.amountSatang, 0), HM_LT_7);
  // The fake offers Non-refundable (8,100) next to it: cheaper, but never sold automatically.
  const plainAnswer = kit.fakeCb.calls.find((c) => c.method === "getAvailableRoomTypes")!;
  assert.equal(plainAnswer.params.promoCode, undefined);
  assert.equal(week.inventory.find((i) => i.slug === "sunrise-suite")?.rateId, "rate-sr-lt");
  assert.equal(week.inventory.find((i) => i.slug === "garden-suite")?.discount, undefined);
  assert.equal(unfilteredRatePlanReads(kit), 1, "one rate-plan index read per search");

  const three = await search(kit, { checkIn: FAR_CHECKIN, checkOut: addDays(FAR_CHECKIN, 3) });
  assert.equal(hmOf(three.inventory).rateId, "rate-hm", "Long term is not offered for 3 nights: the base rate");
  assert.equal(hmOf(three.inventory).discount, undefined);
});

test("Last minute 10% off: sold for an arrival inside its window (3 days ahead), not for one 15 days ahead", async () => {
  const kit = autoKit({ env: NEAR_ENV });
  const near = hmOf((await search(kit, NEAR)).inventory);
  assert.equal(near.rateId, "rate-hm-lm");
  assert.equal(near.discount?.name, "Last minute 10% off");
  assert.deepEqual(near.baseNightly.map((n) => n.amountSatang), [810_000, 810_000, 810_000]);
  const later = hmOf((await search(kit, { checkIn: "2026-10-20", checkOut: "2026-10-23" })).inventory);
  assert.equal(later.rateId, "rate-hm");
});

test("flag off: base rates only, and no rate-plan index read", async () => {
  const kit = autoKit({ env: { ...STRIPE_TEST_ENV, BOOKING_AUTO_DISCOUNTS: "off" } });
  const hm = hmOf((await search(kit, SEVEN_NIGHTS)).inventory);
  assert.equal(hm.rateId, "rate-hm");
  assert.equal(hm.discount, undefined);
  assert.equal(kit.fakeCb.count("getRatePlans"), 0);
  const res = await checkout(kit, HONEYMOON, SEVEN_NIGHTS);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(postOf(kit)?.params["rooms[0][roomRateID]"], "rate-hm");
  assert.equal((res.body as CheckoutSuccess).quote.autoDiscount ?? null, null);
  assert.equal(kit.fakeCb.count("getRatePlans"), 1, "only the stay-rule read under the lock");
});

test("one rate-plan index read per search, read at the same time as availability, shared by searches with and without the code (60 s cache)", async () => {
  const kit = autoKit();
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    try {
      return await kit.fakeCb.fetch(url, init);
    } finally {
      inFlight--;
    }
  }) as typeof fetch;
  // Its own read key: the search caches are per server instance (every test file runs in one process).
  const config = { dataSource: "cloudbeds" as const, cloudbeds: { apiKey: "cbat_auto_cache_once", propertyId: "235064", baseRateOnly: true, autoDiscountPlans: DEFAULT_AUTO_DISCOUNT_PLANS } };
  const plain = await getInventory(SEVEN_NIGHTS.checkIn, SEVEN_NIGHTS.checkOut, config, { fetchImpl, cacheTtlMs: SEARCH_CACHE_TTL_MS, allowDemoFallback: false });
  assert.equal(hmOf(plain.inventory).rateId, "rate-hm-lt");
  assert.equal(kit.fakeCb.count("getRatePlans"), 1);
  assert.equal(kit.fakeCb.count("getAvailableRoomTypes"), 1);
  assert.equal(maxInFlight, 2, "the index and availability reads overlap");
  // The same search again: both answers from the cache.
  await getInventory(SEVEN_NIGHTS.checkIn, SEVEN_NIGHTS.checkOut, config, { fetchImpl, cacheTtlMs: SEARCH_CACHE_TTL_MS, allowDemoFallback: false });
  assert.equal(kit.fakeCb.calls.length, 2);
  // With the code: the same index rows (no second getRatePlans read), availability asked plain and with the code.
  const withCode = await getInventory(SEVEN_NIGHTS.checkIn, SEVEN_NIGHTS.checkOut, config, {
    fetchImpl,
    cacheTtlMs: SEARCH_CACHE_TTL_MS,
    allowDemoFallback: false,
    promo: { cloudbedsCode: FAKE_DIRECT_PROMO_CODE },
  });
  assert.equal(kit.fakeCb.count("getRatePlans"), 1);
  assert.equal(kit.fakeCb.count("getAvailableRoomTypes"), 3);
  assert.equal(hmOf(withCode.inventory).rateId, "rate-hm-direct", "Direct (80%) beats Long term (94%)");
  assert.equal(withCode.inventory.find((i) => i.slug === "sunrise-suite")?.rateId, "rate-sr-lt", "no Direct plan there: its automatic discount");
  assert.equal(withCode.inventory.find((i) => i.slug === "sunrise-suite")?.promoNotApplied, true);
  // Automatic discounts off: one read only (no index).
  maxInFlight = 0;
  await getInventory(SEVEN_NIGHTS.checkIn, SEVEN_NIGHTS.checkOut, { ...config, cloudbeds: { ...config.cloudbeds, apiKey: "cbat_auto_cache_off", autoDiscountPlans: [] } }, { fetchImpl, allowDemoFallback: false });
  assert.equal(kit.fakeCb.count("getRatePlans"), 1);
  assert.equal(maxInFlight, 1);
});

test("a cached search answer is reused only with the same rate-plan index (a changed index re-reads availability)", async () => {
  const kit = autoKit();
  const deps = { apiKey: "cbat_auto_cache_index", propertyId: "235064", fetchImpl: kit.fakeCb.fetch, baseRateOnly: true, cacheTtlMs: 60_000, nowMs: 1_000 };
  const withLongTerm: RatePlanIndex = { promo: {}, auto: { "462958": [{ rateId: "rate-hm-lt", parentRateId: "rate-hm", name: "Long term booking" }] } };
  const none: RatePlanIndex = { promo: {}, auto: {} };
  assert.equal(hmOf(await cloudbedsInventory(SEVEN_NIGHTS.checkIn, SEVEN_NIGHTS.checkOut, { ...deps, rateIndex: withLongTerm })).rateId, "rate-hm-lt");
  assert.equal(hmOf(await cloudbedsInventory(SEVEN_NIGHTS.checkIn, SEVEN_NIGHTS.checkOut, { ...deps, rateIndex: Promise.resolve(withLongTerm) })).rateId, "rate-hm-lt");
  assert.equal(kit.fakeCb.count("getAvailableRoomTypes"), 1, "same index: cached");
  assert.equal(hmOf(await cloudbedsInventory(SEVEN_NIGHTS.checkIn, SEVEN_NIGHTS.checkOut, { ...deps, rateIndex: none })).rateId, "rate-hm");
  assert.equal(kit.fakeCb.count("getAvailableRoomTypes"), 2, "another index: read and parsed again");
});

test("search: the automatic discounts' rate-plan read is best effort - getRatePlans failing (HTTP 500, success:false) shows the base rates with a log line, never a failed search", async (t) => {
  const infos = t.mock.method(console, "info", () => undefined);
  for (const kind of ["http500", "rejected"] as const) {
    const kit = autoKit();
    kit.fakeCb.failNext("getRatePlans", kind);
    const r = await search(kit, SEVEN_NIGHTS, { autoDiscountsBestEffort: true });
    assert.equal(r.dataSource, "cloudbeds", kind);
    assert.equal(hmOf(r.inventory).rateId, "rate-hm", `${kind}: the base rate, as with automatic discounts off`);
    assert.ok(r.inventory.some((i) => i.available), kind);
    assert.ok(r.inventory.every((i) => i.discount === undefined), kind);
    assert.equal(r.rateIndex, undefined, "no index for a cart to reuse");
    assert.equal(kit.fakeCb.count("getRatePlans"), 1);
  }
  const lines = infos.mock.calls.filter((c) => c.arguments[0] === "[booking] cloudbeds_rate_index_failed").map((c) => String(c.arguments[1]));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /getRatePlans HTTP 500/);
  assert.match(lines[1], /getRatePlans failed: /);
  // The availability route asks for it; checkout can't (getCartInventory's options leave it out).
  const route = readFileSync(new URL("../../app/api/booking/availability/route.ts", import.meta.url), "utf8");
  assert.ok(route.includes("autoDiscountsBestEffort: true"));
});

test("search: availability takes its call-budget token before the rate-plan read, so with one token left the search still shows the base rates (the index read is not sent)", async (t) => {
  t.mock.method(console, "info", () => undefined);
  const kit = autoKit();
  const r = await search(kit, SEVEN_NIGHTS, { autoDiscountsBestEffort: true, budget: createTokenBucket(0.001, 1) });
  assert.equal(r.dataSource, "cloudbeds");
  assert.equal(hmOf(r.inventory).rateId, "rate-hm");
  assert.equal(kit.fakeCb.count("getAvailableRoomTypes"), 1);
  assert.equal(kit.fakeCb.count("getRatePlans"), 0, "no token left for it");
});

test("search: a cached answer whose rate-plan index has changed is still served when availability can't be re-read (the index read took the last call-budget token)", async (t) => {
  t.mock.method(console, "info", () => undefined);
  const kit = autoKit();
  let tokens = 1;
  const budget = { take: () => (tokens > 0 ? (tokens--, true) : false), msUntilNext: () => 60_000 };
  // Its own read key: the search caches are per server instance (every test file runs in one process).
  const config = { dataSource: "cloudbeds" as const, cloudbeds: { apiKey: "cbat_auto_scarce", propertyId: "235064", baseRateOnly: true, autoDiscountPlans: DEFAULT_AUTO_DISCOUNT_PLANS } };
  const run = () =>
    getInventory(SEVEN_NIGHTS.checkIn, SEVEN_NIGHTS.checkOut, config, { fetchImpl: kit.fakeCb.fetch, cacheTtlMs: SEARCH_CACHE_TTL_MS, allowDemoFallback: false, autoDiscountsBestEffort: true, budget });
  // 1. One token: availability takes it, the index read gets none - the base rate, cached without the index.
  assert.equal(hmOf((await run()).inventory).rateId, "rate-hm");
  assert.equal(kit.fakeCb.count("getRatePlans"), 0);
  // 2. One token again: the index read takes it (Long term is listed: another index), availability gets none - the cached answer.
  tokens = 1;
  const second = await run();
  assert.equal(second.dataSource, "cloudbeds");
  assert.equal(hmOf(second.inventory).rateId, "rate-hm");
  assert.equal(kit.fakeCb.count("getRatePlans"), 1);
  assert.equal(kit.fakeCb.count("getAvailableRoomTypes"), 1);
  // 3. Tokens again: the index rows come from their cache and availability is re-read with them - the discount.
  tokens = 2;
  assert.equal(hmOf((await run()).inventory).rateId, "rate-hm-lt");
  assert.equal(kit.fakeCb.count("getRatePlans"), 1);
  assert.equal(kit.fakeCb.count("getAvailableRoomTypes"), 2);
});

test("search: a cached answer is served as it is when the optional rate-plan read fails (e.g. its rows cache expired first); a required one still fails the read", async () => {
  const kit = autoKit();
  const deps = { apiKey: "cbat_auto_cache_failed", propertyId: "235064", fetchImpl: kit.fakeCb.fetch, baseRateOnly: true, cacheTtlMs: 60_000, nowMs: 1_000 };
  const withLongTerm: RatePlanIndex = { promo: {}, auto: { "462958": [{ rateId: "rate-hm-lt", parentRateId: "rate-hm", name: "Long term booking" }] } };
  assert.equal(hmOf(await cloudbedsInventory(SEVEN_NIGHTS.checkIn, SEVEN_NIGHTS.checkOut, { ...deps, rateIndex: withLongTerm })).rateId, "rate-hm-lt");
  const failed: unknown[] = [];
  const failing = () => Promise.reject(new Error("getRatePlans HTTP 500"));
  const hit = await cloudbedsInventory(SEVEN_NIGHTS.checkIn, SEVEN_NIGHTS.checkOut, { ...deps, nowMs: 30_000, rateIndex: failing, onRateIndexFailed: (e) => failed.push(e) });
  assert.equal(hmOf(hit).rateId, "rate-hm-lt", "the cached answer stands");
  assert.equal(kit.fakeCb.count("getAvailableRoomTypes"), 1, "from the cache");
  assert.equal(failed.length, 1);
  await assert.rejects(cloudbedsInventory(SEVEN_NIGHTS.checkIn, SEVEN_NIGHTS.checkOut, { ...deps, nowMs: 30_000, rateIndex: failing }), /getRatePlans HTTP 500/);
});

/** kit.fakeCb.fetch, with getRatePlans answering `status` while `state.failing` (counted in state.sent). */
function failingRatePlans(kit: Kit, status: number, headers: Record<string, string> = {}) {
  const state = { failing: true, sent: 0 };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (!String(url).includes("/getRatePlans")) return kit.fakeCb.fetch(url, init);
    state.sent++;
    if (!state.failing) return kit.fakeCb.fetch(url, init);
    return new Response(JSON.stringify({ success: false, message: "Internal error" }), { status, headers: { "content-type": "application/json", ...headers } });
  }) as typeof fetch;
  return { state, fetchImpl };
}

test("search: a failed optional rate-plan read is remembered (RATE_PLAN_FAIL_TTL_MS) - cached searches don't re-send it: no call, no budget token, no wait; a required read (code, checkout) still asks", async (t) => {
  const infos = t.mock.method(console, "info", () => undefined);
  const kit = autoKit();
  const { state, fetchImpl } = failingRatePlans(kit, 500);
  let taken = 0;
  const budget = { take: () => (taken++, true), msUntilNext: () => 0 };
  // Its own read key: the search caches are per server instance (every test file runs in one process).
  const config = { dataSource: "cloudbeds" as const, cloudbeds: { apiKey: "cbat_auto_fail_remembered", propertyId: "235064", baseRateOnly: true, autoDiscountPlans: DEFAULT_AUTO_DISCOUNT_PLANS } };
  const run = (promo?: { cloudbedsCode: string }) =>
    getInventory(SEVEN_NIGHTS.checkIn, SEVEN_NIGHTS.checkOut, config, { fetchImpl, cacheTtlMs: SEARCH_CACHE_TTL_MS, allowDemoFallback: false, autoDiscountsBestEffort: true, budget, ...(promo ? { promo } : {}) });
  for (let i = 0; i < 5; i++) {
    const r = await run();
    assert.equal(hmOf(r.inventory).rateId, "rate-hm", `search ${i + 1}: the base rate`);
  }
  assert.equal(state.sent, 1, "getRatePlans sent once, not once per cached search");
  assert.equal(kit.fakeCb.count("getAvailableRoomTypes"), 1);
  assert.equal(taken, 2, "availability and the one index read: no token after the first search");
  const lines = infos.mock.calls.filter((c) => c.arguments[0] === "[booking] cloudbeds_rate_index_failed").map((c) => String(c.arguments[1]));
  assert.equal(lines.length, 5);
  assert.match(lines[0], /getRatePlans HTTP 500/);
  assert.match(lines[1], /getRatePlans HTTP 500 \(remembered: not re-sent for 20 s\)/);
  // A search with the code needs the index: it asks (and fails closed), never served from the remembered failure.
  await assert.rejects(run({ cloudbedsCode: FAKE_DIRECT_PROMO_CODE }), /Live availability unavailable: getRatePlans HTTP 500$/);
  assert.equal(state.sent, 2);
  // Checkout (no cache): asks too.
  await assert.rejects(cloudbedsRateIndex(SEVEN_NIGHTS.checkIn, SEVEN_NIGHTS.checkOut, { cloudbedsCode: null, autoPlans: DEFAULT_AUTO_DISCOUNT_PLANS }, { apiKey: config.cloudbeds.apiKey, propertyId: "235064", fetchImpl }), /getRatePlans HTTP 500$/);
  assert.equal(state.sent, 3);
  // Cloudbeds answers again: a required read's success clears the remembered failure; the next plain search gets the discount.
  state.failing = false;
  assert.equal(hmOf((await run({ cloudbedsCode: FAKE_DIRECT_PROMO_CODE })).inventory).rateId, "rate-hm-direct");
  assert.equal(hmOf((await run()).inventory).rateId, "rate-hm-lt");
  assert.equal(state.sent, 4, "the plain search reuses the rows just read");
});

test("cloudbedsRateIndex rememberFailure: only with a cache TTL; for RATE_PLAN_FAIL_TTL_MS after a sent read failed (a 429 costs its call and one retry, once); a budget refusal before sending is not remembered", async () => {
  const kit = autoKit();
  const { state, fetchImpl } = failingRatePlans(kit, 429, { "retry-after": "1" });
  const options = { cloudbedsCode: null, autoPlans: DEFAULT_AUTO_DISCOUNT_PLANS };
  const deps = { apiKey: "cbat_auto_fail_ttl", propertyId: "235064", fetchImpl, cacheTtlMs: 60_000, rememberFailure: true, nowMs: 1_000, sleep: async () => undefined };
  const index = (nowMs: number, extra: Partial<Parameters<typeof cloudbedsRateIndex>[3]> = {}) => cloudbedsRateIndex(SEVEN_NIGHTS.checkIn, SEVEN_NIGHTS.checkOut, options, { ...deps, nowMs, ...extra });
  await assert.rejects(index(1_000), /getRatePlans HTTP 429$/);
  assert.equal(state.sent, 2, "the call and its one 429 retry");
  await assert.rejects(index(5_000), /getRatePlans HTTP 429 \(remembered/);
  await assert.rejects(index(1_000 + RATE_PLAN_FAIL_TTL_MS - 1), /remembered/);
  assert.equal(state.sent, 2, "nothing sent while remembered");
  // Without rememberFailure, or without a TTL (checkout), it is sent.
  await assert.rejects(index(5_000, { rememberFailure: false }), /getRatePlans HTTP 429$/);
  await assert.rejects(index(5_000, { cacheTtlMs: undefined }), /getRatePlans HTTP 429$/);
  assert.equal(state.sent, 6);
  // Expired: sent again, and its success is cached as usual.
  state.failing = false;
  const fresh = await index(1_000 + RATE_PLAN_FAIL_TTL_MS);
  assert.ok(fresh.auto["462958"]?.some((r) => r.name === "Long term booking"), JSON.stringify(fresh));
  assert.equal(state.sent, 7);
  state.failing = true;
  assert.deepEqual(await index(1_000 + RATE_PLAN_FAIL_TTL_MS + 1), fresh, "from the rows cache");
  assert.equal(state.sent, 7);

  // No budget token: nothing sent, nothing remembered - the next read with a token is sent.
  const kit2 = autoKit();
  const two = failingRatePlans(kit2, 500);
  two.state.failing = false;
  const deps2 = { ...deps, apiKey: "cbat_auto_fail_budget", fetchImpl: two.fetchImpl };
  await assert.rejects(cloudbedsRateIndex(SEVEN_NIGHTS.checkIn, SEVEN_NIGHTS.checkOut, options, { ...deps2, budget: { take: () => false, msUntilNext: () => 60_000 } }), CloudbedsBudgetError);
  assert.equal(two.state.sent, 0);
  await cloudbedsRateIndex(SEVEN_NIGHTS.checkIn, SEVEN_NIGHTS.checkOut, options, deps2);
  assert.equal(two.state.sent, 1);
});

test("search with a valid code, and checkout: a failed rate-plan read still fails closed (the Direct rate and the price need it), nothing held", async () => {
  const kit = autoKit();
  kit.fakeCb.failNext("getRatePlans", "http500");
  await assert.rejects(search(kit, SEVEN_NIGHTS, { autoDiscountsBestEffort: true, promo: { cloudbedsCode: FAKE_DIRECT_PROMO_CODE } }), /Live availability unavailable: getRatePlans HTTP 500/);
  const kit2 = autoKit();
  const req = request(HONEYMOON, SEVEN_NIGHTS);
  const quote = await serverQuote(kit2, req);
  kit2.fakeCb.failNext("getRatePlans", "http500"); // the re-quote's index read
  const res = await runCheckout({ ...req, expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang }, kit2.checkoutDeps());
  assert.equal(res.status, 503, JSON.stringify(res.body));
  assert.equal(kit2.fakeCb.count("postReservation"), 0);
});

/* --------------------------------- checkout -------------------------------- */

test("Long term booking sold end to end (7 nights): hold on its roomRateID with no promo code, the plan's total + 5%, labelled everywhere, paid, folio balance 0", async () => {
  const kit = autoKit();
  const res = await checkout(kit, HONEYMOON, SEVEN_NIGHTS);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  const fee = Math.round(HM_LT_7 * 0.05);
  assert.equal(body.quote.roomsSubtotalSatang, HM_LT_7);
  assert.equal(body.quote.lines[0].listRoomSatang, HM_BASE_7);
  assert.deepEqual(body.quote.lines[0].discount, { kind: "auto", name: "Long term booking" });
  assert.deepEqual(body.quote.autoDiscount, { names: ["Long term booking"], baseRoomsSatang: HM_BASE_7, savingSatang: HM_BASE_7 - HM_LT_7 });
  assert.equal(body.quote.directRate, null);
  assert.equal(body.quote.promo, null);
  assert.equal(body.quote.totalSatang, HM_LT_7 + fee);
  assert.equal(lineDiscountLabel(body.quote.lines[0], body.quote), "Long term booking");

  const post = postOf(kit)!;
  assert.equal(post.params["rooms[0][roomRateID]"], "rate-hm-lt");
  assert.equal(post.params.promoCode, undefined, "an automatic discount needs no code");
  // Quote and re-quote: one index read each (the 2-adult gate reuses it); the re-check under the lock reads none.
  assert.equal(unfilteredRatePlanReads(kit), 2);
  const restrictionsAt = kit.fakeCb.calls.findIndex((c) => c.method === "getRatePlans" && c.params.roomTypeID !== undefined);
  assert.ok(restrictionsAt >= 0);
  assert.equal(kit.fakeCb.calls.slice(restrictionsAt + 1).some((c) => c.method === "getRatePlans"), false);
  const reservation = kit.fakeCb.reservations.get(body.holdReservationId!)!;
  assert.equal(reservation.subTotal * 100, HM_LT_7);
  assert.match(reservation.notes.join("\n"), /Automatic discount: Long term booking\./);

  const sessionId = sessionIdOf(body);
  const session = kit.fakeStripe.session(sessionId)!;
  assert.equal(session.amount_total, HM_LT_7 + fee);
  assert.match(session.line_items_input[0].name, /^Honeymoon .+ - Standard Rate \(Long term booking\)$/);
  // The return page's token: the room's discount, its base price struck through.
  const token = new URL(session.success_url.replace("{CHECKOUT_SESSION_ID}", "x")).searchParams.get("t");
  const v = verifyBookingToken(token, kit.config.tokenSecret, NOW);
  assert.ok(v.ok);
  if (v.ok) {
    assert.deepEqual(v.payload.booking.itemDiscounts, [{ kind: "auto", label: "Long term booking", listSatang: HM_BASE_7 }]);
    assert.equal(v.payload.booking.promoCode, null);
    // GA4: the plan's name as item_variant (no coupon: there is no code).
    const purchase = purchaseParams(v.payload.booking);
    assert.equal(purchase.coupon, "");
    assert.equal((purchase.items as { item_variant?: string }[])[0].item_variant, "Long term booking");
  }
  assert.equal(itemFromQuoteLine(body.quote.lines[0], body.quote).item_variant, "Long term booking");

  kit.fakeStripe.complete(sessionId);
  const { payload, header } = kit.fakeStripe.signedEvent("checkout.session.completed", sessionId);
  assert.equal((await handleStripeWebhook(payload, header, kit.deps, { nowMs: NOW })).body, "confirmed");
  assert.equal(reservation.status, "confirmed");
  assert.equal(kit.fakeCb.balance(body.holdReservationId!), 0);
});

test("Last minute sold end to end for a near arrival (guard relaxed: MOCK writer)", async () => {
  const kit = autoKit({ env: NEAR_ENV });
  const res = await checkout(kit, HONEYMOON, NEAR);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  assert.equal(body.quote.roomsSubtotalSatang, 3 * 810_000);
  assert.deepEqual(body.quote.autoDiscount?.names, ["Last minute 10% off"]);
  assert.equal(postOf(kit)?.params["rooms[0][roomRateID]"], "rate-hm-lm");
  assert.equal(kit.fakeCb.reservations.get(body.holdReservationId!)?.subTotal, 3 * 8100);
});

test("3 nights far ahead: no automatic discount offered, the base rate is booked as before", async () => {
  const kit = autoKit();
  const res = await checkout(kit, HONEYMOON);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((res.body as CheckoutSuccess).quote.autoDiscount, null);
  assert.equal((res.body as CheckoutSuccess).quote.lines[0].listRoomSatang, undefined);
  assert.equal(postOf(kit)?.params["rooms[0][roomRateID]"], "rate-hm");
});

test("promo-code plans and Non-refundable are never sold automatically, even when Cloudbeds lists them in the plain answer and they are cheaper", async () => {
  const roomTypes: Record<string, FakeRoomType> = {
    ...AUTO_ROOM_TYPES,
    "462958": {
      ...AUTO_ROOM_TYPES["462958"],
      plans: [...HM_PLANS, { rateId: "rate-hm-vip", name: "Long term VIP", pctOfBase: 70, promoCode: "VIP", inPlainAnswer: true, offeredFromNights: 7 }],
    },
  };
  // Even with the owner listing them as automatic plans.
  const kit = autoKit({ roomTypes, env: { ...STRIPE_TEST_ENV, BOOKING_AUTO_DISCOUNT_PLANS: "Long term,Non-refundable" } });
  const res = await checkout(kit, HONEYMOON, SEVEN_NIGHTS);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((res.body as CheckoutSuccess).quote.roomsSubtotalSatang, HM_LT_7);
  assert.equal(postOf(kit)?.params["rooms[0][roomRateID]"], "rate-hm-lt");
  assert.equal(postOf(kit)?.params.promoCode, undefined);
  // 3 nights: Non-refundable is still offered (and 10% cheaper) - the base rate is sold.
  const kit3 = autoKit({ roomTypes, env: { ...STRIPE_TEST_ENV, BOOKING_AUTO_DISCOUNT_PLANS: "Non-refundable" } });
  assert.equal((await checkout(kit3, HONEYMOON)).status, 200);
  assert.equal(postOf(kit3)?.params["rooms[0][roomRateID]"], "rate-hm");
});

test("cheapest wins at checkout: DIRECT (20% off) beats Long term (6%); an Early bird plan cheaper than Direct is sold instead, without the promo code", async () => {
  const kit = autoKit();
  const direct = await checkout(kit, HONEYMOON, { ...SEVEN_NIGHTS, promo: "DIRECT" });
  assert.equal(direct.status, 200, JSON.stringify(direct.body));
  assert.equal((direct.body as CheckoutSuccess).quote.roomsSubtotalSatang, HM_DIRECT_7);
  assert.equal((direct.body as CheckoutSuccess).quote.autoDiscount, null);
  assert.equal(postOf(kit)?.params["rooms[0][roomRateID]"], "rate-hm-direct");
  assert.equal(postOf(kit)?.params.promoCode, FAKE_DIRECT_PROMO_CODE);

  const roomTypes: Record<string, FakeRoomType> = {
    ...AUTO_ROOM_TYPES,
    "462958": { ...AUTO_ROOM_TYPES["462958"], plans: [...HM_PLANS, { rateId: "rate-hm-eb", name: "Early bird 25% off", pctOfBase: 75 }] },
  };
  const kit2 = autoKit({ roomTypes });
  const early = await checkout(kit2, HONEYMOON, { ...SEVEN_NIGHTS, promo: "DIRECT" });
  assert.equal(early.status, 200, JSON.stringify(early.body));
  const quote = (early.body as CheckoutSuccess).quote;
  assert.equal(quote.roomsSubtotalSatang, 7 * 675_000);
  assert.equal(quote.directRate, null, "no room on the Direct rate");
  assert.deepEqual(quote.autoDiscount?.names, ["Early bird 25% off"]);
  assert.equal(postOf(kit2)?.params["rooms[0][roomRateID]"], "rate-hm-eb");
  assert.equal(postOf(kit2)?.params.promoCode, undefined, "no promo code without a Direct room");
});

test("mixed cart (Direct + automatic + base, 7 nights, code DIRECT): each room on its own rate id, one promo code, each discount's base total apart, paid, balance 0", async () => {
  const kit = autoKit();
  const res = await checkout(kit, [...HONEYMOON, ...SUNRISE, ...GARDEN], { ...SEVEN_NIGHTS, promo: "DIRECT" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const quote = (res.body as CheckoutSuccess).quote;
  assert.equal(quote.roomsSubtotalSatang, HM_DIRECT_7 + SR_LT_7 + GS_BASE_7);
  assert.deepEqual(quote.lines.map((l) => l.discount?.kind ?? null), ["direct", "auto", null]);
  assert.deepEqual(quote.lines.map((l) => lineDiscountLabel(l, quote)), ["Direct rate - code DIRECT", "Long term booking", null]);
  // GA4 funnel items (add_to_cart ... add_payment_info): the variant on the automatic discount only, as on the purchase below.
  assert.deepEqual(quote.lines.map((l) => itemFromQuoteLine(l, quote).item_variant ?? null), [null, "Long term booking", null]);
  assert.equal(quote.directRate?.baseRoomsSatang, HM_BASE_7 + SR_LT_7 + GS_BASE_7, "the Direct room at its base rate, the others as quoted");
  assert.deepEqual(quote.autoDiscount, { names: ["Long term booking"], baseRoomsSatang: HM_DIRECT_7 + SR_BASE_7 + GS_BASE_7, savingSatang: SR_BASE_7 - SR_LT_7 });
  const post = postOf(kit)!;
  assert.deepEqual([0, 1, 2].map((i) => post.params[`rooms[${i}][roomRateID]`]), ["rate-hm-direct", "rate-sr-lt", "rate-gs"]);
  assert.deepEqual(Object.keys(post.params).filter((k) => /promo/i.test(k)), ["promoCode"]);
  assert.equal(post.params.promoCode, FAKE_DIRECT_PROMO_CODE);
  const body = res.body as CheckoutSuccess;
  const session = kit.fakeStripe.session(sessionIdOf(body))!;
  assert.deepEqual(
    session.line_items_input.slice(0, 3).map((l) => l.name.replace(/^.* - Standard Rate/, "")),
    [" (Direct rate)", " (Long term booking)", ""],
  );
  const v = verifyBookingToken(new URL(session.success_url.replace("{CHECKOUT_SESSION_ID}", "x")).searchParams.get("t"), kit.config.tokenSecret, NOW);
  assert.ok(v.ok);
  if (v.ok) {
    assert.deepEqual(v.payload.booking.itemDiscounts, [
      { kind: "direct", label: "Direct rate - code DIRECT", listSatang: HM_BASE_7 },
      { kind: "auto", label: "Long term booking", listSatang: SR_BASE_7 },
      null,
    ]);
    assert.deepEqual((purchaseParams(v.payload.booking).items as { item_variant?: string }[]).map((i) => i.item_variant ?? null), [null, "Long term booking", null]);
  }
  kit.fakeStripe.complete(session.id);
  const { payload, header } = kit.fakeStripe.signedEvent("checkout.session.completed", session.id);
  assert.equal((await handleStripeWebhook(payload, header, kit.deps, { nowMs: NOW })).body, "confirmed");
  assert.equal(kit.fakeCb.balance(body.holdReservationId!), 0);
});

/* ------------------------------ stay rules ------------------------------ */

function ratePlansAnswer(baseDays: Record<string, unknown>[], autoDays: Record<string, unknown>[], autoExtra: Record<string, unknown> = {}) {
  const days = (overrides: Record<string, unknown>[]) =>
    ["2027-11-10", "2027-11-11", "2027-11-12", "2027-11-13"].map((date, i) => ({ date, minLos: 0, maxLos: 0, closedToArrival: false, closedToDeparture: false, blocked: false, roomsAvailable: 1, ...(overrides[i] ?? {}) }));
  return {
    success: true,
    data: [
      { rateID: "hm-nr", isDerived: true, ratePlanID: "p-nr", ratePlanNamePublic: "Non-refundable 10% discount", promoCode: null, parentRateID: "hm-base", roomRateDetailed: days([]) },
      { rateID: "hm-direct", isDerived: true, ratePlanID: "484584", ratePlanNamePublic: "Direct booking rate", promoCode: "Direct", parentRateID: "hm-base", roomRateDetailed: days([]) },
      { rateID: "hm-lm", isDerived: true, ratePlanID: "p-lm", ratePlanNamePublic: "Last minute 10% off", promoCode: null, parentRateID: "hm-base", roomRateDetailed: days(autoDays), ...autoExtra },
      { rateID: "hm-base", isDerived: false, ratePlanID: null, ratePlanNamePublic: null, roomRateDetailed: days(baseDays) },
    ],
  };
}
const AUTO_SEL = { kind: "auto" as const, plans: DEFAULT_AUTO_DISCOUNT_PLANS, baseRateId: "hm-base" };
const check = (json: unknown, checkOut = "2027-11-13", rateId = "hm-lm", sel: typeof AUTO_SEL | null = AUTO_SEL) =>
  evaluateRestrictions(json, "462958", rateId, "2027-11-10", checkOut, { promo: sel });

test("stay rules for an automatic discount: the derived row AND its base row over every stay night (strictest wins; 0 = no limit)", () => {
  const minBase = ratePlansAnswer([{ minLos: 2 }], []);
  assert.deepEqual(check(minBase, "2027-11-11"), { ok: false, reason: "min_stay", minNights: 2, auto: true });
  assert.deepEqual(check(minBase, "2027-11-11", "hm-lm", null), { ok: true, checked: true, derived: true }, "the row alone would pass (and is refused as derived)");
  assert.deepEqual(check(ratePlansAnswer([{}, { minLos: 2 }], [{}, {}, { minLos: 4 }])), { ok: false, reason: "min_stay", minNights: 4, auto: true });
  assert.deepEqual(check(ratePlansAnswer([{ maxLos: 0 }], [{ maxLos: 2 }])), { ok: false, reason: "max_stay", maxNights: 2, auto: true });
  assert.equal(check(ratePlansAnswer([{ closedToArrival: true }], [])).ok, false);
  assert.deepEqual(check(ratePlansAnswer([], [{}, {}, {}, { closedToDeparture: true }])), { ok: false, reason: "closed_to_departure", auto: true });
  assert.deepEqual(check(ratePlansAnswer([{}, { blocked: true }], [])), { ok: false, reason: "blocked", auto: true });
  assert.deepEqual(check(ratePlansAnswer([], [{}, {}, { roomsAvailable: 0 }])), { ok: false, reason: "sold_out", auto: true });
  assert.deepEqual(check(ratePlansAnswer([], [])), { ok: true, checked: true, auto: true });
});

test("stay rules: the derived-rate defence allows exactly the automatic discount selected, and still refuses any other derived row", () => {
  const ok = ratePlansAnswer([], []);
  const refused = { ok: true, checked: false, derived: true };
  assert.deepEqual(check(ok, "2027-11-13", "hm-nr"), refused, "Non-refundable presented as the automatic discount");
  assert.deepEqual(check(ok, "2027-11-13", "hm-direct"), refused, "the Direct rate (a promo code) presented as an automatic discount");
  assert.deepEqual(check(ok, "2027-11-13", "999"), refused, "not listed");
  assert.deepEqual(check(ok, "2027-11-13", "hm-lm", { ...AUTO_SEL, plans: ["Long term"] }), refused, "a plan no longer configured");
  assert.deepEqual(check(ratePlansAnswer([], [], { promoCode: "LM" })), refused, "the plan now needs a code");
  assert.deepEqual(check(ratePlansAnswer([], [], { isDerived: false })), refused, "no longer derived");
  assert.deepEqual(check(ratePlansAnswer([], [], { parentRateID: "hm-nr" })), refused, "derived from another rate");
  assert.deepEqual(check(ok, "2027-11-13", "hm-lm", { ...AUTO_SEL, baseRateId: "hm-other" }), refused, "priced next to another base row");
  // getRatePlans sends no parentRateID: allowed next to the base row it was priced with, refused next to another.
  assert.deepEqual(check(ratePlansAnswer([], [], { parentRateID: null })), { ok: true, checked: true, auto: true }, "no parent sent: the base row is the parent");
  assert.deepEqual(check(ratePlansAnswer([], [], { parentRateID: null }), "2027-11-13", "hm-lm", { ...AUTO_SEL, baseRateId: "hm-other" }), refused, "priced next to another base row (getRatePlans sends no parentRateID)");
  // The Direct path is unchanged: its selection still confirms only a promo-code row.
  assert.deepEqual(evaluateRestrictions(ok, "462958", "hm-direct", "2027-11-10", "2027-11-13", { promo: { cloudbedsCode: "Direct", baseRateId: "hm-base" } }), { ok: true, checked: true, promo: true });
  assert.deepEqual(evaluateRestrictions(ok, "462958", "hm-lm", "2027-11-10", "2027-11-13", { promo: { cloudbedsCode: "Direct", baseRateId: "hm-base" } }), refused);
});

test("non-refundable is read in the WHOLE plan name, not only in the 60 characters the page shows: a long name ending in it is never sold automatically, nor allowed by the derived-rate defence", () => {
  const longNames = [
    "Early bird 20% off - book at least 60 days before arrival - Non-refundable", // 74 characters
    "Long term booking (7+ nights, paid in full at booking) - non refundable", // cut at "... - non"
    "Early bird 15% off - book 60 days ahead, prepaid & non-refundable", // cut at "... non-refun"
  ];
  for (const name of longNames) {
    assert.ok(name.length > 60 && !/non[\s_-]*refundable/i.test(planDisplayName(name) ?? ""), `the label alone hides it: ${name}`);
    assert.equal(isAutoDiscountName(name, DEFAULT_AUTO_DISCOUNT_PLANS), false, name);
    const index = parseRatePlanIndex(
      { success: true, data: [{ rateID: "hm-eb", roomTypeID: "462958", isDerived: true, ratePlanNamePublic: name, promoCode: null, parentRateID: "hm-base" }] },
      { cloudbedsCode: null, autoPlans: DEFAULT_AUTO_DISCOUNT_PLANS },
    );
    assert.deepEqual(index.auto, {}, name);
    // Under the lock: refused as a derived rate, never confirmed as the automatic discount.
    assert.deepEqual(check(ratePlansAnswer([], [], { rateID: "hm-lm", ratePlanNamePublic: name })), { ok: true, checked: false, derived: true }, name);
  }
  // A long eligible name is still sold, its label cut to 60 characters.
  const long = "Early bird 20% off - book at least 60 days before arrival, free cancellation as usual";
  const index = parseRatePlanIndex(
    { success: true, data: [{ rateID: "hm-eb", roomTypeID: "462958", isDerived: true, ratePlanNamePublic: long, promoCode: null, parentRateID: "hm-base" }] },
    { cloudbedsCode: null, autoPlans: DEFAULT_AUTO_DISCOUNT_PLANS },
  );
  assert.deepEqual(index.auto, { "462958": [{ rateId: "hm-eb", parentRateId: "hm-base", name: long.slice(0, 60).trim() }] });
});

test("non-refundable in its other spellings is never sold automatically either (short forms, Unicode dashes, no / not refundable, prepaid, advance purchase); plain discount names still qualify", () => {
  for (const name of [
    "Early bird 15% (Non-Ref)",
    "Early Bird NRF",
    "Early bird NonRef 15%",
    "Early bird no refund",
    "Early bird - no refunds",
    "Early bird not refundable",
    "Early bird unrefundable",
    "Early bird Non‑refundable", // non-breaking hyphen
    "Early bird Non–refundable", // en dash
    "Early bird prepaid 15% off",
    "Early bird pre-paid",
    "Early bird advance purchase",
  ]) {
    assert.equal(isAutoDiscountName(name, DEFAULT_AUTO_DISCOUNT_PLANS), false, name);
    const index = parseRatePlanIndex(
      { success: true, data: [{ rateID: "hm-eb", roomTypeID: "462958", isDerived: true, ratePlanNamePublic: name, promoCode: null, parentRateID: "hm-base" }] },
      { cloudbedsCode: null, autoPlans: DEFAULT_AUTO_DISCOUNT_PLANS },
    );
    assert.deepEqual(index.auto, {}, name);
    // Under the lock: refused as a derived rate, never confirmed as the automatic discount.
    assert.deepEqual(check(ratePlansAnswer([], [], { ratePlanNamePublic: name })), { ok: true, checked: false, derived: true }, name);
  }
  for (const name of ["Early bird 15% off", "Early bird - free cancellation as usual", "Long term booking (refundable)", "Long term booking - refunds as usual", "Last minute nonstop deal"]) {
    assert.equal(isAutoDiscountName(name, DEFAULT_AUTO_DISCOUNT_PLANS), true, name);
  }
});

test("checkout enforces the plan's and the base row's stay rules on an automatic discount before any hold", async () => {
  // Long term offered from 7 nights while its own plan says minLos 10.
  const planMin = autoKit({ roomTypes: { ...AUTO_ROOM_TYPES, "462958": { ...AUTO_ROOM_TYPES["462958"], plans: [{ ...fakeLongTermPlan("rate-hm-lt"), minLos: 10 }] } } });
  const r1 = await checkout(planMin, HONEYMOON, SEVEN_NIGHTS);
  assert.equal(r1.status, 409, JSON.stringify(r1.body));
  assert.match(r1.body.ok ? "" : r1.body.message, /minimum stay of 10 nights/);
  assert.equal(planMin.fakeCb.count("postReservation"), 0);
  // The base row allows at most 5 nights: the Long term stay of 7 is refused too.
  const baseMax = autoKit({ roomTypes: { ...AUTO_ROOM_TYPES, "462958": { ...AUTO_ROOM_TYPES["462958"], maxLos: 5 } } });
  const r2 = await checkout(baseMax, HONEYMOON, SEVEN_NIGHTS);
  assert.equal(r2.status, 409, JSON.stringify(r2.body));
  assert.match(r2.body.ok ? "" : r2.body.message, /at most 5 nights/);
  assert.equal(baseMax.fakeCb.count("postReservation"), 0);
});

test("never trust the client: a rate sent by the browser is ignored; another derived rate reaching the locked check is refused with an alert naming the automatic discount", async () => {
  const kit = autoKit();
  const tampered = [{ ...HONEYMOON[0], rateId: "rate-hm-nr", roomRateID: "rate-hm-nr" }] as unknown as CartItemInput[];
  const res = await checkout(kit, tampered, { ...SEVEN_NIGHTS, rateId: "rate-hm-nr" } as Partial<CheckoutRequest>);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(postOf(kit)?.params["rooms[0][roomRateID]"], "rate-hm-lt", "the server's own choice");

  const kit2 = autoKit();
  const original = kit2.deps.restrictions!;
  kit2.deps.restrictions = (roomTypeId, _rateId, checkIn, checkOut, adults, promo) => original(roomTypeId, "rate-hm-nr", checkIn, checkOut, adults, promo);
  const refused = await checkout(kit2, HONEYMOON, SEVEN_NIGHTS);
  assert.equal(refused.status, 409);
  assert.match(refused.body.ok ? "" : refused.body.message, /can't be booked online/);
  assert.equal(kit2.fakeCb.count("postReservation"), 0);
  const alert = kit2.alerts.find((a) => a.subject.includes("derived rate"));
  assert.match(alert?.lines[0] ?? "", /offered as the automatic discount "Long term booking", but Cloudbeds' getRatePlans does not confirm it/);
  assert.match(alert?.lines[1] ?? "", /BOOKING_AUTO_DISCOUNTS=off/);
  assert.ok(kit2.logs.some((l) => l.message === "checkout_refused_derived_rate" && l.data?.auto === true));
});

test("the plan gone between the re-quote and the lock (renamed with a promo code): the stay-rule read under the lock refuses it", async () => {
  const roomTypes = { ...AUTO_ROOM_TYPES };
  const kit = autoKit({ roomTypes });
  const original = kit.deps.restrictions!;
  kit.deps.restrictions = (...args) => {
    roomTypes["462958"] = { ...AUTO_ROOM_TYPES["462958"], plans: [{ ...fakeLongTermPlan("rate-hm-lt"), promoCode: "LONG" }] };
    return original(...args);
  };
  const res = await checkout(kit, HONEYMOON, SEVEN_NIGHTS);
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.ok ? "" : res.body.message, /can't be booked online/);
  assert.equal(kit.fakeCb.count("postReservation"), 0);
  assert.ok(kit.logs.some((l) => l.message === "checkout_refused_derived_rate" && l.data?.auto === true));
});

/* --------------------------- Cloudbeds refusals --------------------------- */

test("Cloudbeds prices an automatic-discount hold at the BASE rate: hold cancelled, nothing charged, one fixed-key alert, the guest offered the classic page or WhatsApp", async () => {
  const kit = autoKit({ cb: { plansPricedAtBase: true } });
  for (let i = 0; i < 2; i++) {
    const res = await checkout(kit, HONEYMOON, SEVEN_NIGHTS);
    assert.equal(res.status, 503);
    assert.equal(res.body.ok ? "" : res.body.error, "payment_unavailable");
    const message = res.body.ok ? "" : res.body.message;
    assert.equal(message, `We couldn't reserve your room at our "Long term booking" rate online just now. Nothing has been charged. Book on our classic booking page, or message us on WhatsApp and we'll book it for you.`);
  }
  assert.equal(kit.fakeStripe.sessions.size, 0, "no Stripe call");
  assert.ok([...kit.fakeCb.reservations.values()].every((r) => r.status === "canceled"), "each hold given back");
  const subject = "Automatic discounts blocked: Cloudbeds priced Long term booking at the base rate - set BOOKING_AUTO_DISCOUNTS=off and redeploy";
  assert.equal(autoAtBaseAlert("Long term booking"), subject);
  const alerts = kit.alerts.filter((a) => a.subject.startsWith(AUTO_AT_BASE_ALERT_PREFIX));
  assert.deepEqual(alerts.map((a) => a.subject), [subject], "one fixed-key alert, not one per booking");
  assert.match(alerts[0].lines[1], /^Fix now: set BOOKING_AUTO_DISCOUNTS=off in Vercel and redeploy\./);
  assert.equal(kit.alerts.some((a) => a.subject.startsWith("Booking stopped: Cloudbeds price differs")), false, "classified apart from a price change");
  assert.equal(kit.alerts.some((a) => a.subject === DIRECT_AT_BASE_ALERT), false, "not the Direct rate's");
  assert.equal(kit.logs.filter((l) => l.message === "hold_auto_discount_at_base").length, 2);
});

test("mixed cart priced at the base rate: the automatic rooms alone -> auto_at_base; the Direct rooms alone -> the DIRECT alert; both -> both alerts", async () => {
  const cart = [...HONEYMOON, ...SUNRISE];
  const stay = { ...SEVEN_NIGHTS, promo: "DIRECT" };
  const autoOnly = autoKit({ cb: { plansPricedAtBase: true } });
  assert.equal((await checkout(autoOnly, cart, stay)).status, 503);
  assert.equal(autoOnly.alerts.filter((a) => a.subject.startsWith(AUTO_AT_BASE_ALERT_PREFIX)).length, 1);
  assert.equal(autoOnly.alerts.some((a) => a.subject === DIRECT_AT_BASE_ALERT), false);

  const directOnly = autoKit({ cb: { directPricedAtBase: true } });
  assert.equal((await checkout(directOnly, cart, stay)).status, 503);
  assert.equal(directOnly.alerts.some((a) => a.subject === DIRECT_AT_BASE_ALERT), true);
  assert.equal(directOnly.alerts.some((a) => a.subject.startsWith(AUTO_AT_BASE_ALERT_PREFIX)), false);

  const both = autoKit({ cb: { plansPricedAtBase: true, directPricedAtBase: true } });
  const res = await checkout(both, cart, stay);
  assert.equal(res.status, 503);
  assert.match(res.body.ok ? "" : res.body.message, /code DIRECT on our classic booking page/);
  assert.equal(both.alerts.some((a) => a.subject === DIRECT_AT_BASE_ALERT), true);
  assert.equal(both.alerts.some((a) => a.subject.startsWith(AUTO_AT_BASE_ALERT_PREFIX)), true);
  assert.ok([...both.fakeCb.reservations.values()].every((r) => r.status === "canceled"));
  assert.equal(both.fakeStripe.sessions.size, 0);
});

test("classifyHoldTotal: the automatic discount rooms at their base rate are their own kind; the Direct kind and price changes keep theirs", () => {
  const folio = (total: number, fees = 0) => ({ grandTotalSatang: total + fees, subTotalSatang: total, taxesFeesSatang: fees, additionalItemsSatang: 0 });
  const quoted = 1_000;
  // Rooms: a Direct room 400 (base 500), an automatic one 300 (base 330), a base one 300.
  const input = (held: number, f = folio(held)) => classifyHoldTotal({ quotedRoomsSatang: quoted, holdTotalSatang: held, folio: f, baseRoomsSatang: 1_100, autoBaseRoomsSatang: 1_030 });
  assert.deepEqual(input(1_030), { kind: "auto_at_base", totalSatang: 1_030, alsoDirect: false });
  assert.deepEqual(input(1_100), { kind: "promo_at_base", totalSatang: 1_100 });
  assert.deepEqual(input(1_130), { kind: "auto_at_base", totalSatang: 1_130, alsoDirect: true });
  assert.deepEqual(input(1_000), { kind: "match" });
  assert.equal(input(1_031).kind, "price_changed", "anything else is a price change");
  assert.equal(classifyHoldTotal({ quotedRoomsSatang: quoted, holdTotalSatang: 1_030, folio: { ...folio(1_030), subTotalSatang: 1_000 }, autoBaseRoomsSatang: 1_030 }).kind, "cloudbeds_fees", "the folio's rooms say the rooms were priced as quoted");
  assert.equal(classifyHoldTotal({ quotedRoomsSatang: quoted, holdTotalSatang: 1_030, folio: folio(1_030) }).kind, "price_changed", "no discount on the quote: never at base");
  assert.equal(classifyHoldTotal({ quotedRoomsSatang: quoted, holdTotalSatang: 2_000, folio: folio(2_000), autoBaseRoomsSatang: 1_030 }).kind, "price_changed");
  // The two base totals equal: the hold can't tell them apart - read as the automatic discount (the Direct rate is proven in Stage B).
  assert.deepEqual(
    classifyHoldTotal({ quotedRoomsSatang: quoted, holdTotalSatang: 1_100, folio: folio(1_100), baseRoomsSatang: 1_100, autoBaseRoomsSatang: 1_100 }),
    { kind: "auto_at_base", totalSatang: 1_100, alsoDirect: false },
  );
});

test("priced at the base rate on two different plans (Long term, then Last minute): still ONE alert per mode, naming the first plan", async () => {
  const kit = autoKit({ env: NEAR_ENV, cb: { plansPricedAtBase: true } });
  assert.equal((await checkout(kit, HONEYMOON, SEVEN_NIGHTS)).status, 503);
  assert.equal((await checkout(kit, HONEYMOON, NEAR)).status, 503);
  const plans = kit.logs.filter((l) => l.message === "hold_auto_discount_at_base").map((l) => l.data?.plans);
  assert.deepEqual(plans, [["Long term booking"], ["Last minute 10% off"]], "two plans priced at base");
  const alerts = kit.alerts.filter((a) => a.subject.startsWith(AUTO_AT_BASE_ALERT_PREFIX));
  assert.deepEqual(alerts.map((a) => a.subject), [autoAtBaseAlert("Long term booking")], "a fixed key, not one per plan");
});

test("two rooms on automatic discounts, no code: one plan is named once (hold note, guest message, alert); two plans are both named in the alert and the guest gets 'our discounted rate'", async () => {
  const cart = [...HONEYMOON, ...SUNRISE];
  // Both rooms on Long term booking (7 nights far ahead).
  const kit = autoKit();
  const res = await checkout(kit, cart, SEVEN_NIGHTS);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  assert.deepEqual(body.quote.autoDiscount, { names: ["Long term booking"], baseRoomsSatang: HM_BASE_7 + SR_BASE_7, savingSatang: HM_BASE_7 - HM_LT_7 + SR_BASE_7 - SR_LT_7 });
  const notes = kit.fakeCb.reservations.get(body.holdReservationId!)!.notes.join("\n");
  assert.match(notes, /Automatic discount: Long term booking\./);
  assert.doesNotMatch(notes, /Long term booking, Long term booking/);
  const atBase = autoKit({ cb: { plansPricedAtBase: true } });
  const refused = await checkout(atBase, cart, SEVEN_NIGHTS);
  assert.equal(refused.status, 503, JSON.stringify(refused.body));
  assert.equal(
    refused.body.ok ? "" : refused.body.message,
    `We couldn't reserve your room at our "Long term booking" rate online just now. Nothing has been charged. Book on our classic booking page, or message us on WhatsApp and we'll book it for you.`,
  );
  assert.deepEqual(atBase.alerts.filter((a) => a.subject.startsWith(AUTO_AT_BASE_ALERT_PREFIX)).map((a) => a.subject), [autoAtBaseAlert("Long term booking")]);

  // Two plans: Honeymoon on Last minute (cheaper than its Long term), Sunrise on Long term (near arrival, 7 nights).
  const nearWeek = { checkIn: "2026-10-08", checkOut: addDays("2026-10-08", 7) };
  const two = autoKit({ env: NEAR_ENV });
  const ok = await checkout(two, cart, nearWeek);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual((ok.body as CheckoutSuccess).quote.autoDiscount?.names, ["Last minute 10% off", "Long term booking"]);
  assert.match(two.fakeCb.reservations.get((ok.body as CheckoutSuccess).holdReservationId!)!.notes.join("\n"), /Automatic discount: Last minute 10% off, Long term booking\./);
  const twoAtBase = autoKit({ env: NEAR_ENV, cb: { plansPricedAtBase: true } });
  const both = await checkout(twoAtBase, cart, nearWeek);
  assert.equal(both.status, 503, JSON.stringify(both.body));
  assert.match(both.body.ok ? "" : both.body.message, /^We couldn't reserve your room at our discounted rate online just now\./);
  assert.deepEqual(
    twoAtBase.alerts.filter((a) => a.subject.startsWith(AUTO_AT_BASE_ALERT_PREFIX)).map((a) => a.subject),
    [autoAtBaseAlert("Last minute 10% off and Long term booking")],
    "the alert names every plan priced at base, so the owner drops the right one",
  );
});

test("postReservation refuses a discounted rate not open to the source: the 'Cloudbeds refused the reservation' alert names the plan and where to tick the source", async () => {
  const kit = autoKit({ cb: { ratesNotForSource: ["rate-hm-lt"] } });
  const res = await checkout(kit, HONEYMOON, SEVEN_NIGHTS);
  assert.equal(res.status, 503, JSON.stringify(res.body));
  assert.match(res.body.ok ? "" : res.body.message, /Nothing has been charged\. Message us on WhatsApp/);
  const alert = kit.alerts.find((a) => a.subject === "Booking stopped: Cloudbeds refused the reservation");
  assert.ok(alert, JSON.stringify(kit.alerts));
  assert.match(alert.lines[0], /Rate rate-hm-lt is not available for this reservation/);
  assert.match(alert.lines[2], /^Fix: Cloudbeds refused a discounted rate this booking holds \(Long term booking\)/);
  assert.equal(alert.lines[3], "In Cloudbeds: Rates and Availability > Rate Plans & Packages > Long term booking > 'Which sources is rate plan available for?' > tick the own booking page's source (CLOUDBEDS_SOURCE_ID), save.");
  assert.match(alert.lines[4], /set BOOKING_AUTO_DISCOUNTS=off in Vercel and redeploy\.$/);
  assert.doesNotMatch(alert.lines[4], /BOOKING_DIRECT_PROMO/);

  // The same live failure for the Direct rate (2026-10-07): its plan named, its own switch.
  const direct = autoKit({ cb: { ratesNotForSource: ["rate-hm-direct"] } });
  assert.equal((await checkout(direct, HONEYMOON, { promo: "DIRECT" })).status, 503);
  const dAlert = direct.alerts.find((a) => a.subject === "Booking stopped: Cloudbeds refused the reservation")!;
  assert.equal(dAlert.lines[3], rateSourceFixLine("Direct booking rate"));
  assert.match(dAlert.lines[4], /BOOKING_DIRECT_PROMO=off/);
  assert.doesNotMatch(dAlert.lines[4], /BOOKING_AUTO_DISCOUNTS/, "a Direct-only refusal never switches the automatic discounts off");

  // A mixed cart with the code whose OTHER room's base rate is refused: that room's base rate and the code as a
  // possible cause (Stage B case 24(d)) - never the Direct plan's source, never a discount switch for it.
  const mixed = autoKit({ cb: { ratesNotForSource: ["rate-gs"] } });
  assert.equal((await checkout(mixed, [...HONEYMOON, ...GARDEN], { promo: "DIRECT" })).status, 503);
  const mAlert = mixed.alerts.find((a) => a.subject === "Booking stopped: Cloudbeds refused the reservation")!;
  assert.match(mAlert.lines[2], /^Fix: Cloudbeds refused rate rate-gs, the BASE rate of Private Garden View Suite in this booking - not a discounted plan/);
  assert.match(mAlert.lines[3], /reservation-level promoCode .*set BOOKING_DIRECT_PROMO=off in Vercel/);
  assert.equal(mAlert.lines.some((l) => /Direct booking rate|Which sources is rate plan available for|BOOKING_AUTO_DISCOUNTS/.test(l)), false, JSON.stringify(mAlert.lines));
});

test("rateNotForSourceFix: only for that refusal and a cart with a discounted rate; the plan whose rate id the message names, a cart room's base rate when that is named, else every discounted plan", () => {
  const inv = (slug: string, rateId: string, discount?: { kind: "direct" | "auto"; name: string }): RoomInventory => ({
    slug,
    available: true,
    remaining: 1,
    baseNightly: [],
    rateId,
    ...(discount ? { discount: { ...discount, baseRateId: "b", baseNightly: [], baseAdultsExtraSatang: {} } } : {}),
  });
  const input = {
    items: [...HONEYMOON, ...SUNRISE, ...GARDEN],
    inventory: [inv("honeymoon-suite", "hm-direct", { kind: "direct", name: "Direct booking rate" }), inv("sunrise-suite", "sr-lt", { kind: "auto", name: "Long term booking" }), inv("garden-suite", "gs")],
  };
  assert.deepEqual(rateNotForSourceFix("Room type is not available for the selected dates", input, null), []);
  assert.deepEqual(rateNotForSourceFix(rateNotForSourceMessage("gs"), { ...input, items: GARDEN }, null), [], "no discounted rate in the cart");
  const named = rateNotForSourceFix(rateNotForSourceMessage("sr-lt"), input, "s-1192402");
  assert.match(named[0], /\(Long term booking\): the plan is most likely not open to the own booking page's reservation source \(s-1192402\)\./);
  assert.deepEqual(named.slice(1, -1), [rateSourceFixLine("Long term booking")]);
  assert.match(named.at(-1) ?? "", /set BOOKING_AUTO_DISCOUNTS=off in Vercel/);
  assert.doesNotMatch(named.at(-1) ?? "", /BOOKING_DIRECT_PROMO/);
  const direct = rateNotForSourceFix(rateNotForSourceMessage("hm-direct"), input, null);
  assert.deepEqual(direct.slice(1, -1), [rateSourceFixLine("Direct booking rate")]);
  assert.match(direct.at(-1) ?? "", /set BOOKING_DIRECT_PROMO=off in Vercel/);
  assert.doesNotMatch(direct.at(-1) ?? "", /BOOKING_AUTO_DISCOUNTS/);
  const unnamed = rateNotForSourceFix("Rate is not available for this reservation.", input, null);
  assert.deepEqual(unnamed.slice(1, -1), [rateSourceFixLine("Direct booking rate"), rateSourceFixLine("Long term booking")]);
  assert.match(unnamed.at(-1) ?? "", /BOOKING_AUTO_DISCOUNTS=off and BOOKING_DIRECT_PROMO=off/);

  // The message names a room held at its BASE rate: that room's base rate - no discount plan blamed, no discount switch.
  const withCode = { ...input, promo: { code: "DIRECT", cloudbedsCode: "Direct" } };
  const base = rateNotForSourceFix(rateNotForSourceMessage("gs"), withCode, "s-1192402");
  assert.equal(base.length, 2);
  assert.match(base[0], /^Fix: Cloudbeds refused rate gs, the BASE rate of Private Garden View Suite in this booking - not a discounted plan, .*reservation source \(s-1192402\)\.$/);
  assert.match(base[1], /^Also: the hold also carried the reservation-level promoCode .*\(Stage B case 24\(d\)\)\. .*set BOOKING_DIRECT_PROMO=off in Vercel, redeploy and tell the developer\.$/);
  for (const line of base) assert.doesNotMatch(line, /Direct booking rate|Long term booking|Which sources is rate plan available for|BOOKING_AUTO_DISCOUNTS/);
  assert.equal(rateNotForSourceFix(rateNotForSourceMessage("gs"), input, null).length, 1, "no promo code sent: the base-rate line alone");
  // A discounted room's base rate id (both discounted rooms here are priced next to "b").
  assert.match(rateNotForSourceFix(rateNotForSourceMessage("b"), input, null)[0], /^Fix: Cloudbeds refused rate b, the BASE rate of Honeymoon .+, Sunrise .+ in this booking/);
  // An automatic plan named while the code was sent: its own lines, plus the code as a possible cause; the Direct rate named: not that line.
  const autoWithCode = rateNotForSourceFix(rateNotForSourceMessage("sr-lt"), withCode, null);
  assert.deepEqual(autoWithCode.slice(1, 2), [rateSourceFixLine("Long term booking")]);
  assert.match(autoWithCode[2], /set BOOKING_AUTO_DISCOUNTS=off in Vercel/);
  assert.match(autoWithCode[3], /^If the automatic plan is already open to the source: the hold also carried the reservation-level promoCode/);
  assert.equal(autoWithCode.length, 4);
  assert.equal(rateNotForSourceFix(rateNotForSourceMessage("hm-direct"), withCode, null).some((l) => /reservation-level promoCode/.test(l)), false);
});

/* ------------------------------ token and demo ------------------------------ */

const TOKEN_BOOKING: BookingSummary = {
  ref: "MSV-20261005-ABCD",
  paymentMode: "stripe-test",
  checkIn: FAR_CHECKIN,
  checkOut: FAR_7_OUT,
  nights: 7,
  items: [...HONEYMOON, ...GARDEN],
  itemRoomSatang: [HM_LT_7, GS_BASE_7],
  itemDiscounts: [{ kind: "auto", label: "Long term booking", listSatang: HM_BASE_7 }, null],
  promoCode: null,
  totalSatang: 13_000_000,
  cardFeeSatang: 600_000,
  dueNowSatang: 13_000_000,
  createdAt: new Date(NOW).toISOString(),
  linkExpiresAt: new Date(NOW + 1_800_000).toISOString(),
};
const TOKEN_SECRET = "test-only-7f3K9qLm2xVw8RtY4pZn6bHc1dJe5gUa";

test("the booking token carries each room's discount for the return page, and refuses a forged one", () => {
  const booking = TOKEN_BOOKING;
  const secret = TOKEN_SECRET;
  const ok = verifyBookingToken(createBookingToken(booking, null, secret, 3600, NOW), secret, NOW);
  assert.ok(ok.ok);
  for (const itemDiscounts of [
    [{ kind: "auto", label: "Long term booking", listSatang: HM_LT_7 - 1 }, null], // a "base" below the price paid
    [{ kind: "auto", label: "Long term booking\u0000", listSatang: HM_BASE_7 }, null],
    [{ kind: "other", label: "x", listSatang: HM_BASE_7 }, null],
    [{ kind: "auto", label: "", listSatang: HM_BASE_7 }, null],
    [null],
  ]) {
    const forged = { ...booking, itemDiscounts } as unknown as BookingSummary;
    assert.equal(verifyBookingToken(createBookingToken(forged, null, secret, 3600, NOW), secret, NOW).ok, false, JSON.stringify(itemDiscounts));
  }
});

test("plan names lose control and invisible format characters (zero-width space, soft hyphen, word joiner), so the plan is recognised and its label passes the booking token's check", () => {
  assert.equal(planDisplayName("Long term booking\u200B"), "Long term booking");
  assert.equal(planDisplayName("Last minute 10% off\u00AD"), "Last minute 10% off");
  assert.equal(planDisplayName("Early\u200Bbird 15% off\u0007"), "Early bird 15% off");
  assert.equal(isAutoDiscountName("Early\u200Bbird 15% off", ["Early bird"]), true);
  const index = parseRatePlanIndex(
    { success: true, data: [{ rateID: "hm-lt", roomTypeID: "462958", isDerived: true, ratePlanNamePublic: "Long term\u2060 booking\u200B", promoCode: null, parentRateID: "hm-base" }] },
    { cloudbedsCode: null, autoPlans: DEFAULT_AUTO_DISCOUNT_PLANS },
  );
  const label = index.auto["462958"]?.[0]?.name ?? "";
  assert.equal(label, "Long term booking");
  // The label as the return page's token carries it (a paid booking's return page and Back release verify it).
  const booking: BookingSummary = { ...TOKEN_BOOKING, itemDiscounts: [{ kind: "auto", label, listSatang: HM_BASE_7 }, null] };
  assert.equal(verifyBookingToken(createBookingToken(booking, null, TOKEN_SECRET, 3600, NOW), TOKEN_SECRET, NOW).ok, true);
});

test("demo is unchanged: no automatic discount, no rate-plan read, the demo's own DIRECT % as before", () => {
  const demo = getBookingConfig({});
  assert.equal(demo.cloudbeds, null);
  assert.ok(demoInventory(FAR_CHECKIN, FAR_7_OUT).every((i) => i.discount === undefined));
  const offers = buildOffers(demoInventory(FAR_CHECKIN, FAR_7_OUT), 2);
  assert.ok(offers.every((o) => o.rates.every((r) => r.list === undefined)));
  const room = offers.find((o) => o.available)!;
  const q = computeQuote(
    { checkIn: FAR_CHECKIN, checkOut: FAR_7_OUT, items: [{ slug: room.slug, ratePlanId: "standard", adults: 1, addonIds: [] }], promo: { code: "DIRECT", pct: 10, label: "Direct booking discount (10%)" }, pricing: { cardFeePct: 3, depositPct: 100 } },
    offers,
  );
  assert.equal(q.autoDiscount, null);
  assert.equal(q.directRate, null);
  assert.equal(q.promo?.pct, 10);
});

/* ------------------------------------ UI ----------------------------------- */

test("booking page UI: automatic discounts show the base price struck through and the plan's name on the card, summary, payment step and return page", () => {
  const ui = (path: string) => readFileSync(new URL(`../../components/booking/${path}`, import.meta.url), "utf8");
  const card = ui("results/RoomOfferCard.tsx");
  // The wiring only (the label and note texts are tested on the helpers below).
  assert.ok(card.includes("const discountLabel = listTotal !== null ? rateDiscountLabel(rate.list, directCode) : null;") && card.includes("{discountLabel}"));
  assert.ok(card.includes("const wasTotal = discountLabel !== null ? listTotal : promo ? total : null;"));
  assert.ok(card.includes("promoNotAppliedNote(directCode, offer.rates[0]?.list)"), "a code beaten by an automatic discount says so");
  for (const path of ["summary/ReservationSummary.tsx", "checkout/PaymentStep.tsx"]) {
    assert.ok(ui(path).includes("lineDiscountLabel(line, quote)"), path);
    assert.ok(ui(path).includes("line.listRoomSatang"), path);
  }
  const ret = ui("return/ReturnStatus.tsx");
  assert.ok(ret.includes("booking.itemDiscounts?.[i]") && ret.includes("{discount.label}") && ret.includes("formatThbWithCode(discount.listSatang)") && ret.includes("line-through"));
});

test("room card: ONE label per rate (an automatic discount's plan name, also next to a code; the Direct rate's only with the code), and the note when the code's rate is not the one shown", () => {
  const baseNightly = [{ date: FAR_CHECKIN, amountSatang: 900_000 }];
  const autoList = { baseNightly, adultsExtraSatang: {}, kind: "auto" as const, name: "Long term booking" };
  const directList = { baseNightly, adultsExtraSatang: {}, kind: "direct" as const };
  assert.equal(rateDiscountLabel(autoList, null), "Long term booking");
  assert.equal(rateDiscountLabel(autoList, "DIRECT"), "Long term booking", "never the Direct label on an automatic discount");
  assert.equal(rateDiscountLabel(directList, "DIRECT"), "Direct rate - code DIRECT");
  assert.equal(rateDiscountLabel(directList, null), null, "no label (and no struck-through price) without the code");
  assert.equal(rateDiscountLabel({ baseNightly, adultsExtraSatang: {} }, "DIRECT"), "Direct rate - code DIRECT", "a list from before automatic discounts is the Direct rate");
  assert.equal(rateDiscountLabel(undefined, "DIRECT"), null, "a rate without a list price");
  assert.equal(promoNotAppliedNote("DIRECT", autoList), `Code DIRECT doesn't lower this room's price for these dates - our "Long term booking" rate is shown.`);
  assert.equal(promoNotAppliedNote("DIRECT", undefined), "Code DIRECT doesn't apply to this room for these dates - our standard rate is shown.");
  assert.equal(promoNotAppliedNote("DIRECT", directList), "Code DIRECT doesn't apply to this room for these dates - our standard rate is shown.");
});

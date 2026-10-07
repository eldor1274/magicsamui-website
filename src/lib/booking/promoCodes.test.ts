// Any Cloudbeds promo code on the own engine (owner decision, 2026-10-07): the "Long term" plan (26% off, 7+ nights)
// sits behind a Cloudbeds promo code (LONGSTAY) so it is never shown automatically, and the own page accepts ANY code
// the owner sets up in Cloudbeds, without a code change. DIRECT keeps its own mapping (BOOKING_PROMO_CODE ->
// CLOUDBEDS_PROMO_CODE) exactly as before. Covers the lookup in the rate-plan index (case-insensitive, Cloudbeds'
// own spelling sent), the unknown-code and non-refundable notes, the row sold (cheapest of base / automatic / code),
// the stay rules, the derived-rate defence, the hold (roomRateID + promoCode), the at-base classification and its
// alert, the "rate not open to the source" fix, labels, GA4 coupon, the switch, and the landing prefill.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildOffers, getInventory, promoAskFor, searchPromoVerdict } from "./availability.ts";
import { couponOf, purchaseParams } from "./clientAnalytics.ts";
import { cloudbedsInventory, evaluateRestrictions, mergePromoAnswer, parseRatePlanIndex } from "./cloudbedsProvider.ts";
import { getBookingConfig, getPublicBookingConfig } from "./config.ts";
import type { Env } from "./config.ts";
import { addDays } from "./dates.ts";
import {
  FAKE_DIRECT_PROMO_CODE,
  FAKE_LONGSTAY_PROMO_CODE,
  fakeLastMinutePlan,
  fakeLongStayCodePlan,
  fakeLongTermPlan,
  fakeNonRefundablePlan,
} from "./mock/fakeCloudbeds.ts";
import type { FakeCloudbedsOptions, FakeRoomType } from "./mock/fakeCloudbeds.ts";
import { codeRateLabel, computeQuote, lineDiscountLabel, promoCodeHint, promoInputOffered, promoNotAppliedNote, rateDiscountLabel, resolvePromoFor } from "./quote.ts";
import { AUTO_AT_BASE_ALERT_PREFIX, DIRECT_AT_BASE_ALERT, codeAtBaseAlert, directAtBaseMessage, rateSourceFixLine } from "./stripeCheckout.ts";
import { handleStripeWebhook } from "./stripeWebhook.ts";
import { FAR_CHECKIN, HONEYMOON, NOW, ROOM_TYPES, STRIPE_TEST_ENV, checkout, makeKit, sessionIdOf } from "./testkit.ts";
import type { Kit } from "./testkit.ts";
import { createBookingToken, verifyBookingToken } from "./token.ts";
import { homeSearchPath } from "./urls.ts";
import type { BookingSummary, CartItemInput, CheckoutRequest, CheckoutSuccess, RoomInventory } from "./types.ts";

/**
 * Honeymoon: base 9,000/night; Direct 80% (code Direct); "Long term" 74% behind code LONGSTAY (minLos 7, offered for
 * 7+ nights); Last minute (inside its window only); Non-refundable 90%. Sunrise: base 4,500.50, LONGSTAY too. Garden: base only.
 */
const CODE_ROOM_TYPES: Record<string, FakeRoomType> = {
  ...ROOM_TYPES,
  "462958": {
    ...ROOM_TYPES["462958"],
    directRateId: "rate-hm-direct",
    plans: [fakeLongStayCodePlan("rate-hm-ls"), fakeLastMinutePlan("rate-hm-lm"), fakeNonRefundablePlan("rate-hm-nr")],
  },
  "462960": { ...ROOM_TYPES["462960"], plans: [fakeLongStayCodePlan("rate-sr-ls")] },
};
const SEVEN_NIGHTS = { checkIn: FAR_CHECKIN, checkOut: addDays(FAR_CHECKIN, 7) };
const THREE_NIGHTS = { checkIn: FAR_CHECKIN, checkOut: addDays(FAR_CHECKIN, 3) };
const HM_BASE_7 = 7 * 900_000;
const HM_LS_7 = 7 * 666_000; // 9,000 x 74%
const SR_BASE_7 = 7 * 450_050;
const SR_LT_7 = 7 * 423_047; // 4,500.50 x 94% (the public "Long term booking" plan)
const SUNRISE: CartItemInput[] = [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
const CLASSIC = "/booking/classic";

function codeKit(options: { env?: Env; roomTypes?: Record<string, FakeRoomType>; cb?: FakeCloudbedsOptions } = {}): Kit {
  return makeKit({ env: options.env, cb: { roomTypes: options.roomTypes ?? CODE_ROOM_TYPES, ...options.cb } });
}

/** A Honeymoon Suite with these further plans (the other room types as in CODE_ROOM_TYPES). */
const withHmPlans = (plans: NonNullable<FakeRoomType["plans"]>): Record<string, FakeRoomType> => ({ ...CODE_ROOM_TYPES, "462958": { ...CODE_ROOM_TYPES["462958"], plans } });

const postOf = (kit: Kit) => kit.fakeCb.calls.find((c) => c.method === "postReservation");
const unfilteredRatePlanReads = (kit: Kit) => kit.fakeCb.calls.filter((c) => c.method === "getRatePlans" && c.params.roomTypeID === undefined).length;
const promoReads = (kit: Kit) => kit.fakeCb.calls.filter((c) => c.method === "getAvailableRoomTypes" && c.params.promoCode !== undefined).map((c) => c.params.promoCode);
const by = (inv: RoomInventory[], slug: string) => inv.find((i) => i.slug === slug)!;

/** The availability route's own steps (route.ts): promoAskFor -> getInventory -> searchPromoVerdict -> buildOffers. */
async function routeSearch(kit: Kit, stay: { checkIn: string; checkOut: string }, code: string | null, extra: Parameters<typeof getInventory>[3] = {}) {
  const settings = kit.config.promo;
  const ask = promoAskFor(code, settings);
  const result = await getInventory(stay.checkIn, stay.checkOut, kit.config, {
    fetchImpl: kit.fakeCb.fetch,
    allowDemoFallback: false,
    autoDiscountsBestEffort: true,
    ...(ask ? { promo: ask } : {}),
    ...extra,
  });
  return { ask, result, promo: searchPromoVerdict(code, settings, CLASSIC, result), offers: buildOffers(result.inventory, 2, kit.config.ratePlans) };
}

/* ---------------------------------- the ask ---------------------------------- */

test("promoAskFor: DIRECT keeps its configured Cloudbeds code; any other well-formed code is looked up; nothing where no Cloudbeds code is sold", () => {
  const s = getBookingConfig(STRIPE_TEST_ENV).promo;
  assert.deepEqual(promoAskFor(" direct ", s), { cloudbedsCode: "Direct" });
  assert.deepEqual(promoAskFor(" longstay ", s), { code: "LONGSTAY" });
  assert.deepEqual(promoAskFor("summer-26_x", s), { code: "SUMMER-26_X" });
  for (const bad of ["", "  ", "<b>", "long stay", "x".repeat(33)]) assert.equal(promoAskFor(bad, s), null, bad);
  // A custom alias: its own mapping; the default word is then just another code.
  const custom = getBookingConfig({ ...STRIPE_TEST_ENV, BOOKING_PROMO_CODE: "summer26", CLOUDBEDS_PROMO_CODE: "DirectWeb" }).promo;
  assert.deepEqual(promoAskFor("Summer26", custom), { cloudbedsCode: "DirectWeb" });
  assert.deepEqual(promoAskFor("DIRECT", custom), { code: "DIRECT" });
  // The switch off (classic-only), the demo's % and Beam: never asks Cloudbeds for a code.
  assert.equal(promoAskFor("LONGSTAY", getBookingConfig({ ...STRIPE_TEST_ENV, BOOKING_DIRECT_PROMO: "off" }).promo), null);
  assert.equal(promoAskFor("DIRECT", getBookingConfig({ ...STRIPE_TEST_ENV, BOOKING_DIRECT_PROMO: "off" }).promo), null);
  assert.equal(promoAskFor("LONGSTAY", getBookingConfig({}).promo), null);
});

/* ------------------------------- the index lookup ------------------------------ */

test("the rate-plan index looks a code up case-insensitively, keeps Cloudbeds' own spelling, and never lists a plan whose name reads as non-refundable", () => {
  const rows = {
    success: true,
    data: [
      { rateID: "hm-base", roomTypeID: "462958", isDerived: false, ratePlanNamePublic: null, promoCode: null, parentRateID: null },
      { rateID: "hm-direct", roomTypeID: "462958", isDerived: true, ratePlanNamePublic: "Direct booking rate", promoCode: "Direct", parentRateID: "hm-base" },
      { rateID: "hm-nr-ls", roomTypeID: "462958", isDerived: true, ratePlanNamePublic: "Long term prepaid", promoCode: "LONGSTAY", parentRateID: "hm-base" },
      { rateID: "hm-ls", roomTypeID: "462958", isDerived: true, ratePlanNamePublic: "Long term", promoCode: " LongStay ", parentRateID: "hm-base" },
      { rateID: "sr-ls", roomTypeID: "462960", isDerived: true, ratePlanNamePublic: "Long term", promoCode: "LONGSTAY", parentRateID: "sr-base" },
      { rateID: "hm-nr", roomTypeID: "462958", isDerived: true, ratePlanNamePublic: "Non-refundable 10% discount", promoCode: "SAVE10", parentRateID: "hm-base" },
    ],
  };
  const index = parseRatePlanIndex(rows, { cloudbedsCode: "longstay", autoPlans: [] });
  assert.deepEqual(index.promo, {
    "462958": [{ rateId: "hm-ls", parentRateId: "hm-base", name: "Long term" }],
    "462960": [{ rateId: "sr-ls", parentRateId: "sr-base", name: "Long term" }],
  });
  assert.deepEqual(index.lookup, { code: "longstay", cloudbedsCode: "LongStay", planName: "Long term", refusedPlans: ["Long term prepaid"] });
  // Only non-refundable plans carry it: nothing to sell, the plans named for the note.
  assert.deepEqual(parseRatePlanIndex(rows, { cloudbedsCode: "SAVE10", autoPlans: [] }).lookup, { code: "SAVE10", cloudbedsCode: null, planName: null, refusedPlans: ["Non-refundable 10% discount"] });
  assert.deepEqual(parseRatePlanIndex(rows, { cloudbedsCode: "SAVE10", autoPlans: [] }).promo, {});
  // Unknown: nothing; no code: no lookup at all (as before).
  assert.deepEqual(parseRatePlanIndex(rows, { cloudbedsCode: "SUMMER99", autoPlans: [] }).lookup, { code: "SUMMER99", cloudbedsCode: null, planName: null, refusedPlans: [] });
  assert.equal(parseRatePlanIndex(rows, { cloudbedsCode: null, autoPlans: [] }).lookup, undefined);
  // The DIRECT alias reads the same rows as before.
  assert.deepEqual(parseRatePlanIndex(rows, { cloudbedsCode: "Direct", autoPlans: [] }).promo, { "462958": [{ rateId: "hm-direct", parentRateId: "hm-base", name: "Direct booking rate" }] });
});

test("resolvePromoFor with the lookup: a sellable plan -> valid with its name; only non-refundable plans -> a calm note (classic page, WhatsApp); nothing -> 'isn't valid for these dates'", () => {
  const s = getBookingConfig(STRIPE_TEST_ENV).promo;
  const found = { code: "LONGSTAY", cloudbedsCode: "LongStay", planName: "Long term", refusedPlans: [] };
  assert.deepEqual(resolvePromoFor(" longstay ", s, CLASSIC, found), { code: "LONGSTAY", valid: true, pct: 0, label: "Long term" });
  assert.deepEqual(resolvePromoFor("longstay", s, CLASSIC, { ...found, planName: null }), { code: "LONGSTAY", valid: true, pct: 0, label: "Special rate" });
  // A lookup for another code never validates this one.
  assert.equal(resolvePromoFor("OTHER", s, CLASSIC, found)?.valid, false);
  const nr = resolvePromoFor("SAVE10", s, CLASSIC, { code: "SAVE10", cloudbedsCode: null, planName: null, refusedPlans: ["Non-refundable 10% discount"] });
  assert.ok(nr && !nr.valid && nr.note === true);
  if (nr && !nr.valid) {
    assert.equal(nr.message, "Code SAVE10 is for a non-refundable rate, which can't be booked on this page - our classic booking page applies it, or message us on WhatsApp and we'll book it for you.");
    assert.deepEqual(nr.link, { href: CLASSIC, text: "Book with code SAVE10 on our classic booking page" });
  }
  assert.deepEqual(resolvePromoFor("summer99", s, CLASSIC, { code: "SUMMER99", cloudbedsCode: null, planName: null, refusedPlans: [] }), {
    code: "SUMMER99",
    valid: false,
    message: "Code SUMMER99 isn't valid for these dates.",
  });
  // DIRECT never needs a lookup, and its verdict is as before.
  assert.deepEqual(resolvePromoFor("direct", s, CLASSIC), { code: "DIRECT", valid: true, pct: 0, label: "Direct rate" });
});

/* --------------------------------- the search --------------------------------- */

test("LONGSTAY for 7 nights: the index is read first, availability asked plain and with Cloudbeds' code, the code's rows sold and labelled with the plan's name", async () => {
  const kit = codeKit();
  const { result, promo, offers } = await routeSearch(kit, SEVEN_NIGHTS, "LONGSTAY");
  assert.deepEqual(promo, { code: "LONGSTAY", valid: true, pct: 0, label: "Long term" });
  // The index first (it says which code to ask for), then availability without and with the code.
  assert.equal(kit.fakeCb.calls[0].method, "getRatePlans");
  assert.equal(kit.fakeCb.calls[0].params.roomTypeID, undefined);
  assert.deepEqual(promoReads(kit), [FAKE_LONGSTAY_PROMO_CODE]);
  assert.equal(kit.fakeCb.count("getAvailableRoomTypes"), 2);
  assert.equal(unfilteredRatePlanReads(kit), 1, "one index read serves the code and the automatic discounts");
  const hm = by(result.inventory, "honeymoon-suite");
  assert.equal(hm.rateId, "rate-hm-ls");
  assert.deepEqual(hm.baseNightly.map((n) => n.amountSatang), Array(7).fill(666_000));
  assert.deepEqual(hm.discount && { kind: hm.discount.kind, name: hm.discount.name, showName: hm.discount.showName, baseRateId: hm.discount.baseRateId }, {
    kind: "direct",
    name: "Long term",
    showName: true,
    baseRateId: "rate-hm",
  });
  assert.equal(by(result.inventory, "sunrise-suite").rateId, "rate-sr-ls");
  // No plan for the code on the Garden Suite: its base rate, and the card says the code doesn't apply.
  assert.equal(by(result.inventory, "garden-suite").rateId, "rate-gs");
  assert.equal(by(result.inventory, "garden-suite").promoNotApplied, true);

  // Offers and the quote: "<plan> - code <CODE>", the base price struck through.
  const rate = offers.find((o) => o.slug === "honeymoon-suite")!.rates[0];
  assert.equal(rate.totalSatang, HM_LS_7);
  assert.equal(rate.list?.name, "Long term");
  assert.equal(rateDiscountLabel(rate.list, "LONGSTAY"), "Long term - code LONGSTAY");
  const q = computeQuote(
    { ...SEVEN_NIGHTS, items: HONEYMOON, promo: { code: "LONGSTAY", pct: 0, label: "Long term" }, pricing: { cardFeePct: 5, depositPct: 100 } },
    offers,
  );
  assert.deepEqual(q.directRate, { code: "LONGSTAY", label: "Long term - code LONGSTAY", baseRoomsSatang: HM_BASE_7, savingSatang: HM_BASE_7 - HM_LS_7 });
  assert.deepEqual(q.lines[0].discount, { kind: "direct", name: "Long term" });
  assert.equal(lineDiscountLabel(q.lines[0], q), "Long term - code LONGSTAY");
  assert.equal(q.autoDiscount, null);
});

test("a code is matched case-insensitively and Cloudbeds' own spelling is what availability and the hold are sent", async () => {
  const roomTypes = withHmPlans([fakeLongStayCodePlan("rate-hm-ls", "LongStay")]);
  const kit = codeKit({ roomTypes });
  const { promo, result } = await routeSearch(kit, SEVEN_NIGHTS, " longstay ");
  assert.deepEqual(promo, { code: "LONGSTAY", valid: true, pct: 0, label: "Long term" });
  assert.deepEqual(promoReads(kit), ["LongStay"]);
  assert.equal(by(result.inventory, "honeymoon-suite").rateId, "rate-hm-ls");
  // The fake refuses a hold on the plan unless promoCode is exactly Cloudbeds' spelling (live: roomRateID + promoCode).
  const booked = codeKit({ roomTypes });
  const res = await checkout(booked, HONEYMOON, { ...SEVEN_NIGHTS, promo: "longStay" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(postOf(booked)?.params["rooms[0][roomRateID]"], "rate-hm-ls");
  assert.equal(postOf(booked)?.params.promoCode, "LongStay");
  assert.equal((res.body as CheckoutSuccess).quote.directRate?.label, "Long term - code LONGSTAY", "the label shows the code as the guest typed it, upper case");
});

test("LONGSTAY for 3 nights: the plan (minLos 7) is not offered, so the code is a calm 'doesn't apply' note and checkout books the base rate", async () => {
  const kit = codeKit();
  const { promo, result } = await routeSearch(kit, THREE_NIGHTS, "LONGSTAY");
  assert.deepEqual(promo, { code: "LONGSTAY", valid: false, note: true, message: "Code LONGSTAY doesn't apply to these dates - the prices shown are our standard rates." });
  assert.equal(by(result.inventory, "honeymoon-suite").rateId, "rate-hm");
  const res = await checkout(codeKit(), HONEYMOON, { ...THREE_NIGHTS, promo: "LONGSTAY" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((res.body as CheckoutSuccess).quote.directRate, null);
});

test("LONGSTAY for 3 nights REFUSED by Cloudbeds (success:false, not an empty answer): still the base rates and the 'doesn't apply' note, never a 503; checkout books the base rate shown", async () => {
  const cb = { promoRefusedWhenNotOffered: true };
  const kit = codeKit({ cb });
  const { promo, result, offers } = await routeSearch(kit, THREE_NIGHTS, "LONGSTAY");
  assert.deepEqual(promoReads(kit), [FAKE_LONGSTAY_PROMO_CODE], "asked with the code, and refused");
  assert.deepEqual(promo, { code: "LONGSTAY", valid: false, note: true, message: "Code LONGSTAY doesn't apply to these dates - the prices shown are our standard rates." });
  // Every room the plain search lists, on the same rate.
  const plain = await routeSearch(codeKit({ cb }), THREE_NIGHTS, null);
  const rows = (inv: RoomInventory[]) => inv.map((i) => [i.slug, i.available, i.rateId ?? null]);
  assert.deepEqual(rows(result.inventory), rows(plain.result.inventory));
  assert.equal(by(result.inventory, "honeymoon-suite").rateId, "rate-hm");
  const shown = offers.find((o) => o.slug === "honeymoon-suite")!.rates[0].totalSatang;
  assert.equal(shown, 3 * 900_000);

  // The re-quote (and its 2-adult gate) takes the same refusal: the guest pays the base rate they were shown.
  const booked = codeKit({ cb });
  const res = await checkout(booked, HONEYMOON, { ...THREE_NIGHTS, promo: "LONGSTAY" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((res.body as CheckoutSuccess).quote.directRate, null);
  assert.equal((res.body as CheckoutSuccess).quote.roomsSubtotalSatang, shown);
  assert.equal(postOf(booked)?.params["rooms[0][roomRateID]"], "rate-hm");
  assert.equal(postOf(booked)?.params.promoCode, undefined);

  // The same fake still sells the plan where it applies (7 nights); DIRECT refused stays fail-closed (the read fails).
  assert.equal((await routeSearch(codeKit({ cb }), SEVEN_NIGHTS, "LONGSTAY")).promo?.valid, true);
  await assert.rejects(routeSearch(codeKit({ roomTypes: ROOM_TYPES, cb }), THREE_NIGHTS, "DIRECT"), /promo code\) failed: Invalid promo code/);
});

test("mergePromoAnswer with refusedAsNoRows (a code other than DIRECT): a success:false promo answer is no code rows - the plain answer, logged; an answer without a success flag still fails the read", () => {
  const plain = { success: true, data: [{ propertyID: "235064", propertyRooms: [{ roomTypeID: "462958", roomRateID: "hm-base" }] }] };
  const logged: { m: string; d?: Record<string, unknown> }[] = [];
  const log = (m: string, d?: Record<string, unknown>) => void logged.push({ m, d });
  assert.equal(mergePromoAnswer(plain, { success: false, message: "Invalid promo code" }, log, { refusedAsNoRows: true }), plain);
  assert.deepEqual(logged, [{ m: "cloudbeds_promo_answer_refused", d: { message: "Invalid promo code" } }]);
  assert.throws(() => mergePromoAnswer(plain, { data: [] }, log, { refusedAsNoRows: true }), /promo code\) failed: no success flag/);
  assert.throws(() => mergePromoAnswer(plain, { success: false, message: "Invalid promo code" }, log), /promo code\) failed: Invalid promo code/, "DIRECT: fail-closed");
});

test("LONGSTAY for 3 nights offered by Cloudbeds anyway: the plan's own stay rule (minLos 7) refuses it under the lock, before any hold", async () => {
  const kit = codeKit({ roomTypes: withHmPlans([{ ...fakeLongStayCodePlan("rate-hm-ls"), offeredFromNights: undefined }]) });
  const res = await checkout(kit, HONEYMOON, { ...THREE_NIGHTS, promo: "LONGSTAY" });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.ok ? "" : res.body.message, /needs a minimum stay of 7 nights/);
  assert.equal(kit.fakeCb.count("postReservation"), 0);
  assert.equal(kit.fakeStripe.sessions.size, 0);
});

test("an unknown code: 'isn't valid for these dates' (never an error), no promo-code read, the rates as without a code; checkout ignores it", async () => {
  const kit = codeKit();
  const { promo, result } = await routeSearch(kit, SEVEN_NIGHTS, "summer99");
  assert.deepEqual(promo, { code: "SUMMER99", valid: false, message: "Code SUMMER99 isn't valid for these dates." });
  assert.deepEqual(promoReads(kit), [], "no getAvailableRoomTypes with a promo code");
  assert.equal(kit.fakeCb.count("getAvailableRoomTypes"), 1);
  assert.equal(unfilteredRatePlanReads(kit), 1, "the one index read (also the automatic discounts')");
  assert.deepEqual(result.promoLookup, { code: "SUMMER99", cloudbedsCode: null, planName: null, refusedPlans: [] });
  assert.ok(result.inventory.every((i) => i.promoNotApplied === undefined && i.discount?.kind !== "direct"));
  assert.equal(by(result.inventory, "honeymoon-suite").rateId, "rate-hm");

  const res = await checkout(codeKit(), HONEYMOON, { ...SEVEN_NIGHTS, promo: "SUMMER99" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((res.body as CheckoutSuccess).quote.directRate, null);
  assert.equal((res.body as CheckoutSuccess).quote.roomsSubtotalSatang, HM_BASE_7);

  // Automatic discounts off: the lookup is the only rate-plan read, and still no promo-code read.
  const off = codeKit({ env: { ...STRIPE_TEST_ENV, BOOKING_AUTO_DISCOUNTS: "off" } });
  await routeSearch(off, SEVEN_NIGHTS, "SUMMER99");
  assert.equal(unfilteredRatePlanReads(off), 1);
  assert.deepEqual(promoReads(off), []);
});

test("a code whose plan reads as non-refundable is never sold: a note pointing to the classic page or WhatsApp, no promo-code read; a code on a refundable and a non-refundable plan sells only the refundable one", async () => {
  const nrPlan = { rateId: "rate-hm-save", name: "Non-refundable 30% off", pctOfBase: 70, promoCode: "SAVE30" };
  const kit = codeKit({ roomTypes: withHmPlans([nrPlan]) });
  const { promo, result } = await routeSearch(kit, SEVEN_NIGHTS, "SAVE30");
  assert.ok(promo && !promo.valid && promo.note === true);
  assert.match(promo && !promo.valid ? promo.message : "", /^Code SAVE30 is for a non-refundable rate.*classic booking page.*WhatsApp/);
  assert.deepEqual(promoReads(kit), []);
  assert.equal(by(result.inventory, "honeymoon-suite").rateId, "rate-hm");
  const nrKit = codeKit({ roomTypes: withHmPlans([nrPlan]) });
  assert.equal((await checkout(nrKit, HONEYMOON, { ...SEVEN_NIGHTS, promo: "SAVE30" })).status, 200);
  assert.equal(postOf(nrKit)?.params["rooms[0][roomRateID]"], "rate-hm");
  assert.equal(postOf(nrKit)?.params.promoCode, undefined);

  // The same code on a cheaper "Prepaid" plan and a dearer refundable one: only the refundable one is sold.
  const both = withHmPlans([
    { rateId: "rate-hm-pp", name: "Spring prepaid 30% off", pctOfBase: 70, promoCode: "SPRING" },
    { rateId: "rate-hm-sp", name: "Spring 15% off", pctOfBase: 85, promoCode: "SPRING" },
  ]);
  const spring = await routeSearch(codeKit({ roomTypes: both }), SEVEN_NIGHTS, "SPRING");
  assert.deepEqual(spring.promo, { code: "SPRING", valid: true, pct: 0, label: "Spring 15% off" });
  assert.equal(by(spring.result.inventory, "honeymoon-suite").rateId, "rate-hm-sp");
  const springKit = codeKit({ roomTypes: both });
  assert.equal((await checkout(springKit, HONEYMOON, { ...SEVEN_NIGHTS, promo: "SPRING" })).status, 200);
  assert.equal(postOf(springKit)?.params["rooms[0][roomRateID]"], "rate-hm-sp");

  // The derived-rate defence under the lock refuses a code's row whose name reads as non-refundable.
  const days = ["2027-11-10", "2027-11-11"].map((date) => ({ date, minLos: 0, maxLos: 0, roomsAvailable: 1 }));
  const plans = {
    success: true,
    data: [
      { rateID: "hm-save", isDerived: true, ratePlanNamePublic: "Long term NRF", promoCode: "SAVE30", parentRateID: "hm-base", roomRateDetailed: days },
      { rateID: "hm-base", isDerived: false, ratePlanID: null, ratePlanNamePublic: null, roomRateDetailed: days },
    ],
  };
  assert.deepEqual(evaluateRestrictions(plans, "462958", "hm-save", "2027-11-10", "2027-11-11", { promo: { cloudbedsCode: "SAVE30", baseRateId: "hm-base" } }), {
    ok: true,
    checked: false,
    derived: true,
  });
});

test("DIRECT is unchanged next to other codes: its configured code, no lookup first, the Direct rows and 'Direct rate - code DIRECT'", async () => {
  const kit = codeKit();
  const { ask, promo, result, offers } = await routeSearch(kit, SEVEN_NIGHTS, "direct");
  assert.deepEqual(ask, { cloudbedsCode: FAKE_DIRECT_PROMO_CODE });
  assert.deepEqual(promo, { code: "DIRECT", valid: true, pct: 0, label: "Direct rate" });
  assert.equal(result.promoLookup, undefined);
  // As before: availability first (plain and with the code), the index read alongside.
  assert.equal(kit.fakeCb.calls[0].method, "getAvailableRoomTypes");
  assert.deepEqual(promoReads(kit), [FAKE_DIRECT_PROMO_CODE]);
  const hm = by(result.inventory, "honeymoon-suite");
  assert.equal(hm.rateId, "rate-hm-direct", "LONGSTAY's plan is not asked for with DIRECT");
  assert.equal(hm.discount?.showName, undefined);
  const list = offers.find((o) => o.slug === "honeymoon-suite")!.rates[0].list;
  assert.equal(list?.name, undefined);
  assert.equal(rateDiscountLabel(list, "DIRECT"), "Direct rate - code DIRECT");

  const booked = codeKit();
  const res = await checkout(booked, HONEYMOON, { ...SEVEN_NIGHTS, promo: "DIRECT" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  assert.equal(body.quote.directRate?.label, "Direct rate - code DIRECT");
  assert.deepEqual(body.quote.lines[0].discount, { kind: "direct", name: "Direct rate" });
  assert.equal(postOf(booked)?.params["rooms[0][roomRateID]"], "rate-hm-direct");
  assert.equal(postOf(booked)?.params.promoCode, FAKE_DIRECT_PROMO_CODE);
  assert.match(booked.fakeCb.reservations.get(body.holdReservationId!)!.notes.join("\n"), /Direct rate \(code DIRECT\)\./);
  assert.match(booked.fakeStripe.session(sessionIdOf(body))!.line_items_input[0].name, / - Standard Rate \(Direct rate\)$/);
});

test("BOOKING_DIRECT_PROMO=off switches EVERY code off: the classic-page note for LONGSTAY too, no lookup, no promo-code read, checkout on the base rate", async () => {
  const env = { ...STRIPE_TEST_ENV, BOOKING_DIRECT_PROMO: "off" };
  const kit = codeKit({ env });
  const { ask, promo } = await routeSearch(kit, SEVEN_NIGHTS, "LONGSTAY");
  assert.equal(ask, null);
  assert.deepEqual(promo, {
    code: "LONGSTAY",
    valid: false,
    note: true,
    message: "Code LONGSTAY can't be applied on this page right now - prices here are our standard rates. Our classic booking page applies it.",
    link: { href: CLASSIC, text: "Book with code LONGSTAY on our classic booking page" },
  });
  assert.deepEqual(promoReads(kit), []);
  const pub = getPublicBookingConfig(env);
  assert.equal(promoInputOffered(pub), true, "the code box stays, answered with the note");
  assert.equal(promoCodeHint(pub), null);

  const booked = codeKit({ env });
  const res = await checkout(booked, HONEYMOON, { ...SEVEN_NIGHTS, promo: "LONGSTAY" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((res.body as CheckoutSuccess).quote.directRate, null);
  assert.equal(postOf(booked)?.params["rooms[0][roomRateID]"], "rate-hm");
  assert.equal(postOf(booked)?.params.promoCode, undefined);
  assert.deepEqual(promoReads(booked), []);
});

/* --------------------------------- cheapest wins -------------------------------- */

test("cheapest wins between a code's rate and the automatic discounts: LONGSTAY (26%) beats Long term booking (6%); an Early bird plan cheaper than it is sold instead, without the promo code; a tie goes to the code", async () => {
  // LONGSTAY next to the public Long term booking plan.
  const vsLongTerm = withHmPlans([fakeLongStayCodePlan("rate-hm-ls"), fakeLongTermPlan("rate-hm-lt")]);
  const plain = await routeSearch(codeKit({ roomTypes: vsLongTerm }), SEVEN_NIGHTS, null);
  assert.equal(by(plain.result.inventory, "honeymoon-suite").rateId, "rate-hm-lt", "no code: the automatic discount");
  const coded = await routeSearch(codeKit({ roomTypes: vsLongTerm }), SEVEN_NIGHTS, "LONGSTAY");
  assert.equal(by(coded.result.inventory, "honeymoon-suite").rateId, "rate-hm-ls");
  assert.equal(by(coded.result.inventory, "honeymoon-suite").discount?.kind, "direct");

  // An Early bird plan (30% off) beats LONGSTAY on the Honeymoon Suite: sold with no promo code; the card says so.
  const vsEarly = withHmPlans([fakeLongStayCodePlan("rate-hm-ls"), { rateId: "rate-hm-eb", name: "Early bird 30% off", pctOfBase: 70 }]);
  const early = await routeSearch(codeKit({ roomTypes: vsEarly }), SEVEN_NIGHTS, "LONGSTAY");
  const hm = by(early.result.inventory, "honeymoon-suite");
  assert.equal(hm.rateId, "rate-hm-eb");
  assert.equal(hm.discount?.kind, "auto");
  assert.equal(hm.promoNotApplied, true);
  assert.equal(promoNotAppliedNote("LONGSTAY", early.offers.find((o) => o.slug === "honeymoon-suite")!.rates[0].list), `Code LONGSTAY doesn't lower this room's price for these dates - our "Early bird 30% off" rate is shown.`);
  assert.equal(early.promo?.valid, true, "the Sunrise Suite still gets the code's rate");
  const earlyKit = codeKit({ roomTypes: vsEarly });
  const res = await checkout(earlyKit, HONEYMOON, { ...SEVEN_NIGHTS, promo: "LONGSTAY" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const quote = (res.body as CheckoutSuccess).quote;
  assert.equal(quote.directRate, null);
  assert.deepEqual(quote.autoDiscount?.names, ["Early bird 30% off"]);
  assert.equal(postOf(earlyKit)?.params["rooms[0][roomRateID]"], "rate-hm-eb");
  assert.equal(postOf(earlyKit)?.params.promoCode, undefined, "no promo code without a room on the code's rate");

  // When no room gets the code's rate, the search note says the prices shown are the best rates.
  const onlyHm = { ...vsEarly, "462960": { ...CODE_ROOM_TYPES["462960"], plans: [] } };
  const none = await routeSearch(codeKit({ roomTypes: onlyHm }), SEVEN_NIGHTS, "LONGSTAY");
  assert.deepEqual(none.promo, { code: "LONGSTAY", valid: false, note: true, message: "Code LONGSTAY doesn't apply to these dates - the prices shown are our best rates for them." });

  // A tie: the rate the guest asked for.
  const tie = withHmPlans([fakeLongStayCodePlan("rate-hm-ls"), { rateId: "rate-hm-eb", name: "Early bird 26% off", pctOfBase: 74 }]);
  assert.equal(by((await routeSearch(codeKit({ roomTypes: tie }), SEVEN_NIGHTS, "LONGSTAY")).result.inventory, "honeymoon-suite").rateId, "rate-hm-ls");
});

/* --------------------------------- checkout -------------------------------- */

test("LONGSTAY booked end to end (7 nights): hold on the plan's roomRateID with the promo code, labelled everywhere, GA4 coupon = the code, paid, balance 0", async () => {
  const kit = codeKit();
  const res = await checkout(kit, HONEYMOON, { ...SEVEN_NIGHTS, promo: "LONGSTAY" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  const fee = Math.round(HM_LS_7 * 0.05);
  assert.equal(body.quote.roomsSubtotalSatang, HM_LS_7);
  assert.equal(body.quote.totalSatang, HM_LS_7 + fee);
  assert.deepEqual(body.quote.directRate, { code: "LONGSTAY", label: "Long term - code LONGSTAY", baseRoomsSatang: HM_BASE_7, savingSatang: HM_BASE_7 - HM_LS_7 });
  assert.equal(body.quote.autoDiscount, null);
  assert.equal(lineDiscountLabel(body.quote.lines[0], body.quote), "Long term - code LONGSTAY");
  assert.equal(couponOf(body.quote), "LONGSTAY");

  const post = postOf(kit)!;
  assert.equal(post.params["rooms[0][roomRateID]"], "rate-hm-ls");
  assert.equal(post.params.promoCode, FAKE_LONGSTAY_PROMO_CODE);
  // Quote and re-quote: one index read each (the 2-adult gate reuses it, lookup included); none in the re-check under the lock.
  assert.equal(unfilteredRatePlanReads(kit), 2);
  const restrictionsAt = kit.fakeCb.calls.findIndex((c) => c.method === "getRatePlans" && c.params.roomTypeID !== undefined);
  assert.ok(restrictionsAt >= 0);
  const afterLock = kit.fakeCb.calls.slice(restrictionsAt + 1);
  assert.equal(afterLock.some((c) => c.method === "getRatePlans"), false, "no index read in the re-check");
  assert.equal(afterLock.some((c) => c.method === "getAvailableRoomTypes" && c.params.promoCode !== undefined), false, "the re-check reads without the code");
  const reservation = kit.fakeCb.reservations.get(body.holdReservationId!)!;
  assert.equal(Math.round(reservation.subTotal * 100), HM_LS_7);
  assert.match(reservation.notes.join("\n"), /Long term \(code LONGSTAY\)\./);

  const sessionId = sessionIdOf(body);
  const session = kit.fakeStripe.session(sessionId)!;
  assert.equal(session.amount_total, HM_LS_7 + fee);
  assert.match(session.line_items_input[0].name, /^Honeymoon .+ - Standard Rate \(Long term\)$/);
  const v = verifyBookingToken(new URL(session.success_url.replace("{CHECKOUT_SESSION_ID}", "x")).searchParams.get("t"), kit.config.tokenSecret, NOW);
  assert.ok(v.ok);
  if (v.ok) {
    assert.equal(v.payload.booking.promoCode, "LONGSTAY");
    assert.deepEqual(v.payload.booking.itemDiscounts, [{ kind: "direct", label: "Long term - code LONGSTAY", listSatang: HM_BASE_7 }]);
    assert.equal(purchaseParams(v.payload.booking).coupon, "LONGSTAY");
  }

  kit.fakeStripe.complete(sessionId);
  const { payload, header } = kit.fakeStripe.signedEvent("checkout.session.completed", sessionId);
  assert.equal((await handleStripeWebhook(payload, header, kit.deps, { nowMs: NOW })).body, "confirmed");
  assert.equal(reservation.status, "confirmed");
  assert.equal(kit.fakeCb.balance(body.holdReservationId!), 0);
});

test("one code on two plans with different names: each room is labelled with its own plan (card, summary, Stripe line, hold note, return page); priced at base, the guest gets 'our discounted rate' and the code's alert names both plans", async () => {
  const roomTypes = {
    ...withHmPlans([fakeLongStayCodePlan("rate-hm-ls")]),
    "462960": { ...CODE_ROOM_TYPES["462960"], plans: [{ ...fakeLongStayCodePlan("rate-sr-ls"), name: "Long stay villa 25%", pctOfBase: 75 }] },
  };
  const kit = codeKit({ roomTypes });
  const res = await checkout(kit, [...HONEYMOON, ...SUNRISE], { ...SEVEN_NIGHTS, promo: "LONGSTAY" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  assert.deepEqual(body.quote.lines.map((l) => lineDiscountLabel(l, body.quote)), ["Long term - code LONGSTAY", "Long stay villa 25% - code LONGSTAY"]);
  assert.equal(body.quote.directRate?.label, "Long term - code LONGSTAY", "the code's label: the first plan carrying it");
  assert.match(kit.fakeCb.reservations.get(body.holdReservationId!)!.notes.join("\n"), /Long term, Long stay villa 25% \(code LONGSTAY\)\./);
  const session = kit.fakeStripe.session(sessionIdOf(body))!;
  assert.deepEqual(session.line_items_input.slice(0, 2).map((l) => l.name.replace(/^.* - Standard Rate/, "")), [" (Long term)", " (Long stay villa 25%)"]);
  const v = verifyBookingToken(new URL(session.success_url.replace("{CHECKOUT_SESSION_ID}", "x")).searchParams.get("t"), kit.config.tokenSecret, NOW);
  assert.ok(v.ok);
  if (v.ok) assert.deepEqual(v.payload.booking.itemDiscounts?.map((d) => d?.label), ["Long term - code LONGSTAY", "Long stay villa 25% - code LONGSTAY"]);
  assert.equal(postOf(kit)?.params.promoCode, "LONGSTAY", "one reservation-level promo code");

  // Cloudbeds prices both plans at the base rate: the guest is not told one plan's name, and the code's one alert (fixed key)
  // names both plans, so the owner checks each.
  const plans = ["Long term", "Long stay villa 25%"];
  const atBase = codeKit({ roomTypes, cb: { plansPricedAtBase: true } });
  const refused = await checkout(atBase, [...HONEYMOON, ...SUNRISE], { ...SEVEN_NIGHTS, promo: "LONGSTAY" });
  assert.equal(refused.status, 503, JSON.stringify(refused.body));
  const message = refused.body.ok ? "" : refused.body.message;
  assert.equal(message, directAtBaseMessage("LONGSTAY", plans));
  assert.match(message, /^We couldn't reserve your room at our discounted rate online just now\. Nothing has been charged\. Book with code LONGSTAY on our classic booking page/);
  const subject = 'Code LONGSTAY bookings blocked: Cloudbeds priced the "Long term" and "Long stay villa 25%" rates at the base rate - set BOOKING_DIRECT_PROMO=off and redeploy';
  assert.equal(codeAtBaseAlert("LONGSTAY", plans), subject);
  const alerts = atBase.alerts.filter((a) => a.subject.startsWith("Code LONGSTAY bookings blocked"));
  assert.deepEqual(alerts.map((a) => a.subject), [subject], "the alert names every plan priced at base, so the owner checks the right ones");
  assert.match(alerts[0].lines[0], /on the "Long term" and "Long stay villa 25%" rates \(code LONGSTAY; Cloudbeds promo code LONGSTAY\)/);
  assert.equal(atBase.alerts.some((a) => a.subject === DIRECT_AT_BASE_ALERT), false);
  assert.deepEqual(atBase.logs.find((l) => l.message === "hold_code_at_base")?.data?.plans, plans);
});

test("Cloudbeds prices a LONGSTAY hold at the BASE rate: classified apart, hold cancelled, nothing charged, one alert per code naming the code and the switch; never the DIRECT alert", async () => {
  const kit = codeKit({ cb: { plansPricedAtBase: true } });
  for (let i = 0; i < 2; i++) {
    const res = await checkout(kit, HONEYMOON, { ...SEVEN_NIGHTS, promo: "LONGSTAY" });
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.ok ? "" : res.body.error, "payment_unavailable");
    assert.equal(res.body.ok ? "" : res.body.message, directAtBaseMessage("LONGSTAY", ["Long term"]));
  }
  assert.match(directAtBaseMessage("LONGSTAY", ["Long term"]), /^We couldn't reserve your room at our "Long term" rate online just now\. Nothing has been charged\. Book with code LONGSTAY on our classic booking page/);
  assert.equal(kit.fakeStripe.sessions.size, 0, "no Stripe call");
  assert.ok([...kit.fakeCb.reservations.values()].every((r) => r.status === "canceled"), "each hold given back");
  const subject = 'Code LONGSTAY bookings blocked: Cloudbeds priced the "Long term" rate at the base rate - set BOOKING_DIRECT_PROMO=off and redeploy';
  assert.equal(codeAtBaseAlert("LONGSTAY", ["Long term"]), subject);
  const alerts = kit.alerts.filter((a) => a.subject.startsWith("Code LONGSTAY bookings blocked"));
  assert.deepEqual(alerts.map((a) => a.subject), [subject], "one fixed-key alert per code, not one per booking");
  assert.match(alerts[0].lines[0], /on the "Long term" rate \(code LONGSTAY; Cloudbeds promo code LONGSTAY\)/);
  assert.match(alerts[0].lines[1], /^Fix now: set BOOKING_DIRECT_PROMO=off in Vercel and redeploy\. That switches off EVERY code on the own page, DIRECT included/);
  assert.match(alerts[0].lines[1], /Removing the code from the plan in Cloudbeds is no fix/);
  assert.equal(kit.alerts.some((a) => a.subject === DIRECT_AT_BASE_ALERT), false);
  assert.equal(kit.alerts.some((a) => a.subject.startsWith("Booking stopped: Cloudbeds price differs")), false, "classified apart from a price change");
  const logged = kit.logs.filter((l) => l.message === "hold_code_at_base");
  assert.equal(logged.length, 2);
  assert.deepEqual(logged[0].data?.plans, ["Long term"]);
  assert.equal(logged[0].data?.code, "LONGSTAY");
  assert.equal(kit.logs.some((l) => l.message === "hold_direct_at_base"), false);
});

test("a cart with a LONGSTAY room and an automatic-discount room, both priced at the base rate: the automatic alert and the code's own alert", async () => {
  const roomTypes = { ...withHmPlans([fakeLongStayCodePlan("rate-hm-ls")]), "462960": { ...CODE_ROOM_TYPES["462960"], plans: [fakeLongTermPlan("rate-sr-lt")] } };
  const ok = codeKit({ roomTypes });
  const fine = await checkout(ok, [...HONEYMOON, ...SUNRISE], { ...SEVEN_NIGHTS, promo: "LONGSTAY" });
  assert.equal(fine.status, 200, JSON.stringify(fine.body));
  assert.equal((fine.body as CheckoutSuccess).quote.roomsSubtotalSatang, HM_LS_7 + SR_LT_7);
  assert.deepEqual([0, 1].map((i) => postOf(ok)?.params[`rooms[${i}][roomRateID]`]), ["rate-hm-ls", "rate-sr-lt"]);
  assert.equal(postOf(ok)?.params.promoCode, "LONGSTAY");

  const kit = codeKit({ roomTypes, cb: { plansPricedAtBase: true } });
  const res = await checkout(kit, [...HONEYMOON, ...SUNRISE], { ...SEVEN_NIGHTS, promo: "LONGSTAY" });
  assert.equal(res.status, 503, JSON.stringify(res.body));
  assert.equal(res.body.ok ? "" : res.body.message, directAtBaseMessage("LONGSTAY", ["Long term"]));
  assert.equal(kit.alerts.filter((a) => a.subject.startsWith(AUTO_AT_BASE_ALERT_PREFIX)).length, 1);
  const code = kit.alerts.filter((a) => a.subject === codeAtBaseAlert("LONGSTAY", ["Long term"]));
  assert.equal(code.length, 1);
  assert.match(code[0].lines[0], /priced the code LONGSTAY rooms of a cart that also had automatic discounts at the base rate/);
  assert.match(code[0].lines[1], /\(it switches off every code, DIRECT included\)\.$/);
  assert.equal(kit.alerts.some((a) => a.subject === DIRECT_AT_BASE_ALERT), false);
  assert.equal(SR_BASE_7 > SR_LT_7, true);
});

test("one at-base alert PER CODE: DIRECT's alert never silences LONGSTAY's (alone or in a cart with an automatic discount), and one code's never silences another's", async () => {
  const summer = { rateId: "rate-hm-sm", name: "Summer 15% off", pctOfBase: 85, promoCode: "SUMMER" };
  const roomTypes = {
    ...withHmPlans([fakeLongStayCodePlan("rate-hm-ls"), summer]),
    "462960": { ...CODE_ROOM_TYPES["462960"], plans: [fakeLongTermPlan("rate-sr-lt")] },
  };
  // One kit, so one alerter and one repeat-suppression window for every booking below.
  const kit = codeKit({ roomTypes, cb: { directPricedAtBase: true, plansPricedAtBase: true } });
  const blocked = () => kit.alerts.map((a) => a.subject).filter((s) => / bookings blocked: /.test(s));
  assert.equal((await checkout(kit, HONEYMOON, { ...SEVEN_NIGHTS, promo: "DIRECT" })).status, 503);
  assert.deepEqual(blocked(), [DIRECT_AT_BASE_ALERT]);
  // The mixed cart's code alert (auto_at_base, alsoDirect) after DIRECT's.
  assert.equal((await checkout(kit, [...HONEYMOON, ...SUNRISE], { ...SEVEN_NIGHTS, promo: "LONGSTAY" })).status, 503);
  assert.deepEqual(blocked(), [DIRECT_AT_BASE_ALERT, codeAtBaseAlert("LONGSTAY", ["Long term"])]);
  // A second code (promo_at_base) after both.
  assert.equal((await checkout(kit, HONEYMOON, { ...SEVEN_NIGHTS, promo: "SUMMER" })).status, 503);
  // LONGSTAY alone again: its alert was already sent (one per code), so nothing new.
  assert.equal((await checkout(kit, HONEYMOON, { ...SEVEN_NIGHTS, promo: "LONGSTAY" })).status, 503);
  assert.deepEqual(blocked(), [DIRECT_AT_BASE_ALERT, codeAtBaseAlert("LONGSTAY", ["Long term"]), codeAtBaseAlert("SUMMER", ["Summer 15% off"])]);
  assert.equal(kit.logs.filter((l) => l.message === "hold_code_at_base").length, 2, "SUMMER and LONGSTAY alone");

  // LONGSTAY alone first in a fresh kit (promo_at_base) after DIRECT's: its own alert too.
  const alone = codeKit({ roomTypes, cb: { directPricedAtBase: true, plansPricedAtBase: true } });
  await checkout(alone, HONEYMOON, { ...SEVEN_NIGHTS, promo: "DIRECT" });
  await checkout(alone, HONEYMOON, { ...SEVEN_NIGHTS, promo: "LONGSTAY" });
  assert.deepEqual(alone.alerts.map((a) => a.subject), [DIRECT_AT_BASE_ALERT, codeAtBaseAlert("LONGSTAY", ["Long term"])]);
});

test("never trust the client: a rate sent by the browser is ignored; another derived rate reaching the locked check as LONGSTAY's is refused with an alert naming the code's plan", async () => {
  const kit = codeKit();
  const tampered = [{ ...HONEYMOON[0], rateId: "rate-hm-nr", roomRateID: "rate-hm-nr" }] as unknown as CartItemInput[];
  const res = await checkout(kit, tampered, { ...SEVEN_NIGHTS, promo: "LONGSTAY", rateId: "rate-hm-nr" } as Partial<CheckoutRequest>);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(postOf(kit)?.params["rooms[0][roomRateID]"], "rate-hm-ls", "the server's own choice");

  for (const swapped of ["rate-hm-nr", "rate-hm-direct"]) {
    const kit2 = codeKit();
    const original = kit2.deps.restrictions!;
    kit2.deps.restrictions = (roomTypeId, _rateId, checkIn, checkOut, adults, promo) => original(roomTypeId, swapped, checkIn, checkOut, adults, promo);
    const refused = await checkout(kit2, HONEYMOON, { ...SEVEN_NIGHTS, promo: "LONGSTAY" });
    assert.equal(refused.status, 409, swapped);
    assert.match(refused.body.ok ? "" : refused.body.message, /can't be booked online/);
    assert.equal(kit2.fakeCb.count("postReservation"), 0, swapped);
    const alert = kit2.alerts.find((a) => a.subject.includes("derived rate"));
    assert.match(alert?.lines[0] ?? "", /was offered as the "Long term" rate for code LONGSTAY \(Cloudbeds promo code LONGSTAY\), but Cloudbeds' getRatePlans does not confirm it/, swapped);
    assert.match(alert?.lines[1] ?? "", /set BOOKING_DIRECT_PROMO=off and redeploy \(every code off, DIRECT included\)/);
    assert.ok(kit2.logs.some((l) => l.message === "checkout_refused_derived_rate" && l.data?.promo === true));
  }
});

test("postReservation refuses LONGSTAY's plan for the source: the alert names the plan, where to tick the source, and the switch (which turns every code off)", async () => {
  const kit = codeKit({ cb: { ratesNotForSource: ["rate-hm-ls"] } });
  const res = await checkout(kit, HONEYMOON, { ...SEVEN_NIGHTS, promo: "LONGSTAY" });
  assert.equal(res.status, 503, JSON.stringify(res.body));
  const alert = kit.alerts.find((a) => a.subject === "Booking stopped: Cloudbeds refused the reservation");
  assert.ok(alert, JSON.stringify(kit.alerts));
  assert.match(alert.lines[0], /Rate rate-hm-ls is not available for this reservation/);
  assert.match(alert.lines[2], /^Fix: Cloudbeds refused a discounted rate this booking holds \(Long term\)/);
  assert.equal(alert.lines[3], rateSourceFixLine("Long term"));
  assert.match(alert.lines[4], /set BOOKING_DIRECT_PROMO=off in Vercel and redeploy\. BOOKING_DIRECT_PROMO=off switches off every code on the own page, DIRECT included\.$/);
  assert.doesNotMatch(alert.lines[4], /BOOKING_AUTO_DISCOUNTS/);
});

test("postReservation refuses another rate in a LONGSTAY cart for the source: the promoCode line blames the code LONGSTAY room, never a Direct-rate room the cart doesn't have", async () => {
  const refused = (kit: Kit) => kit.alerts.find((a) => a.subject === "Booking stopped: Cloudbeds refused the reservation");
  // An automatic plan (Long term booking on the Sunrise Suite) refused next to the code's room.
  const roomTypes = { ...withHmPlans([fakeLongStayCodePlan("rate-hm-ls")]), "462960": { ...CODE_ROOM_TYPES["462960"], plans: [fakeLongTermPlan("rate-sr-lt")] } };
  const auto = codeKit({ roomTypes, cb: { ratesNotForSource: ["rate-sr-lt"] } });
  assert.equal((await checkout(auto, [...HONEYMOON, ...SUNRISE], { ...SEVEN_NIGHTS, promo: "LONGSTAY" })).status, 503);
  const autoLines = refused(auto)?.lines ?? [];
  assert.match(autoLines[2] ?? "", /^Fix: Cloudbeds refused a discounted rate this booking holds \(Long term booking\)/, JSON.stringify(auto.alerts));
  const autoPromo = autoLines.find((l) => l.startsWith("If the automatic plan is already open to the source: "));
  assert.match(autoPromo ?? "", /reservation-level promoCode \(a room on the code LONGSTAY's rate in the same cart\)/, JSON.stringify(autoLines));
  assert.ok(autoLines.every((l) => !/the Direct rate/.test(l)), JSON.stringify(autoLines));
  // A room's BASE rate refused next to the code's room.
  const garden: CartItemInput[] = [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
  const base = codeKit({ cb: { ratesNotForSource: ["rate-gs"] } });
  assert.equal((await checkout(base, [...HONEYMOON, ...garden], { ...SEVEN_NIGHTS, promo: "LONGSTAY" })).status, 503);
  const baseLines = refused(base)?.lines ?? [];
  assert.match(baseLines.find((l) => l.startsWith("Also: ")) ?? "", /reservation-level promoCode \(a room on the code LONGSTAY's rate in the same cart\)/, JSON.stringify(baseLines));
  assert.ok(baseLines.every((l) => !/the Direct rate/.test(l)), JSON.stringify(baseLines));
});

/* ----------------------------------- labels ---------------------------------- */

test("labels: '<plan> - code <CODE>' for another code, 'Direct rate - code DIRECT' kept; never longer than the booking token takes (80 characters)", () => {
  const baseNightly = [{ date: FAR_CHECKIN, amountSatang: 900_000 }];
  assert.equal(rateDiscountLabel({ baseNightly, adultsExtraSatang: {}, kind: "direct", name: "Long term" }, "LONGSTAY"), "Long term - code LONGSTAY");
  assert.equal(rateDiscountLabel({ baseNightly, adultsExtraSatang: {}, kind: "direct" }, "DIRECT"), "Direct rate - code DIRECT");
  assert.equal(rateDiscountLabel({ baseNightly, adultsExtraSatang: {}, kind: "direct", name: "Long term" }, null), null);
  const code = "A".repeat(32);
  const label = codeRateLabel("Long term booking for our most loyal guests, every room type", code);
  assert.ok(label.length <= 80, label);
  assert.ok(label.endsWith(` - code ${code}`), "the code is never cut");
  // The return page's token takes it.
  const booking: BookingSummary = {
    ref: "MSV-20261007-ABCD",
    paymentMode: "stripe-test",
    ...SEVEN_NIGHTS,
    nights: 7,
    items: HONEYMOON,
    itemRoomSatang: [HM_LS_7],
    itemDiscounts: [{ kind: "direct", label, listSatang: HM_BASE_7 }],
    promoCode: code,
    totalSatang: HM_LS_7,
    cardFeeSatang: 0,
    dueNowSatang: HM_LS_7,
    createdAt: new Date(NOW).toISOString(),
    linkExpiresAt: new Date(NOW + 1_800_000).toISOString(),
  };
  const secret = "test-only-7f3K9qLm2xVw8RtY4pZn6bHc1dJe5gUa";
  assert.equal(verifyBookingToken(createBookingToken(booking, null, secret, 3600, NOW), secret, NOW).ok, true);
});

test("a code's plan with no public name (neither in getRatePlans nor on the availability row): 'Special rate - code <CODE>' on the room, like the search line", async () => {
  const roomTypes = withHmPlans([{ rateId: "rate-hm-sm", name: "", pctOfBase: 85, promoCode: "SUMMER" }]);
  const { promo, result, offers } = await routeSearch(codeKit({ roomTypes }), SEVEN_NIGHTS, "summer");
  assert.deepEqual(promo, { code: "SUMMER", valid: true, pct: 0, label: "Special rate" });
  const hm = by(result.inventory, "honeymoon-suite");
  assert.equal(hm.rateId, "rate-hm-sm");
  assert.equal(hm.discount?.name, "Special rate");
  const list = offers.find((o) => o.slug === "honeymoon-suite")!.rates[0].list;
  assert.equal(list?.name, "Special rate");
  assert.equal(rateDiscountLabel(list, "SUMMER"), "Special rate - code SUMMER");
  const q = computeQuote({ ...SEVEN_NIGHTS, items: HONEYMOON, promo: { code: "SUMMER", pct: 0, label: "Special rate" }, pricing: { cardFeePct: 5, depositPct: 100 } }, offers);
  assert.equal(lineDiscountLabel(q.lines[0], q), "Special rate - code SUMMER");
  assert.equal(q.directRate?.label, "Special rate - code SUMMER");
});

test("a cached search keeps a code's plan-name label apart from the same Cloudbeds code asked as DIRECT", async () => {
  const kit = codeKit();
  const deps = { apiKey: "cbat_codes_cache_label", propertyId: "235064", fetchImpl: kit.fakeCb.fetch, baseRateOnly: true, cacheTtlMs: 60_000, nowMs: 1_000 };
  const rates = { "462958": [{ rateId: "rate-hm-direct", parentRateId: "rate-hm", name: "Direct booking rate" }] };
  const named = await cloudbedsInventory(SEVEN_NIGHTS.checkIn, SEVEN_NIGHTS.checkOut, { ...deps, promo: { cloudbedsCode: "Direct", rates, showName: true } });
  assert.equal(by(named, "honeymoon-suite").discount?.showName, true);
  const alias = await cloudbedsInventory(SEVEN_NIGHTS.checkIn, SEVEN_NIGHTS.checkOut, { ...deps, promo: { cloudbedsCode: "Direct", rates } });
  assert.equal(by(alias, "honeymoon-suite").discount?.showName, undefined, "not the named answer from the cache");
  assert.equal(by(alias, "honeymoon-suite").rateId, "rate-hm-direct");
});

/* ------------------------------ landing and wiring ------------------------------ */

test("landing links and the homepage bar carry any code: ?promo=LONGSTAY prefills the page, the homepage passes what the guest typed", () => {
  assert.equal(new URL(homeSearchPath({ ...SEVEN_NIGHTS, adults: 2, promo: " longstay " }, true, "s1"), ORIGIN_FOR_URLS).searchParams.get("promo"), "LONGSTAY");
  assert.equal(new URL(homeSearchPath({ ...SEVEN_NIGHTS, adults: 2, promo: "summer-26" }, true, "s1"), ORIGIN_FOR_URLS).searchParams.get("promo"), "SUMMER-26");
  assert.equal(new URL(homeSearchPath({ ...SEVEN_NIGHTS, adults: 2, promo: "LONGSTAY" }, false, "s1"), ORIGIN_FOR_URLS).searchParams.get("promo"), null, "no code where the pill isn't offered");
  const src = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  // The page's ?promo= prefill takes any well-formed code (not only DIRECT); the homepage bar passes the guest's draft.
  assert.ok(src("components/booking/OwnBookingPage.tsx").includes("/^[A-Za-z0-9_-]{1,32}$/.test(promo)) out.promo = promo.toUpperCase();"));
  assert.ok(src("components/HomeSearchBar.tsx").includes("promo: draft.promo }, promoEnabled)"));
  assert.ok(src("components/booking/search/PromoPopover.tsx").includes("const CODE_RE = /^[A-Z0-9_-]{1,32}$/;"));
  // The checkout asks Cloudbeds as promoAskFor says and resolves the code on the re-quote's own lookup.
  const co = src("lib/booking/checkout.ts");
  assert.ok(co.includes("promoAskFor(req.promo, config.promo)") && co.includes("resolvePromoFor(req.promo, config.promo, \"\", inventoryResult.promoLookup ?? null)"));
});

const ORIGIN_FOR_URLS = "https://magicsamui.com";

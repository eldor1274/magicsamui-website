// The money path after the WI-0 read-only check of the live property
// (6 Oct 2026): the custom Cloudbeds payment method ("Stripe(website)"),
// Cloudbeds' own per-source taxes/fees (5% "Card Charging Fee" on the default
// "Website / Booking engine" source), the folio read back before payment, the
// reservation source sent with the hold, faster alerts when a paid booking's
// payment record is refused, and the guest's late arrival / requests reaching
// staff. All against the in-repo fakes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runCheckout } from "./checkout.ts";
import { createCloudbedsWriter, readBalanceDetailed } from "./cloudbedsWrite.ts";
import { getBookingConfig, getFulfilmentConfig, resolveCloudbedsPaymentMethod, resolveCloudbedsSourceId, stripeLiveBlockers } from "./config.ts";
import { fulfilSession, releaseHold } from "./fulfil.ts";
import { keys } from "./lock.ts";
import { FAKE_PAYMENT_METHODS, createFakeCloudbeds } from "./mock/fakeCloudbeds.ts";
import { parseSessionMeta, sessionMetadata } from "./payments/stripe.ts";
import { FOLIO_CHECK_MIN_REMAINING_MS, FOLIO_RETRY_PAUSE_MS, classifyHoldTotal } from "./stripeCheckout.ts";
import { handleStripeWebhook } from "./stripeWebhook.ts";
import { runSweep } from "./sweep.ts";
import { GUEST, HONEYMOON, NOW, STRIPE_LIVE_ENV, STRIPE_TEST_ENV, checkout, makeKit, request, serverQuote, sessionIdOf } from "./testkit.ts";
import type { Kit } from "./testkit.ts";
import type { CartItemInput, CheckoutSuccess } from "./types.ts";

const GARDEN: CartItemInput[] = [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
/** Honeymoon, 3 nights at 9,000: rooms 27,000.00, our 5% fee 1,350.00. */
const ROOMS = 2_700_000;
const FEE = 135_000;

async function pricedBody(kit: Kit, items: CartItemInput[] = HONEYMOON, extra = {}) {
  const req = request(items, extra);
  const quote = await serverQuote(kit, req);
  return { ...req, expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang };
}

async function paidSession(kit: Kit, items: CartItemInput[] = HONEYMOON) {
  const res = await checkout(kit, items);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  const sessionId = sessionIdOf(body);
  kit.fakeStripe.complete(sessionId);
  return { sessionId, reservationId: body.holdReservationId as string, ref: body.ref };
}

const stripePosts = (kit: Kit) => kit.fakeStripe.calls.filter((c) => c.method === "POST").length;
const blocked = (kit: Kit) => kit.alerts.filter((a) => a.subject === "Online bookings blocked: Cloudbeds adds taxes/fees to online holds");

/* ------------------------- A3: CLOUDBEDS_SOURCE_ID ------------------------- */

// First in this file: the warning is logged once per process.
test("CLOUDBEDS_SOURCE_ID: primary source ids only (s-N, s-N-1), trimmed; anything else is ignored with a warning naming the variable, never its value", () => {
  const warned: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args);
  try {
    assert.equal(resolveCloudbedsSourceId({ CLOUDBEDS_SOURCE_ID: "s-41" }), "s-41");
    assert.equal(resolveCloudbedsSourceId({ CLOUDBEDS_SOURCE_ID: "s-41-1" }), "s-41-1");
    assert.equal(resolveCloudbedsSourceId({ CLOUDBEDS_SOURCE_ID: " s-41 " }), "s-41");
    assert.equal(resolveCloudbedsSourceId({}), null);
    assert.equal(resolveCloudbedsSourceId({ CLOUDBEDS_SOURCE_ID: "  " }), null);
    assert.deepEqual(warned, [], "unset is not a warning");
    for (const bad of ["ss-3-1", "41", "s-", "s-x", "s-41-2", "S-41", "s-1234567890123"]) {
      assert.equal(resolveCloudbedsSourceId({ CLOUDBEDS_SOURCE_ID: bad }), null, bad);
    }
    assert.equal(warned.length, 1, "logged once per process");
    assert.match(JSON.stringify(warned), /config_warning.*CLOUDBEDS_SOURCE_ID/);
    assert.equal(JSON.stringify(warned).includes("ss-3-1"), false, "the value is never logged");
  } finally {
    console.warn = original;
  }
  assert.equal(getBookingConfig({ ...STRIPE_TEST_ENV, CLOUDBEDS_SOURCE_ID: "s-41" }).cloudbedsSourceId, "s-41");
  assert.equal(getBookingConfig(STRIPE_TEST_ENV).cloudbedsSourceId, null);
  // Not a live-lock condition.
  assert.deepEqual(stripeLiveBlockers({ ...STRIPE_LIVE_ENV, CLOUDBEDS_SOURCE_ID: "ss-3-1" }), []);
});

/* ---------------------- A1: the Cloudbeds payment method ---------------------- */

test("payment method: the exact custom value is kept (punctuation, case); whitespace, control characters, built-ins and unset are problems - no default", () => {
  const resolve = (env: Record<string, string | undefined>, mode: "stripe-test" | "stripe-live" = "stripe-test") => resolveCloudbedsPaymentMethod(env, mode);
  assert.deepEqual(resolve({ CLOUDBEDS_STRIPE_PAYMENT_METHOD: "Stripe(website)" }), { method: "Stripe(website)", problem: null });
  assert.deepEqual(resolve({ CLOUDBEDS_STRIPE_PAYMENT_METHOD: " Stripe(website)\n" }), { method: "Stripe(website)", problem: null }, "trimmed");
  assert.equal(resolve({ CLOUDBEDS_STRIPE_PAYMENT_METHOD: "stripe(Website)" }).method, "stripe(Website)", "case kept exactly");
  assert.equal(resolve({ CLOUDBEDS_STRIPE_PAYMENT_METHOD: "1" }).method, "1", "a number Cloudbeds assigned");
  assert.equal(resolve({ CLOUDBEDS_STRIPE_PAYMENT_METHOD: "x".repeat(64) }).method, "x".repeat(64));

  for (const bad of ["Stripe TEST", "Stripe\tTEST", "Stripe\u0007", "Stripe\u200b", "x".repeat(65)]) {
    const r = resolve({ CLOUDBEDS_STRIPE_PAYMENT_METHOD: bad });
    assert.equal(r.method, null, JSON.stringify(bad));
    assert.match(r.problem ?? "", /^CLOUDBEDS_STRIPE_PAYMENT_METHOD ".*" is not a Cloudbeds payment method value/);
    assert.match(r.problem ?? "", /scripts\/cloudbeds-wi0-check\.mjs/);
  }
  // Built-ins would file Stripe money as cash, a card, PayPal, a transfer... ("credit" also needs a cardType).
  for (const builtIn of ["credit", "cards", "Cash", "bank_transfer", "EBANKING", "pay_pal", "debit", "check", "check_true", "bill"]) {
    const r = resolve({ CLOUDBEDS_STRIPE_PAYMENT_METHOD: builtIn });
    assert.equal(r.method, null, builtIn);
    assert.match(r.problem ?? "", /built-in method/);
  }
  // Unset: a problem, and NOT the old default "stripe" (a method this property doesn't have).
  assert.equal(resolve({}).method, null);
  assert.match(resolve({}).problem ?? "", /^CLOUDBEDS_STRIPE_PAYMENT_METHOD is not set/);
  const unset = getBookingConfig({ ...STRIPE_TEST_ENV, CLOUDBEDS_STRIPE_PAYMENT_METHOD: undefined });
  assert.equal(unset.cloudbedsPaymentMethod, null);
  assert.match(unset.cloudbedsPaymentMethodProblem ?? "", /not set/);
});

test("payment method: outside live the TEST variable wins when set - an invalid one is a problem, never a fall-through to the live method; live ignores it", () => {
  const env = { CLOUDBEDS_STRIPE_PAYMENT_METHOD: "Stripe(website)" };
  assert.equal(resolveCloudbedsPaymentMethod({ ...env, CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD: "Stripe_TEST" }, "stripe-test").method, "Stripe_TEST");
  assert.equal(resolveCloudbedsPaymentMethod({ ...env, CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD: "" }, "stripe-test").method, "Stripe(website)");
  assert.equal(resolveCloudbedsPaymentMethod({ ...env, CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD: "Stripe_TEST" }, "stripe-mock").method, "Stripe_TEST");
  const invalid = resolveCloudbedsPaymentMethod({ ...env, CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD: "Stripe TEST" }, "stripe-test");
  assert.deepEqual(invalid.method, null, "test money never falls through to the real method");
  assert.match(invalid.problem ?? "", /^CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD "Stripe TEST"/);
  // Live: only the live variable, even when the test one is invalid.
  assert.deepEqual(resolveCloudbedsPaymentMethod({ ...env, CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD: "Stripe TEST" }, "stripe-live"), { method: "Stripe(website)", problem: null });
  assert.equal(resolveCloudbedsPaymentMethod({ CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD: "Stripe_TEST" }, "stripe-live").method, null);
});

test("test money goes to the separate test method end to end (CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD)", async () => {
  const kit = makeKit({ env: { ...STRIPE_TEST_ENV, CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD: "Stripe_TEST" } });
  const { sessionId, reservationId } = await paidSession(kit);
  assert.equal((await fulfilSession(sessionId, kit.deps)).state, "confirmed");
  assert.deepEqual(kit.fakeCb.reservations.get(reservationId)!.payments.map((p) => p.type), ["Stripe_TEST"]);
});

test("payment method problems never lock the config: fulfilment, release and the sweeper keep loading it", () => {
  const live = { ...STRIPE_LIVE_ENV, CLOUDBEDS_STRIPE_PAYMENT_METHOD: "Stripe TEST" };
  assert.deepEqual(stripeLiveBlockers(live), [], "not a live-lock condition");
  assert.equal(getBookingConfig(live).paymentMode, "stripe-live");
  assert.match(getBookingConfig(live).cloudbedsPaymentMethodProblem ?? "", /CLOUDBEDS_STRIPE_PAYMENT_METHOD/);
  assert.equal(getFulfilmentConfig({ ...live, BOOKING_ALLOW_LIVE_PAYMENTS: "false" }).paymentMode, "stripe-live", "emergency stop: still drains");
});

test("checkout with real Cloudbeds writes refuses EARLY on a payment method problem: 503 'message us', nothing held, one alert naming the variable", async () => {
  for (const env of [
    { ...STRIPE_TEST_ENV, CLOUDBEDS_STRIPE_PAYMENT_METHOD: "Stripe TEST" },
    { ...STRIPE_TEST_ENV, CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD: "cash" },
    { ...STRIPE_TEST_ENV, CLOUDBEDS_STRIPE_PAYMENT_METHOD: undefined },
  ]) {
    const kit = makeKit({ env });
    const body = await pricedBody(kit);
    for (let i = 0; i < 2; i++) {
      const res = await runCheckout(body, kit.checkoutDeps());
      assert.equal(res.status, 503);
      assert.equal(res.body.ok ? "" : res.body.error, "payment_unavailable");
      assert.match(res.body.ok ? "" : res.body.message, /Nothing has been charged\. Message us on WhatsApp/);
    }
    assert.equal(kit.fakeCb.count("postReservation"), 0, "no hold");
    assert.deepEqual(kit.fakeCb.calls.filter((c) => c.verb !== "GET"), [], "no Cloudbeds write at all");
    assert.equal(kit.fakeCb.count("getRatePlans"), 0, "refused before the locked re-checks");
    assert.equal(stripePosts(kit), 0, "no Stripe session");
    assert.deepEqual(await kit.deps.kv.zrangeByScore(keys.intentIndex(), 0, Number.MAX_SAFE_INTEGER, 10), [], "no intent");
    const alerts = kit.alerts.filter((a) => a.subject === "Online bookings stopped: the Cloudbeds payment method is not set up");
    assert.equal(alerts.length, 1, "deduplicated");
    assert.equal(alerts[0].severity, "warning");
    assert.match(alerts[0].lines[0], /^CLOUDBEDS_STRIPE_(TEST_)?PAYMENT_METHOD /);
  }
});

test("the MOCK writer (nothing reaches Cloudbeds) is not refused without a method, and still confirms paid bookings", async () => {
  const env = { ...STRIPE_TEST_ENV, CLOUDBEDS_API_KEY_BOOKING: undefined, CLOUDBEDS_STRIPE_PAYMENT_METHOD: undefined };
  const kit = makeKit({ env, cb: { lenient: true } });
  assert.equal(kit.deps.writer.mode, "mock");
  assert.notEqual(kit.config.cloudbedsPaymentMethodProblem, null);
  const { sessionId, reservationId } = await paidSession(kit);
  assert.equal((await fulfilSession(sessionId, kit.deps)).state, "confirmed");
  assert.equal(kit.fakeCb.reservations.get(reservationId)!.payments.length, 1);
});

/* ------------------- A8: the fake's payment methods ------------------- */

test("fake Cloudbeds: getPaymentMethods lists the property's methods; postPayment takes only an active method's exact value (ASSUMED strict)", async () => {
  const fake = createFakeCloudbeds({ roomTypes: { "462958": { rate: 9000, rateId: "r", units: 1 } } });
  const res = await fake.fetch("https://api.cloudbeds.com/api/v1.3/getPaymentMethods?propertyID=1", { headers: { "x-api-key": "k" } });
  const methods = ((await res.json()) as { data: { methods: { method: string; code: string; name: string }[] } }).data.methods;
  assert.ok(methods.some((m) => m.method === "Stripe(website)" && m.code === "Stripe(website)" && m.name === "Stripe (website)"));
  assert.ok(methods.some((m) => m.method === "credit" && m.code === "cards"));
  assert.deepEqual(methods, FAKE_PAYMENT_METHODS);

  const w = createCloudbedsWriter({ apiKey: "k", propertyId: "1", fetchImpl: fake.fetch, budget: null });
  const hold = await w.createHold({
    ref: "MSV-20261005-ABCD",
    checkIn: "2027-11-10",
    checkOut: "2027-11-13",
    rooms: [{ roomTypeId: "462958", rateId: "r", adults: 2 }],
    guest: { firstName: "A", lastName: "B", email: "a@b.co", phone: "+1 5555555", country: "US", zip: "1" },
    estimatedArrivalTime: null,
    paymentMethod: "credit",
    expectedRoomsSatang: 0,
  });
  for (const wrong of ["stripe", "Stripe", "Stripe (website)", "stripe(website)"]) {
    await assert.rejects(w.recordPayment({ reservationId: hold.reservationId, amountSatang: 100, method: wrong, description: "x" }), /Invalid payment type/, wrong);
  }
  assert.deepEqual(await w.recordPayment({ reservationId: hold.reservationId, amountSatang: 100, method: "Stripe(website)", description: "x" }), { paymentId: "pay-1" });
});

/* ------------------------ A3: sourceID on the hold ------------------------ */

test("the hold carries sourceID = CLOUDBEDS_SOURCE_ID when set, and no sourceID at all otherwise", async () => {
  const plain = makeKit();
  assert.equal((await checkout(plain)).status, 200);
  assert.equal("sourceID" in plain.fakeCb.calls.find((c) => c.method === "postReservation")!.params, false);

  const withSource = makeKit({ env: { ...STRIPE_TEST_ENV, CLOUDBEDS_SOURCE_ID: "s-41" } });
  assert.equal((await checkout(withSource)).status, 200);
  assert.equal(withSource.fakeCb.calls.find((c) => c.method === "postReservation")!.params.sourceID, "s-41");
});

test("a refused hold's alert lists the reservation source among the suspects", async () => {
  const kit = makeKit();
  const body = await pricedBody(kit);
  kit.fakeCb.failNext("postReservation", "rejected", "Invalid sourceID");
  assert.equal((await runCheckout(body, kit.checkoutDeps())).status, 503);
  const alert = kit.alerts.find((a) => a.subject === "Booking stopped: Cloudbeds refused the reservation");
  assert.match(alert?.lines.join(" ") ?? "", /the reservation source \(CLOUDBEDS_SOURCE_ID\)/);
});

/* -------------------- A4: Cloudbeds taxes/fees on the hold -------------------- */

test("classifyHoldTotal: exact equality of BOTH totals (and no Cloudbeds charges) is the only pass; refusals are classified", () => {
  const Q = ROOMS;
  const folio = (o: Partial<{ grandTotalSatang: number | null; subTotalSatang: number | null; taxesFeesSatang: number | null; additionalItemsSatang: number | null }> = {}) => ({
    grandTotalSatang: Q,
    subTotalSatang: Q,
    taxesFeesSatang: 0,
    additionalItemsSatang: 0,
    ...o,
  });
  const c = (holdTotalSatang: number | null, f: ReturnType<typeof folio> | null) => classifyHoldTotal({ quotedRoomsSatang: Q, holdTotalSatang, folio: f });

  assert.deepEqual(c(Q, folio()), { kind: "match" });
  assert.deepEqual(c(null, folio()), { kind: "match" }, "postReservation without a total: the folio decides");
  // A matching postReservation total alone is never enough.
  assert.deepEqual(c(Q, null), { kind: "unreadable" });
  assert.deepEqual(c(null, null), { kind: "unreadable" });
  assert.deepEqual(c(Q, folio({ grandTotalSatang: null })), { kind: "unreadable" });

  // The default source's 5%: in both totals, or only on the folio.
  const fivePct = folio({ grandTotalSatang: Q + FEE, taxesFeesSatang: FEE });
  assert.deepEqual(c(Q + FEE, fivePct), { kind: "cloudbeds_fees", extraSatang: FEE, pctOfRooms: "5.00" });
  assert.deepEqual(c(Q, fivePct), { kind: "cloudbeds_fees", extraSatang: FEE, pctOfRooms: "5.00" });
  // Any Cloudbeds charge on the folio refuses, even 1 satang, even when the totals match.
  assert.deepEqual(c(Q, folio({ taxesFeesSatang: 1 })), { kind: "cloudbeds_fees", extraSatang: 1, pctOfRooms: "0.00" });
  assert.deepEqual(c(Q, folio({ grandTotalSatang: Q + 50_000, additionalItemsSatang: 50_000 })), { kind: "cloudbeds_fees", extraSatang: 50_000, pctOfRooms: "1.85" });
  assert.deepEqual(c(Q, folio({ subTotalSatang: Q - 50_000, additionalItemsSatang: 50_000 })), { kind: "cloudbeds_fees", extraSatang: 50_000, pctOfRooms: "1.89" });
  // No breakdown readable: the rooms equal the quote and the total is up to 15% higher -> a source fee.
  const noBreakdown = (total: number) => folio({ grandTotalSatang: total, taxesFeesSatang: null, additionalItemsSatang: null });
  assert.deepEqual(c(Q + 253_800, noBreakdown(Q + 253_800)), { kind: "cloudbeds_fees", extraSatang: 253_800, pctOfRooms: "9.40" });
  assert.deepEqual(c(Q + 1, noBreakdown(Q + 1)), { kind: "cloudbeds_fees", extraSatang: 1, pctOfRooms: "0.00" });
  assert.deepEqual(c(Q + 405_000, noBreakdown(Q + 405_000)), { kind: "cloudbeds_fees", extraSatang: 405_000, pctOfRooms: "15.00" });
  assert.deepEqual(c(Q + 405_001, noBreakdown(Q + 405_001)), { kind: "price_changed", totalSatang: Q + 405_001, pctOfQuote: "+15.00" });

  // The rooms themselves differ: a price change, with the %.
  assert.deepEqual(c(2_730_000, folio({ grandTotalSatang: 2_730_000, subTotalSatang: 2_730_000 })), { kind: "price_changed", totalSatang: 2_730_000, pctOfQuote: "+1.11" });
  assert.deepEqual(c(Q - 54_000, folio({ grandTotalSatang: Q - 54_000, subTotalSatang: Q - 54_000 })), { kind: "price_changed", totalSatang: Q - 54_000, pctOfQuote: "-2.00" });
  assert.deepEqual(c(Q - 1, null), { kind: "price_changed", totalSatang: Q - 1, pctOfQuote: "0.00" });
  // Folio unreadable: rooms can't be told from fees -> a price change (still refused).
  assert.deepEqual(c(Q + FEE, null), { kind: "price_changed", totalSatang: Q + FEE, pctOfQuote: "+5.00" });
});

test("default source with the 5% Card Charging Fee: hold cancelled, 503 'message us', ONE alert across two dates, nothing sent to Stripe or posted", async () => {
  const kit = makeKit({ cb: { sourceFeePct: { default: 5 } } });
  const first = await checkout(kit);
  const second = await checkout(kit, HONEYMOON, { checkIn: "2027-12-01", checkOut: "2027-12-04" });
  for (const res of [first, second]) {
    assert.equal(res.status, 503);
    assert.equal(res.body.ok ? "" : res.body.error, "payment_unavailable");
    assert.match(res.body.ok ? "" : res.body.message, /Nothing has been charged\. Message us on WhatsApp/);
  }
  const holds = [...kit.fakeCb.reservations.values()];
  assert.equal(holds.length, 2);
  assert.ok(holds.every((r) => r.status === "canceled" && r.taxesFees === 1350));
  assert.equal(stripePosts(kit), 0, "no Stripe session");
  assert.equal(kit.fakeCb.count("postCustomItem"), 0);
  assert.equal(kit.fakeCb.count("postPayment"), 0);
  assert.equal(kit.alerts.some((a) => a.subject.includes("price differs")), false, "not a per-room/date price alert");
  const [alert, ...more] = blocked(kit);
  assert.deepEqual(more, [], "one alert key per mode, not per room and date");
  assert.equal(alert.severity, "warning");
  const text = alert.lines.join(" ");
  assert.match(text, /THB 1350\.00 of taxes\/fees \(5\.00% of the rooms\)/);
  assert.match(text, /Reservation source used: Website \/ Booking engine \(default/);
  assert.match(text, /Settings > Property > Sources/);
  assert.match(text, /add a primary source for the own booking page with NO taxes or fees; put its id \(s-<number>\) in CLOUDBEDS_SOURCE_ID/);
  assert.doesNotMatch(text, /other form/);
  assert.match(text, /Never remove the Card Charging Fee from the "Website \/ Booking Engine" source/);
  assert.equal(kit.logs.filter((l) => l.message === "hold_taxes_fees").length, 2);
});

test("CLOUDBEDS_SOURCE_ID already set and the hold still carries a fee: the alert's fix checks THAT source, then the other id form - not a new source", async () => {
  const kit = makeKit({ env: { ...STRIPE_TEST_ENV, CLOUDBEDS_SOURCE_ID: "s-41" }, cb: { sourceFeePct: { "s-41": 5 } } });
  assert.equal((await checkout(kit)).status, 503);
  assert.equal(stripePosts(kit), 0);
  const text = blocked(kit)[0]?.lines.join(" ") ?? "";
  assert.match(text, /Reservation source used: CLOUDBEDS_SOURCE_ID s-41\./);
  assert.match(text, /section 4b\) check that source s-41 carries no taxes or fees, and remove any that was added/);
  assert.match(text, /switch CLOUDBEDS_SOURCE_ID to the other form \(s-N or s-N-1, Stage B case 19\) and redeploy/);
  assert.doesNotMatch(text, /add a primary source/);
  assert.match(text, /Never remove the Card Charging Fee from the "Website \/ Booking Engine" source/);
});

test("a fee-free source in CLOUDBEDS_SOURCE_ID: the paid folio has exactly ONE fee line (ours), no Cloudbeds taxes/fees, balance 0", async () => {
  const kit = makeKit({ env: { ...STRIPE_TEST_ENV, CLOUDBEDS_SOURCE_ID: "s-41" }, cb: { sourceFeePct: { default: 5, "s-41": 0 } } });
  const { sessionId, reservationId } = await paidSession(kit);
  assert.equal(kit.fakeCb.calls.find((c) => c.method === "postReservation")!.params.sourceID, "s-41");
  assert.equal(kit.fakeStripe.session(sessionId)!.amount_total, ROOMS + FEE, "rooms + our 5%");
  assert.equal((await fulfilSession(sessionId, kit.deps)).state, "confirmed");
  const r = kit.fakeCb.reservations.get(reservationId)!;
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].itemName, "TEST - Payment processing fee");
  assert.equal(r.taxesFees, 0);
  assert.equal(kit.fakeCb.balance(reservationId), 0, "no double fee");
  const folio = await kit.deps.writer.getReservation(reservationId);
  assert.deepEqual(
    [folio.subTotalSatang, folio.additionalItemsSatang, folio.taxesFeesSatang, folio.grandTotalSatang, folio.paidSatang, folio.sourceId],
    [ROOMS, FEE, 0, ROOMS + FEE, ROOMS + FEE, "s-41"],
  );
  assert.equal(blocked(kit).length, 0);
  assert.equal(kit.alerts.some((a) => /not filed under source|taxes\/fees on top|balance is not zero/.test(a.subject)), false);
});

test("the fee only on the folio (postReservation's total leaves it out): refused BEFORE payment by the read-back", async () => {
  const kit = makeKit({ cb: { sourceFeePct: { default: 5 }, feeOnlyOnFolio: true } });
  const res = await checkout(kit);
  assert.equal(res.status, 503);
  assert.equal(res.body.ok ? "" : res.body.error, "payment_unavailable");
  const [r] = [...kit.fakeCb.reservations.values()];
  assert.equal(r.status, "canceled");
  assert.equal(stripePosts(kit), 0, "no Stripe session: the guest never pays 1.05x against a 1.10x folio");
  assert.equal(blocked(kit).length, 1);
  assert.match(blocked(kit)[0].lines.join(" "), /\(5\.00% of the rooms\)/);
});

test("5% + 4.4% on the source: blocked, the alert shows 9.40%", async () => {
  const kit = makeKit({ cb: { sourceFeePct: { default: 9.4 } } });
  assert.equal((await checkout(kit)).status, 503);
  assert.match(blocked(kit)[0]?.lines.join(" ") ?? "", /THB 2538\.00 of taxes\/fees \(9\.40% of the rooms\)/);
  assert.equal(stripePosts(kit), 0);
});

test("a real room price change still answers 409 price_changed; its alert now carries the %", async () => {
  const kit = makeKit({ cb: { pricer: ({ rooms, startDate }) => (rooms.length && startDate ? 27_300 : 0) } });
  const res = await checkout(kit);
  assert.equal(res.status, 409);
  assert.equal(res.body.ok ? "" : res.body.error, "price_changed");
  assert.equal(blocked(kit).length, 0);
  const alert = kit.alerts.find((a) => a.subject === "Booking stopped: Cloudbeds price differs from the quote");
  assert.match(alert?.lines[0] ?? "", /priced the hold at 2730000 satang \(\+1\.11% against the quote\), the page quoted 2700000 satang/);
});

test("the folio read-back is mandatory: a failed read (and its one retry) cancels the hold (502, nothing charged), and so does too little time to read it", async () => {
  const kit = makeKit();
  const body = await pricedBody(kit);
  kit.fakeCb.failNext("getReservation", "http500");
  kit.fakeCb.failNext("getReservation", "http500");
  const res = await runCheckout(body, kit.checkoutDeps());
  assert.equal(res.status, 502);
  assert.equal([...kit.fakeCb.reservations.values()][0].status, "canceled");
  assert.equal(stripePosts(kit), 0);
  assert.ok(kit.alerts.some((a) => a.subject === "Booking stopped: Cloudbeds returned no price for the hold"));

  // postReservation leaves 7 s: enough for a Stripe call, not for the read AND a Stripe call or a cancel.
  const kit2 = makeKit();
  const body2 = await pricedBody(kit2);
  const wall = { ms: 1_000_000 };
  kit2.fakeCb.failNext("postReservation", "pass", undefined, () => {
    wall.ms += 18_000;
  });
  const late = await runCheckout(body2, { ...kit2.checkoutDeps(), clock: () => wall.ms, deadlineMs: wall.ms + 25_000 });
  assert.ok(25_000 - 18_000 < FOLIO_CHECK_MIN_REMAINING_MS);
  assert.equal(late.status, 503);
  assert.equal([...kit2.fakeCb.reservations.values()][0].status, "canceled");
  assert.equal(stripePosts(kit2), 0);
  assert.ok(kit2.logs.some((l) => l.message === "checkout_out_of_time" && l.data?.step === "before_folio_check"));
});

test("the folio read keeps failing, also for the cancel's own read: the checkout's hold is cancelled anyway and the guest's retry gets the room; other releases still refuse", async () => {
  const kit = makeKit();
  const body = await pricedBody(kit);
  for (let i = 0; i < 3; i++) kit.fakeCb.failNext("getReservation", "http500");
  const res = await runCheckout(body, kit.checkoutDeps());
  assert.equal(res.status, 502);
  const [r] = [...kit.fakeCb.reservations.values()];
  assert.equal(r.status, "canceled", "no payment page yet: nobody can have paid, so the read is not needed");
  assert.equal(kit.fakeCb.count("getReservation"), 3, "the read, its retry and the cancel's own read");
  assert.equal(kit.fakeCb.count("putReservation"), 1, "the cancel");
  assert.ok(kit.logs.some((l) => l.message === "release_read_failed_cancel_anyway" && l.data?.reservationId === r.reservationID));
  assert.equal(kit.logs.some((l) => l.message === "hold_cancel_failed"), false);
  assert.equal(kit.alerts.some((a) => a.subject === `Hold ${r.reservationID} could not be cancelled`), false);
  assert.deepEqual(await kit.deps.kv.zrangeByScore(keys.holdIndex(), 0, Number.MAX_SAFE_INTEGER, 10), [], "out of the open-holds index");
  assert.equal(stripePosts(kit), 0);
  const retry = await runCheckout(body, kit.checkoutDeps());
  assert.equal(retry.status, 200, JSON.stringify(retry.body));

  // Any other release (sweeper, expired session, abandon) still reads first: a failed read cancels nothing.
  const kit2 = makeKit();
  const held = await checkout(kit2);
  assert.equal(held.status, 200);
  const id = (held.body as CheckoutSuccess).holdReservationId!;
  const puts = kit2.fakeCb.count("putReservation");
  kit2.fakeCb.failNext("getReservation", "http500");
  await assert.rejects(releaseHold(id, kit2.deps, "sweeper: stale hold"), /getReservation/);
  assert.equal(kit2.fakeCb.count("putReservation"), puts, "nothing sent");
  assert.equal(kit2.fakeCb.reservations.get(id)!.status, "not_confirmed");
  assert.equal(kit2.logs.some((l) => l.message === "release_read_failed_cancel_anyway"), false);
});

test("one failed folio read is read again (a GET is never ambiguous): the booking goes ahead on ONE hold; no second read without the time for it", async () => {
  const kit = makeKit();
  const body = await pricedBody(kit);
  kit.fakeCb.failNext("getReservation", "http500");
  const res = await runCheckout(body, kit.checkoutDeps());
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(kit.fakeCb.count("postReservation"), 1, "one hold, never created twice");
  assert.equal(kit.fakeCb.count("getReservation"), 2);
  assert.notEqual([...kit.fakeCb.reservations.values()][0].status, "canceled");
  assert.equal(stripePosts(kit), 1);
  assert.ok(kit.logs.some((l) => l.message === "hold_folio_read_retry"));
  assert.equal(kit.alerts.some((a) => a.subject === "Booking stopped: Cloudbeds returned no price for the hold"), false);

  // postReservation leaves 9 s and the failed read takes 1 s: too little for a second read AND the Stripe call or a cancel.
  const kit2 = makeKit();
  const body2 = await pricedBody(kit2);
  const wall = { ms: 1_000_000 };
  kit2.fakeCb.failNext("postReservation", "pass", undefined, () => {
    wall.ms += 16_000;
  });
  kit2.fakeCb.failNext("getReservation", "http500", undefined, () => {
    wall.ms += 1_000;
  });
  const late = await runCheckout(body2, { ...kit2.checkoutDeps(), clock: () => wall.ms, deadlineMs: wall.ms + 25_000 });
  assert.ok(25_000 - 17_000 < FOLIO_CHECK_MIN_REMAINING_MS + FOLIO_RETRY_PAUSE_MS);
  assert.equal(late.status, 502);
  assert.equal(kit2.fakeCb.count("getReservation"), 2, "the failed read and the cancel's own read: no retry");
  assert.equal(kit2.logs.some((l) => l.message === "hold_folio_read_retry"), false);
  assert.equal([...kit2.fakeCb.reservations.values()][0].status, "canceled");
  assert.equal(stripePosts(kit2), 0);
});

test("a hanging folio read is cut short so the hold can still be cancelled before the deadline", async () => {
  const kit = makeKit();
  const body = await pricedBody(kit);
  // The first getReservation (the folio read) never answers: only its timeout ends it.
  let hung = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/getReservation?") && hung++ === 0) {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    }
    return kit.fakeCb.fetch(input, init);
  }) as typeof fetch;
  kit.deps.writer = createCloudbedsWriter({ apiKey: "cbat_write_testkit", propertyId: "235064", mode: kit.deps.writer.mode, fetchImpl, budget: null, log: kit.deps.log, sleep: async () => undefined });
  let offset = 0;
  const clock = () => Date.now() + offset;
  const deadlineMs = clock() + 25_000;
  // postReservation leaves 8.3 s: enough to start the read, which is then bounded so the cancel still fits.
  kit.fakeCb.failNext("postReservation", "pass", undefined, () => {
    offset = deadlineMs - Date.now() - 8_300;
  });
  const res = await runCheckout(body, { ...kit.checkoutDeps(), clock, deadlineMs });
  assert.equal(res.status, 502);
  assert.ok(kit.logs.some((l) => l.message === "hold_folio_read_failed"));
  assert.equal(kit.logs.some((l) => l.message === "hold_cancel_failed"), false, "the cancel had time left");
  assert.equal([...kit.fakeCb.reservations.values()][0].status, "canceled");
  assert.equal(stripePosts(kit), 0);
  assert.ok(clock() < deadlineMs, "answered before the deadline");
});

test("hold_created logs Cloudbeds' own dateCreated (no personal data) to calibrate its clock", async () => {
  const kit = makeKit();
  assert.equal((await checkout(kit)).status, 200);
  const created = kit.logs.find((l) => l.message === "hold_created");
  assert.equal(created?.data?.cloudbedsDateCreated, "2026-10-05 10:00:00", "the fake stamps Bangkok time");
});

test("getReservation reads subTotal / additionalItems / taxesFees (object or array) and the source", async () => {
  assert.deepEqual(readBalanceDetailed([{ subTotal: 100, additionalItems: "5.00", taxesFees: 1, grandTotal: 106, paid: 0 }, { subTotal: "50.50", additionalItems: 0, taxesFees: 0, grandTotal: 50.5, paid: 0 }]), {
    paid: 0,
    grandTotal: 15_650,
    subTotal: 15_050,
    additionalItems: 500,
    taxesFees: 100,
  });
  const data = { reservationID: "1", status: "not_confirmed", source: "Own website", sourceID: "s-41-1", balanceDetailed: { subTotal: "27,000.00", additionalItems: 0, taxesFees: "1350.00", grandTotal: 28350, paid: 0 } };
  const w = createCloudbedsWriter({ apiKey: "k", propertyId: "1", fetchImpl: (async () => Response.json({ success: true, data })) as unknown as typeof fetch, budget: null });
  const r = await w.getReservation("1");
  assert.deepEqual([r.subTotalSatang, r.additionalItemsSatang, r.taxesFeesSatang, r.grandTotalSatang, r.source, r.sourceId], [ROOMS, 0, FEE, ROOMS + FEE, "Own website", "s-41-1"]);
});

/* ------------- A2: a paid booking whose payment record is refused ------------- */

test("Cloudbeds refuses the payment record (method deactivated): CRITICAL at once naming the variable, never cancelled, claim cleared; fixed -> the sweeper confirms with ONE payment", async () => {
  const methods = FAKE_PAYMENT_METHODS.filter((m) => m.method !== "Stripe(website)");
  const kit = makeKit({ cb: { paymentMethods: methods } });
  const { sessionId, reservationId, ref } = await paidSession(kit);
  const { payload, header } = kit.fakeStripe.signedEvent("checkout.session.completed", sessionId);
  assert.equal((await handleStripeWebhook(payload, header, kit.deps, { nowMs: NOW })).status, 500);

  const urgent = kit.alerts.filter((a) => a.subject === `URGENT: paid booking ${ref}: Cloudbeds refused to record the payment`);
  assert.equal(urgent.length, 1, "at once, not after the 2 h escalation");
  assert.equal(urgent[0].severity, "critical");
  const text = urgent[0].lines.join(" ");
  assert.match(text, new RegExp(`Cloudbeds reservation ${reservationId}\\) was PAID via Stripe \\(THB 28350\\.00`));
  assert.match(text, /Invalid payment type/);
  assert.match(text, /Payment method sent: "Stripe\(website\)", from CLOUDBEDS_STRIPE_PAYMENT_METHOD/);
  assert.match(text, /Do NOT cancel this reservation: the guest has paid/);
  assert.match(text, /fix the value and redeploy \(the sweeper then records the payment and confirms the booking\)/);
  assert.match(text, /record the FULL amount THB 28350\.00 \(rooms \+ fee\) once on the folio by hand/);
  assert.match(text, /never both/);
  // Retries continue after the alert: the folio is checked first, so an automatic record is never doubled by hand.
  assert.match(
    text,
    /First open the folio: .*keep retrying, so if a Stripe payment of THB 28350\.00 is already listed, it was recorded automatically after this alert - do not add it again, only confirm the reservation if it is not Confirmed yet\. Otherwise EITHER fix/,
  );
  assert.equal(kit.alerts.some((a) => a.subject.includes("not yet confirmed in Cloudbeds (retrying)")), false, "no warning on top");
  const r = kit.fakeCb.reservations.get(reservationId)!;
  assert.equal(r.status, "not_confirmed", "never cancelled");
  assert.equal(r.payments.length, 0);
  assert.equal(await kit.deps.kv.get(keys.fulfilStep(sessionId, "payment-attempt")), null, "refused outright: the next retry may post at once");

  // A retry within the alert window does not mail again.
  assert.equal((await handleStripeWebhook(payload, header, kit.deps, { nowMs: NOW })).status, 500);
  assert.equal(kit.alerts.filter((a) => a.subject === urgent[0].subject).length, 1);

  // The method is active again (or the env value fixed): the sweeper records it once and confirms.
  methods.push({ method: "Stripe(website)", code: "Stripe(website)", name: "Stripe (website)" });
  const s = await runSweep(kit.deps);
  assert.equal(s.fulfilled, 1);
  assert.equal(r.status, "confirmed");
  assert.equal(r.payments.length, 1);
  assert.equal(r.payments[0].type, "Stripe(website)");
  assert.equal(kit.fakeCb.balance(reservationId), 0);
});

test("a method that became unusable after the hold: nothing is sent, CRITICAL at once; other failures stay a warning", async () => {
  const kit = makeKit();
  const { sessionId, ref } = await paidSession(kit);
  kit.deps.config = getBookingConfig({ ...STRIPE_TEST_ENV, CLOUDBEDS_STRIPE_PAYMENT_METHOD: undefined });
  const { payload, header } = kit.fakeStripe.signedEvent("checkout.session.completed", sessionId);
  assert.equal((await handleStripeWebhook(payload, header, kit.deps, { nowMs: NOW })).status, 500);
  assert.equal(kit.fakeCb.count("postPayment"), 0, "nothing sent");
  assert.equal(await kit.deps.kv.get(keys.fulfilStep(sessionId, "payment-attempt")), null, "nothing claimed");
  const urgent = kit.alerts.find((a) => a.subject === `URGENT: paid booking ${ref}: Cloudbeds refused to record the payment`);
  assert.equal(urgent?.severity, "critical");
  assert.match(urgent?.lines.join(" ") ?? "", /Payment method sent: none, from CLOUDBEDS_STRIPE_PAYMENT_METHOD.*\. CLOUDBEDS_STRIPE_PAYMENT_METHOD is not set/);

  // A Cloudbeds blip on the confirm step is not a payment refusal: the usual warning (escalated after 2 h).
  const kit2 = makeKit();
  const b = await paidSession(kit2);
  kit2.fakeCb.failNext("putReservation", "http500");
  await assert.rejects(fulfilSession(b.sessionId, kit2.deps));
  const ev = kit2.fakeStripe.signedEvent("checkout.session.completed", b.sessionId);
  kit2.fakeCb.failNext("putReservation", "http500");
  assert.equal((await handleStripeWebhook(ev.payload, ev.header, kit2.deps, { nowMs: NOW })).status, 500);
  assert.deepEqual(
    kit2.alerts.filter((a) => a.subject.includes(b.ref)).map((a) => a.severity),
    ["warning"],
  );
  // The warning staff get for a PAID booking names it: ref, Cloudbeds reservation and amount.
  const warn = kit2.alerts.find((a) => a.subject.includes(b.ref))!;
  assert.equal(warn.subject, `Paid booking ${b.ref} not yet confirmed in Cloudbeds (retrying)`);
  assert.match(warn.lines.join(" "), new RegExp(`Booking ${b.ref} \\(Cloudbeds reservation ${b.reservationId}, THB 28350\\.00, Stripe session ${b.sessionId}\\) is PAID`));
  assert.match(warn.lines.join(" "), /Do NOT cancel/);
});

test("postPayment refused with HTTP 403 (e.g. no write:payment scope): CRITICAL at once with the scope hint, never cancelled, claim cleared; a 5xx or a lasting 429 stays the warning", async () => {
  const kit = makeKit();
  const { sessionId, reservationId, ref } = await paidSession(kit);
  kit.fakeCb.failNext("postPayment", "http403");
  const { payload, header } = kit.fakeStripe.signedEvent("checkout.session.completed", sessionId);
  assert.equal((await handleStripeWebhook(payload, header, kit.deps, { nowMs: NOW })).status, 500);
  const urgent = kit.alerts.filter((a) => a.subject === `URGENT: paid booking ${ref}: Cloudbeds refused to record the payment`);
  assert.equal(urgent.length, 1, "at once, not after the 2 h escalation");
  assert.equal(urgent[0].severity, "critical");
  assert.match(urgent[0].lines.join(" "), /Forbidden/);
  assert.match(urgent[0].lines.join(" "), /for HTTP 401\/403, check the booking key's write:payment scope instead/);
  assert.equal(kit.alerts.some((a) => a.subject.includes("not yet confirmed in Cloudbeds (retrying)")), false, "no warning on top");
  const r = kit.fakeCb.reservations.get(reservationId)!;
  assert.equal(r.status, "not_confirmed", "never cancelled");
  assert.equal(r.payments.length, 0);
  assert.equal(await kit.deps.kv.get(keys.fulfilStep(sessionId, "payment-attempt")), null, "refused outright: the next retry may post at once");

  // Not refusals: a 5xx (it may have landed) and a 429 still there after the retries.
  for (const [kind, times] of [["http500", 1], ["rate_limit", 4]] as const) {
    const kit2 = makeKit();
    const b = await paidSession(kit2);
    for (let i = 0; i < times; i++) kit2.fakeCb.failNext("postPayment", kind);
    const ev = kit2.fakeStripe.signedEvent("checkout.session.completed", b.sessionId);
    assert.equal((await handleStripeWebhook(ev.payload, ev.header, kit2.deps, { nowMs: NOW })).status, 500);
    assert.equal(kit2.fakeCb.count("postPayment"), times, kind);
    assert.deepEqual(
      kit2.alerts.filter((a) => a.subject.includes(b.ref)).map((a) => [a.subject, a.severity]),
      [[`Paid booking ${b.ref} not yet confirmed in Cloudbeds (retrying)`, "warning"]],
      kind,
    );
  }
});

test("part of the payment recorded by hand before we post: needs attention (critical), the full total is NOT posted on top", async () => {
  const methods = FAKE_PAYMENT_METHODS.filter((m) => m.method !== "Stripe(website)");
  const kit = makeKit({ cb: { paymentMethods: methods } });
  const { sessionId, reservationId, ref } = await paidSession(kit);
  const { payload, header } = kit.fakeStripe.signedEvent("checkout.session.completed", sessionId);
  assert.equal((await handleStripeWebhook(payload, header, kit.deps, { nowMs: NOW })).status, 500);
  // Staff record the rooms only (not the fee) by hand; then the method is fixed and the sweeper runs.
  await kit.deps.writer.recordPayment({ reservationId, amountSatang: ROOMS, method: "cash", description: "front desk" });
  methods.push({ method: "Stripe(website)", code: "Stripe(website)", name: "Stripe (website)" });
  await runSweep(kit.deps);

  const r = kit.fakeCb.reservations.get(reservationId)!;
  assert.equal(r.payments.length, 1, "only the manual entry: nothing counted twice");
  assert.notEqual(r.status, "canceled");
  const attention = kit.alerts.find((a) => a.subject === `URGENT: paid booking ${ref} needs attention`);
  assert.equal(attention?.severity, "critical");
  assert.match(attention?.lines[0] ?? "", /^PART OF THE PAYMENT IS ALREADY ON THE FOLIO: .* shows THB 27000\.00 paid of the THB 28350\.00 .*add the missing THB 1350\.00/);
  // Later runs read the done marker: still nothing posted.
  assert.equal((await fulfilSession(sessionId, kit.deps)).state, "needs_attention");
  await runSweep(kit.deps);
  assert.equal(r.payments.length, 1);
});

test("needs attention while the fee line is not confirmed (postCustomItem failed or got no clear answer): the fee is tried once more first; still not confirmed -> the alert says to check the folio and add it only if missing", async () => {
  const missingFee =
    /ALSO: adding the "Payment processing fee" item \(THB 1350\.00\) to the folio failed or got no clear answer\. Open the folio: if no "Payment processing fee" line of THB 1350\.00 is listed, add it once as an item by hand \(otherwise the folio keeps a credit of that amount\); if it is listed, do not add it again\./;
  // The webhook's try, the sweeper's try, then the retry before needs_attention: all refused; the retry lands;
  // or the sweeper's try added the item but its answer was lost (a timeout) and the retry in that run failed.
  // (An item already on the folio when a run starts is never posted again: see the "added by hand" test below.)
  for (const tries of [
    ["rejected", "rejected", "rejected"],
    ["rejected", "rejected"],
    ["rejected", "network_after", "rejected"],
  ] as const) {
    const methods = FAKE_PAYMENT_METHODS.filter((m) => m.method !== "Stripe(website)");
    const kit = makeKit({ cb: { paymentMethods: methods } });
    const { sessionId, reservationId, ref } = await paidSession(kit);
    for (const kind of tries) kit.fakeCb.failNext("postCustomItem", kind, "Access denied (write:item)");
    const { payload, header } = kit.fakeStripe.signedEvent("checkout.session.completed", sessionId);
    assert.equal((await handleStripeWebhook(payload, header, kit.deps, { nowMs: NOW })).status, 500);
    await kit.deps.writer.recordPayment({ reservationId, amountSatang: ROOMS, method: "cash", description: "front desk" });
    methods.push({ method: "Stripe(website)", code: "Stripe(website)", name: "Stripe (website)" });
    await runSweep(kit.deps);

    assert.equal((await fulfilSession(sessionId, kit.deps)).state, "needs_attention");
    assert.equal(kit.fakeCb.count("postCustomItem"), 3, tries.join());
    const r = kit.fakeCb.reservations.get(reservationId)!;
    assert.equal(r.payments.length, 1, "only the manual entry");
    const reason = kit.alerts.find((a) => a.subject === `URGENT: paid booking ${ref} needs attention`)?.lines[0] ?? "";
    assert.match(reason, /^PART OF THE PAYMENT IS ALREADY ON THE FOLIO: /);
    if (tries.length === 2) {
      assert.equal(r.items.length, 1, "the retry landed");
      assert.doesNotMatch(reason, /ALSO:|failed or got no clear answer/);
    } else {
      // Item absent (all refused) or present (landed unseen): either way the owner checks before adding it,
      // and is never told flatly that it is missing - adding it again would put the fee on the folio twice.
      assert.equal(r.items.length, tries[1] === "network_after" ? 1 : 0, tries.join());
      assert.match(reason, missingFee);
      assert.doesNotMatch(reason, /NOT on the folio/);
    }
  }

  // The same before a PAYMENT RECORD IN DOUBT (an unclear postPayment, then a folio whose paid amount can't be read).
  const kit = makeKit();
  const { sessionId } = await paidSession(kit);
  for (let i = 0; i < 3; i++) kit.fakeCb.failNext("postCustomItem", "rejected", "Access denied (write:item)");
  kit.fakeCb.failNext("postPayment", "network_after");
  await assert.rejects(fulfilSession(sessionId, kit.deps));
  kit.fakeCb.setOpaqueFolio(true);
  const out = await fulfilSession(sessionId, kit.deps);
  assert.equal(kit.fakeCb.count("postCustomItem"), 3);
  assert.match(out.state === "needs_attention" ? out.reason : "", new RegExp(`^PAYMENT RECORD IN DOUBT: .* ${missingFee.source}`));
});

test("fee line added but its answer lost, then the retry fails: confirmed, and the 'fee line is missing' alert says to check the folio first, never to add it unconditionally", async () => {
  const kit = makeKit();
  const { sessionId, reservationId, ref } = await paidSession(kit);
  kit.fakeCb.failNext("postCustomItem", "network_after"); // step 5: the item IS added, the answer is lost
  kit.fakeCb.failNext("postCustomItem", "http500"); // the retry after confirming fails before the referenceID dedupe answers
  assert.equal((await fulfilSession(sessionId, kit.deps)).state, "confirmed");
  const r = kit.fakeCb.reservations.get(reservationId)!;
  assert.equal(r.items.length, 1, "the fee line is on the folio");
  assert.equal(kit.fakeCb.balance(reservationId), 0, "the folio balances: adding the fee by hand would make the guest owe it again");
  const alert = kit.alerts.find((a) => a.subject === `Booking ${ref}: the processing fee line is missing in Cloudbeds`);
  assert.equal(alert?.severity, "warning");
  const text = alert?.lines.join(" ") ?? "";
  assert.match(
    text,
    /and confirmed, but adding the "Payment processing fee" item \(THB 1350\.00\) to the folio failed or got no clear answer\. Open the folio: if no "Payment processing fee" line of THB 1350\.00 is listed, add it once as an item by hand \(otherwise the folio keeps a credit of that amount\); if it is listed, do not add it again\./,
  );
  assert.match(text, /If this repeats, check that the booking API key has the write:item scope\./);
  assert.doesNotMatch(text, /so the folio shows a credit|Add the fee as an item on the folio by hand/);
});

test("both writes refused, the owner records the full amount by hand and confirms; Cloudbeds recovers: the retry adds the fee line once - and posts NONE when the owner also added it by hand", async () => {
  const feeWhileRetrying =
    /If the "Payment processing fee" line is not on the folio yet, recording the full amount leaves a credit equal to that fee: this is expected while the booking is still being retried\. Do NOT add the "Payment processing fee" line by hand: it is added automatically once Cloudbeds accepts it, and "the processing fee line is missing" follows if it never can\./;
  for (const ownerAddsFee of [false, true]) {
    const methods = FAKE_PAYMENT_METHODS.filter((m) => m.method !== "Stripe(website)");
    const kit = makeKit({ cb: { paymentMethods: methods } });
    const { sessionId, reservationId, ref } = await paidSession(kit);
    kit.fakeCb.failNext("postCustomItem", "rejected", "Access denied (write:item)");
    const { payload, header } = kit.fakeStripe.signedEvent("checkout.session.completed", sessionId);
    assert.equal((await handleStripeWebhook(payload, header, kit.deps, { nowMs: NOW })).status, 500);
    const urgent = kit.alerts.find((a) => a.subject === `URGENT: paid booking ${ref}: Cloudbeds refused to record the payment`);
    assert.match(urgent?.lines.join(" ") ?? "", feeWhileRetrying);

    // The owner settles it as told: the FULL amount once, confirmed. That leaves a credit of the missing fee...
    const r = kit.fakeCb.reservations.get(reservationId)!;
    await kit.deps.writer.recordPayment({ reservationId, amountSatang: ROOMS + FEE, method: "cash", description: "front desk" });
    await kit.deps.writer.confirm(reservationId, false);
    assert.equal(kit.fakeCb.balance(reservationId), -1350);
    // ...which the owner may "fix" by adding the fee item by hand (it has no referenceID of ours).
    if (ownerAddsFee) r.items.push({ referenceID: null, itemPrice: 1350, itemName: "Payment processing fee" });

    methods.push({ method: "Stripe(website)", code: "Stripe(website)", name: "Stripe (website)" });
    assert.equal((await runSweep(kit.deps)).fulfilled, 1, String(ownerAddsFee));
    assert.equal((await fulfilSession(sessionId, kit.deps)).state, "confirmed");
    assert.equal(r.status, "confirmed");
    assert.equal(r.payments.length, 1, "only the manual payment");
    assert.equal(r.items.length, 1, "exactly one fee line");
    assert.equal(kit.fakeCb.balance(reservationId), 0);
    assert.equal(kit.fakeCb.count("postCustomItem"), ownerAddsFee ? 1 : 2, "nothing posted on top of the owner's item");
    assert.equal(kit.alerts.some((a) => /balance is not zero|fee line is missing/.test(a.subject)), false);
    const skipped = kit.alerts.filter((a) => a.subject === `Booking ${ref}: the processing fee line was not added (the folio already has items)`);
    const booked = kit.alerts.find((a) => a.subject.startsWith(`New direct booking ${ref} confirmed`));
    if (ownerAddsFee) {
      assert.equal(skipped.length, 1);
      assert.equal(skipped[0].severity, "warning");
      assert.match(skipped[0].lines[0], /already carried additional items of THB 1350\.00 before we added our "Payment processing fee" line \(THB 1350\.00\), so we did NOT add it/);
      assert.match(skipped[0].lines[1], /exactly one "Payment processing fee" line of THB 1350\.00 should be listed\. If none is, add it once by hand; if there are two, remove one\./);
      assert.match(booked?.lines[1] ?? "", /; the payment is on the folio/);
    } else {
      assert.deepEqual(skipped, [], "a folio with no additional items gets its fee line");
      assert.equal(r.items[0].referenceID, `${ref}-fee`);
      assert.match(booked?.lines[1] ?? "", /the payment and the fee line are on the folio/);
    }
  }
});

/* ------------------------- A5: fulfil's last resort ------------------------- */

test("Cloudbeds taxes/fees on a PAID folio (added after the hold): confirmed, with a specific 'pay twice' alert", async () => {
  const kit = makeKit();
  const { sessionId, reservationId, ref } = await paidSession(kit);
  kit.fakeCb.reservations.get(reservationId)!.taxesFees = 1350; // e.g. staff edited the stay under a source with the 5% fee
  assert.equal((await fulfilSession(sessionId, kit.deps)).state, "confirmed");
  const alert = kit.alerts.find((a) => a.subject === `Booking ${ref}: Cloudbeds added taxes/fees on top of our fee line`);
  assert.equal(alert?.severity, "warning");
  assert.match(alert?.lines[0] ?? "", /Cloudbeds taxes\/fees of THB 1350\.00 on top of our "Payment processing fee" line \(balance THB 1350\.00\)\. The guest may be asked to pay twice\./);
  assert.match(alert?.lines[1] ?? "", /negative Adjustment/);
  assert.match(alert?.lines[1] ?? "", /CLOUDBEDS_SOURCE_ID is not set/);
  assert.equal(kit.alerts.some((a) => a.subject.includes("balance is not zero")), false, "the specific alert replaces the generic one");
});

test("a negative balance after payment (rate lowered after the hold) is reported, never a crash", async () => {
  const kit = makeKit();
  const { sessionId, reservationId, ref } = await paidSession(kit);
  kit.fakeCb.reservations.get(reservationId)!.subTotal -= 100;
  assert.equal((await fulfilSession(sessionId, kit.deps)).state, "confirmed");
  const alert = kit.alerts.find((a) => a.subject === `Booking ${ref}: Cloudbeds balance is not zero after payment`);
  assert.match(alert?.lines[0] ?? "", /a balance of -THB 100\.00/);
});

test("the reservation is not filed under CLOUDBEDS_SOURCE_ID: one deduplicated warning, the booking goes ahead (s-N and s-N-1 are the same source)", async () => {
  const kit = makeKit({ env: { ...STRIPE_TEST_ENV, CLOUDBEDS_SOURCE_ID: "s-41" } });
  const a = await paidSession(kit);
  kit.fakeCb.reservations.get(a.reservationId)!.sourceID = null; // Cloudbeds ignored it: the default source
  assert.equal((await fulfilSession(a.sessionId, kit.deps)).state, "confirmed");
  const b = await paidSession(kit, GARDEN);
  kit.fakeCb.reservations.get(b.reservationId)!.sourceID = "s-41-1"; // the FAQ's spelling of the same source
  assert.equal((await fulfilSession(b.sessionId, kit.deps)).state, "confirmed");
  const mismatch = kit.alerts.filter((x) => x.subject === "Online bookings are not filed under source s-41");
  assert.equal(mismatch.length, 1);
  // The alert key is shared (a wrong second alert would be suppressed): booking b is checked on its own log line.
  const mismatchLogs = kit.logs.filter((l) => l.message === "fulfil_source_mismatch");
  assert.deepEqual(mismatchLogs.map((l) => l.data?.ref), [a.ref], "s-41-1 is the same source as s-41: only booking a");
  assert.match(mismatch[0].lines[0], new RegExp(`Booking ${a.ref}: Cloudbeds reservation ${a.reservationId} has source Website / Booking engine \\(s-1\\)`));
  assert.equal(kit.fakeCb.reservations.get(a.reservationId)!.status, "confirmed");
});

/* ------------------ A6: late arrival and requests reach staff ------------------ */

test("session metadata carries yes/no guest flags only; old sessions without them still parse (unknown)", () => {
  const base = { ref: "MSV-20261005-ABCD", reservationId: "123", roomsSatang: 1000, feeSatang: 50, totalSatang: 1050, checkIn: "2027-11-10", checkOut: "2027-11-12", mode: "stripe-test" };
  const md = sessionMetadata({ ...base, arrivalLate: true, hasRequests: false, noteSaved: false });
  assert.deepEqual([md.msv_arrival_late, md.msv_has_requests, md.msv_note_saved], ["1", "0", "0"]);
  const parsed = parseSessionMeta({ metadata: md, client_reference_id: base.ref });
  assert.deepEqual([parsed?.arrivalLate, parsed?.hasRequests, parsed?.noteSaved], [true, false, false]);
  const old = sessionMetadata(base);
  assert.equal("msv_note_saved" in old, false);
  const parsedOld = parseSessionMeta({ metadata: old, client_reference_id: base.ref });
  assert.equal(parsedOld?.totalSatang, 1050);
  assert.deepEqual([parsedOld?.arrivalLate, parsedOld?.hasRequests, parsedOld?.noteSaved], [null, null, null]);
  assert.equal(parseSessionMeta({ metadata: { ...md, msv_note_saved: "yes" }, client_reference_id: base.ref })?.noteSaved, null);
});

test("late arrival + requests whose pre-payment note failed: flags in the metadata (no text), no alert at hold time, the PAID booking gets the note line and ONE alert for the requests", async () => {
  const kit = makeKit();
  const requests = "Quiet room please, we land at 01:30";
  kit.fakeCb.failNext("postReservationNote", "rejected", "Note could not be saved");
  const res = await checkout(kit, HONEYMOON, { guest: { ...GUEST, arrivalTime: "late", specialRequests: requests } } as never);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  const sessionId = sessionIdOf(body);
  const s = kit.fakeStripe.session(sessionId)!;
  assert.deepEqual([s.metadata.msv_arrival_late, s.metadata.msv_has_requests, s.metadata.msv_note_saved], ["1", "1", "0"]);
  assert.equal(s.payment_intent_metadata.msv_note_saved, "0");
  const metaText = JSON.stringify(s.metadata) + JSON.stringify(s.payment_intent_metadata);
  for (const pii of ["Quiet room", "01:30", GUEST.email, GUEST.lastName]) assert.equal(metaText.includes(pii), false, `metadata leaks ${pii}`);
  const missing = () => kit.alerts.filter((a) => a.subject === `Booking ${body.ref}: the guest's arrival time / requests are missing in Cloudbeds`);
  assert.equal(missing().length, 0, "no alert for an unpaid hold");

  kit.fakeStripe.complete(sessionId);
  assert.equal((await fulfilSession(sessionId, kit.deps)).state, "confirmed");
  const notes = kit.fakeCb.reservations.get(body.holdReservationId!)!.notes;
  const paidNote = notes.find((n) => n.includes("PAID via Stripe"));
  assert.match(paidNote ?? "", /\nEstimated arrival: after midnight\.$/);
  assert.equal(missing().length, 1);
  assert.equal(missing()[0].severity, "warning");
  assert.equal(
    missing()[0].lines[0],
    `Booking ${body.ref} (reservation ${body.holdReservationId}): the guest's arrival time / special requests could not be saved before payment - ask the guest on WhatsApp.`,
  );
  assert.equal(missing()[0].lines[1], "Missing: special requests.", "the late arrival is on the PAID note");
  const alertText = JSON.stringify(kit.alerts);
  for (const pii of ["Quiet room", "01:30", GUEST.email, GUEST.lastName, GUEST.firstName]) assert.equal(alertText.includes(pii), false, `alert leaks ${pii}`);
  await fulfilSession(sessionId, kit.deps);
  assert.equal(missing().length, 1, "once");
});

test("the note failed with only ONE of the two: requests alone get the alert; after midnight alone is on the PAID note (no alert) unless that note fails too", async () => {
  const late = { ...GUEST, arrivalTime: "late", specialRequests: "" };
  for (const { name, guest, flags, paidNoteFails, line, lateLine } of [
    { name: "late, PAID note saved", guest: late, flags: ["1", "0", "0"], paidNoteFails: false, line: null, lateLine: true },
    { name: "late, PAID note failed", guest: late, flags: ["1", "0", "0"], paidNoteFails: true, line: "Missing: arrival after midnight.", lateLine: false },
    { name: "requests", guest: GUEST, flags: ["0", "1", "0"], paidNoteFails: false, line: "Missing: special requests.", lateLine: false },
  ]) {
    const kit = makeKit();
    kit.fakeCb.failNext("postReservationNote", "rejected", "Note could not be saved");
    const res = await checkout(kit, HONEYMOON, { guest } as never);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const body = res.body as CheckoutSuccess;
    const sessionId = sessionIdOf(body);
    const s = kit.fakeStripe.session(sessionId)!;
    assert.deepEqual([s.metadata.msv_arrival_late, s.metadata.msv_has_requests, s.metadata.msv_note_saved], flags);
    kit.fakeStripe.complete(sessionId);
    if (paidNoteFails) kit.fakeCb.failNext("postReservationNote", "rejected", "Note could not be saved");
    assert.equal((await fulfilSession(sessionId, kit.deps)).state, "confirmed");
    const missing = kit.alerts.filter((a) => a.subject === `Booking ${body.ref}: the guest's arrival time / requests are missing in Cloudbeds`);
    assert.deepEqual(missing.map((a) => a.lines[1]), line === null ? [] : [line], name);
    const paidNote = kit.fakeCb.reservations.get(body.holdReservationId!)!.notes.find((n) => n.includes("PAID via Stripe")) ?? "";
    assert.equal(paidNote.endsWith("\nEstimated arrival: after midnight."), lateLine, name);
  }
});

test("note saved -> no alert; an OLD session without the flags -> no alert and no extra note line", async () => {
  const kit = makeKit();
  const ok = await paidSession(kit); // GUEST: 15:00 arrival, has requests, note saved
  const s = kit.fakeStripe.session(ok.sessionId)!;
  assert.deepEqual([s.metadata.msv_arrival_late, s.metadata.msv_has_requests, s.metadata.msv_note_saved], ["0", "1", "1"]);
  assert.equal((await fulfilSession(ok.sessionId, kit.deps)).state, "confirmed");
  assert.equal(kit.alerts.some((a) => a.subject.includes("missing in Cloudbeds")), false);

  const kit2 = makeKit();
  kit2.fakeCb.failNext("postReservationNote", "rejected", "Note could not be saved");
  const res = await checkout(kit2, HONEYMOON, { guest: { ...GUEST, arrivalTime: "late" } } as never);
  const body = res.body as CheckoutSuccess;
  const sessionId = sessionIdOf(body);
  const old = kit2.fakeStripe.session(sessionId)!;
  for (const k of ["msv_arrival_late", "msv_has_requests", "msv_note_saved"]) delete old.metadata[k];
  kit2.fakeStripe.complete(sessionId);
  assert.equal((await fulfilSession(sessionId, kit2.deps)).state, "confirmed");
  assert.equal(kit2.alerts.some((a) => a.subject.includes("missing in Cloudbeds")), false);
  assert.doesNotMatch(kit2.fakeCb.reservations.get(body.holdReservationId!)!.notes.join("\n"), /PAID via Stripe.*\n.*after midnight/);
});

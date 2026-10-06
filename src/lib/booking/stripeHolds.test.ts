// Hold safety (fix round 1): hold intents + orphan recovery, our own
// checkouts never double-booking a unit, the sweeper's own age check, mode
// tags, staff-confirmed holds, failure alerts, the Stage B staff key, the
// drain path after a provider switch, and the fee line never blocking a
// confirmation. All against the in-repo fakes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runAbandon } from "./abandon.ts";
import { runCheckout } from "./checkout.ts";
import { BookingConfigError, getBookingConfig, getStripeDrainConfig, stripeLiveBlockers } from "./config.ts";
import { fulfilSession, releaseHold, releaseSession } from "./fulfil.ts";
import type { KvStore } from "./kv.ts";
import { holdIdentifier, keyScope, keys, parseHoldIdentifier, readJson, recordHold } from "./lock.ts";
import type { HoldRecord } from "./lock.ts";
import { runStatus } from "./status.ts";
import { MAX_HOLDS_PER_CLIENT, MAX_OPEN_HOLDS, isAvailabilityRefusal, testModeRefusal } from "./stripeCheckout.ts";
import { handleStripeWebhook, BAD_SIGNATURE_ALERT_THRESHOLD } from "./stripeWebhook.ts";
import { STALE_HOLD_MS, runSweep } from "./sweep.ts";
import { hasTestAccess, readCookie, testAccessCookieValue, testAccessKeyMatches } from "./testAccess.ts";
import { HONEYMOON, NOW, STRIPE_LIVE_ENV, STRIPE_TEST_ENV, TEST_ACCESS_KEY, TOKEN_SECRET, checkout, makeKit, request, serverQuote, sessionIdOf } from "./testkit.ts";
import type { Kit } from "./testkit.ts";
import type { CheckoutSuccess, StatusResponse } from "./types.ts";

const GARDEN = [{ slug: "garden-suite", ratePlanId: "standard" as const, adults: 2, addonIds: [] }];

async function pricedBody(kit: Kit, items = HONEYMOON) {
  const req = request(items);
  const quote = await serverQuote(kit, req);
  return { ...req, expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang };
}

function reservationsOf(kit: Kit) {
  return [...kit.fakeCb.reservations.values()];
}

/* ------------------------------ intents ------------------------------ */

test("postReservation times out AFTER Cloudbeds created a CONFIRMED reservation: alert, intent kept, the next stale sweep cancels it", async () => {
  const kit = makeKit(); // the fake creates API bookings as "confirmed", like many properties
  const body = await pricedBody(kit);
  kit.fakeCb.failNext("postReservation", "network_after");
  const res = await runCheckout(body, kit.checkoutDeps());
  assert.equal(res.status, 502);
  assert.equal(res.body.ok ? "" : res.body.error, "upstream_error");
  assert.equal(kit.fakeStripe.calls.filter((c) => c.method === "POST").length, 0, "no Stripe session");
  const [orphan] = reservationsOf(kit);
  assert.equal(orphan.status, "confirmed", "Cloudbeds really created it");
  assert.match(orphan.thirdPartyIdentifier ?? "", /^MSV-\d{8}-[A-Z2-9]{4}-TEST$/);
  assert.ok(kit.alerts.some((a) => a.subject.includes("outcome unknown")), "the owner hears about it");
  // The intent was written BEFORE the call and is still open.
  const open = await kit.deps.kv.zrangeByScore(keys.intentIndex(), 0, Number.MAX_SAFE_INTEGER, 10);
  assert.equal(open.length, 1);

  // A sweep right away leaves it alone (it might still be paid for... it can't, but we never act on young holds).
  const early = await runSweep(kit.deps);
  assert.equal(orphan.status, "confirmed");
  assert.equal(early.released, 0);

  kit.now.ms += STALE_HOLD_MS + 5 * 60_000;
  const swept = await runSweep(kit.deps);
  assert.equal(orphan.status, "canceled", "orphan released although it was 'confirmed'");
  assert.equal(swept.released, 1);
  assert.equal(swept.openHolds, 0);
  assert.deepEqual(await kit.deps.kv.zrangeByScore(keys.intentIndex(), 0, Number.MAX_SAFE_INTEGER, 10), [], "intent settled");
});

test("a 5xx or an id-less success on postReservation is also treated as 'maybe created' (intent kept); a refusal settles it", async () => {
  const kit = makeKit();
  const body = await pricedBody(kit);
  kit.fakeCb.failNext("postReservation", "http500");
  assert.equal((await runCheckout(body, kit.checkoutDeps())).status, 502);
  assert.equal((await kit.deps.kv.zrangeByScore(keys.intentIndex(), 0, Number.MAX_SAFE_INTEGER, 10)).length, 1);

  const kit2 = makeKit();
  const body2 = await pricedBody(kit2);
  kit2.fakeCb.failNext("postReservation", "rejected", "Room type is not available for the selected dates", () => {
    kit2.fakeCb.book("462958", "2027-11-10", "2027-11-13"); // an OTA booking took the unit a moment earlier
  });
  const refused = await runCheckout(body2, kit2.checkoutDeps());
  assert.equal(refused.status, 409);
  assert.equal(refused.body.ok ? "" : refused.body.error, "unavailable");
  assert.deepEqual(await kit2.deps.kv.zrangeByScore(keys.intentIndex(), 0, Number.MAX_SAFE_INTEGER, 10), [], "nothing was created: settled");
  assert.equal(kit2.alerts.length, 0, "a real availability refusal is not an alert");
});

test("Redis down before the hold: refused with nothing written to Cloudbeds", async () => {
  const kit = makeKit();
  const body = await pricedBody(kit);
  const broken: KvStore = { ...kit.deps.kv, zadd: async () => { throw new Error("redis down"); } };
  const res = await runCheckout(body, { ...kit.checkoutDeps(), stripe: { ...kit.deps, kv: broken } });
  assert.equal(res.status, 503);
  assert.equal(kit.fakeCb.count("postReservation"), 0);
});

test("success path: the intent is settled and the hold record carries pendingMarked", async () => {
  const kit = makeKit();
  const res = await checkout(kit);
  const body = res.body as CheckoutSuccess;
  assert.equal(res.status, 200);
  assert.deepEqual(await kit.deps.kv.zrangeByScore(keys.intentIndex(), 0, Number.MAX_SAFE_INTEGER, 10), []);
  const rec = await readJson<HoldRecord>(kit.deps.kv, keys.hold(body.holdReservationId!));
  assert.equal(rec?.pendingMarked, true);
  assert.equal(rec?.sessionId, sessionIdOf(body));
});

/* ---------------------- our own checkouts never race ---------------------- */

test("two concurrent checkouts for the LAST unit (Cloudbeds would overbook): exactly one hold, the other is told it's gone", async () => {
  const kit = makeKit({ cb: { overbook: true } });
  // Sanity: this fake really overbooks when asked directly.
  const probe = makeKit({ cb: { overbook: true } });
  const hold = { ref: "MSV-20261005-ABCD", checkIn: "2027-11-10", checkOut: "2027-11-13", rooms: [{ roomTypeId: "462958", rateId: null, adults: 2 }], guest: { firstName: "A", lastName: "B", email: "a@b.co", phone: "+1 5555555", country: "US", zip: "1" }, estimatedArrivalTime: null, paymentMethod: "credit" as const, expectedRoomsSatang: 0 };
  await probe.deps.writer.createHold(hold);
  await probe.deps.writer.createHold(hold);
  assert.equal(probe.fakeCb.count("postReservation"), 2);

  const body = await pricedBody(kit);
  const [a, b] = await Promise.all([runCheckout(body, kit.checkoutDeps()), runCheckout(body, kit.checkoutDeps())]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], JSON.stringify([a.body, b.body]));
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.body.ok ? "" : loser.body.error, "unavailable");
  assert.equal(kit.fakeCb.count("postReservation"), 1, "only one hold was ever written");
  assert.equal(reservationsOf(kit).filter((r) => r.status !== "canceled").length, 1);
});

test("a unit held by another checkout for too long -> 'try again in a minute', nothing written", async () => {
  const kit = makeKit();
  const body = await pricedBody(kit);
  await kit.deps.kv.setNx(keys.unitLock("HM"), "someone-else", 90);
  const res = await runCheckout(body, { ...kit.checkoutDeps(), unitLockWaitMs: 50 });
  assert.equal(res.status, 503);
  assert.equal(res.body.ok ? "" : res.body.error, "upstream_error");
  assert.match(res.body.ok ? "" : res.body.message, /try again in a minute/);
  assert.equal(kit.fakeCb.count("postReservation"), 0);
  assert.deepEqual(await kit.deps.kv.zrangeByScore(keys.intentIndex(), 0, Number.MAX_SAFE_INTEGER, 10), [], "attempt settled");
});

/* ------------------------- the sweeper's own age check ------------------------- */

test("sweeper never releases a FRESH hold, even when Cloudbeds lists it and no session exists yet", async () => {
  const kit = makeKit();
  const fresh = await kit.deps.writer.createHold({
    ref: "MSV-20261005-WXYZ",
    identifier: "MSV-20261005-WXYZ-TEST",
    checkIn: "2027-12-01",
    checkOut: "2027-12-02",
    rooms: [{ roomTypeId: "462958", rateId: null, adults: 2 }],
    guest: { firstName: "A", lastName: "B", email: "a@b.co", phone: "+1 5555555", country: "US", zip: "1" },
    estimatedArrivalTime: null,
    paymentMethod: "credit",
    expectedRoomsSatang: 0,
  });
  // The window between createHold and the session: a record without a session id.
  await recordHold(kit.deps.kv, { ref: "MSV-20261005-WXYZ", reservationId: fresh.reservationId, sessionId: null, createdAt: kit.now.ms, mode: kit.config.paymentMode });
  const s = await runSweep(kit.deps);
  assert.equal(kit.fakeCb.reservations.get(fresh.reservationId)?.status, "confirmed");
  assert.equal(s.released, 0);
  assert.ok(s.skippedYoung >= 1);

  // Without any record or intent of ours, Cloudbeds' creation time decides. getReservations only has the
  // property-local dateCreated (Bangkok), read as UTC: never older than it is, up to 7 h younger.
  await kit.deps.kv.del(keys.hold(fresh.reservationId));
  await kit.deps.kv.zrem(keys.holdIndex(), fresh.reservationId);
  await runSweep(kit.deps);
  assert.equal(kit.fakeCb.reservations.get(fresh.reservationId)?.status, "confirmed");

  kit.now.ms += STALE_HOLD_MS + 60_000;
  await runSweep(kit.deps);
  assert.equal(kit.fakeCb.reservations.get(fresh.reservationId)?.status, "confirmed", "cautious age: still young");

  // Old enough now - but it is CONFIRMED and we hold no record or intent of it (staff may have re-booked a
  // paid guest under the ref, or Redis lost it): never cancelled, the owner is told once.
  kit.now.ms += 7 * 3600_000;
  await runSweep(kit.deps);
  assert.equal(kit.fakeCb.reservations.get(fresh.reservationId)?.status, "confirmed", "a confirmed reservation with no record is never cancelled");
  const told = () => kit.alerts.filter((a) => a.subject.includes(`Reservation ${fresh.reservationId} carries an online-booking id we have no record of`));
  assert.equal(told().length, 1);
  await runSweep(kit.deps);
  assert.equal(told().length, 1, "told once");

  // The same orphan still "Confirmation pending" (an unpaid hold whose record was lost) is released.
  kit.fakeCb.reservations.get(fresh.reservationId)!.status = "not_confirmed";
  await runSweep(kit.deps);
  assert.equal(kit.fakeCb.reservations.get(fresh.reservationId)?.status, "canceled");
});

test("mode tags: a live sweeper never touches a -TEST hold, and a test sweeper never touches a live one", async () => {
  assert.equal(holdIdentifier("MSV-20261005-ABCD", "stripe-live"), "MSV-20261005-ABCD");
  assert.equal(holdIdentifier("MSV-20261005-ABCD", "stripe-test"), "MSV-20261005-ABCD-TEST");
  assert.deepEqual(parseHoldIdentifier("MSV-20261005-ABCD-TEST"), { ref: "MSV-20261005-ABCD", live: false });
  assert.deepEqual(parseHoldIdentifier("MSV-20261005-ABCD"), { ref: "MSV-20261005-ABCD", live: true });
  assert.equal(parseHoldIdentifier("BDC-123"), null);
  assert.equal(parseHoldIdentifier(null), null);

  const live = makeKit({ env: STRIPE_LIVE_ENV });
  const mk = (identifier: string) =>
    live.deps.writer.createHold({
      ref: identifier.slice(0, 17),
      identifier,
      checkIn: "2027-12-01",
      checkOut: "2027-12-02",
      rooms: [{ roomTypeId: "462958", rateId: null, adults: 2 }],
      guest: { firstName: "A", lastName: "B", email: "a@b.co", phone: "+1 5555555", country: "US", zip: "1" },
      estimatedArrivalTime: null,
      paymentMethod: "credit",
      expectedRoomsSatang: 0,
    });
  const testHold = await mk("MSV-20261005-TTTT-TEST");
  live.now.ms += STALE_HOLD_MS + 60_000;
  const s = await runSweep(live.deps);
  assert.equal(live.fakeCb.reservations.get(testHold.reservationId)?.status, "confirmed", "test hold untouched by the live sweeper");
  assert.ok(s.skippedOtherMode >= 1);
});

/* --------------------- release: staff-confirmed holds --------------------- */

test("a hold staff confirmed by hand (no payment) is never cancelled automatically: the owner is alerted", async () => {
  const kit = makeKit();
  const res = await checkout(kit);
  const body = res.body as CheckoutSuccess;
  const id = body.holdReservationId!;
  assert.equal(kit.fakeCb.reservations.get(id)?.status, "not_confirmed");
  kit.fakeCb.reservations.get(id)!.status = "confirmed"; // front desk confirmed it
  kit.fakeStripe.expire(sessionIdOf(body));
  const out = await releaseSession(sessionIdOf(body), kit.deps, "session expired");
  assert.equal(out.state, "refused_confirmed");
  assert.equal(kit.fakeCb.reservations.get(id)?.status, "confirmed");
  assert.ok(kit.alerts.some((a) => a.subject.includes("confirmed but unpaid")));
  // A checked-in guest is never cancelled either.
  (kit.fakeCb.reservations.get(id) as { status: string }).status = "checked_in";
  assert.equal((await releaseHold(id, kit.deps, "x")).state, "refused_confirmed");
});

/* ------------------------------ alerts ------------------------------ */

test("a non-availability refusal (setup problem) -> 'message us' + alert, never 'just booked'", async () => {
  assert.equal(isAvailabilityRefusal("Room type is not available for the selected dates"), true);
  assert.equal(isAvailabilityRefusal("No availability"), true);
  assert.equal(isAvailabilityRefusal("Parameter guestZip is required"), false);
  assert.equal(isAvailabilityRefusal("Invalid roomRateID"), false);

  const kit = makeKit();
  const body = await pricedBody(kit);
  kit.fakeCb.failNext("postReservation", "rejected", "Parameter guestZip is required");
  const res = await runCheckout(body, kit.checkoutDeps());
  assert.equal(res.status, 503);
  assert.equal(res.body.ok ? "" : res.body.error, "payment_unavailable");
  assert.doesNotMatch(res.body.ok ? "" : res.body.message, /just been booked/);
  assert.ok(kit.alerts.some((a) => a.subject.includes("Cloudbeds refused the reservation") && a.lines.join(" ").includes("guestZip")));
});

test("Stripe can't create the session -> hold cancelled AND the owner alerted with the Stripe error code (no PII)", async () => {
  const kit = makeKit();
  const body = await pricedBody(kit);
  kit.fakeStripe.failNext(/^POST \/v1\/checkout\/sessions$/, 400, "The payment method type provided: promptpay is invalid");
  const res = await runCheckout(body, kit.checkoutDeps());
  assert.equal(res.status, 502);
  assert.equal(reservationsOf(kit)[0].status, "canceled");
  const alert = kit.alerts.find((a) => a.subject.includes("Stripe could not create the payment page"));
  assert.ok(alert);
  assert.match(alert.lines.join(" "), /invalid_request_error/);
  assert.equal(JSON.stringify(kit.alerts).includes("owner-test@"), false);
});

test("a failure AFTER the session exists (Redis) expires the session and cancels the hold", async () => {
  const kit = makeKit();
  const body = await pricedBody(kit);
  let holdWrites = 0;
  const kv: KvStore = {
    ...kit.deps.kv,
    set: async (key, value, ttl) => {
      if (key.startsWith("msv:hold:") && ++holdWrites === 2) throw new Error("redis blip");
      return kit.deps.kv.set(key, value, ttl);
    },
  };
  const res = await runCheckout(body, { ...kit.checkoutDeps(), stripe: { ...kit.deps, kv } });
  assert.equal(res.status, 502);
  const [session] = [...kit.fakeStripe.sessions.values()];
  assert.equal(session.status, "expired", "the open session can never be paid");
  assert.equal(reservationsOf(kit)[0].status, "canceled");
});

test("rejected webhook signatures: one alert after a few in an hour", async () => {
  const kit = makeKit();
  const res = await checkout(kit);
  const sessionId = sessionIdOf(res.body);
  const forged = kit.fakeStripe.signedEvent("checkout.session.completed", sessionId, { secret: "whsec_wrong_0123456789" });
  for (let i = 0; i < BAD_SIGNATURE_ALERT_THRESHOLD + 2; i++) {
    assert.equal((await handleStripeWebhook(forged.payload, forged.header, kit.deps, { nowMs: NOW })).status, 400);
  }
  assert.equal(kit.alerts.filter((a) => a.subject.includes("signatures are being rejected")).length, 1);
});

test("a release that keeps failing in the webhook alerts the owner", async () => {
  const kit = makeKit();
  const res = await checkout(kit);
  const sessionId = sessionIdOf(res.body);
  kit.fakeStripe.expire(sessionId);
  kit.fakeCb.failNext("getReservation", "http500");
  const ev = kit.fakeStripe.signedEvent("checkout.session.expired", sessionId);
  assert.equal((await handleStripeWebhook(ev.payload, ev.header, kit.deps, { nowMs: NOW })).status, 500);
  assert.ok(kit.alerts.some((a) => a.subject.includes("could not be released")));
});

/* --------------------------- abuse brakes --------------------------- */

test("hold brakes: too many open holds -> refused before Cloudbeds; one client can't keep creating holds", async () => {
  const kit = makeKit();
  for (let i = 0; i < MAX_OPEN_HOLDS; i++) await kit.deps.kv.zadd(keys.holdIndex(), NOW, `fake-${i}`);
  const body = await pricedBody(kit);
  const res = await runCheckout(body, kit.checkoutDeps());
  assert.equal(res.status, 503);
  assert.equal(kit.fakeCb.count("postReservation"), 0);
  assert.ok(kit.alerts.some((a) => a.subject.includes("too many unpaid holds")));

  const kit2 = makeKit();
  const body2 = await pricedBody(kit2, GARDEN);
  const deps2 = { ...kit2.checkoutDeps(), clientIp: "203.0.113.9" };
  for (let i = 0; i < MAX_HOLDS_PER_CLIENT; i++) {
    const r = await runCheckout(body2, deps2);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await releaseHold((r.body as CheckoutSuccess).holdReservationId!, kit2.deps, "test");
  }
  const over = await runCheckout(body2, deps2);
  assert.equal(over.status, 429);
  assert.equal(kit2.fakeCb.count("postReservation"), MAX_HOLDS_PER_CLIENT);
  // The IP itself is never stored or logged.
  assert.equal(kit2.logText().includes("203.0.113.9"), false);
});

/* ------------------------- Stage B staff access ------------------------- */

test("Stage B guard: real test holds need the staff cookie too; the refusal never says what is checked", async () => {
  const kit = makeKit();
  const body = await pricedBody(kit);
  const noCookie = await runCheckout(body, { ...kit.checkoutDeps(), testAccessToken: null });
  assert.equal(noCookie.status, 403);
  const msg = noCookie.body.ok ? "" : noCookie.body.message;
  assert.doesNotMatch(msg, /email|owner|cookie|key/i);
  const wrongCookie = await runCheckout(body, { ...kit.checkoutDeps(), testAccessToken: "deadbeef" });
  assert.equal(wrongCookie.status, 403);
  assert.equal(kit.fakeCb.count("postReservation"), 0);
  assert.equal((await runCheckout(body, kit.checkoutDeps())).status, 200);

  // Without BOOKING_TEST_ACCESS_KEY every real test hold is refused.
  const unset = makeKit({ env: { ...STRIPE_TEST_ENV, BOOKING_TEST_ACCESS_KEY: undefined } });
  assert.equal((await checkout(unset)).status, 403);
  assert.equal(testModeRefusal({ guestEmail: "a@b.co", minArrivalMonths: 12, accessKey: null }, "2030-01-01", "a@b.co", "2026-10-05", true) !== null, true);

  // Cookie helpers.
  const value = testAccessCookieValue(TOKEN_SECRET, TEST_ACCESS_KEY);
  assert.equal(value.includes(TEST_ACCESS_KEY), false, "the cookie never holds the key itself");
  assert.equal(hasTestAccess(TEST_ACCESS_KEY, TOKEN_SECRET, value), true);
  assert.equal(hasTestAccess(TEST_ACCESS_KEY, "another-secret-0123456789abcdefgh", value), false);
  assert.equal(hasTestAccess(null, TOKEN_SECRET, value), false);
  assert.equal(testAccessKeyMatches(TEST_ACCESS_KEY, ` ${TEST_ACCESS_KEY} `), true);
  assert.equal(testAccessKeyMatches(TEST_ACCESS_KEY, "nope"), false);
  assert.equal(testAccessKeyMatches(null, TEST_ACCESS_KEY), false);
  assert.equal(readCookie("a=1; msv_booking_test_access=abc%20d; b=2", "msv_booking_test_access"), "abc d");
  assert.equal(readCookie(null, "x"), null);
});

/* ------------------------------ config ------------------------------ */

test("config: real Cloudbeds writes need Redis even with test keys; live needs the sweeper secret", () => {
  const noRedis = { ...STRIPE_TEST_ENV, UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined };
  assert.throws(
    () => getBookingConfig(noRedis),
    (e: unknown) => e instanceof BookingConfigError && e.code === "payment_misconfigured" && e.missing.some((m) => m.includes("Upstash")),
  );
  // The MOCK writer is fine in memory.
  assert.deepEqual(getBookingConfig({ ...noRedis, CLOUDBEDS_API_KEY_BOOKING: undefined }).cloudbedsWrite, { mode: "mock" });
  assert.ok(stripeLiveBlockers({ ...STRIPE_LIVE_ENV, BOOKING_SWEEP_SECRET: undefined }).some((m) => m.includes("SWEEP")));
  assert.deepEqual(stripeLiveBlockers({ ...STRIPE_LIVE_ENV, BOOKING_SWEEP_SECRET: undefined, CRON_SECRET: "cron-secret-0123456789" }), []);
  // Test money can go to its own Cloudbeds payment method; live ignores that variable.
  assert.equal(getBookingConfig({ ...STRIPE_TEST_ENV, CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD: "stripe_test" }).cloudbedsPaymentMethod, "stripe_test");
  assert.equal(getBookingConfig({ ...STRIPE_LIVE_ENV, CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD: "stripe_test" }).cloudbedsPaymentMethod, "stripe");
});

/* ------------------------------- drain ------------------------------- */

test("drain: after BOOKING_PAYMENT_PROVIDER moves away from stripe, Stripe bookings already started still confirm", async () => {
  assert.equal(getStripeDrainConfig(STRIPE_TEST_ENV), null, "provider still stripe: the normal config covers it");
  assert.equal(getStripeDrainConfig({ BOOKING_PAYMENT_PROVIDER: "demo" }), null, "no Stripe key: nothing to drain");
  const switched = { ...STRIPE_TEST_ENV, BOOKING_PAYMENT_PROVIDER: "demo" };
  const drain = getStripeDrainConfig(switched);
  assert.equal(drain?.paymentMode, "stripe-test");
  const switchedLive = { ...STRIPE_LIVE_ENV, BOOKING_PAYMENT_PROVIDER: "beam", BOOKING_ALLOW_LIVE_PAYMENTS: "false" };
  assert.equal(getStripeDrainConfig(switchedLive)?.paymentMode, "stripe-live", "drains live sessions even with the emergency stop");

  const kit = makeKit();
  const res = await checkout(kit);
  const body = res.body as CheckoutSuccess;
  const session = kit.fakeStripe.session(sessionIdOf(body))!;
  const t = new URL(session.success_url.replace("{CHECKOUT_SESSION_ID}", "x")).searchParams.get("t")!;
  kit.fakeStripe.complete(session.id);
  const demoConfig = getBookingConfig(switched); // the provider is now demo (same token secret)
  assert.equal(demoConfig.paymentMode, "demo");
  // Without the drain hook: refused as another mode.
  assert.equal((await runStatus({ t, p: null, l: null, s: session.id }, { config: demoConfig, nowMs: NOW })).status, 409);
  const r = (await runStatus({ t, p: null, l: null, s: session.id }, { config: demoConfig, nowMs: NOW, stripeDrain: () => kit.deps })).body as StatusResponse;
  assert.equal(r.status, "paid");
  assert.deepEqual(r.fulfilment, { state: "confirmed", reservationId: body.holdReservationId });

  // Abandon drains too.
  const kit2 = makeKit();
  const res2 = await checkout(kit2);
  const s2 = kit2.fakeStripe.session(sessionIdOf(res2.body))!;
  const t2 = new URL(s2.success_url.replace("{CHECKOUT_SESSION_ID}", "x")).searchParams.get("t")!;
  const ab = await runAbandon({ t: t2, s: s2.id }, { config: demoConfig, nowMs: NOW, stripeDrain: () => kit2.deps });
  assert.deepEqual(ab.body, { ok: true, state: "released" });
});

/* ------------------ the fee line never blocks a booking ------------------ */

test("fee item fails every time -> payment recorded, booking CONFIRMED, owner alerted to add the fee", async () => {
  const kit = makeKit();
  const res = await checkout(kit);
  const body = res.body as CheckoutSuccess;
  const sessionId = sessionIdOf(body);
  kit.fakeStripe.complete(sessionId);
  kit.fakeCb.failNext("postCustomItem", "rejected", "Access denied (write:item)");
  kit.fakeCb.failNext("postCustomItem", "rejected", "Access denied (write:item)");
  const out = await fulfilSession(sessionId, kit.deps);
  assert.equal(out.state, "confirmed");
  const r = kit.fakeCb.reservations.get(body.holdReservationId!)!;
  assert.equal(r.status, "confirmed");
  assert.equal(r.payments.length, 1);
  assert.equal(r.items.length, 0);
  assert.ok(kit.alerts.some((a) => a.subject.includes("fee line is missing")));
});

test("fee item fails once -> retried after confirming; folio balances, no alert", async () => {
  const kit = makeKit();
  const res = await checkout(kit);
  const body = res.body as CheckoutSuccess;
  const sessionId = sessionIdOf(body);
  kit.fakeStripe.complete(sessionId);
  kit.fakeCb.failNext("postCustomItem", "http500");
  const out = await fulfilSession(sessionId, kit.deps);
  assert.equal(out.state, "confirmed");
  assert.equal(kit.fakeCb.balance(body.holdReservationId!), 0);
  assert.equal(kit.alerts.some((a) => a.subject.includes("fee line is missing")), false);
});

/* ------------------------------ sweeper ------------------------------ */

test("live: checkout alerts when the sweeper has not run; a sweep records its run", async () => {
  const kit = makeKit({ env: STRIPE_LIVE_ENV });
  await checkout(kit, GARDEN, { checkIn: "2026-11-10", checkOut: "2026-11-12" });
  assert.ok(kit.alerts.some((a) => a.subject.includes("sweeper has not run")));
  await runSweep(kit.deps);
  assert.equal(await kit.deps.kv.get(keys.lastSweep(keyScope(kit.config.paymentMode))), String(kit.now.ms));
  const before = kit.alerts.length;
  await checkout(kit, HONEYMOON, { checkIn: "2026-11-10", checkOut: "2026-11-12" });
  assert.equal(kit.alerts.slice(before).some((a) => a.subject.includes("sweeper has not run")), false);
});

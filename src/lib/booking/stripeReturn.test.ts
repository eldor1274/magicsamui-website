// Return page status, abandon, sweeper, KV lock, analytics gating and the
// stripe-mock click-through, against the in-repo fakes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runAbandon } from "./abandon.ts";
import { buildOffers } from "./availability.ts";
import { addDays } from "./dates.ts";
import { demoInventory } from "./demoProvider.ts";
import { createBookingAnalytics, purchaseParams } from "./clientAnalytics.ts";
import { getBookingConfig } from "./config.ts";
import { createMemoryKv } from "./kv.ts";
import { acquireLock, keys, recordIntent, releaseLock, withLock } from "./lock.ts";
import { runMockStripeAction } from "./mock/mockStripeActions.ts";
import { runStatus } from "./status.ts";
import { runSweep } from "./sweep.ts";
import { STRIPE_LIVE_ENV, NOW, checkout, makeKit, sessionIdOf } from "./testkit.ts";
import type { BookingSummary, CheckoutSuccess, StatusResponse } from "./types.ts";

async function opened(env?: Record<string, string | undefined>) {
  const kit = makeKit(env ? { env } : {});
  const res = await checkout(kit);
  const body = res.body as CheckoutSuccess;
  assert.equal(body.ok, true, JSON.stringify(res.body));
  const session = kit.fakeStripe.session(sessionIdOf(body))!;
  const t = new URL(session.success_url.replace("{CHECKOUT_SESSION_ID}", "x")).searchParams.get("t")!;
  return { kit, body, sessionId: session.id, reservationId: body.holdReservationId!, t };
}

test("KV lock: SET NX semantics, TTL expiry, only the owner releases", async () => {
  let now = 0;
  const kv = createMemoryKv(() => now);
  const a = await acquireLock(kv, "k", 120);
  assert.ok(a);
  assert.equal(await acquireLock(kv, "k", 120), null);
  now += 121_000;
  const b = await acquireLock(kv, "k", 120);
  assert.ok(b, "an expired lock can be re-taken");
  await releaseLock(kv, a!); // stale owner: must not delete b's lock
  assert.equal(await acquireLock(kv, "k", 120), null);
  await releaseLock(kv, b!);
  const r = await withLock(kv, "k", async () => 42);
  assert.deepEqual(r, { acquired: true, value: 42 });
  assert.equal(await kv.get("k"), null, "released after the run, even on success");
  await assert.rejects(withLock(kv, "k", async () => { throw new Error("boom"); }));
  assert.equal(await kv.get("k"), null, "released after a throw too");
  await kv.zadd("z", 5, "a");
  await kv.zadd("z", 1, "b");
  assert.deepEqual(await kv.zrangeByScore("z", 0, 10, 10), ["b", "a"]);
  await kv.zrem("z", "b");
  assert.deepEqual(await kv.zrangeByScore("z", 0, 10, 10), ["a"]);
});

test("return page (status): open -> pending; paid -> fulfilled & confirmed (no purchase outside live); expired -> released", async () => {
  const { kit, body, sessionId, reservationId, t } = await opened();
  const status = (s: string | null) => runStatus({ t, p: null, l: null, s }, { config: kit.config, stripe: kit.deps, nowMs: NOW });

  let r = (await status(sessionId)).body as StatusResponse;
  assert.equal(r.status, "pending");
  assert.deepEqual(r.fulfilment, { state: "awaiting_payment", reservationId: null });
  assert.equal(r.provider, "stripe");

  kit.fakeStripe.complete(sessionId);
  r = (await status(sessionId)).body as StatusResponse;
  assert.equal(r.status, "paid");
  assert.deepEqual(r.fulfilment, { state: "confirmed", reservationId });
  assert.equal(r.purchase, null, "no GA4 purchase from test mode");
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "confirmed");
  // The session id may be missing (reload, new tab): the link token or the recorded pointer find it.
  r = (await runStatus({ t, p: null, l: body.linkToken, s: null }, { config: kit.config, stripe: kit.deps, nowMs: NOW })).body as StatusResponse;
  assert.equal(r.status, "paid");
  r = (await status(null)).body as StatusResponse;
  assert.equal(r.status, "paid");
  assert.equal(kit.fakeCb.count("postPayment"), 1);

  const other = await opened();
  other.kit.fakeStripe.expire(other.sessionId);
  const e = (await runStatus({ t: other.t, p: null, l: null, s: other.sessionId }, { config: other.kit.config, stripe: other.kit.deps, nowMs: NOW })).body as StatusResponse;
  assert.equal(e.status, "expired");
  assert.equal(e.fulfilment.state, "released");
  assert.equal(other.kit.fakeCb.reservations.get(other.reservationId)?.status, "canceled");
});

test("status refuses a session that belongs to another booking", async () => {
  const a = await opened();
  const b = await opened();
  // Same fake world: put b's session into a's Stripe to simulate someone pairing a token with another session id.
  a.kit.fakeStripe.sessions.set(b.sessionId, b.kit.fakeStripe.session(b.sessionId)!);
  const r = (await runStatus({ t: a.t, p: null, l: null, s: b.sessionId }, { config: a.kit.config, stripe: a.kit.deps, nowMs: NOW })).body as StatusResponse;
  assert.equal(r.status, "failed");
  assert.equal(r.failureCode, "AMOUNT_OR_REFERENCE_MISMATCH");
});

test("live: purchase only after paid AND confirmed, transaction_id = Cloudbeds reservationID, value in baht", async () => {
  const { kit, sessionId, reservationId, t, body } = await opened(STRIPE_LIVE_ENV);
  assert.equal(kit.config.paymentMode, "stripe-live");
  kit.fakeStripe.complete(sessionId);
  // Cloudbeds refuses the first time (a clear refusal, so the retry may post at once): paid but still "confirming" -> no purchase yet.
  kit.fakeCb.failNext("postPayment", "rejected", "Temporarily unavailable");
  let r = (await runStatus({ t, p: null, l: null, s: sessionId }, { config: kit.config, stripe: kit.deps, nowMs: NOW })).body as StatusResponse;
  assert.equal(r.status, "paid");
  assert.equal(r.fulfilment.state, "confirming");
  assert.equal(r.purchase, null);
  r = (await runStatus({ t, p: null, l: null, s: sessionId }, { config: kit.config, stripe: kit.deps, nowMs: NOW })).body as StatusResponse;
  assert.equal(r.fulfilment.state, "confirmed");
  assert.deepEqual(r.purchase, { transactionId: reservationId, valueBaht: body.quote.totalSatang / 100, currency: "THB" });
  // No test guard in live: the near-term dates and any email are fine (the kit used the far dates anyway).
  assert.equal(kit.config.testGuard, null);
});

test("analytics gating: stripe purchase needs the server's confirmation; never from test/mock/preview", () => {
  const booking = { ref: "MSV-20261005-ABCD", paymentMode: "stripe-live", checkIn: "2027-11-10", checkOut: "2027-11-13", nights: 3, items: [{ slug: "honeymoon-suite", ratePlanId: "standard", adults: 2, addonIds: [] }], itemRoomSatang: [2_700_000], promoCode: null, totalSatang: 2_835_000, cardFeeSatang: 135_000, dueNowSatang: 2_835_000, createdAt: "2026-10-05T03:00:00.000Z", linkExpiresAt: "2026-10-05T03:30:00.000Z" } as BookingSummary;
  const confirmed = { transactionId: "6954439751495", valueBaht: 28350, currency: "THB" as const };
  const p = purchaseParams(booking, confirmed);
  assert.equal(p.transaction_id, "6954439751495");
  assert.equal(p.value, 28350);
  assert.equal(p.tax, 1350);
  assert.equal(createBookingAnalytics("stripe-live", "production").enabled, true);
  for (const [mode, env] of [["stripe-live", "preview"], ["stripe-test", "production"], ["stripe-mock", "production"], ["demo", "production"]] as const) {
    assert.equal(createBookingAnalytics(mode, env).enabled, false, `${mode}/${env}`);
  }
  // Without a window (server) nothing happens and nothing throws; without confirmation a stripe purchase is a no-op.
  createBookingAnalytics("stripe-live", "production").purchase(booking);
  createBookingAnalytics("stripe-live", "production").purchase(booking, confirmed);
});

test("abandon API: expires + releases; never cancels a paid session; demo/beam -> not_applicable; bad token -> 400", async () => {
  const { kit, body, sessionId, reservationId, t } = await opened();
  const res = await runAbandon({ t, l: body.linkToken }, { config: kit.config, stripe: kit.deps, nowMs: NOW });
  assert.deepEqual(res.body, { ok: true, state: "released" });
  assert.equal(kit.fakeStripe.session(sessionId)?.status, "expired");
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "canceled");
  // The return page then says "cancelled" (not "expired").
  const st = (await runStatus({ t, p: null, l: null, s: sessionId }, { config: kit.config, stripe: kit.deps, nowMs: NOW })).body as StatusResponse;
  assert.equal(st.status, "cancelled");
  // Repeat: harmless.
  assert.deepEqual((await runAbandon({ t }, { config: kit.config, stripe: kit.deps, nowMs: NOW })).body, { ok: true, state: "closed" });

  const paid = await opened();
  paid.kit.fakeStripe.complete(paid.sessionId);
  const p = await runAbandon({ t: paid.t, s: paid.sessionId }, { config: paid.kit.config, stripe: paid.kit.deps, nowMs: NOW });
  assert.deepEqual(p.body, { ok: true, state: "paid" });
  assert.equal(paid.kit.fakeCb.reservations.get(paid.reservationId)?.status, "confirmed");

  assert.equal((await runAbandon({ t: "garbage" }, { config: kit.config, stripe: kit.deps, nowMs: NOW })).status, 400);
  const demo = getBookingConfig({});
  assert.equal((await runAbandon({ t }, { config: demo, nowMs: NOW })).status, 400, "a stripe token is not valid under the demo secret");
});

test("sweeper: repairs a dropped 'paid' webhook, releases expired and session-less holds, leaves open ones", async () => {
  const { kit, sessionId, reservationId } = await opened();
  kit.fakeStripe.complete(sessionId); // paid, but no webhook ever arrived

  // A second hold whose session expired without a webhook.
  const r2 = await checkout(kit, [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }]);
  const s2 = sessionIdOf(r2.body);
  const res2 = (r2.body as CheckoutSuccess).holdReservationId!;
  kit.fakeStripe.expire(s2);

  // A third, still open (guest paying right now).
  const r3 = await checkout(kit, [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }]);
  const res3 = (r3.body as CheckoutSuccess).holdReservationId!;

  // An orphan MSV hold: postReservation landed but our side never heard back (no record, no session -
  // only the INTENT checkout writes before every postReservation). Left "confirmed", as many properties
  // create API bookings: the sweeper must find it anyway, aged by the intent.
  await recordIntent(kit.deps.kv, { ref: "MSV-20261005-ABCD", identifier: "MSV-20261005-ABCD-TEST", mode: kit.config.paymentMode, createdAt: kit.now.ms, reservationId: null });
  const orphan = await kit.deps.writer.createHold({
    ref: "MSV-20261005-ABCD",
    identifier: "MSV-20261005-ABCD-TEST",
    checkIn: "2027-12-01",
    checkOut: "2027-12-02",
    rooms: [{ roomTypeId: "462958", rateId: null, adults: 2 }],
    guest: { firstName: "A", lastName: "B", email: "a@b.co", phone: "+1 5555555", country: "US", zip: "1" },
    estimatedArrivalTime: null,
    paymentMethod: "credit",
    expectedRoomsSatang: 0,
  });
  assert.equal(kit.fakeCb.reservations.get(orphan.reservationId)!.status, "confirmed");

  kit.fakeStripe.session(sessionIdOf(r3.body))!.expires_at += 3600; // keep #3 open
  kit.now.ms += 45 * 60_000; // past the stale threshold (sessions expire at 31 min)

  const summary = await runSweep(kit.deps);
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "confirmed", "dropped webhook repaired");
  assert.equal(kit.fakeCb.count("postPayment"), 1);
  assert.equal(kit.fakeCb.reservations.get(res2)?.status, "canceled", "expired session released");
  assert.equal(kit.fakeCb.reservations.get(res3)?.status, "not_confirmed", "open session left alone");
  assert.equal(kit.fakeCb.reservations.get(orphan.reservationId)?.status, "canceled", "orphan MSV hold released");
  assert.equal(summary.fulfilled, 1);
  assert.equal(summary.released, 2);
  assert.ok(summary.skippedOpen >= 1);
  assert.equal(summary.errors, 0);

  // Running again changes nothing.
  const calls = kit.fakeCb.count("putReservation");
  const again = await runSweep(kit.deps);
  assert.equal(again.fulfilled + again.released, 0);
  assert.equal(kit.fakeCb.count("putReservation"), calls);
  assert.equal(await kit.deps.kv.get(keys.fulfilDone(sessionId)) !== null, true);
});

test("stripe-mock click-through: pay -> webhook through the real handler -> confirmed; 404 outside mock", async () => {
  const mockEnv = { BOOKING_PAYMENT_PROVIDER: "stripe", BOOKING_STRIPE_MOCK: "true" };
  // Like the app's mock writer: no read-side room types, the fake prices the hold at the quoted subtotal.
  const kit = makeKit({ env: mockEnv, cb: { roomTypes: undefined, lenient: true } });
  assert.equal(kit.config.paymentMode, "stripe-mock");
  assert.equal(kit.config.dataSource, "demo");
  // First 3-night window where the demo calendar has the Honeymoon Suite free.
  let window: { checkIn: string; checkOut: string } | null = null;
  for (let i = 0; i < 200 && !window; i++) {
    const checkIn = addDays("2027-01-04", i);
    const checkOut = addDays(checkIn, 3);
    if (buildOffers(demoInventory(checkIn, checkOut), 2).find((o) => o.slug === "honeymoon-suite")?.available) window = { checkIn, checkOut };
  }
  assert.ok(window);
  const res = await checkout(kit, undefined, window);
  const body = res.body as CheckoutSuccess;
  assert.equal(body.ok, true, JSON.stringify(res.body));
  const sessionId = sessionIdOf(body);
  const out = await runMockStripeAction({ sessionId, action: "pay" }, kit.fakeStripe, kit.deps);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.match(out.body.ok ? out.body.redirectUrl : "", new RegExp(`/booking-preview/return\\?.*session_id=${sessionId}$`));
  assert.equal(kit.fakeCb.reservations.get(body.holdReservationId!)?.status, "confirmed");
  assert.equal((await runMockStripeAction({ sessionId, action: "pay" }, kit.fakeStripe, kit.deps)).status, 409);

  const real = makeKit();
  assert.equal((await runMockStripeAction({ sessionId, action: "pay" }, real.fakeStripe, real.deps)).status, 404);
});

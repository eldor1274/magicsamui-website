// Go-live fixes, round 3: paid bookings whose Cloudbeds confirmation keeps
// failing, mode-scoped Redis keys, the fee item per mode, fulfil never undoing
// staff work, the sweeper's index hygiene, base-rate-only availability,
// departure-day restrictions, deadline-bound Cloudbeds writes, and small
// guest-facing / analytics fixes. All against the in-repo fakes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createAlerter } from "./alerts.ts";
import { cloudbedsRestrictions, evaluateRestrictions, parseAvailableRoomTypes } from "./cloudbedsProvider.ts";
import { CloudbedsWriteError, MIN_CALL_MS, createCloudbedsWriter } from "./cloudbedsWrite.ts";
import { finishesLiveStripePayments, getBookingConfig, getInventoryConfig, sweepSecretOf, sweepSecretsOf } from "./config.ts";
import { PAID_UNCONFIRMED_ESCALATE_MS, alertFulfilFailure, feeItemFor, fulfilSession } from "./fulfil.ts";
import { normalizePostcode, validateGuest } from "./guest.ts";
import { createMemoryKv } from "./kv.ts";
import { keyScope, keys, recordHold } from "./lock.ts";
import { OVERLAP_WINDOW_MS, slugsOverlappingOpenHolds } from "./stripeCheckout.ts";
import { handleStripeWebhook } from "./stripeWebhook.ts";
import { INDEX_PRUNE_MS, INDEX_SIZE_ALERT, STALE_HOLD_MS, SWEEP_LOOKBACK_MS, runSweep } from "./sweep.ts";
import { FAR_CHECKIN, FAR_CHECKOUT, GUEST, HONEYMOON, NOW, STRIPE_LIVE_ENV, STRIPE_TEST_ENV, checkout, makeKit, sessionIdOf } from "./testkit.ts";
import type { Kit } from "./testkit.ts";
import type { CartItemInput, CheckoutSuccess } from "./types.ts";
import { parseGuestInput } from "./validate.ts";
import { allowListedSearch } from "./urls.ts";

const GARDEN: CartItemInput[] = [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];

async function paidSession(kit: Kit, items: CartItemInput[] = HONEYMOON) {
  const res = await checkout(kit, items);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  const sessionId = sessionIdOf(body);
  kit.fakeStripe.complete(sessionId);
  return { sessionId, reservationId: body.holdReservationId as string, ref: body.ref };
}

const params = (kit: Kit, method: string) => kit.fakeCb.calls.filter((c) => c.method === method).map((c) => c.params);

/* ------------------------- fee item per mode ------------------------- */

test("fee line: one Cloudbeds item per mode with a static note; per-booking ids go into the PAID note", async () => {
  const kit = makeKit();
  const a = await paidSession(kit);
  assert.equal((await fulfilSession(a.sessionId, kit.deps)).state, "confirmed");
  const b = await paidSession(kit, GARDEN);
  assert.equal((await fulfilSession(b.sessionId, kit.deps)).state, "confirmed");

  const items = params(kit, "postCustomItem");
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.equal(item["items[0][appItemID]"], "msv-payment-processing-fee-test", "test mode never uses the live item");
    assert.equal(item["items[0][itemSKU]"], "MSV-PAYMENT-FEE-TEST");
    assert.equal(item["items[0][itemName]"], "TEST - Payment processing fee");
    // Cloudbeds reuses the first text sent for an appItemID: it must carry nothing per booking.
    assert.doesNotMatch(item["items[0][itemNote]"], /MSV-|pi_|cs_/);
  }
  assert.equal(items[0]["items[0][itemNote]"], items[1]["items[0][itemNote]"]);

  // Each reservation gets its OWN "PAID" note with its own ref and PaymentIntent.
  for (const x of [a, b]) {
    const notes = kit.fakeCb.reservations.get(x.reservationId)!.notes;
    const paid = notes.filter((n) => n.includes("PAID via Stripe"));
    assert.equal(paid.length, 1, "one PAID note per booking");
    assert.match(paid[0], new RegExp(`^TEST MODE - NOT REAL MONEY\\. PAID via Stripe pi_\\S+ \\(THB [\\d,.]+\\) for online booking ${x.ref} - do NOT cancel`));
  }

  // Live: its own item, no test text anywhere.
  assert.deepEqual(feeItemFor("stripe-live"), {
    appItemId: "msv-payment-processing-fee",
    itemSku: "MSV-PAYMENT-FEE",
    name: "Payment processing fee",
    note: "Online booking payment processing fee, paid via Stripe.",
  });
  assert.notEqual(feeItemFor("stripe-test").appItemId, feeItemFor("stripe-live").appItemId);
  assert.notEqual(feeItemFor("stripe-mock").appItemId, feeItemFor("stripe-live").appItemId);
});

/* -------------- paid, but the Cloudbeds confirmation keeps failing -------------- */

test("paid but Cloudbeds keeps refusing the payment: PAID note, never released, retried past 48 h, CRITICAL after 2 h, then confirmed", async () => {
  const kit = makeKit();
  const { sessionId, reservationId, ref } = await paidSession(kit);
  const realWriter = kit.deps.writer;
  // e.g. CLOUDBEDS_STRIPE_PAYMENT_METHOD is wrong: every postPayment is refused.
  kit.deps.writer = {
    ...realWriter,
    recordPayment: async () => {
      throw new CloudbedsWriteError("postPayment", "rejected", "Payment type not found", 200, null, false);
    },
  };
  const { payload, header } = kit.fakeStripe.signedEvent("checkout.session.completed", sessionId);
  assert.equal((await handleStripeWebhook(payload, header, kit.deps, { nowMs: NOW })).status, 500);

  // The first Cloudbeds write is the note telling staff not to cancel it.
  const res = kit.fakeCb.reservations.get(reservationId)!;
  assert.ok(res.notes.some((n) => n.includes("PAID via Stripe") && n.includes("do NOT cancel") && n.includes(ref)));
  assert.equal(res.status, "not_confirmed");
  const scope = keyScope(kit.config.paymentMode);
  assert.deepEqual(await kit.deps.kv.zrangeByScore(keys.paidIndex(scope), 0, Number.MAX_SAFE_INTEGER, 10), [sessionId]);

  // A stale sweep: the hold stays in the index (paid, not done) and is retried, never released.
  kit.now.ms += STALE_HOLD_MS + 5 * 60_000;
  const s1 = await runSweep(kit.deps);
  assert.equal(res.status, "not_confirmed", "never cancelled");
  assert.equal(s1.paidUnconfirmed, 1);
  assert.equal(s1.released, 0);
  assert.deepEqual(await kit.deps.kv.zrangeByScore(keys.holdIndex(), 0, Number.MAX_SAFE_INTEGER, 10), [reservationId], "kept until the done marker");
  assert.equal(kit.alerts.filter((a) => a.severity === "critical").length, 0, "not yet escalated");

  // 2+ hours after payment: CRITICAL (stored, re-sent until delivered) naming the booking.
  kit.now.ms = NOW + PAID_UNCONFIRMED_ESCALATE_MS + 60_000;
  kit.mail.ok = false;
  await runSweep(kit.deps);
  const pending = await kit.deps.kv.zrangeByScore(keys.pendingAlertIndex(scope), 0, Number.MAX_SAFE_INTEGER, 10);
  assert.ok(pending.includes(`fulfil-stuck:${sessionId}`), "stored for re-sending");
  kit.mail.ok = true;
  kit.now.ms += 10 * 60_000;
  await runSweep(kit.deps);
  const urgent = kit.alerts.filter((a) => a.severity === "critical" && a.subject === `URGENT: paid booking ${ref} still not confirmed in Cloudbeds`);
  assert.equal(urgent.length, 1);
  assert.match(urgent[0].lines.join(" "), new RegExp(`Cloudbeds reservation ${reservationId}`));
  assert.match(urgent[0].lines.join(" "), /Do NOT cancel/);

  // 3 days later - past the 48 h Stripe lookback and Stripe's own retries - the cause is fixed: the sweeper confirms it.
  kit.now.ms = NOW + SWEEP_LOOKBACK_MS + 24 * 3600_000;
  kit.deps.writer = realWriter;
  const s3 = await runSweep(kit.deps);
  assert.equal(s3.fulfilled, 1);
  assert.equal(s3.paidUnconfirmed, 0);
  assert.equal(res.status, "confirmed");
  assert.equal(res.payments.length, 1);
  assert.deepEqual(await kit.deps.kv.zrangeByScore(keys.paidIndex(scope), 0, Number.MAX_SAFE_INTEGER, 10), []);
  assert.deepEqual(await kit.deps.kv.zrangeByScore(keys.holdIndex(), 0, Number.MAX_SAFE_INTEGER, 10), []);
});

test("a fulfil failure before the session was seen paid names only the session (no guessing)", async () => {
  const kit = makeKit();
  await alertFulfilFailure(kit.deps, "cs_test_unknown", new Error("boom"));
  const [a] = kit.alerts;
  assert.equal(a.subject, "Paid booking not yet confirmed in Cloudbeds (retrying)");
  assert.match(a.lines[0], /cs_test_unknown/);
});

/* ------------------- fulfil never undoes staff work ------------------- */

test("fulfil running late never moves a checked-in guest back to confirmed; an unexpected status goes to the owner", async () => {
  const kit = makeKit();
  const a = await paidSession(kit);
  (kit.fakeCb.reservations.get(a.reservationId) as { status: string }).status = "checked_in";
  const out = await fulfilSession(a.sessionId, kit.deps);
  assert.equal(out.state, "confirmed");
  assert.equal(kit.fakeCb.reservations.get(a.reservationId)!.status, "checked_in", "left as staff set it");
  assert.equal(params(kit, "putReservation").filter((p) => p.reservationID === a.reservationId && p.status === "confirmed").length, 0);
  assert.equal(kit.fakeCb.reservations.get(a.reservationId)!.payments.length, 1, "the payment is still recorded");

  const b = await paidSession(kit, GARDEN);
  (kit.fakeCb.reservations.get(b.reservationId) as { status: string }).status = "no_show";
  const outB = await fulfilSession(b.sessionId, kit.deps);
  assert.equal(outB.state, "needs_attention");
  assert.equal(kit.fakeCb.reservations.get(b.reservationId)!.status as string, "no_show");
  assert.ok(kit.alerts.some((x) => x.severity === "critical" && x.subject.includes(b.ref)));
});

/* --------------------- mode-scoped shared Redis keys --------------------- */

test("Stage B and live on ONE Redis: a test sweeper never hides a dead live sweeper or re-sends/clears live alerts", async () => {
  const now = { ms: NOW };
  const kv = createMemoryKv(() => now.ms);
  const live = makeKit({ env: STRIPE_LIVE_ENV, kv, now });
  const testKit = makeKit({ env: STRIPE_TEST_ENV, kv, now });

  // A live critical alert that could not be delivered.
  live.mail.ok = false;
  await live.deps.alert("URGENT: paid booking MSV-20261005-ABCD needs attention", ["x"], { key: "attention:cs_live_1", severity: "critical" });
  assert.deepEqual(await kv.zrangeByScore(keys.pendingAlertIndex("live"), 0, Number.MAX_SAFE_INTEGER, 10), ["attention:cs_live_1"]);

  // The test deployment sweeps (mail works there): it neither re-sends nor clears the live alert ...
  const s = await runSweep(testKit.deps);
  assert.equal(s.undeliveredAlerts, 0);
  assert.equal(testKit.alerts.filter((a) => a.subject.includes("MSV-20261005-ABCD")).length, 0);
  assert.deepEqual(await kv.zrangeByScore(keys.pendingAlertIndex("live"), 0, Number.MAX_SAFE_INTEGER, 10), ["attention:cs_live_1"]);
  // ... and its run is not a live sweep.
  assert.equal(await kv.get(keys.lastSweep("live")), null);
  assert.equal(await kv.get(keys.lastSweep("stripe-test")), String(now.ms));

  // A test alert never suppresses the live alert with the same key.
  await testKit.deps.alert("Stripe webhook: signatures are being rejected", ["t"], { key: "webhook-bad-signature" });
  live.mail.ok = true;
  await live.deps.alert("Stripe webhook: signatures are being rejected", ["l"], { key: "webhook-bad-signature" });
  assert.equal(live.alerts.filter((a) => a.subject === "Stripe webhook: signatures are being rejected").length, 1);

  // The live sweeper re-sends its own alert.
  const ls = await runSweep(live.deps);
  assert.equal(ls.undeliveredAlerts, 1);
  assert.ok(live.alerts.some((a) => a.subject.includes("MSV-20261005-ABCD")));
  assert.equal(keyScope("stripe-live"), "live");
  assert.equal(keyScope("stripe-test"), "stripe-test");
  assert.notEqual(keyScope("live"), "live", "no other mode can borrow the live scope");
});

test("the alerter keeps claims and stored alerts per scope", async () => {
  const kv = createMemoryKv();
  const sent: string[] = [];
  const mk = (scope: string) =>
    createAlerter({ kv, log: () => undefined, emailEnabled: true, subjectPrefix: "", footer: "", scope, send: async (m) => (sent.push(m.subject), true) });
  await mk("stripe-test")("A", ["a"], { key: "k" });
  await mk("live")("A", ["a"], { key: "k" });
  assert.equal(sent.length, 2, "a test claim never suppresses the live alert");
  assert.equal(await kv.get(keys.alerted("live", "k")), "1");
  assert.equal(await kv.get(keys.alerted("stripe-test", "k")), "1");
});

/* ------------------------- open-holds index hygiene ------------------------- */

test("overlap check reads only fresh holds, so old index entries can never hide a new one", async () => {
  const kv = createMemoryKv();
  const tower = [{ slug: "tower-club-3br", ratePlanId: "standard" as const, adults: 2, addonIds: [] }];
  // 150 old entries (other-mode leftovers, releases that kept failing) - more than any scan limit used to read.
  for (let i = 0; i < 150; i++) {
    await recordHold(kv, { ref: `MSV-20261001-OLD${i % 10}`, reservationId: `old-${i}`, sessionId: null, createdAt: NOW - OVERLAP_WINDOW_MS - 3600_000 - i, mode: "stripe-test", units: ["HM"], checkIn: FAR_CHECKIN, checkOut: FAR_CHECKOUT });
  }
  assert.deepEqual(await slugsOverlappingOpenHolds(kv, tower, FAR_CHECKIN, FAR_CHECKOUT, NOW), [], "old entries are not bridged (Cloudbeds shows them)");
  await recordHold(kv, { ref: "MSV-20261005-NEWW", reservationId: "fresh", sessionId: "cs_x", createdAt: NOW, mode: "stripe-test", units: ["HM"], checkIn: FAR_CHECKIN, checkOut: FAR_CHECKOUT });
  assert.deepEqual(await slugsOverlappingOpenHolds(kv, tower, FAR_CHECKIN, FAR_CHECKOUT, NOW + 60_000), ["tower-club-3br"]);
});

test("sweeper prunes index entries it can't vouch for, and alerts when the index keeps growing", async () => {
  const kit = makeKit();
  // An entry whose record expired (30 days) and an old other-mode leftover.
  await kit.deps.kv.zadd(keys.holdIndex(), NOW - 31 * 24 * 3600_000, "expired-record");
  await recordHold(kit.deps.kv, { ref: "MSV-20260901-LIVE", reservationId: "live-leftover", sessionId: null, createdAt: NOW - INDEX_PRUNE_MS - 3600_000, mode: "stripe-live" });
  const s = await runSweep(kit.deps);
  assert.equal(s.pruned, 2);
  assert.deepEqual(await kit.deps.kv.zrangeByScore(keys.holdIndex(), 0, Number.MAX_SAFE_INTEGER, 10), []);
  assert.equal(kit.fakeCb.count("putReservation"), 0, "nothing was cancelled");

  // A fresh other-mode entry is left alone; a huge index alerts.
  for (let i = 0; i <= INDEX_SIZE_ALERT; i++) {
    await recordHold(kit.deps.kv, { ref: "MSV-20261005-LIVE", reservationId: `live-${i}`, sessionId: null, createdAt: NOW - STALE_HOLD_MS - 60_000, mode: "stripe-live" });
  }
  const s2 = await runSweep(kit.deps);
  assert.equal(s2.pruned, 0);
  assert.ok(kit.alerts.some((a) => a.subject === "The booking sweeper's hold index keeps growing"));
});

/* --------------------------- base rate only --------------------------- */

test("Stripe sells the base (BAR) row only: a room with only package/derived rows is unavailable, never sold as 'Standard'", () => {
  const row = (extra: Record<string, unknown>, rate = 9000) => ({
    roomTypeID: "462958",
    roomRateID: String(extra.roomRateID ?? "base"),
    roomsAvailable: 1,
    roomRateDetailed: [
      { date: "2026-10-28", rate },
      { date: "2026-10-29", rate },
    ],
    ...extra,
  });
  const json = (rows: unknown[]) => ({ success: true, data: [{ propertyCurrency: [{ currencyCode: "THB" }], propertyRooms: rows }] });
  const plan = row({ roomRateID: "longstay", ratePlanNamePublic: "Long stay" }, 7000);
  const derived = row({ roomRateID: "nonref", derivedType: "percentage" }, 6000);
  const noBase: string[] = [];
  const hm = (rows: unknown[], baseRateOnly: boolean) =>
    parseAvailableRoomTypes(json(rows), "2026-10-28", "2026-10-30", { baseRateOnly, onNoBaseRate: (s) => noBase.push(s) }).find((r) => r.slug === "honeymoon-suite")!;
  assert.equal(hm([plan, derived], true).available, false);
  assert.deepEqual(noBase, ["honeymoon-suite"]);
  assert.equal(hm([plan, derived, row({})], true).rateId, "base");
  // Beam/demo keep the old tiering (a named plan stands in when no base row exists).
  assert.equal(hm([plan, derived], false).rateId, "longstay");

  assert.equal(getBookingConfig(STRIPE_TEST_ENV).cloudbeds?.baseRateOnly, true);
  assert.equal(getInventoryConfig(STRIPE_TEST_ENV).cloudbeds?.baseRateOnly, true);
  assert.equal(getInventoryConfig({ CLOUDBEDS_API_KEY: "k" }).cloudbeds?.baseRateOnly, false);
});

/* ------------------------ departure-day restrictions ------------------------ */

test("restrictions: asked one day past check-out so closed-to-departure is enforced; no arrival row = not checked", async () => {
  let url = "";
  const fetchImpl = (async (u: string) => {
    url = u;
    return Response.json({
      success: true,
      data: [
        {
          rateID: "r",
          roomTypeID: "462958",
          roomRateDetailed: [
            { date: "2027-11-10", minLos: 0, roomsAvailable: 1 },
            { date: "2027-11-11", minLos: 0, roomsAvailable: 1 },
            { date: "2027-11-12", closedToDeparture: true, roomsAvailable: 0 },
          ],
        },
      ],
    });
  }) as unknown as typeof fetch;
  const r = await cloudbedsRestrictions("462958", "r", "2027-11-10", "2027-11-12", 2, { apiKey: "k", propertyId: "1", fetchImpl });
  assert.equal(new URL(url).searchParams.get("endDate"), "2027-11-13");
  assert.deepEqual(r, { ok: false, reason: "closed_to_departure" });
  // The departure day itself being sold out does not block a stay that leaves that morning.
  const okStay = evaluateRestrictions(
    { success: true, data: [{ rateID: "r", roomTypeID: "462958", roomRateDetailed: [{ date: "2027-11-10" }, { date: "2027-11-11" }, { date: "2027-11-12", roomsAvailable: 0 }] }] },
    "462958",
    "r",
    "2027-11-10",
    "2027-11-12",
  );
  assert.deepEqual(okStay, { ok: true, checked: true });
  // A row without the arrival day can't be evaluated: never reported as checked.
  const noArrival = evaluateRestrictions({ success: true, data: [{ rateID: "r", roomTypeID: "462958", roomRateDetailed: [] }] }, "462958", "r", "2027-11-10", "2027-11-12");
  assert.deepEqual(noArrival, { ok: true, checked: false });
});

/* ------------------------ deadline-bound writes ------------------------ */

test("a deadline-bound writer never sends a call it can't finish, and skips a 429 retry that doesn't fit", async () => {
  let calls = 0;
  const fetch429 = (async () => {
    calls++;
    return new Response("{}", { status: 429, headers: { "retry-after": "5" } });
  }) as unknown as typeof fetch;
  const clock = { ms: 1_000_000 };
  const writer = createCloudbedsWriter({ apiKey: "k", propertyId: "1", fetchImpl: fetch429, budget: null, sleep: async (ms) => void (clock.ms += ms) });

  const nearlyOut = writer.bounded!(clock.ms + MIN_CALL_MS - 1, () => clock.ms);
  await assert.rejects(nearlyOut.cancel("42"), (e: unknown) => e instanceof CloudbedsWriteError && e.kind === "budget" && !e.ambiguous);
  assert.equal(calls, 0, "nothing sent");

  const threeSeconds = writer.bounded!(clock.ms + 3_000, () => clock.ms);
  await assert.rejects(threeSeconds.cancel("42"), (e: unknown) => e instanceof CloudbedsWriteError && e.kind === "rate_limited");
  assert.equal(calls, 1, "the 5 s Retry-After does not fit: no retry");

  // Unbounded, the same writer still retries (up to 3 times).
  calls = 0;
  await assert.rejects(writer.cancel("42"));
  assert.equal(calls, 4);
});

/* ------------------------------ small fixes ------------------------------ */

test("sweeper secrets: BOOKING_SWEEP_SECRET and CRON_SECRET are both accepted", () => {
  const a = "sweep-secret-0123456789abcdef";
  const b = "cron-secret-0123456789abcdef";
  assert.deepEqual(sweepSecretsOf({ BOOKING_SWEEP_SECRET: a, CRON_SECRET: b }), [a, b]);
  assert.deepEqual(sweepSecretsOf({ CRON_SECRET: b }), [b]);
  assert.deepEqual(sweepSecretsOf({ BOOKING_SWEEP_SECRET: "short", CRON_SECRET: b }), [b]);
  assert.deepEqual(sweepSecretsOf({}), []);
  assert.equal(sweepSecretOf({ BOOKING_SWEEP_SECRET: a, CRON_SECRET: b }), a);
});

test("postcodes typed on a Japanese or Chinese keyboard (full-width) are accepted and sent plain", () => {
  assert.equal(normalizePostcode("１０１１５"), "10115");
  assert.equal(normalizePostcode(" sw1a　1aa "), "SW1A 1AA");
  assert.equal(validateGuest({ ...GUEST, postcode: "１０１１５" }).postcode, undefined);
  const parsed = parseGuestInput({ ...GUEST, postcode: "１０１１５" });
  assert.ok(parsed.ok);
  assert.equal(parsed.ok && parsed.value.postcode, "10115");
  assert.ok(validateGuest({ ...GUEST, postcode: "10115!" }).postcode);
});

test("the address-bar cleanup keeps ad-click ids (no PII) and drops tokens", () => {
  const kept = allowListedSearch("?t=TOKEN&ref=MSV-1&gclid=g&gad_source=1&gad_campaignid=2&dclid=d&_gl=x&msclkid=m&fbclid=f&utm_source=google&staff=1");
  const q = new URLSearchParams(kept);
  for (const k of ["gclid", "gad_source", "gad_campaignid", "dclid", "_gl", "msclkid", "fbclid", "utm_source", "staff"]) assert.ok(q.has(k), k);
  assert.ok(!q.has("t") && !q.has("ref"));
});

test("Stripe sends the receipt itself: receipt_email on the PaymentIntent (no account-wide switch needed)", async () => {
  const kit = makeKit();
  const res = await checkout(kit, HONEYMOON);
  assert.equal(res.status, 200);
  const create = kit.fakeStripe.calls.find((c) => c.method === "POST" && c.path === "/v1/checkout/sessions");
  assert.ok(create, "session created");
  assert.equal((create.body.payment_intent_data as Record<string, unknown>).receipt_email, GUEST.email);
});

test("the soft-launch return page stays measured while live payments are only being finished (emergency stop)", () => {
  assert.equal(finishesLiveStripePayments(STRIPE_LIVE_ENV), true);
  assert.equal(finishesLiveStripePayments({ ...STRIPE_LIVE_ENV, BOOKING_ALLOW_LIVE_PAYMENTS: "false" }), true, "emergency stop");
  assert.equal(finishesLiveStripePayments({ ...STRIPE_LIVE_ENV, BOOKING_PAYMENT_PROVIDER: "demo" }), true, "drain after a provider switch");
  assert.equal(finishesLiveStripePayments(STRIPE_TEST_ENV), false);
  assert.equal(finishesLiveStripePayments({}), false, "default env: unchanged");
});

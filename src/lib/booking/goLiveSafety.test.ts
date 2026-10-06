// Go-live safety (fix round 2): alert delivery that can't be lost, a
// postPayment whose answer is lost never posted twice, folio figures read in
// both v1.3 shapes, the sweeper's Cloudbeds side failing loudly, orphan holds
// aged by their intent, the "sold out" verdict confirmed by a fresh read, the
// 30 s time budget, Stripe's maximum charge, our own open holds blocking an
// overlapping cart, and the atomic Upstash counter. All against the fakes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createAlerter, pendingAlertId, resendPendingAlerts } from "./alerts.ts";
import { runCheckout } from "./checkout.ts";
import { cloudbedsRestrictions } from "./cloudbedsProvider.ts";
import { createCloudbedsWriter, readBalanceDetailed } from "./cloudbedsWrite.ts";
import { PAYMENT_DOUBT_COOLDOWN_MS, fulfilSession, releaseHold } from "./fulfil.ts";
import { createMemoryKv } from "./kv.ts";
import { INCR_WITH_TTL, createUpstashKv } from "./kvUpstash.ts";
import type { UpstashClient } from "./kvUpstash.ts";
import { keyScope, keys, recordIntent } from "./lock.ts";
import { CLIENT_BRAKE_MINUTES, HOLD_MIN_REMAINING_MS, MAX_HOLDS_PER_CLIENT, MAX_HOLDS_PER_IP, READ_FAILURE_ALERT_COUNT, slugsOverlappingOpenHolds } from "./stripeCheckout.ts";
import { CLOUDBEDS_FAILURE_ALERT_RUNS, INTENT_GIVE_UP_MS, STALE_HOLD_MS, runSweep } from "./sweep.ts";
import { FAR_CHECKIN, FAR_CHECKOUT, GUEST, HONEYMOON, ROOM_TYPES, STRIPE_LIVE_ENV, checkout, makeKit, request, serverQuote, sessionIdOf } from "./testkit.ts";
import type { Kit } from "./testkit.ts";
import type { CartItemInput, CheckoutSuccess } from "./types.ts";

async function heldAndOpen(kit: Kit = makeKit()) {
  const res = await checkout(kit);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  return { kit, body, sessionId: sessionIdOf(body), reservationId: body.holdReservationId as string };
}

async function pricedBody(kit: Kit, items: CartItemInput[] = HONEYMOON, extra = {}) {
  const req = request(items, extra);
  const quote = await serverQuote(kit, req);
  return { ...req, expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang };
}

const openIntents = (kit: Kit) => kit.deps.kv.zrangeByScore(keys.intentIndex(), 0, Number.MAX_SAFE_INTEGER, 10);

/* ------------------------------ alert delivery ------------------------------ */

test("alerts: a failed send is logged and frees the repeat key, so the next occurrence is sent", async () => {
  const kv = createMemoryKv();
  const logs: string[] = [];
  let ok = false;
  const sent: string[] = [];
  const alert = createAlerter({
    kv,
    log: (m) => logs.push(m),
    emailEnabled: true,
    subjectPrefix: "",
    footer: "",
    scope: "live",
    send: async (m) => {
      if (ok) sent.push(m.subject);
      return ok;
    },
  });
  await alert("Hold X could not be cancelled", ["line"], { key: "cancel-fail:X" });
  assert.ok(logs.includes("alert_send_failed"), "sendSiteMail answers false (never throws): the result is checked");
  assert.equal(await kv.get(keys.alerted("live", "cancel-fail:X")), null, "key freed after the failed send");
  ok = true;
  await alert("Hold X could not be cancelled", ["line"], { key: "cancel-fail:X" });
  assert.equal(sent.length, 1);
  // Delivered: repeats within the window are suppressed.
  await alert("Hold X could not be cancelled", ["line"], { key: "cancel-fail:X" });
  assert.equal(sent.length, 1);
  // A send that throws counts as failed too.
  const throwing = createAlerter({ kv, log: (m) => logs.push(m), emailEnabled: true, subjectPrefix: "", footer: "", scope: "live", send: async () => Promise.reject(new Error("boom")) });
  await throwing("Other", ["x"], { key: "other" });
  assert.equal(await kv.get(keys.alerted("live", "other")), null);
});

test("alerts: a function killed mid-send only blocks repeats for the short claim, never the 6 h window", async () => {
  const kv = createMemoryKv();
  const deferred: (() => Promise<void>)[] = [];
  const alert = createAlerter({ kv, log: () => undefined, emailEnabled: true, subjectPrefix: "", footer: "", scope: "live", send: async () => true, defer: (t) => deferred.push(t) });
  await alert("S", ["l"], { key: "k" });
  assert.equal(deferred.length, 1, "sent after the response (after()), not inline");
  assert.equal(await kv.get(keys.alerted("live", "k")), "sending");
  // The deferred task never ran (function killed): the claim expires on its own; nothing stays "delivered".
  await deferred[0]();
  assert.equal(await kv.get(keys.alerted("live", "k")), "1");
  // Outside a request scope after() throws: the alerter sends inline instead.
  let inline = 0;
  const fallback = createAlerter({
    kv,
    log: () => undefined,
    emailEnabled: true,
    subjectPrefix: "",
    footer: "",
    scope: "live",
    send: async () => {
      inline++;
      return true;
    },
    defer: () => {
      throw new Error("after() was called outside a request scope");
    },
  });
  await fallback("T", ["l"]);
  assert.equal(inline, 1);
});

test("a CRITICAL alert is stored until delivered and re-sent by the sweeper (guest paid for a cancelled hold)", async () => {
  const { kit, sessionId, reservationId } = await heldAndOpen();
  kit.fakeCb.reservations.get(reservationId)!.status = "canceled";
  kit.fakeStripe.complete(sessionId);
  kit.mail.ok = false; // the relay and SMTP are both down
  const out = await fulfilSession(sessionId, kit.deps);
  assert.equal(out.state, "needs_attention");
  assert.equal(kit.alerts.length, 0, "nothing delivered");
  assert.ok(kit.logs.some((l) => l.message === "alert_send_failed"));
  const pending = await kit.deps.kv.zrangeByScore(keys.pendingAlertIndex(keyScope(kit.config.paymentMode)), 0, Number.MAX_SAFE_INTEGER, 10);
  assert.deepEqual(pending, [`attention:${sessionId}`]);
  // Later fulfil calls return early from the done marker - only the sweeper can re-send it.
  await fulfilSession(sessionId, kit.deps);

  // Sweeper while mail is still down: counted, still pending.
  kit.now.ms += 10 * 60_000;
  const s1 = await runSweep(kit.deps);
  assert.equal(s1.undeliveredAlerts, 1);
  assert.equal(kit.alerts.length, 0);

  kit.mail.ok = true;
  const s2 = await runSweep(kit.deps);
  assert.equal(s2.undeliveredAlerts, 1);
  const urgent = kit.alerts.filter((a) => a.severity === "critical");
  assert.equal(urgent.length, 1);
  assert.match(urgent[0].subject, /URGENT: paid booking .* needs attention/);
  assert.match(urgent[0].lines.join(" "), /CANCELLED/);
  assert.match(urgent[0].lines.join(" "), /Re-sent by the booking sweeper/);

  const s3 = await runSweep(kit.deps);
  assert.equal(s3.undeliveredAlerts, 0, "delivered: no longer pending");
  assert.equal(kit.alerts.filter((a) => a.severity === "critical").length, 1, "sent once");
});

test("a key-less critical alert keeps one record across re-sends", async () => {
  const kv = createMemoryKv();
  let ok = false;
  const alert = createAlerter({ kv, log: () => undefined, emailEnabled: true, subjectPrefix: "", footer: "", scope: "live", send: async () => ok });
  await alert("Critical thing", ["a", "b"], { severity: "critical" });
  const id = pendingAlertId("Critical thing", ["a", "b"], null);
  assert.deepEqual(await kv.zrangeByScore(keys.pendingAlertIndex("live"), 0, Number.MAX_SAFE_INTEGER, 10), [id]);
  assert.equal(await resendPendingAlerts({ kv, alert, log: () => undefined }, "live", Date.now()), 1);
  assert.deepEqual(await kv.zrangeByScore(keys.pendingAlertIndex("live"), 0, Number.MAX_SAFE_INTEGER, 10), [id], "same record, not a new one");
  ok = true;
  await resendPendingAlerts({ kv, alert, log: () => undefined }, "live", Date.now());
  assert.deepEqual(await kv.zrangeByScore(keys.pendingAlertIndex("live"), 0, Number.MAX_SAFE_INTEGER, 10), []);
});

/* ------------------------- postPayment answer lost ------------------------- */

test("postPayment lands AFTER the retry read the folio: the retry waits, so the stay is recorded exactly once", async () => {
  const { kit, sessionId, reservationId } = await heldAndOpen();
  kit.fakeStripe.complete(sessionId);
  kit.fakeCb.failNext("postPayment", "network_late"); // our 15 s timeout fires; Cloudbeds is still committing it
  await assert.rejects(fulfilSession(sessionId, kit.deps));
  const r = kit.fakeCb.reservations.get(reservationId)!;
  assert.equal(r.payments.length, 0, "not on the folio yet");

  // The return page polls 3 s later: the folio still shows nothing, but an attempt is in doubt -> no second post.
  kit.now.ms += 3_000;
  assert.equal((await fulfilSession(sessionId, kit.deps)).state, "in_progress");
  assert.equal(kit.fakeCb.count("postPayment"), 1);

  // Cloudbeds finishes the first request.
  assert.equal(await kit.fakeCb.commitLate(), 1);
  assert.equal(r.payments.length, 1);

  // Webhook retry after the cool-down: the folio now shows it -> confirm, no new payment.
  kit.now.ms += PAYMENT_DOUBT_COOLDOWN_MS;
  const done = await fulfilSession(sessionId, kit.deps);
  assert.equal(done.state, "confirmed");
  assert.equal(r.payments.length, 1);
  assert.equal(kit.fakeCb.count("postPayment"), 1);
  assert.equal(kit.fakeCb.balance(reservationId), 0);
});

test("postPayment that never landed is posted once more after the cool-down; a clear refusal is retried at once", async () => {
  const { kit, sessionId, reservationId } = await heldAndOpen();
  kit.fakeStripe.complete(sessionId);
  kit.fakeCb.failNext("postPayment", "network"); // never reached Cloudbeds - but we can't tell
  await assert.rejects(fulfilSession(sessionId, kit.deps));
  kit.now.ms += 60_000;
  assert.equal((await fulfilSession(sessionId, kit.deps)).state, "in_progress");
  kit.now.ms += PAYMENT_DOUBT_COOLDOWN_MS;
  assert.equal((await fulfilSession(sessionId, kit.deps)).state, "confirmed");
  assert.equal(kit.fakeCb.reservations.get(reservationId)!.payments.length, 1);
  assert.ok(kit.logs.some((l) => l.message === "fulfil_payment_reposted"));

  // A refusal (success:false) is not ambiguous: the next caller posts straight away.
  const b = await heldAndOpen();
  b.kit.fakeStripe.complete(b.sessionId);
  b.kit.fakeCb.failNext("postPayment", "rejected", "Payment method not found");
  await assert.rejects(fulfilSession(b.sessionId, b.kit.deps));
  assert.equal((await fulfilSession(b.sessionId, b.kit.deps)).state, "confirmed");
  assert.equal(b.kit.fakeCb.reservations.get(b.reservationId)!.payments.length, 1);
});

test("after an unclear postPayment, a folio whose paid amount can't be read goes to the owner - never a guessed second payment", async () => {
  const { kit, sessionId, reservationId } = await heldAndOpen();
  kit.fakeStripe.complete(sessionId);
  kit.fakeCb.failNext("postPayment", "network_after"); // landed, answer lost
  await assert.rejects(fulfilSession(sessionId, kit.deps));
  kit.fakeCb.setOpaqueFolio(true);
  kit.now.ms += PAYMENT_DOUBT_COOLDOWN_MS + 60_000;
  const out = await fulfilSession(sessionId, kit.deps);
  assert.equal(out.state, "needs_attention");
  assert.equal(kit.fakeCb.reservations.get(reservationId)!.payments.length, 1, "no second payment");
  const urgent = kit.alerts.find((a) => a.severity === "critical");
  assert.match(urgent?.lines.join(" ") ?? "", /PAYMENT RECORD IN DOUBT/);
});

/* ---------------------------- folio figures ---------------------------- */

test("balanceDetailed as an object OR an array (v1.3 oneOf); an unreadable paid figure is unknown, never 0", async () => {
  const none = { subTotal: null, additionalItems: null, taxesFees: null };
  assert.deepEqual(readBalanceDetailed({ paid: "100.00", grandTotal: 300 }), { paid: 10_000, grandTotal: 30_000, ...none });
  assert.deepEqual(readBalanceDetailed([{ paid: "100.00", grandTotal: 300 }, { paid: 50, grandTotal: "200.50" }]), { paid: 15_000, grandTotal: 50_050, ...none });
  assert.deepEqual(readBalanceDetailed([{ paid: 1 }, { grandTotal: 2 }]), { paid: null, grandTotal: null, ...none });
  assert.deepEqual(readBalanceDetailed(undefined), { paid: null, grandTotal: null, ...none });
  assert.deepEqual(readBalanceDetailed([]), { paid: null, grandTotal: null, ...none });

  const answer = (data: unknown) => (async () => Response.json({ success: true, data })) as unknown as typeof fetch;
  const w = (data: unknown) => createCloudbedsWriter({ apiKey: "k", propertyId: "1", fetchImpl: answer(data), budget: null });
  const arr = await w({ reservationID: "1", status: "not_confirmed", balance: 0, balanceDetailed: [{ paid: 150, grandTotal: 150 }] }).getReservation("1");
  assert.equal(arr.paidSatang, 15_000);
  assert.equal(arr.grandTotalSatang, 15_000);
  // No balanceDetailed: derived from total - balance.
  const derived = await w({ reservationID: "1", status: "not_confirmed", total: 300, balance: 100 }).getReservation("1");
  assert.equal(derived.paidSatang, 20_000);
  const unknown = await w({ reservationID: "1", status: "not_confirmed" }).getReservation("1");
  assert.equal(unknown.paidSatang, null);
});

test("release refuses (and alerts) when the folio's payments can't be read", async () => {
  const { kit, reservationId } = await heldAndOpen();
  kit.fakeCb.setOpaqueFolio(true);
  const out = await releaseHold(reservationId, kit.deps, "test");
  assert.equal(out.state, "refused_paid");
  assert.equal(kit.fakeCb.reservations.get(reservationId)!.status, "not_confirmed", "nothing cancelled");
  assert.ok(kit.alerts.some((a) => a.subject.includes("payments could not be read")));
});

/* ----------------------------- sweeper ----------------------------- */

test("sweeper: a failing Cloudbeds listing is not a sweep - lastSweep untouched, intents counted, alert after a few runs", async () => {
  const kit = makeKit();
  await recordIntent(kit.deps.kv, { ref: "MSV-20261005-QQQQ", identifier: "MSV-20261005-QQQQ-TEST", mode: kit.config.paymentMode, createdAt: kit.now.ms, reservationId: null });
  kit.now.ms += STALE_HOLD_MS + 60_000;
  for (let i = 1; i <= CLOUDBEDS_FAILURE_ALERT_RUNS; i++) {
    kit.fakeCb.failNext("getReservations", "http500");
    const s = await runSweep(kit.deps);
    assert.equal(s.cloudbedsOk, false);
    assert.equal(s.openHolds, 1, "the unresolved intent is still open");
    assert.equal(await kit.deps.kv.get(keys.lastSweep(keyScope(kit.config.paymentMode))), null);
    assert.equal(kit.alerts.some((a) => a.subject.includes("cannot read Cloudbeds")), i === CLOUDBEDS_FAILURE_ALERT_RUNS);
  }
  const ok = await runSweep(kit.deps);
  assert.equal(ok.cloudbedsOk, true);
  assert.equal(await kit.deps.kv.get(keys.lastSweep(keyScope(kit.config.paymentMode))), String(kit.now.ms));
  assert.equal(await kit.deps.kv.get(keys.sweepCloudbedsFailures(keyScope(kit.config.paymentMode))), null, "the failure streak resets");
});

test("sweeper: an intent never matched in Cloudbeds is dropped after 12 h WITH an alert naming the ref", async () => {
  const kit = makeKit();
  await recordIntent(kit.deps.kv, { ref: "MSV-20261005-ZZZZ", identifier: "MSV-20261005-ZZZZ-TEST", mode: kit.config.paymentMode, createdAt: kit.now.ms, reservationId: null });
  kit.now.ms += INTENT_GIVE_UP_MS + 60_000;
  await runSweep(kit.deps);
  assert.deepEqual(await openIntents(kit), []);
  const alert = kit.alerts.find((a) => a.subject.includes("no Cloudbeds reservation found"));
  assert.ok(alert);
  assert.match(alert.lines.join(" "), /MSV-20261005-ZZZZ-TEST/);
});

test("sweeper: an orphan found through its intent keeps the intent's age - a failed release alerts at once and is retried", async () => {
  const kit = makeKit();
  const body = await pricedBody(kit);
  kit.fakeCb.failNext("postReservation", "network_after"); // created, answer lost
  assert.equal((await runCheckout(body, kit.checkoutDeps())).status, 502);
  const [orphan] = [...kit.fakeCb.reservations.values()];
  kit.now.ms += STALE_HOLD_MS + 5 * 60_000; // 45 min: past the session lifetime, under the 60 min alert age
  kit.fakeCb.failNext("getReservation", "http500"); // the release fails this run
  const s1 = await runSweep(kit.deps);
  assert.equal(orphan.status, "confirmed");
  assert.equal(s1.errors, 1);
  assert.ok(kit.alerts.some((a) => a.subject.includes("could not be released")), "alerted although younger than 60 min");
  assert.deepEqual(await openIntents(kit), [], "the intent became a hold record");
  assert.ok(await kit.deps.kv.get(keys.hold(orphan.reservationID)));

  // Next run: aged by the intent (Cloudbeds' own Bangkok-time stamp would read 7 h too young).
  await runSweep(kit.deps);
  assert.equal(orphan.status, "canceled");
});

/* ------------------------- checkout: hold refusals ------------------------- */

test("'Rate is not available' while a fresh read shows the room free -> setup alert + 'message us', never 'just booked'", async () => {
  const kit = makeKit();
  const body = await pricedBody(kit);
  kit.fakeCb.failNext("postReservation", "rejected", "Rate is not available");
  const res = await runCheckout(body, kit.checkoutDeps());
  assert.equal(res.status, 503);
  assert.equal(res.body.ok ? "" : res.body.error, "payment_unavailable");
  assert.doesNotMatch(res.body.ok ? "" : res.body.message, /just been booked/);
  assert.ok(kit.alerts.some((a) => a.subject.includes("Cloudbeds refused the reservation")));
});

test("postReservation with an id but no readable total: read back once; still unreadable -> the hold is cancelled at once", async () => {
  const kit = makeKit();
  kit.fakeCb.failNext("postReservation", "no_total");
  const res = await checkout(kit);
  assert.equal(res.status, 200, "the total was read back with getReservation");

  const kit2 = makeKit();
  const body = await pricedBody(kit2);
  kit2.fakeCb.failNext("postReservation", "no_total", undefined, () => kit2.fakeCb.setOpaqueFolio(true));
  const res2 = await runCheckout(body, kit2.checkoutDeps());
  assert.equal(res2.status, 502);
  const [r] = [...kit2.fakeCb.reservations.values()];
  assert.equal(r.status, "canceled", "cancelled now, not left for the sweeper");
  assert.deepEqual(await openIntents(kit2), [], "nothing left unresolved");
  assert.equal(kit2.fakeStripe.calls.filter((c) => c.method === "POST").length, 0);
  assert.ok(kit2.alerts.some((a) => a.subject.includes("no price for the hold")));
});

test("Stripe's maximum charge is checked before any Cloudbeds write (a long stay in the whole villa)", async () => {
  const kit = makeKit({ cb: { roomTypes: { ...ROOM_TYPES, "501425": { rate: 45_000, rateId: "rate-m1", units: 1, maxGuests: 10 } } } });
  const villa: CartItemInput[] = [{ slug: "magic-1-villa", ratePlanId: "standard", adults: 2, addonIds: [] }];
  const body = await pricedBody(kit, villa, { checkIn: FAR_CHECKIN, checkOut: "2027-12-04" }); // 24 nights x 45,000 x 1.05
  const res = await runCheckout(body, kit.checkoutDeps());
  assert.equal(res.status, 422);
  assert.match(res.body.ok ? "" : res.body.message, /WhatsApp/);
  assert.equal(kit.fakeCb.count("postReservation"), 0, "nothing reserved");
  assert.deepEqual(await openIntents(kit), []);
});

/* ---------------------------- the time budget ---------------------------- */

test("time budget: no hold is started without time to finish it; a hold that runs late is given back before the Stripe call", async () => {
  const kit = makeKit();
  const body = await pricedBody(kit);
  const wall = { ms: 1_000_000 };
  const tight = await runCheckout(body, { ...kit.checkoutDeps(), clock: () => wall.ms, deadlineMs: wall.ms + HOLD_MIN_REMAINING_MS - 1 });
  assert.equal(tight.status, 503);
  assert.equal(kit.fakeCb.count("postReservation"), 0);
  assert.deepEqual(await openIntents(kit), []);

  // postReservation takes 20 s of a 25 s budget: the Stripe call can't fit -> hold cancelled, 503.
  kit.fakeCb.failNext("postReservation", "pass", undefined, () => {
    wall.ms += 20_000;
  });
  const late = await runCheckout(body, { ...kit.checkoutDeps(), clock: () => wall.ms, deadlineMs: wall.ms + 25_000 });
  assert.equal(late.status, 503);
  const [r] = [...kit.fakeCb.reservations.values()];
  assert.equal(r.status, "canceled");
  assert.equal(kit.fakeStripe.calls.filter((c) => c.method === "POST").length, 0);
  assert.ok(kit.logs.some((l) => l.message === "checkout_out_of_time"));
});

/* -------------------- our own holds block overlapping carts -------------------- */

test("our open hold blocks an overlapping combination cart even when Cloudbeds' availability lags", async () => {
  // tower-club-3br shares the Honeymoon unit; the fake (like a lagging Cloudbeds read) doesn't reflect the honeymoon hold on it.
  const kit = makeKit({ cb: { roomTypes: { ...ROOM_TYPES, "575061": { rate: 20_000, rateId: "rate-tc", units: 1 } } } });
  const tower: CartItemInput[] = [{ slug: "tower-club-3br", ratePlanId: "standard", adults: 2, addonIds: [] }];
  const towerBody = await pricedBody(kit, tower);
  await heldAndOpen(kit); // Honeymoon held, guest on the Stripe page
  assert.deepEqual(await slugsOverlappingOpenHolds(kit.deps.kv, tower, FAR_CHECKIN, FAR_CHECKOUT, kit.now.ms), ["tower-club-3br"]);
  const res = await runCheckout(towerBody, kit.checkoutDeps());
  assert.equal(res.status, 409);
  assert.equal(res.body.ok ? "" : res.body.error, "unavailable");
  assert.equal(kit.fakeCb.count("postReservation"), 1, "only the honeymoon hold was ever written");
  // Other dates are fine.
  assert.deepEqual(await slugsOverlappingOpenHolds(kit.deps.kv, tower, FAR_CHECKOUT, "2027-11-20", kit.now.ms), []);
});

/* ------------------------------ client brake ------------------------------ */

test("client brake: guests sharing one IP (hotel Wi-Fi, carrier NAT) don't lock each other out", async () => {
  // Live kit: no Stage B guard, so any guest email may book.
  const kit = makeKit({ env: STRIPE_LIVE_ENV });
  const garden: CartItemInput[] = [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
  const near = { checkIn: "2026-11-10", checkOut: "2026-11-12" };
  const body = await pricedBody(kit, garden, near);
  const deps = { ...kit.checkoutDeps(), clientIp: "198.51.100.7" };
  const book = async (email: string) => {
    const r = await runCheckout({ ...body, guest: { ...GUEST, email } }, deps);
    if (r.status === 200) await releaseHold((r.body as CheckoutSuccess).holdReservationId!, kit.deps, "test");
    return r;
  };
  for (let i = 0; i < MAX_HOLDS_PER_CLIENT; i++) assert.equal((await book("first@example.com")).status, 200);
  const over = await book("first@example.com");
  assert.equal(over.status, 429);
  assert.equal(over.body.ok ? null : over.body.retryAfterMinutes, CLIENT_BRAKE_MINUTES);
  assert.doesNotMatch(over.body.ok ? "" : over.body.message, /Too many booking attempts from this connection/);
  // Another guest on the same connection still gets through...
  assert.equal((await book("second@example.com")).status, 200);
  // ...until the connection itself reaches its (higher) cap.
  let last = 200;
  for (let i = 0; i < MAX_HOLDS_PER_IP; i++) last = (await book(`guest${i}@example.com`)).status;
  assert.equal(last, 429);
  assert.equal(kit.logText().includes("198.51.100.7"), false, "the IP is never logged");
});

/* ------------------------------ Upstash counter ------------------------------ */

test("Upstash incr is one atomic call that also heals a counter left without a TTL", async () => {
  const values = new Map<string, number>();
  const ttls = new Map<string, number>();
  const evals: string[] = [];
  const client = {
    eval: async (script: string, k: string[], args: string[]) => {
      evals.push(script);
      assert.equal(script, INCR_WITH_TTL);
      const n = (values.get(k[0]) ?? 0) + 1;
      values.set(k[0], n);
      if (!ttls.has(k[0])) ttls.set(k[0], Number(args[0]));
      return n;
    },
  } as unknown as UpstashClient;
  const kv = createUpstashKv({ url: "https://x.upstash.io", token: "t" }, client);
  // A counter an older, non-atomic INCR left without a TTL.
  values.set("c", 7);
  assert.equal(await kv.incr("c", 2400), 8);
  assert.equal(ttls.get("c"), 2400, "TTL set although the key already existed");
  assert.equal(await kv.incr("fresh", 60), 1);
  assert.equal(ttls.get("fresh"), 60);
  assert.equal(evals.length, 2, "one round trip per call");
  assert.match(INCR_WITH_TTL, /ttl/);
  assert.match(INCR_WITH_TTL, /expire/);
});

/* ------------------------- checkout: Cloudbeds reads ------------------------- */

test("restrictions that can't be evaluated are logged and alerted (once per room type); repeated read failures alert the owner", async () => {
  const kit = makeKit();
  const body = await pricedBody(kit);
  const unchecked = { ...kit.deps, restrictions: async () => ({ ok: true as const, checked: false }) };
  const res = await runCheckout(body, { ...kit.checkoutDeps(), stripe: unchecked });
  assert.equal(res.status, 200, "availability itself is live: the booking goes ahead");
  assert.ok(kit.logs.some((l) => l.message === "restrictions_unchecked"));
  assert.equal(kit.alerts.filter((a) => a.subject.includes("Stay rules not checked")).length, 1);

  const kit2 = makeKit();
  const body2 = await pricedBody(kit2);
  const failing = {
    ...kit2.deps,
    restrictions: async () => {
      throw new Error("getRatePlans HTTP 403");
    },
  };
  for (let i = 0; i < READ_FAILURE_ALERT_COUNT; i++) {
    const r = await runCheckout(body2, { ...kit2.checkoutDeps(), stripe: failing });
    assert.equal(r.status, 503);
    assert.equal(kit2.alerts.some((a) => a.subject.includes("Cloudbeds availability can't be read")), i === READ_FAILURE_ALERT_COUNT - 1);
  }
  assert.equal(kit2.fakeCb.count("postReservation"), 0);
});

test("Cloudbeds reads retry once after a 429, honouring Retry-After (capped)", async () => {
  const waits: number[] = [];
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    return Response.json({ success: true, data: [{ rateID: "r", roomTypeID: "462958", roomRateDetailed: [{ date: "2027-11-10", minLos: 0 }] }] });
  }) as unknown as typeof fetch;
  const r = await cloudbedsRestrictions("462958", "r", "2027-11-10", "2027-11-12", 2, { apiKey: "k", propertyId: "1", fetchImpl, sleep: async (ms) => void waits.push(ms) });
  assert.deepEqual(r, { ok: true, checked: true });
  assert.deepEqual(waits, [1000]);
  assert.equal(calls, 2);
  // Twice in a row: the second 429 is an error (no endless retries).
  calls = 0;
  const always429 = (async () => {
    calls++;
    return new Response("{}", { status: 429, headers: { "retry-after": "30" } });
  }) as unknown as typeof fetch;
  waits.length = 0;
  await assert.rejects(cloudbedsRestrictions("462958", "r", "2027-11-10", "2027-11-12", 2, { apiKey: "k", propertyId: "1", fetchImpl: always429, sleep: async (ms) => void waits.push(ms) }));
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000], "Retry-After capped");
});

/* ------------------------------ guest names ------------------------------ */

test("names typed with an ideographic space or full-width letters are accepted and sent normalised", async () => {
  const { normalizeName, validateGuest } = await import("./guest.ts");
  const { parseGuestInput } = await import("./validate.ts");
  assert.equal(normalizeName("Taro　Jr."), "Taro Jr.");
  assert.equal(normalizeName("  Ｍａｒｉａ  "), "Maria");
  assert.equal(validateGuest({ ...GUEST, firstName: "Taro　Jr." }).firstName, undefined);
  assert.equal(validateGuest({ ...GUEST, firstName: "R2D2" }).firstName, "Please use letters, spaces, apostrophes or hyphens only.");
  const parsed = parseGuestInput({ ...GUEST, firstName: "Taro　Jr.", lastName: "Yamada " });
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.equal(parsed.value.firstName, "Taro Jr.");
    assert.equal(parsed.value.lastName, "Yamada");
  }
});

/* ------------------------ analytics gate + claims ------------------------ */

test("the preview is tracked only while it takes real payments (stripe-live on production)", async () => {
  const { getPublicBookingConfig } = await import("./config.ts");
  const { STRIPE_TEST_ENV } = await import("./testkit.ts");
  assert.equal(getPublicBookingConfig(STRIPE_LIVE_ENV).live, true, "Stage C / soft launch on /booking-preview reach GA4");
  assert.equal(getPublicBookingConfig(STRIPE_TEST_ENV).live, false);
  assert.equal(getPublicBookingConfig({}).live, false, "default (demo): untracked");
  assert.equal(getPublicBookingConfig({ ...STRIPE_LIVE_ENV, BOOKING_ALLOW_LIVE_PAYMENTS: "false" }).live, false, "emergency stop: untracked");
  assert.equal(getPublicBookingConfig({ ...STRIPE_LIVE_ENV, VERCEL_ENV: "preview" }).live, false);
});

test("landing descriptions drop the best-rate promise only while the own engine serves /booking", async () => {
  const { descriptionForEngine, landings } = await import("../../data/landings.ts");
  for (const t of Object.values(landings)) {
    assert.equal(descriptionForEngine(t, false), t.description);
    assert.notEqual(descriptionForEngine(t, true), t.description, `${t.code}: clause found and replaced`);
  }
});

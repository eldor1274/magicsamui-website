// End-to-end Stripe hold-first flow against the in-repo fakes: real SDK,
// real Cloudbeds writer, real checkout/fulfil/release/webhook code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runCheckout } from "./checkout.ts";
import { createCloudbedsWriter } from "./cloudbedsWrite.ts";
import { getCatalogueRoom } from "./catalogue.ts";
import { abandonSession, fulfilSession, releaseHold, releaseSession } from "./fulfil.ts";
import { keys } from "./lock.ts";
import { handleStripeWebhook } from "./stripeWebhook.ts";
import { verifyBookingToken } from "./token.ts";
import type { CheckoutSuccess } from "./types.ts";
import { FAR_CHECKIN, FAR_CHECKOUT, GUEST, HONEYMOON, NOW, STRIPE_TEST_ENV, TEST_EMAIL, checkout, makeKit, request, serverQuote, sessionIdOf } from "./testkit.ts";

async function heldAndOpen() {
  const kit = makeKit();
  const res = await checkout(kit);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  return { kit, body, sessionId: sessionIdOf(body), reservationId: body.holdReservationId as string };
}

test("checkout holds first: Cloudbeds reservation (pending, MSV ref, no email) then a Stripe session for rooms + 5% fee", async () => {
  const { kit, body, sessionId, reservationId } = await heldAndOpen();
  assert.equal(body.provider, "stripe");
  assert.equal(body.paymentMode, "stripe-test");
  assert.match(body.redirectUrl, /^https:\/\/checkout\.stripe\.com\//);

  // The hold: exact room type + priced rate, guest details, our ref, no Cloudbeds email.
  const post = kit.fakeCb.calls.find((c) => c.method === "postReservation");
  assert.ok(post);
  assert.equal(post.params["rooms[0][roomTypeID]"], "462958");
  assert.equal(post.params["rooms[0][roomRateID]"], "rate-hm");
  assert.equal(post.params["adults[0][quantity]"], "2");
  assert.equal(post.params["children[0][quantity]"], "0");
  // Outside live the identifier is tagged, so a live sweeper never touches a test hold (and staff can tell them apart).
  assert.equal(post.params.thirdPartyIdentifier, `${body.ref}-TEST`);
  assert.equal(post.params.sendEmailConfirmation, "false");
  assert.equal(post.params.guestEmail, TEST_EMAIL);
  assert.equal(post.params.guestZip, "84320");
  assert.equal(post.params.guestPhone, "+66 952466011");
  assert.equal(post.params.estimatedArrivalTime, "15:00");
  const res = kit.fakeCb.reservations.get(reservationId);
  assert.equal(res?.status, "not_confirmed", "an unpaid hold is marked Confirmation pending");
  assert.match(res?.notes.join("\n") ?? "", /Late dinner please/);
  assert.match(res?.notes[0] ?? "", /^TEST MODE - NOT REAL MONEY\. Online booking MSV-/);

  // The session: satang 1:1, rooms + openly shown fee, no PII in metadata.
  const s = kit.fakeStripe.session(sessionId);
  assert.ok(s);
  const rooms = 3 * 9000_00;
  const fee = Math.round(rooms * 0.05);
  assert.equal(body.quote.cardFeePct, 5);
  assert.equal(body.quote.depositPct, 100);
  assert.equal(s.amount_total, rooms + fee);
  assert.equal(s.currency, "thb");
  assert.deepEqual(
    s.line_items_input.map((l) => l.unit_amount),
    [rooms, fee],
  );
  assert.match(s.line_items_input[1].name, /^Payment processing fee \(5%\)$/);
  assert.equal(s.client_reference_id, body.ref);
  assert.equal(s.customer_email, TEST_EMAIL);
  assert.equal(s.submit_type, "book");
  assert.deepEqual(s.allowed_payment_method_types, ["card", "promptpay"]);
  assert.equal(s.metadata.msv_cb_reservation_id, reservationId);
  assert.equal(s.metadata.msv_total_satang, String(rooms + fee));
  const metaText = JSON.stringify(s.metadata) + JSON.stringify(s.payment_intent_metadata);
  for (const pii of [GUEST.email, GUEST.lastName, "952466011"]) assert.equal(metaText.includes(pii), false, `metadata leaks ${pii}`);
  // Expiry: 30 minutes (+1 min margin), as a hold timeout.
  assert.equal(s.expires_at, Math.floor(NOW / 1000) + 31 * 60);
  // success_url carries Stripe's placeholder, unencoded.
  assert.match(s.success_url, /&session_id=\{CHECKOUT_SESSION_ID\}$/);

  // No PII in the token, the URLs or the logs.
  const token = new URL(s.success_url.replace("{CHECKOUT_SESSION_ID}", "x")).searchParams.get("t");
  const v = verifyBookingToken(token, kit.config.tokenSecret, NOW);
  assert.ok(v.ok);
  const publicText = JSON.stringify(v.ok ? v.payload : {}) + s.success_url + (s.cancel_url ?? "") + body.redirectUrl + kit.logText();
  for (const pii of [GUEST.email, GUEST.firstName + " ", GUEST.lastName, "952466011", "84320", "Late dinner"]) {
    assert.equal(publicText.includes(pii), false, `leaks ${pii}`);
  }
});

test("the hold takes the unit out of availability; cancelling puts it back", async () => {
  const { kit, reservationId } = await heldAndOpen();
  const again = await runCheckout({ ...request(HONEYMOON), expectedTotalSatang: 1, expectedDueNowSatang: 1 }, kit.checkoutDeps());
  assert.equal(again.body.ok, false);
  if (!again.body.ok) assert.equal(again.body.error, "unavailable");
  await releaseHold(reservationId, kit.deps, "test");
  const after = await checkout(kit);
  assert.equal(after.status, 200);
});

test("paid -> fulfil: fee line + payment (baht) + confirmed, balance 0; replay changes nothing", async () => {
  const { kit, sessionId, reservationId, body } = await heldAndOpen();
  kit.fakeStripe.complete(sessionId);
  const { payload, header } = kit.fakeStripe.signedEvent("checkout.session.completed", sessionId);
  const first = await handleStripeWebhook(payload, header, kit.deps, { nowMs: NOW });
  assert.equal(first.status, 200);
  assert.equal(first.body, "confirmed");

  const r = kit.fakeCb.reservations.get(reservationId);
  assert.ok(r);
  assert.equal(r.status, "confirmed");
  assert.equal(r.payments.length, 1);
  assert.equal(r.payments[0].type, "Stripe(website)", "the exact custom method value, case and punctuation kept");
  // Satang -> baht only at the Cloudbeds boundary: 28,350.00 THB.
  assert.equal(kit.fakeCb.calls.find((c) => c.method === "postPayment")?.params.amount, "28350.00");
  // Test money is labelled as such in the live PMS.
  assert.match(r.payments[0].description, /^TEST MODE - NOT REAL MONEY\. Stripe pi_fake_\w+ charge ch_fake_\w+ session cs_test_fake_\w+ ref MSV-/);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].referenceID, `${body.ref}-fee`);
  assert.equal(kit.fakeCb.calls.find((c) => c.method === "postCustomItem")?.params["items[0][itemPrice]"], "1350.00");
  assert.equal(kit.fakeCb.balance(reservationId), 0);
  assert.ok(kit.alerts.some((a) => a.severity === "info" && a.subject.includes("confirmed")));

  // Replays (Stripe resend, return page, sweeper) change nothing.
  const before = kit.fakeCb.calls.length;
  const replay = await handleStripeWebhook(payload, header, kit.deps, { nowMs: NOW });
  assert.equal(replay.status, 200);
  const again = await fulfilSession(sessionId, kit.deps);
  assert.equal(again.state, "confirmed");
  assert.equal(kit.fakeCb.calls.length, before, "no Cloudbeds call after done");
  assert.equal(kit.fakeCb.count("postPayment"), 1);
});

test("5 concurrent fulfils -> exactly one postPayment and one fee item", async () => {
  const { kit, sessionId, reservationId } = await heldAndOpen();
  kit.fakeStripe.complete(sessionId);
  const results = await Promise.all(Array.from({ length: 5 }, () => fulfilSession(sessionId, kit.deps)));
  assert.equal(kit.fakeCb.count("postPayment"), 1);
  assert.equal(kit.fakeCb.count("postCustomItem"), 1);
  assert.equal(results.filter((r) => r.state === "confirmed").length, 1);
  assert.equal(results.filter((r) => r.state === "in_progress").length, 4);
  assert.equal(kit.fakeCb.balance(reservationId), 0);
  // Later callers see the done marker.
  assert.equal((await fulfilSession(sessionId, kit.deps)).state, "confirmed");
  assert.equal(kit.fakeCb.count("postPayment"), 1);
});

test("duplicate webhooks racing the return page against a SLOW Cloudbeds -> exactly one payment and one fee item", async () => {
  const { kit, sessionId, reservationId } = await heldAndOpen();
  // Every Cloudbeds call takes 25 ms, so the callers below genuinely overlap inside fulfil.
  const slowFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    await new Promise((r) => setTimeout(r, 25));
    return kit.fakeCb.fetch(input, init);
  }) as typeof fetch;
  const deps = {
    ...kit.deps,
    writer: createCloudbedsWriter({ apiKey: "cbat_write_testkit", propertyId: "235064", mode: "mock", fetchImpl: slowFetch, budget: null, log: () => undefined }),
  };
  kit.fakeStripe.complete(sessionId);
  const delivery = (type: string) => {
    const { payload, header } = kit.fakeStripe.signedEvent(type, sessionId);
    return handleStripeWebhook(payload, header, deps, { nowMs: kit.now.ms, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) });
  };
  const [w1, w2, w3, r1, r2, w4] = await Promise.all([
    delivery("checkout.session.completed"),
    delivery("checkout.session.completed"), // Stripe retry / duplicate delivery
    delivery("checkout.session.async_payment_succeeded"),
    fulfilSession(sessionId, deps), // the guest's return page (status)
    fulfilSession(sessionId, deps), // a second tab
    delivery("checkout.session.completed"),
  ]);
  assert.equal(kit.fakeCb.count("postPayment"), 1);
  assert.equal(kit.fakeCb.count("postCustomItem"), 1);
  assert.equal(kit.fakeCb.balance(reservationId), 0);
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "confirmed");
  // Every webhook answers 2xx (waiting for the winner rather than failing), so Stripe stops retrying.
  for (const w of [w1, w2, w3, w4]) assert.equal(w.status, 200, w.body);
  for (const r of [r1, r2]) assert.ok(r.state === "confirmed" || r.state === "in_progress", r.state);
  assert.equal((await fulfilSession(sessionId, deps)).state, "confirmed");
  assert.equal(kit.fakeCb.count("postPayment"), 1);
});

test("a lost postPayment response is not paid twice: the retry sees the folio already paid", async () => {
  const { kit, sessionId, reservationId } = await heldAndOpen();
  kit.fakeStripe.complete(sessionId);
  // Cloudbeds records the payment but the confirm step fails -> fulfil throws, step marker for payment is set.
  kit.fakeCb.failNext("putReservation", "http500");
  await assert.rejects(fulfilSession(sessionId, kit.deps));
  assert.equal(kit.fakeCb.count("postPayment"), 1);
  // Simulate losing our own step marker too (worst case): the folio guard still prevents a second payment.
  await kit.deps.kv.del(keys.fulfilStep(sessionId, "payment"));
  const ok = await fulfilSession(sessionId, kit.deps);
  assert.equal(ok.state, "confirmed");
  assert.equal(kit.fakeCb.count("postPayment"), 1);
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "confirmed");
});

test("Cloudbeds answers success:false with HTTP 200 during fulfil -> webhook 500 (Stripe retries), CRITICAL alert at once, then succeeds", async () => {
  const { kit, sessionId } = await heldAndOpen();
  kit.fakeStripe.complete(sessionId);
  kit.fakeCb.failNext("postPayment", "rejected", "Payment type not found");
  const { payload, header } = kit.fakeStripe.signedEvent("checkout.session.completed", sessionId);
  const failed = await handleStripeWebhook(payload, header, kit.deps, { nowMs: NOW });
  assert.equal(failed.status, 500);
  const failAlerts = kit.alerts.filter((a) => /^URGENT: paid booking MSV-\d{8}-\w{4}: Cloudbeds refused to record the payment$/.test(a.subject));
  assert.equal(failAlerts.length, 1);
  // It names the booking, not only the Stripe session: ref, Cloudbeds reservation and amount.
  assert.match(failAlerts[0].lines.join(" "), /Cloudbeds reservation \S+\) was PAID via Stripe \(THB [\d,.]+/);
  assert.match(failAlerts[0].lines.join(" "), /Do NOT cancel/);
  assert.equal(failAlerts[0].severity, "critical", "a refused payment record repeats on every retry: no 2 h wait");
  const retried = await handleStripeWebhook(payload, header, kit.deps, { nowMs: NOW });
  assert.equal(retried.status, 200);
  assert.equal(kit.fakeCb.count("postPayment"), 2, "first was refused (nothing recorded), second recorded");
  assert.equal(kit.fakeCb.reservations.get(kit.fakeCb.calls.find((c) => c.method === "postPayment")!.params.reservationID)?.payments.length, 1);
});

test("expired session -> hold cancelled; a paid session is NEVER cancelled", async () => {
  const { kit, sessionId, reservationId } = await heldAndOpen();
  kit.fakeStripe.expire(sessionId);
  const { payload, header } = kit.fakeStripe.signedEvent("checkout.session.expired", sessionId);
  const res = await handleStripeWebhook(payload, header, kit.deps, { nowMs: NOW });
  assert.equal(res.status, 200);
  assert.equal(res.body, "released");
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "canceled");
  // Idempotent.
  assert.equal((await releaseSession(sessionId, kit.deps, "again")).state, "already_released");

  const paid = await heldAndOpen();
  paid.kit.fakeStripe.complete(paid.sessionId);
  assert.equal((await releaseSession(paid.sessionId, paid.kit.deps, "x")).state, "refused_paid");
  await fulfilSession(paid.sessionId, paid.kit.deps);
  // Even a direct release by reservation id is refused once paid.
  assert.equal((await releaseHold(paid.reservationId, paid.kit.deps, "x")).state, "refused_paid");
  // A forged "expired" event for a paid session is refused too (release re-reads the session).
  const forged = paid.kit.fakeStripe.signedEvent("checkout.session.expired", paid.sessionId);
  const r2 = await handleStripeWebhook(forged.payload, forged.header, paid.kit.deps, { nowMs: NOW });
  assert.equal(r2.status, 200);
  assert.equal(paid.kit.fakeCb.reservations.get(paid.reservationId)?.status, "confirmed");
});

test("a folio that already shows a payment is never cancelled", async () => {
  const { kit, sessionId, reservationId } = await heldAndOpen();
  await kit.deps.writer.recordPayment({ reservationId, amountSatang: 100, method: "cash", description: "front desk" });
  kit.fakeStripe.expire(sessionId);
  assert.equal((await releaseSession(sessionId, kit.deps, "expired")).state, "refused_paid");
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "not_confirmed");
  assert.ok(kit.alerts.some((a) => a.subject.includes("folio shows a payment")));
});

test("delayed payment: completed+unpaid keeps the hold; async failure releases it; async success confirms", async () => {
  const a = await heldAndOpen();
  a.kit.fakeStripe.completeDelayed(a.sessionId);
  let ev = a.kit.fakeStripe.signedEvent("checkout.session.completed", a.sessionId);
  assert.equal((await handleStripeWebhook(ev.payload, ev.header, a.kit.deps, { nowMs: NOW })).body, "awaiting async payment");
  assert.equal(a.kit.fakeCb.reservations.get(a.reservationId)?.status, "not_confirmed");
  a.kit.fakeStripe.asyncFail(a.sessionId);
  ev = a.kit.fakeStripe.signedEvent("checkout.session.async_payment_failed", a.sessionId);
  assert.equal((await handleStripeWebhook(ev.payload, ev.header, a.kit.deps, { nowMs: NOW })).body, "released");
  assert.equal(a.kit.fakeCb.reservations.get(a.reservationId)?.status, "canceled");

  const b = await heldAndOpen();
  b.kit.fakeStripe.completeDelayed(b.sessionId);
  b.kit.fakeStripe.asyncSucceed(b.sessionId);
  ev = b.kit.fakeStripe.signedEvent("checkout.session.async_payment_succeeded", b.sessionId);
  assert.equal((await handleStripeWebhook(ev.payload, ev.header, b.kit.deps, { nowMs: NOW })).body, "confirmed");
  assert.equal(b.kit.fakeCb.reservations.get(b.reservationId)?.status, "confirmed");
});

test("guest Cancel: abandon expires the session and releases the hold; a paid session is fulfilled instead", async () => {
  const { kit, sessionId, reservationId, body } = await heldAndOpen();
  assert.deepEqual(await abandonSession(sessionId, kit.deps, body.ref), { state: "released" });
  assert.equal(kit.fakeStripe.session(sessionId)?.status, "expired");
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "canceled");
  // Another booking's token can't cancel this session.
  const other = await heldAndOpen();
  assert.deepEqual(await abandonSession(other.sessionId, other.kit.deps, "MSV-20261005-AAAA"), { state: "closed" });
  assert.equal(other.kit.fakeStripe.session(other.sessionId)?.status, "open");
  // Paid in another tab -> fulfilled, not cancelled.
  other.kit.fakeStripe.complete(other.sessionId);
  assert.deepEqual(await abandonSession(other.sessionId, other.kit.deps, other.body.ref), { state: "paid" });
  assert.equal(other.kit.fakeCb.reservations.get(other.reservationId)?.status, "confirmed");
});

test("abandon: an unknown session is closed (nothing to pay or expire); a Stripe outage is an error, never 'released'", async () => {
  const { kit, sessionId, reservationId, body } = await heldAndOpen();
  assert.deepEqual(await abandonSession("cs_test_doesnotexist0000000000", kit.deps, body.ref), { state: "closed" });
  // Stripe down while checking the real session: the caller must hear an error (the page then refuses
  // to open a second payable session) and the hold is left for the expiry webhook / sweeper.
  kit.fakeStripe.failNext(/^GET \/v1\/checkout\/sessions\//, 500);
  await assert.rejects(() => abandonSession(sessionId, kit.deps, body.ref));
  assert.equal(kit.fakeStripe.session(sessionId)?.status, "open");
  assert.notEqual(kit.fakeCb.reservations.get(reservationId)?.status, "canceled");
});

test("price assert: Cloudbeds grandTotal != quote -> hold cancelled, price_changed, nothing sent to Stripe", async () => {
  const kit = makeKit({ cb: { pricer: ({ rooms, startDate }) => (rooms.length && startDate ? 27_300 : 0) } });
  const res = await checkout(kit);
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  if (res.body.ok) return;
  assert.equal(res.body.error, "price_changed");
  assert.equal(res.body.quote, undefined, "no stale quote to re-show");
  const [r] = [...kit.fakeCb.reservations.values()];
  assert.equal(r.status, "canceled");
  assert.equal(kit.fakeStripe.calls.filter((c) => c.method === "POST").length, 0);
  assert.ok(kit.alerts.some((a) => a.subject.includes("price differs")));
});

test("Stripe failure after the hold -> the hold is cancelled, upstream_error, nothing charged", async () => {
  const kit = makeKit();
  const req = request(HONEYMOON);
  const quote = await serverQuote(kit, req);
  kit.fakeStripe.failNext(/^POST \/v1\/checkout\/sessions$/, 500);
  const res = await runCheckout({ ...req, expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang }, kit.checkoutDeps());
  assert.equal(res.status, 502);
  assert.equal(res.body.ok ? "" : res.body.error, "upstream_error");
  assert.equal([...kit.fakeCb.reservations.values()][0].status, "canceled");
});

test("Cloudbeds refuses the hold (success:false, HTTP 200) -> unavailable, no session; a timeout -> upstream_error", async () => {
  const kit = makeKit();
  const req = request(HONEYMOON);
  const quote = await serverQuote(kit, req);
  const body = { ...req, expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang };
  // An OTA booking takes the last unit just before our hold: the refusal is real, and a fresh read confirms it.
  let ota = "";
  kit.fakeCb.failNext("postReservation", "rejected", "No availability", () => {
    ota = kit.fakeCb.book("462958", FAR_CHECKIN, FAR_CHECKOUT);
  });
  const refused = await runCheckout(body, kit.checkoutDeps());
  assert.equal(refused.status, 409);
  assert.equal(refused.body.ok ? "" : refused.body.error, "unavailable");
  assert.equal(kit.alerts.length, 0, "a confirmed sell-out is not a setup alert");
  kit.fakeCb.reservations.get(ota)!.status = "canceled";
  kit.fakeCb.failNext("postReservation", "network");
  const timeout = await runCheckout(body, kit.checkoutDeps());
  assert.equal(timeout.status, 502);
  assert.equal(kit.fakeStripe.calls.filter((c) => c.method === "POST").length, 0);
});

test("test-mode guard: real Cloudbeds writes need arrival 12+ months out AND the owner's test email", async () => {
  const kit = makeKit();
  const soon = await runCheckout({ ...request(HONEYMOON, { checkIn: "2027-03-01", checkOut: "2027-03-04" }), expectedTotalSatang: 1, expectedDueNowSatang: 1 }, kit.checkoutDeps());
  assert.equal(soon.body.ok, false);
  // Price check comes first; use the real price to reach the guard.
  const reqSoon = request(HONEYMOON, { checkIn: "2027-03-01", checkOut: "2027-03-04" });
  const q = await serverQuote(kit, reqSoon);
  const guarded = await runCheckout({ ...reqSoon, expectedTotalSatang: q.totalSatang, expectedDueNowSatang: q.dueNowSatang }, kit.checkoutDeps());
  assert.equal(guarded.status, 403);
  assert.equal(guarded.body.ok ? "" : guarded.body.error, "test_mode_restricted");

  const wrongEmail = await checkout(kit, HONEYMOON, { guest: { ...GUEST, email: "someone@example.com" } } as never);
  assert.equal(wrongEmail.status, 403);
  assert.equal(kit.fakeCb.count("postReservation"), 0, "no hold was written");

  const ok = await checkout(kit, HONEYMOON, { checkIn: FAR_CHECKIN });
  assert.equal(ok.status, 200);

  // Without BOOKING_TEST_GUEST_EMAIL every real hold is refused.
  const noEmail = makeKit({ env: { ...STRIPE_TEST_ENV, BOOKING_TEST_GUEST_EMAIL: undefined } });
  const refused = await checkout(noEmail);
  assert.equal(refused.status, 403);
});

test("restrictions are enforced before the hold (minimum stay)", async () => {
  const kit = makeKit();
  const items = [{ slug: "seaview-2br", ratePlanId: "standard" as const, adults: 2, addonIds: [] }];
  const res = await checkout(kit, items);
  assert.equal(res.status, 409);
  assert.match(res.body.ok ? "" : res.body.message, /minimum stay of 5 nights/);
  assert.equal(kit.fakeCb.count("postReservation"), 0);
});

test("stripe checkout needs valid guest details, Standard Rate only, and ignores ?promo=DIRECT", async () => {
  const kit = makeKit();
  const noGuest = await runCheckout({ ...request(HONEYMOON), guest: undefined, expectedTotalSatang: 1, expectedDueNowSatang: 1 }, kit.checkoutDeps());
  assert.equal(noGuest.status, 400);
  const badEmail = await runCheckout({ ...request(HONEYMOON), guest: { ...GUEST, email: "nope" }, expectedTotalSatang: 1, expectedDueNowSatang: 1 }, kit.checkoutDeps());
  assert.equal(badEmail.status, 400);
  const breakfast = await runCheckout(
    { ...request([{ slug: "honeymoon-suite", ratePlanId: "breakfast", adults: 2, addonIds: [] }]), expectedTotalSatang: 1, expectedDueNowSatang: 1 },
    kit.checkoutDeps(),
  );
  assert.equal(breakfast.status, 400);
  const withPromo = await checkout(kit, HONEYMOON, { promo: "DIRECT" });
  assert.equal(withPromo.status, 200);
  assert.equal((withPromo.body as CheckoutSuccess).quote.promo, null);
  assert.equal(kit.fakeCb.count("postReservation"), 1);
  void getCatalogueRoom;
});

test("webhook: unknown events and sessions that are not ours (shared Cloudbeds account) are acknowledged and ignored", async () => {
  const { kit, sessionId } = await heldAndOpen();
  const s = kit.fakeStripe.session(sessionId)!;
  s.metadata = {}; // someone else's session on the same account
  kit.fakeStripe.complete(sessionId);
  const ev = kit.fakeStripe.signedEvent("checkout.session.completed", sessionId);
  const res = await handleStripeWebhook(ev.payload, ev.header, kit.deps, { nowMs: NOW });
  assert.equal(res.status, 200);
  assert.equal(res.body, "not ours");
  assert.equal(kit.fakeCb.count("postPayment"), 0);
  const other = kit.fakeStripe.signedEvent("payment_intent.created", sessionId);
  assert.equal((await handleStripeWebhook(other.payload, other.header, kit.deps, { nowMs: NOW })).body, "ignored");
});

test("paid but the hold was cancelled in the meantime -> needs_attention + critical alert, no payment posted", async () => {
  const { kit, sessionId, reservationId } = await heldAndOpen();
  kit.fakeCb.reservations.get(reservationId)!.status = "canceled";
  kit.fakeStripe.complete(sessionId);
  const out = await fulfilSession(sessionId, kit.deps);
  assert.equal(out.state, "needs_attention");
  assert.equal(kit.fakeCb.count("postPayment"), 0);
  assert.ok(kit.alerts.some((a) => a.severity === "critical" && a.subject.includes("needs attention")));
  // Reported once: later calls read the done marker.
  await fulfilSession(sessionId, kit.deps);
  assert.equal(kit.alerts.filter((a) => a.severity === "critical").length, 1);
});

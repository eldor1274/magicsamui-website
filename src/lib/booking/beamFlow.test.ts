// The Beam checkout (design S4.3): startBeamCheckout - the hold-first core (holdFirstCheckout.ts) with
// beamCheckoutAdapter (payments/beamCheckoutAdapter.ts) - driven directly on the in-repo fake Beam and the fake
// Cloudbeds (beamTestkit.ts makeBeamKit), with the real Cloudbeds writer, alerter, gateway and sweeper; and, since
// design S4.6, through runCheckout (checkout.ts, the checkout route's path: beamTestkit.ts beamRunCheckout).
//
// Covered: the happy path for card_ewallet and for PromptPay (the hold and its -B-TEST identifier, the folio read
// back, the link request per group with the fee item only on card_ewallet, the signed note, the PaymentRecord and
// its links-open entry, the hold record and pointer, the hold note's Beam deadline); the adapter's words; a price
// mismatch; link 5xx and 4xx; a lost answer retried with the same key; a create lost twice (the hold cancelled, and a
// charge that ever appears on that link found by the sweeper's charge scan -> the cancelled-hold CRITICAL); afterCreate
// failures; a crash after the page; the test guard; the PromptPay switch; the circuit breaker; the budget; no personal
// data anywhere. Through runCheckout (S4.6): both method groups, the method required (and refused while switched off)
// before anything is read, written or sent, a method/fee mismatch, the maximum charge, DIRECT, a code plan (LONGSTAY),
// an automatic discount, availability and checkout on the same Cloudbeds reads, the paused answer and missing deps.
// A Stripe request carrying payMethod is unaffected: feeByMethod.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOffers, getInventory, promoAskFor } from "./availability.ts";
import { BEAM_MAX_CHARGE_SATANG } from "./beam.ts";
import type { BeamCreatePaymentLinkRequest } from "./beam.ts";
import { beamCheckoutAdapter, startBeamCheckout } from "./beamCheckout.ts";
import { BEAM_LIVE_ENV, BEAM_MERCHANT_ID, BEAM_TEST_ENV, beamCheckout, beamHeld, beamQuote, beamRequest, beamRunCheckout, beamServerQuote, makeBeamKit } from "./beamTestkit.ts";
import type { BeamKit } from "./beamTestkit.ts";
import { POLICY_VERSION } from "./catalogue.ts";
import { CHOOSE_PAY_METHOD, runCheckout } from "./checkout.ts";
import type { StripeCheckoutInput } from "./checkoutShared.ts";
import { getInventoryConfig } from "./config.ts";
import { addDays, todayInBangkok } from "./dates.ts";
import { fulfilPayment } from "./fulfil.ts";
import { DEFAULT_CLOSED_WORD, DEFAULT_HOLD_NOTE_DEADLINE } from "./holdFirstCheckout.ts";
import type { CheckoutPageInput } from "./holdFirstCheckout.ts";
import { createMemoryKv } from "./kv.ts";
import type { KvStore } from "./kv.ts";
import { keyScope, keys, readJson } from "./lock.ts";
import type { HoldRecord } from "./lock.ts";
import { FAKE_DIRECT_PROMO_CODE, FAKE_LONGSTAY_PROMO_CODE, fakeLongStayCodePlan, fakeLongTermPlan } from "./mock/fakeCloudbeds.ts";
import { BEAM_PAUSED_MESSAGE, beamHoldNoteDeadline } from "./payments/beamCheckoutAdapter.ts";
import { readRecord, verifyBeamNote } from "./payments/beamRecord.ts";
import { runSweep } from "./sweep.ts";
import { FAR_CHECKIN, FAR_CHECKOUT, GUEST, HONEYMOON, NOW, ORIGIN, ROOM_TYPES, TEST_EMAIL, TOKEN_SECRET, recordingKv } from "./testkit.ts";
import { idempotencyKeyFor, verifyBookingToken } from "./token.ts";
import type { BookingSummary, CartItemInput, PayMethod } from "./types.ts";
import { beamCancelUrl, beamReturnUrl } from "./urls.ts";

const MIN = 60_000;
const SCOPE = keyScope("beam-playground");
const DEADLINE = "after 30 minutes (up to 50 minutes while a PromptPay or wallet payment is still being confirmed)";
const POST_LINK = /^POST \/api\/v1\/payment-links$/;
const PAGE_FAILED = "Booking stopped: Beam could not create the payment page";
const PAUSED_ALERT = "Beam payment pages are failing: Beam checkout paused for 5 minutes";
/** Other units than the default honeymoon suite (a held unit is no longer for sale on those dates). */
const GARDEN: CartItemInput[] = [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
const SUNRISE: CartItemInput[] = [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];

const onlyReservation = (kit: BeamKit) => {
  const all = [...kit.fakeCb.reservations.values()];
  assert.equal(all.length, 1, `expected one reservation, got ${all.length}`);
  return all[0];
};
const refOf = (kit: BeamKit) => (onlyReservation(kit).thirdPartyIdentifier ?? "").replace(/-B-TEST$/, "");
const linkPosts = (kit: BeamKit) => kit.fakeBeam.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/payment-links");
const members = (kit: BeamKit, key: string) => kit.deps.kv.zrangeByScore(key, 0, Number.MAX_SAFE_INTEGER, 1000);
const withSubject = (kit: BeamKit, subject: string) => kit.alerts.filter((a) => a.subject === subject);
const logged = (kit: BeamKit, message: string) => kit.logs.filter((l) => l.message === message);
const basePathOf = (kit: BeamKit) => (kit.config.bookingEngine === "own" ? "/booking" : "/booking-preview");

/** The checkout input for a cart at the server's price for `payMethod`. */
async function checkoutInput(kit: BeamKit, payMethod: PayMethod, over: Partial<StripeCheckoutInput> = {}): Promise<StripeCheckoutInput> {
  const { quote, inventory, dataSource } = await beamQuote(kit, payMethod);
  return { checkIn: FAR_CHECKIN, checkOut: FAR_CHECKOUT, items: HONEYMOON, guest: GUEST, quote, inventory, dataSource, today: todayInBangkok(new Date(kit.now.ms)), ...over };
}

/** The kit with a recording KV on the kit's clock (every write, in order). */
function recordedKit(env = BEAM_TEST_ENV): { kit: BeamKit; kv: ReturnType<typeof recordingKv> } {
  const now = { ms: NOW };
  const kv = recordingKv(createMemoryKv(() => now.ms));
  return { kit: makeBeamKit({ env, kv, now }), kv };
}

/** Beam's answer to the next `n` link creates is lost after Beam made the link (a timeout on our side). */
function loseCreateAnswers(kit: BeamKit, n: number): void {
  const inner = kit.deps.fetchImpl as typeof fetch;
  let left = n;
  kit.deps.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const answer = await inner(input, init);
    if ((init?.method ?? "GET") === "POST" && left > 0) {
      left--;
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    return answer;
  }) as typeof fetch;
}

/* ----------------------------------------- happy path ----------------------------------------- */

for (const payMethod of ["card_ewallet", "promptpay"] as const) {
  test(`happy path, ${payMethod}: hold, folio check, the group's link with the signed note, record, links-open, pointer, the Beam deadline`, async () => {
    const kit = makeBeamKit();
    const res = await startBeamCheckout(await checkoutInput(kit, payMethod), kit.checkoutContext(), payMethod);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.ok);
    const body = res.body;
    const { quote } = body;
    const reservationId = body.holdReservationId as string;

    // The hold: a -B-TEST identifier, marked "Confirmation pending", its folio read back before the page.
    const hold = onlyReservation(kit);
    assert.equal(hold.reservationID, reservationId);
    assert.match(hold.thirdPartyIdentifier ?? "", /^MSV-\d{8}-[A-HJ-NP-Z2-9]{4}-B-TEST$/);
    assert.equal(hold.thirdPartyIdentifier, `${body.ref}-B-TEST`);
    assert.equal(hold.status, "not_confirmed");
    const methods = kit.fakeCb.calls.map((c) => c.method);
    assert.ok(methods.indexOf("getReservation") > methods.indexOf("postReservation"), methods.join(","));
    assert.ok(
      hold.notes[0].startsWith(`TEST MODE - NOT REAL MONEY. Online booking ${body.ref} via magicsamui.com (Beam). Awaiting payment - the hold is cancelled automatically if unpaid ${DEADLINE}.`),
      hold.notes[0],
    );
    assert.ok(!hold.notes[0].includes("if unpaid after 30 minutes."), "never Stripe's bare deadline");

    // The link request: one, with the attempt's key, for exactly what is due, offering only the group.
    const posts = linkPosts(kit);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].idempotencyKey, idempotencyKeyFor(body.ref, "beam-playground", "kit-nonce-1"));
    const req = posts[0].body as BeamCreatePaymentLinkRequest;
    assert.equal(req.order.currency, "THB");
    assert.equal(req.order.netAmount, quote.dueNowSatang);
    assert.equal(req.order.referenceId, body.ref);
    assert.deepEqual(req.linkSettings, payMethod === "card_ewallet" ? { card: { isEnabled: true }, eWallets: { isEnabled: true } } : { qrPromptPay: { isEnabled: true } });
    const feeItems = req.order.orderItems.filter((i) => i.itemName.startsWith("Payment processing fee"));
    if (payMethod === "card_ewallet") {
      assert.ok(quote.cardFeeSatang > 0);
      assert.deepEqual(feeItems, [{ itemName: "Payment processing fee (3%)", price: quote.cardFeeSatang, quantity: 1 }]);
    } else {
      assert.equal(quote.cardFeeSatang, 0, "PromptPay is fee-free (owner decision 1)");
      assert.deepEqual(feeItems, []);
    }
    assert.equal(req.order.orderItems.reduce((s, i) => s + i.price * i.quantity, 0), req.order.netAmount);
    assert.equal(req.collectPhoneNumber, false);
    assert.equal(req.collectDeliveryAddress, false);
    const expiresAt = NOW + 30 * MIN;
    assert.equal(req.expiresAt, new Date(expiresAt).toISOString());

    // Return and Cancel: the own page with the ref and the booking token (no payment id; Beam adds none).
    const back = new URL(req.redirectUrl);
    assert.deepEqual([...back.searchParams.keys()], ["ref", "t"]);
    const t = back.searchParams.get("t") ?? "";
    assert.equal(req.redirectUrl, beamReturnUrl(ORIGIN, basePathOf(kit), body.ref, t));
    assert.equal(req.redirectUrl, `${ORIGIN}${basePathOf(kit)}/return?ref=${body.ref}&t=${t}`);
    assert.equal(req.cancelUrl, beamCancelUrl(ORIGIN, basePathOf(kit), body.ref, t));
    assert.equal(req.cancelUrl, `${ORIGIN}${basePathOf(kit)}?resume=payment&reason=cancelled&ref=${body.ref}&t=${t}`);
    const pageToken = verifyBookingToken(t, TOKEN_SECRET, NOW);
    assert.ok(pageToken.ok);
    assert.equal(pageToken.payload.paymentLinkId, null);
    assert.equal(pageToken.payload.booking.ref, body.ref);

    // The link, its record (708 days) and its links-open entry (score = the link's expiresAt).
    const linkId = new URL(body.redirectUrl).pathname.split("/").pop() ?? "";
    assert.equal(kit.fakeBeam.links.size, 1);
    assert.equal(body.redirectUrl, kit.fakeBeam.link(linkId).url);
    assert.equal(new URL(body.redirectUrl).host, "playground-pay.beamcheckout.com");
    assert.equal(kit.fakeBeam.link(linkId).expiresAtMs, expiresAt);
    const record = await readRecord(kit.deps.kv, linkId);
    assert.deepEqual(record, {
      v: 1,
      linkId,
      ref: body.ref,
      reservationId,
      roomsSatang: quote.roomsSubtotalSatang,
      feeSatang: quote.cardFeeSatang,
      totalSatang: quote.totalSatang,
      payMethod,
      checkIn: FAR_CHECKIN,
      checkOut: FAR_CHECKOUT,
      mode: "beam-playground",
      merchantId: BEAM_MERCHANT_ID,
      arrivalLate: false,
      hasRequests: true,
      noteSaved: true,
      termsVersion: POLICY_VERSION,
      createdAt: NOW,
      expiresAt,
    });
    assert.ok(record);
    const facts = Object.fromEntries(Object.entries(record).filter(([k]) => !["v", "linkId", "merchantId", "createdAt"].includes(k)));
    assert.deepEqual(verifyBeamNote(req.order.internalNote, TOKEN_SECRET), facts, "the signed note carries the record's facts");
    assert.deepEqual(await kit.deps.kv.zrangeByScore(keys.beamLinksOpen(SCOPE), expiresAt, expiresAt, 10), [linkId]);

    // The hold record and the pointer name the payment's key; the link token carries the bare link id.
    const key = `beam:${linkId}`;
    assert.equal((await readJson<HoldRecord>(kit.deps.kv, keys.hold(reservationId)))?.sessionId, key);
    assert.deepEqual(await readJson(kit.deps.kv, keys.booking(body.ref)), { sessionId: key, reservationId });
    const linkToken = verifyBookingToken(body.linkToken, TOKEN_SECRET, NOW);
    assert.ok(linkToken.ok);
    assert.equal(linkToken.payload.paymentLinkId, linkId);
    assert.equal(body.provider, "beam");
    assert.equal(body.paymentMode, "beam-playground");
    assert.equal(body.expiresAt, new Date(expiresAt).toISOString());

    // The gateway reads it as an open payment of ours; nothing alerted; the breaker untouched.
    const payment = await kit.gw.get(key);
    assert.equal(payment.state, "open");
    assert.equal(payment.meta?.ref, body.ref);
    assert.equal(kit.alerts.length, 0, JSON.stringify(kit.alerts));
    assert.equal(await kit.deps.kv.get(keys.beamPageFail(SCOPE)), null);
    assert.ok(logged(kit, "beam_session_created").some((l) => l.data?.sessionId === key && l.data?.amount === quote.dueNowSatang));
  });
}

test("beamCheckoutAdapter sets Beam's words (both), the maximum charge and the mode's hosted host; the grace sets the deadline", () => {
  const kit = makeBeamKit();
  const a = beamCheckoutAdapter(kit.deps, kit.beam, { origin: ORIGIN, nowMs: NOW, payMethod: "card_ewallet" });
  assert.equal(a.provider, "beam");
  assert.equal(a.brand, "Beam");
  assert.equal(a.maxChargeSatang, BEAM_MAX_CHARGE_SATANG);
  assert.equal(a.holdNoteDeadline, DEADLINE);
  assert.equal(a.closedWord, "disabled");
  assert.notEqual(a.holdNoteDeadline, DEFAULT_HOLD_NOTE_DEADLINE);
  assert.notEqual(a.closedWord, DEFAULT_CLOSED_WORD);
  assert.equal(typeof a.beforeHold, "function");
  assert.equal(typeof a.afterCreate, "function");

  assert.equal(a.isAllowedUrl(`https://playground-pay.beamcheckout.com/${BEAM_MERCHANT_ID}/rGtqz6DafS`), true);
  for (const url of [
    null,
    `https://pay.beamcheckout.com/${BEAM_MERCHANT_ID}/rGtqz6DafS`,
    `http://playground-pay.beamcheckout.com/${BEAM_MERCHANT_ID}/rGtqz6DafS`,
    "https://playground-pay.beamcheckout.com.evil.example/x",
    "https://playground-pay.beamcheckout.com:8443/x",
    "https://user:pw@playground-pay.beamcheckout.com/x",
    "not a url",
  ]) {
    assert.equal(a.isAllowedUrl(url), false, String(url));
  }
  const live = makeBeamKit({ env: BEAM_LIVE_ENV });
  const l = beamCheckoutAdapter(live.deps, live.beam, { origin: ORIGIN, nowMs: NOW, payMethod: "promptpay" });
  assert.equal(l.isAllowedUrl(`https://pay.beamcheckout.com/${BEAM_MERCHANT_ID}/rGtqz6DafS`), true);
  assert.equal(l.isAllowedUrl(`https://playground-pay.beamcheckout.com/${BEAM_MERCHANT_ID}/rGtqz6DafS`), false);
  assert.equal(l.holdNoteDeadline, DEADLINE);

  // The deadline follows BEAM_PENDING_GRACE_MINUTES.
  const slow = makeBeamKit({ env: { ...BEAM_TEST_ENV, BEAM_PENDING_GRACE_MINUTES: "30" } });
  assert.equal(
    beamCheckoutAdapter(slow.deps, slow.beam, { origin: ORIGIN, nowMs: NOW, payMethod: "card_ewallet" }).holdNoteDeadline,
    "after 30 minutes (up to 60 minutes while a PromptPay or wallet payment is still being confirmed)",
  );
  assert.equal(beamHoldNoteDeadline({ pendingGraceMinutes: 20 }), DEADLINE);
});

test("beam-live: a '-B' hold without the TEST label, the live hosted page, the same deadline", async () => {
  const kit = makeBeamKit({ env: BEAM_LIVE_ENV });
  const h = await beamHeld(kit);
  const hold = onlyReservation(kit);
  assert.equal(hold.thirdPartyIdentifier, `${h.ref}-B`);
  assert.ok(hold.notes[0].startsWith(`Online booking ${h.ref} via magicsamui.com (Beam). Awaiting payment - the hold is cancelled automatically if unpaid ${DEADLINE}.`), hold.notes[0]);
  assert.equal(new URL(h.body.redirectUrl).host, "pay.beamcheckout.com");
  assert.equal(linkPosts(kit)[0].idempotencyKey, idempotencyKeyFor(h.ref, "beam-live", "kit-nonce-1"));
  assert.deepEqual(await members(kit, keys.beamLinksOpen(keyScope("beam-live"))), [h.linkId]);
});

test("the theme travels on both URLs; a non-Beam config is refused before anything is held", async () => {
  const kit = makeBeamKit();
  const res = await startBeamCheckout(await checkoutInput(kit, "card_ewallet", { theme: "classic" }), kit.checkoutContext(), "card_ewallet");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const req = linkPosts(kit)[0].body as BeamCreatePaymentLinkRequest;
  assert.equal(new URL(req.redirectUrl).searchParams.get("theme"), "classic");
  assert.equal(new URL(req.cancelUrl).searchParams.get("theme"), "classic");

  const { kit: other, kv } = recordedKit();
  const input = await checkoutInput(other, "card_ewallet");
  const ctx = other.checkoutContext();
  for (const config of [{ ...ctx.deps.config, beam: null }, { ...ctx.deps.config, provider: "stripe" as const }]) {
    const refused = await startBeamCheckout(input, { ...ctx, deps: { ...ctx.deps, config } }, "card_ewallet");
    assert.equal(refused.status, 503, `provider ${config.provider}, beam ${config.beam ? "set" : "null"}`);
  }
  assert.deepEqual(kv.writes, []);
  assert.equal(other.fakeCb.reservations.size, 0);
  assert.equal(other.fakeBeam.calls.length, 0);
});

test("BEAM_EWALLETS=off (owner decision 2's emergency switch): the card_ewallet link offers cards only, at the card fee", async () => {
  const kit = makeBeamKit({ env: { ...BEAM_TEST_ENV, BEAM_EWALLETS: "off" } });
  assert.equal(kit.beam.ewallets, false);
  const h = await beamHeld(kit, "card_ewallet");
  const req = linkPosts(kit)[0].body as BeamCreatePaymentLinkRequest;
  assert.deepEqual(req.linkSettings, { card: { isEnabled: true }, eWallets: { isEnabled: false } });
  assert.ok(req.order.orderItems.some((i) => i.itemName === "Payment processing fee (3%)" && i.price === h.quote.cardFeeSatang));
});

/* ------------------------------------- failures before the page ------------------------------------- */

test("a price mismatch cancels the hold before any Beam call (409 price_changed)", async () => {
  const kit = makeBeamKit({ cb: { pricer: ({ rooms, startDate }) => (rooms.length && startDate ? 27_300 : 0) } });
  const res = await beamCheckout(kit);
  assert.equal(res.status, 409);
  assert.ok(!res.body.ok);
  assert.equal(res.body.error, "price_changed");
  assert.equal(onlyReservation(kit).status, "canceled");
  assert.equal(kit.fakeBeam.calls.length, 0, "nothing sent to Beam");
  assert.deepEqual(await members(kit, keys.beamLinksOpen(SCOPE)), []);
  assert.ok(kit.alerts.some((a) => a.subject === "Booking stopped: Cloudbeds price differs from the quote"));
});

test("the test guard (another email, no staff cookie, an arrival under 12 months) refuses before any write or Beam call", async () => {
  const cases: [string, (input: StripeCheckoutInput) => StripeCheckoutInput, boolean][] = [
    ["another email", (i) => ({ ...i, guest: { ...GUEST, email: "someone-else@example.com" } }), true],
    ["no staff cookie", (i) => i, false],
    ["an arrival under 12 months", (i) => ({ ...i, checkIn: "2027-02-10", checkOut: "2027-02-13" }), true],
  ];
  for (const [label, edit, cookie] of cases) {
    const { kit, kv } = recordedKit();
    const input = edit(await checkoutInput(kit, "card_ewallet"));
    const at = kit.fakeCb.calls.length;
    const ctx = kit.checkoutContext();
    const res = await startBeamCheckout(input, cookie ? ctx : { ...ctx, testAccessToken: null }, "card_ewallet");
    assert.equal(res.status, 403, label);
    assert.ok(!res.body.ok);
    assert.equal(res.body.error, "test_mode_restricted", label);
    assert.deepEqual(kv.writes, [], `${label}: no KV write`);
    assert.deepEqual(kit.fakeCb.calls.slice(at), [], `${label}: no Cloudbeds call`);
    assert.equal(kit.fakeBeam.calls.length, 0, `${label}: no Beam call`);
  }
});

test("BEAM_PROMPTPAY=off: a promptpay checkout started directly makes no Beam call and leaves no open hold; card_ewallet still books", async () => {
  const kit = makeBeamKit({ env: { ...BEAM_TEST_ENV, BEAM_PROMPTPAY: "off" } });
  assert.equal(kit.beam.promptPay, false);
  const res = await beamCheckout(kit, "promptpay");
  assert.equal(res.status, 502);
  assert.equal(kit.fakeBeam.calls.length, 0, "no Beam call");
  const hold = onlyReservation(kit);
  assert.equal(hold.status, "canceled");
  assert.deepEqual(await members(kit, keys.holdIndex()), [], "no open hold");
  assert.deepEqual(await members(kit, keys.beamLinksOpen(SCOPE)), []);
  assert.equal(await kit.deps.kv.get(keys.beamPageFail(SCOPE)), null, "our own refusal is not a Beam failure");
  const alert = withSubject(kit, PAGE_FAILED)[0];
  assert.ok(alert, kit.alerts.map((a) => a.subject).join(" | "));
  assert.equal(
    alert.lines[0],
    `Booking ${refOf(kit)}: the Beam payment link was not requested (RangeError: Beam promptpay payments are switched off). The hold was cancelled and nothing was charged.`,
  );
  assert.ok(logged(kit, "beam_session_failed").some((l) => l.data?.errorCode === "NOT_SENT"));

  const h = await beamHeld(kit, "card_ewallet");
  assert.deepEqual((linkPosts(kit)[0].body as BeamCreatePaymentLinkRequest).linkSettings, { card: { isEnabled: true }, eWallets: { isEnabled: true } });
  assert.equal(kit.fakeBeam.link(h.linkId).status, "ACTIVE");
});

/* ------------------------------------- the payment page fails ------------------------------------- */

test("link 5xx (the same-key retry fails too) and 4xx (never retried) cancel the hold and alert", async () => {
  const cases: { label: string; fail: (kit: BeamKit) => void; posts: number; line: string; key: string }[] = [
    {
      label: "5xx",
      fail: (kit) => {
        kit.fakeBeam.failNext(POST_LINK, 500);
        kit.fakeBeam.failNext(POST_LINK, 503);
      },
      posts: 2,
      line: "(no error code, HTTP 503)",
      key: "HTTP_503",
    },
    { label: "4xx", fail: (kit) => kit.fakeBeam.failNext(POST_LINK, 403, "NO_PERMISSION_ERROR"), posts: 1, line: "(NO_PERMISSION_ERROR, HTTP 403)", key: "NO_PERMISSION_ERROR" },
  ];
  for (const c of cases) {
    const kit = makeBeamKit();
    c.fail(kit);
    const res = await beamCheckout(kit);
    assert.equal(res.status, 502, c.label);
    assert.ok(!res.body.ok);
    assert.equal(res.body.error, "upstream_error");
    const posts = linkPosts(kit);
    assert.equal(posts.length, c.posts, c.label);
    assert.equal(new Set(posts.map((p) => p.idempotencyKey)).size, 1, `${c.label}: one key for the attempt`);
    assert.equal(kit.fakeBeam.links.size, 0);
    const hold = onlyReservation(kit);
    assert.equal(hold.status, "canceled", c.label);
    assert.ok(hold.notes.includes("Hold cancelled by the booking page before any payment: beam session failed. Nothing was charged."), hold.notes.join("\n"));
    const alert = withSubject(kit, PAGE_FAILED)[0];
    assert.ok(alert, c.label);
    assert.equal(alert.lines[0], `Booking ${refOf(kit)}: Beam refused or failed to create the payment link ${c.line}. The hold was cancelled and nothing was charged.`);
    assert.equal(alert.lines[1], "If this repeats, every online booking is failing: check the Beam keys, the merchant status and the enabled methods in Lighthouse.");
    assert.notEqual(await kit.deps.kv.get(keys.alerted(SCOPE, `beam-link-fail:${c.key}`)), null, `${c.label}: alert key beam-link-fail:${c.key}`);
    assert.deepEqual(await members(kit, keys.beamLinksOpen(SCOPE)), []);
    assert.equal(await kit.deps.kv.get(keys.beamPageFail(SCOPE)), "1", `${c.label}: counted once`);
    assert.equal(await kit.deps.kv.get(keys.beamPaused(SCOPE)), null);
  }
});

test("a lost answer (timeout after Beam made the link) is retried once with the same key: one link, booked normally", async () => {
  const kit = makeBeamKit();
  loseCreateAnswers(kit, 1);
  const res = await beamCheckout(kit);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.ok);
  const posts = linkPosts(kit);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].idempotencyKey, posts[1].idempotencyKey);
  assert.deepEqual(posts[0].body, posts[1].body, "the same body: Beam answers the stored create");
  assert.equal(kit.fakeBeam.links.size, 1, "Beam made one link");
  const [linkId] = [...kit.fakeBeam.links.keys()];
  assert.equal(res.body.redirectUrl, kit.fakeBeam.link(linkId).url);
  assert.ok(await readRecord(kit.deps.kv, linkId));
  assert.deepEqual(await members(kit, keys.beamLinksOpen(SCOPE)), [linkId]);
  assert.equal(await kit.deps.kv.get(keys.beamPageFail(SCOPE)), null, "a created link is no failure");
  assert.equal(kit.alerts.length, 0);
});

test("a create lost twice cancels the hold; a charge that ever appears on that link is found by the scan -> the cancelled-hold CRITICAL", async () => {
  const kit = makeBeamKit();
  const inner = kit.deps.fetchImpl;
  loseCreateAnswers(kit, 2);
  const res = await beamCheckout(kit);
  assert.equal(res.status, 502);
  assert.equal(linkPosts(kit).length, 2);
  const hold = onlyReservation(kit);
  assert.equal(hold.status, "canceled");
  const ref = refOf(kit);
  const alert = withSubject(kit, PAGE_FAILED)[0];
  assert.equal(alert?.lines[0], `Booking ${ref}: Beam refused or failed to create the payment link (TIMEOUT, no HTTP answer). The hold was cancelled and nothing was charged.`);
  assert.equal(await kit.deps.kv.get(keys.beamPageFail(SCOPE)), "1");

  // Beam made the link: never handed out, never tracked, but signed.
  assert.equal(kit.fakeBeam.links.size, 1);
  const [link] = [...kit.fakeBeam.links.values()];
  assert.equal(link.status, "ACTIVE");
  assert.equal(await readRecord(kit.deps.kv, link.paymentLinkId), null);
  assert.deepEqual(await members(kit, keys.beamLinksOpen(SCOPE)), []);
  const note = verifyBeamNote(link.order.internalNote, TOKEN_SECRET);
  assert.equal(note?.ref, ref);
  assert.equal(note?.reservationId, hold.reservationID);

  // If a charge ever appears on it, the sweeper's charge scan finds the signed note: the CRITICAL of owner decision 3.
  kit.deps.fetchImpl = inner;
  kit.now.ms += 5 * MIN;
  const charge = kit.fakeBeam.pay(link.paymentLinkId, "CARD");
  await runSweep(kit.deps, kit.gw);
  const urgent = kit.alerts.filter((a) => a.severity === "critical");
  assert.equal(urgent.length, 1, JSON.stringify(kit.alerts));
  assert.ok(urgent[0].lines[0].startsWith("The guest PAID but the Cloudbeds hold is CANCELLED."), urgent[0].lines[0]);
  assert.ok(urgent[0].lines[0].includes(`charge ${charge.chargeId}`), urgent[0].lines[0]);
  assert.equal(onlyReservation(kit).status, "canceled", "nothing re-booked automatically");
  assert.equal(kit.fakeCb.calls.filter((c) => c.method === "postPayment").length, 0);
});

/* -------------------------------------- after the page exists -------------------------------------- */

/** A memory KV on `now` whose writes matching `when` throw. */
function failingKv(now: { ms: number }, when: (op: "set" | "zadd", key: string) => boolean): KvStore {
  const inner = createMemoryKv(() => now.ms);
  return {
    ...inner,
    kind: inner.kind,
    async set(key, value, ttl) {
      if (when("set", key)) throw new Error("simulated Redis failure");
      return inner.set(key, value, ttl);
    },
    async zadd(key, score, member) {
      if (when("zadd", key)) throw new Error("simulated Redis failure");
      return inner.zadd(key, score, member);
    },
  };
}

test("an afterCreate failure (the record or the links-open entry) disables the link with a fresh key and cancels the hold", async () => {
  const cases: [string, (op: "set" | "zadd", key: string) => boolean][] = [
    ["the record", (op, key) => op === "set" && key.startsWith("msv:beam:pay:")],
    ["the links-open entry", (op, key) => op === "zadd" && key === keys.beamLinksOpen(SCOPE)],
  ];
  for (const [label, when] of cases) {
    const now = { ms: NOW };
    const kit = makeBeamKit({ kv: failingKv(now, when), now });
    const res = await beamCheckout(kit);
    assert.equal(res.status, 502, label);
    assert.ok(!res.body.ok);
    assert.equal(res.body.error, "upstream_error");
    const [link] = [...kit.fakeBeam.links.values()];
    assert.equal(link.status, "DISABLED", label);
    const patch = kit.fakeBeam.calls.find((c) => c.method === "PATCH");
    assert.match(patch?.idempotencyKey ?? "", new RegExp(`^msv-bd-${link.paymentLinkId}-[0-9a-f]{24}$`), label);
    const hold = onlyReservation(kit);
    assert.equal(hold.status, "canceled", label);
    assert.ok(hold.notes.includes("Hold cancelled by the booking page before any payment: could not finish starting the payment. Nothing was charged."), hold.notes.join("\n"));
    assert.ok(logged(kit, "checkout_after_session_failed").some((l) => l.data?.sessionId === `beam:${link.paymentLinkId}`), label);
    assert.equal(await kit.deps.kv.get(keys.booking(refOf(kit))), null, `${label}: no pointer`);
  }
});

test("a crash after the page: the link is disabled, the hold cancelled, and the alert says 'disabled' (never 'was expired')", async () => {
  const kit = makeBeamKit();
  const input = await checkoutInput(kit, "card_ewallet");
  const log = kit.deps.log;
  kit.deps.log = (message, data) => {
    log(message, data);
    if (message === "beam_session_created") throw new Error("simulated crash after the page");
  };
  const res = await startBeamCheckout(input, kit.checkoutContext(), "card_ewallet");
  assert.equal(res.status, 500);
  const [link] = [...kit.fakeBeam.links.values()];
  assert.equal(link.status, "DISABLED");
  assert.match(kit.fakeBeam.calls.find((c) => c.method === "PATCH")?.idempotencyKey ?? "", new RegExp(`^msv-bd-${link.paymentLinkId}-[0-9a-f]{24}$`));
  const hold = onlyReservation(kit);
  assert.equal(hold.status, "canceled");
  assert.ok(hold.notes[0].includes(`if unpaid ${DEADLINE}.`), hold.notes[0]);
  const alert = withSubject(kit, "Booking stopped: unexpected error after the hold")[0];
  assert.ok(alert, kit.alerts.map((a) => a.subject).join(" | "));
  assert.ok(alert.lines.includes(`The Beam payment page ${link.paymentLinkId} was disabled, the hold was cancelled and nothing was charged.`), alert.lines.join("\n"));
  assert.doesNotMatch(JSON.stringify([kit.alerts, hold.notes]), /was expired|if unpaid after 30 minutes\./);
});

/* ------------------------------------------ circuit breaker ------------------------------------------ */

test("three failed payment pages in a row pause Beam checkout for 5 minutes: the next checkout is refused before any write", async () => {
  const { kit, kv } = recordedKit();
  for (let i = 1; i <= 3; i++) {
    kit.fakeBeam.failNext(POST_LINK, 422, "MERCHANT_STATUS_INVALID_ERROR");
    assert.equal((await beamCheckout(kit)).status, 502, `failure ${i}`);
    assert.equal(await kv.get(keys.beamPageFail(SCOPE)), String(i));
    assert.equal((await kv.get(keys.beamPaused(SCOPE))) !== null, i === 3, `paused after failure ${i}`);
    if (i < 3) kit.now.ms += MIN;
  }
  const pausedAt = kit.now.ms;
  const paused = withSubject(kit, PAUSED_ALERT);
  assert.equal(paused.length, 1);
  assert.equal(paused[0].severity, "warning");
  assert.deepEqual(paused[0].lines, [
    "3 bookings in a row could not create a Beam payment page (latest: MERCHANT_STATUS_INVALID_ERROR, HTTP 422). New Beam checkouts are refused before anything is held for 5 minutes.",
    "If Beam is down (status.beamcheckout.com), set BOOKING_PAYMENT_PROVIDER=stripe and redeploy: in-flight Beam payments are still finished by the Beam drain.",
  ]);
  assert.ok(logged(kit, "beam_checkout_paused").some((l) => l.data?.failures === 3 && l.data?.errorCode === "MERCHANT_STATUS_INVALID_ERROR"));

  // The next checkout, a minute later: refused before any KV write, Cloudbeds call or Beam call.
  kit.now.ms += MIN;
  const input = await checkoutInput(kit, "card_ewallet");
  const at = { kv: kv.writes.length, cb: kit.fakeCb.calls.length, beam: kit.fakeBeam.calls.length, alerts: kit.alerts.length, holds: kit.fakeCb.reservations.size };
  const res = await startBeamCheckout(input, kit.checkoutContext(), "card_ewallet");
  assert.deepEqual(res, { status: 503, body: { ok: false, error: "payment_unavailable", message: BEAM_PAUSED_MESSAGE } });
  assert.equal(
    BEAM_PAUSED_MESSAGE,
    "Online payment is briefly unavailable. Nothing has been reserved or charged. Please book on our classic booking page or message us on WhatsApp.",
  );
  assert.deepEqual(kv.writes.slice(at.kv), [], "no KV write");
  assert.deepEqual(kit.fakeCb.calls.slice(at.cb), [], "no Cloudbeds call");
  assert.equal(kit.fakeBeam.calls.length, at.beam, "no Beam call");
  assert.equal(kit.fakeCb.reservations.size, at.holds, "no hold");
  assert.equal(kit.alerts.length, at.alerts);
  assert.ok(logged(kit, "checkout_refused_before_hold").some((l) => l.data?.provider === "beam" && l.data?.status === 503));

  // Five minutes after the pause began, checkouts go ahead again, and a created link clears the count.
  kit.now.ms = pausedAt + 5 * MIN;
  const h = await beamHeld(kit);
  assert.equal(kit.fakeBeam.link(h.linkId).status, "ACTIVE");
  assert.equal(await kv.get(keys.beamPageFail(SCOPE)), null);
});

test("a create Beam answers 429 (its one retry too) is no outage: never counted toward the pause, even three in a row (round 6)", async () => {
  const kit = makeBeamKit();
  for (let i = 1; i <= 3; i++) {
    kit.fakeBeam.rateLimitNext(2, POST_LINK);
    const res = await beamCheckout(kit);
    assert.equal(res.status, 502, `429 ${i}`);
    assert.equal(await kit.deps.kv.get(keys.beamPageFail(SCOPE)), null, `429 ${i}: not counted`);
    assert.equal(await kit.deps.kv.get(keys.beamPaused(SCOPE)), null, `429 ${i}: no pause`);
    kit.now.ms += MIN;
  }
  assert.equal(withSubject(kit, PAUSED_ALERT).length, 0);
  assert.ok(withSubject(kit, PAGE_FAILED)[0]?.lines[0].includes("TOO_MANY_REQUESTS_ERROR, HTTP 429"), kit.alerts.map((a) => a.lines[0]).join(" | "));
  assert.equal(linkPosts(kit).length, 6, "each create and its one retry");
  // Any other failure still counts.
  kit.fakeBeam.failNext(POST_LINK, 422, "MERCHANT_STATUS_INVALID_ERROR");
  assert.equal((await beamCheckout(kit)).status, 502);
  assert.equal(await kit.deps.kv.get(keys.beamPageFail(SCOPE)), "1");
  const h = await beamHeld(kit);
  assert.equal(kit.fakeBeam.link(h.linkId).status, "ACTIVE", "Beam checkout was never paused");
});

test("only failures in a row inside 5 minutes count: a created link, or a failure outside the window, starts again", async () => {
  const kit = makeBeamKit();
  const failOnce = async () => {
    kit.fakeBeam.failNext(POST_LINK, 400, "API_VALIDATION_ERROR");
    assert.equal((await beamCheckout(kit)).status, 502);
  };
  await failOnce();
  await failOnce();
  assert.equal(await kit.deps.kv.get(keys.beamPageFail(SCOPE)), "2");
  await beamHeld(kit, "card_ewallet", GARDEN);
  assert.equal(await kit.deps.kv.get(keys.beamPageFail(SCOPE)), null, "a created link ends the run");
  await failOnce();
  await failOnce();
  assert.equal(await kit.deps.kv.get(keys.beamPaused(SCOPE)), null);
  // The window runs from the first failure: one 5 minutes later starts a new count.
  kit.now.ms += 5 * MIN;
  await failOnce();
  assert.equal(await kit.deps.kv.get(keys.beamPageFail(SCOPE)), "1");
  assert.equal(await kit.deps.kv.get(keys.beamPaused(SCOPE)), null);
  assert.equal(withSubject(kit, PAUSED_ALERT).length, 0);
});

/* ----------------------------------------- the page directly ----------------------------------------- */

/** createPage's input for a hold the core made (the adapter reads only these fields). */
function pageInput(quote: CheckoutPageInput["quote"], over: Partial<CheckoutPageInput> = {}): CheckoutPageInput {
  return {
    ref: "MSV-20261005-ABCD",
    reservationId: "9900001",
    quote,
    guest: GUEST,
    booking: {} as BookingSummary,
    token: "page-token",
    basePath: "/booking",
    guestFlags: { arrivalLate: false, hasRequests: false, noteSaved: true },
    budgetMs: Number.POSITIVE_INFINITY,
    nonce: () => "direct-nonce",
    ...over,
  };
}

test("createPage: a group the checkout does not take, or a quote with another group's fee, throws before any Beam call", async () => {
  const off = makeBeamKit({ env: { ...BEAM_TEST_ENV, BEAM_PROMPTPAY: "off" } });
  const { quote: free } = await beamQuote(off, "promptpay");
  const a = beamCheckoutAdapter(off.deps, off.beam, { origin: ORIGIN, nowMs: NOW, payMethod: "promptpay" });
  await assert.rejects(() => a.createPage(pageInput(free)), (e: unknown) => e instanceof RangeError && /switched off/.test(e.message));
  assert.equal(off.fakeBeam.calls.length, 0);
  assert.equal(a.errorInfo(new RangeError("x")).errorCode, "NOT_SENT");

  const kit = makeBeamKit();
  const { quote: card } = await beamQuote(kit, "card_ewallet");
  const qr = beamCheckoutAdapter(kit.deps, kit.beam, { origin: ORIGIN, nowMs: NOW, payMethod: "promptpay" });
  await assert.rejects(() => qr.createPage(pageInput(card)), RangeError, "a PromptPay link never carries the card fee");
  assert.equal(kit.fakeBeam.calls.length, 0);
  assert.equal(await kit.deps.kv.get(keys.beamPageFail(SCOPE)), null, "our own refusals are not Beam failures");
});

test("createPage: the same-key retry runs only when it fits the budget; the page names the link by its key", async () => {
  const pauses: number[] = [];
  const kit = makeBeamKit();
  kit.deps.sleep = async (ms: number) => {
    pauses.push(ms);
  };
  const { quote } = await beamQuote(kit, "card_ewallet");
  const a = beamCheckoutAdapter(kit.deps, kit.beam, { origin: ORIGIN, nowMs: NOW, payMethod: "card_ewallet", theme: "classic" });

  kit.fakeBeam.failNext(POST_LINK, 502);
  await assert.rejects(() => a.createPage(pageInput(quote, { budgetMs: 1_000 })));
  assert.equal(linkPosts(kit).length, 1, "no room for a retry inside 1 s");
  assert.deepEqual(pauses, []);

  kit.fakeBeam.failNext(POST_LINK, 502);
  const page = await a.createPage(pageInput(quote, { budgetMs: 25_000 }));
  const posts = linkPosts(kit);
  assert.equal(posts.length, 3, "retried once inside 25 s");
  assert.equal(pauses.length, 1, "one jittered pause, through the gateway's sleep");
  assert.ok(pauses[0] >= 100 && pauses[0] <= 400, String(pauses[0]));
  assert.equal(posts[1].idempotencyKey, posts[2].idempotencyKey);
  assert.equal(posts[2].idempotencyKey, idempotencyKeyFor("MSV-20261005-ABCD", "beam-playground", "direct-nonce"));
  const [linkId] = [...kit.fakeBeam.links.keys()];
  assert.deepEqual(page, { key: `beam:${linkId}`, paymentId: linkId, redirectUrl: kit.fakeBeam.link(linkId).url });
  const req = posts[2].body as BeamCreatePaymentLinkRequest;
  assert.equal(req.redirectUrl, `${ORIGIN}/booking/return?ref=MSV-20261005-ABCD&t=page-token&theme=classic`);
  assert.equal(req.cancelUrl, `${ORIGIN}/booking?resume=payment&reason=cancelled&ref=MSV-20261005-ABCD&t=page-token&theme=classic`);
  // Until afterCreate, nothing of the page is in Redis.
  assert.equal(await readRecord(kit.deps.kv, linkId), null);
  await a.afterCreate?.(page);
  assert.equal((await readRecord(kit.deps.kv, linkId))?.expiresAt, NOW + 30 * MIN);
  assert.deepEqual(await members(kit, keys.beamLinksOpen(SCOPE)), [linkId]);
  await assert.rejects(() => a.afterCreate!({ key: "beam:Zz9Zz9Zz9Z", paymentId: "Zz9Zz9Zz9Z", redirectUrl: null }), /no payment record/);
});

/* ---------------------------------------------- privacy ---------------------------------------------- */

test("no personal data in the logs, the alerts, Redis, the Beam calls or the signed note", async () => {
  const { kit, kv } = recordedKit();
  await beamHeld(kit);
  await beamHeld(kit, "promptpay", GARDEN);
  kit.fakeBeam.failNext(POST_LINK, 500, "INTERNAL_SERVER_ERROR");
  kit.fakeBeam.failNext(POST_LINK, 500, "INTERNAL_SERVER_ERROR");
  assert.equal((await beamCheckout(kit, "card_ewallet", SUNRISE)).status, 502);
  assert.ok(kit.alerts.length >= 1);
  const everything = JSON.stringify([kit.logs, kit.alerts, kv.writes, kit.fakeBeam.calls]);
  for (const pii of [TEST_EMAIL, "Owner", "952466011", "95 246 6011", "+66", "Late dinner"]) assert.ok(!everything.includes(pii), pii);
  for (const call of linkPosts(kit)) {
    const note = (call.body as BeamCreatePaymentLinkRequest).order.internalNote;
    assert.match(note, /^msv1\|m=beam-playground\|r=MSV-\d{8}-[A-HJ-NP-Z2-9]{4}\|res=[A-Za-z0-9_-]+\|rm=\d+\|fee=\d+\|tot=\d+\|ci=[\d-]+\|co=[\d-]+\|pm=(card_ewallet|promptpay)\|tv=[\w.-]*\|fl=[01-]{3}\|ex=\d+\|s=[\w-]{27}$/, note);
  }
});

/* ------------------------- round 5: readings the round-4 tests left open ------------------------- */

test("the circuit breaker failing itself (Redis) never replaces the create's error: the alert names Beam's answer, beam_breaker_failed is logged", async () => {
  const now = { ms: NOW };
  const inner = createMemoryKv(() => now.ms);
  const kv: KvStore = {
    ...inner,
    kind: inner.kind,
    incr: (key, ttl) => (key === keys.beamPageFail(SCOPE) ? Promise.reject(new Error("simulated Redis failure")) : inner.incr(key, ttl)),
  };
  const kit = makeBeamKit({ kv, now });
  kit.fakeBeam.failNext(POST_LINK, 503);
  kit.fakeBeam.failNext(POST_LINK, 503);
  const res = await beamCheckout(kit);
  assert.equal(res.status, 502);
  const alert = withSubject(kit, PAGE_FAILED)[0];
  assert.ok(alert, JSON.stringify(kit.alerts));
  assert.equal(alert.lines[0], `Booking ${refOf(kit)}: Beam refused or failed to create the payment link (no error code, HTTP 503). The hold was cancelled and nothing was charged.`);
  assert.ok(logged(kit, "beam_breaker_failed").some((l) => l.data?.error === "simulated Redis failure"));
  assert.equal(onlyReservation(kit).status, "canceled");
  assert.equal(await kit.deps.kv.get(keys.beamPaused(SCOPE)), null);
});

test("a guest arriving after 11 PM: arrivalLate in the record and the signed note, and the PAID note repeats it (also fulfilled from the note)", async () => {
  for (const source of ["record", "note"] as const) {
    const kit = makeBeamKit();
    const res = await beamCheckout(kit, "card_ewallet", HONEYMOON, { ...GUEST, arrivalTime: "late" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.ok);
    const linkId = new URL(res.body.redirectUrl).pathname.split("/").pop() ?? "";
    assert.equal((await readRecord(kit.deps.kv, linkId))?.arrivalLate, true, source);
    assert.equal(verifyBeamNote(kit.fakeBeam.link(linkId).order.internalNote, TOKEN_SECRET)?.arrivalLate, true, source);
    if (source === "note") await kit.deps.kv.del(keys.beamPayment(linkId));
    kit.fakeBeam.pay(linkId, "CARD");
    assert.equal((await fulfilPayment(`beam:${linkId}`, kit.deps, kit.gw)).state, "confirmed", source);
    const paidNote = onlyReservation(kit).notes.find((n) => n.includes("PAID via Beam"));
    assert.ok(paidNote?.endsWith("\nEstimated arrival: after 11 PM."), `${source}: ${paidNote}`);
  }
});

/* ------------------------- runCheckout: the checkout route's path (design S4.6) ------------------------- */

/** What a Beam checkout without a method group the checkout takes is answered (round-4 amendment). */
const CHOOSE_HOW_TO_PAY = { status: 400, body: { ok: false, error: "invalid_request", message: CHOOSE_PAY_METHOD, fixStep: "payment" } };
const SEVEN_NIGHTS = { checkIn: FAR_CHECKIN, checkOut: addDays(FAR_CHECKIN, 7) };
/** Honeymoon: base 9,000/night. */
const HM_BASE_7 = 7 * 900_000;
const cbWrites = (kit: BeamKit) => kit.fakeCb.calls.filter((c) => !c.method.startsWith("get"));
const postOf = (kit: BeamKit) => kit.fakeCb.calls.find((c) => c.method === "postReservation");
const linkIdOf = (redirectUrl: string) => new URL(redirectUrl).pathname.split("/").pop() ?? "";
/** The booking token on the link's return URL (no payment id). */
const pageTokenOf = (kit: BeamKit, linkId: string) => verifyBookingToken(new URL(kit.fakeBeam.link(linkId).redirectUrl ?? "").searchParams.get("t"), TOKEN_SECRET, kit.now.ms);

test("runCheckout on Beam: card_ewallet and PromptPay go hold-first through startBeamCheckout; both booking tokens carry the method; the guest's details reach Cloudbeds only", async () => {
  for (const payMethod of ["card_ewallet", "promptpay"] as const) {
    const { kit, kv } = recordedKit();
    const res = await beamRunCheckout(kit, HONEYMOON, { payMethod });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.ok);
    const body = res.body;
    assert.equal(body.provider, "beam");
    assert.equal(body.paymentMode, "beam-playground");
    assert.equal(body.dataSource, "cloudbeds");
    // The hold first, with the guest's details (Cloudbeds only), "Confirmation pending".
    const hold = onlyReservation(kit);
    assert.equal(hold.reservationID, body.holdReservationId);
    assert.equal(hold.status, "not_confirmed");
    assert.equal(hold.thirdPartyIdentifier, `${body.ref}-B-TEST`);
    assert.equal(postOf(kit)?.params.guestEmail, TEST_EMAIL);
    // One link of the group, for exactly the quote; PromptPay is fee-free (owner decision 1).
    const posts = linkPosts(kit);
    assert.equal(posts.length, 1);
    const req = posts[0].body as BeamCreatePaymentLinkRequest;
    assert.equal(req.order.netAmount, body.quote.dueNowSatang);
    assert.deepEqual(req.linkSettings, payMethod === "card_ewallet" ? { card: { isEnabled: true }, eWallets: { isEnabled: true } } : { qrPromptPay: { isEnabled: true } });
    assert.equal(body.quote.cardFeeSatang > 0, payMethod === "card_ewallet");
    assert.equal(body.quote.totalSatang - body.quote.cardFeeSatang, 3 * 900_000);
    // The booking summary carries the method, in the page's token and in the link token.
    const linkId = linkIdOf(body.redirectUrl);
    const page = pageTokenOf(kit, linkId);
    assert.ok(page.ok);
    assert.equal(page.payload.paymentLinkId, null);
    assert.equal(page.payload.booking.payMethod, payMethod);
    const link = verifyBookingToken(body.linkToken, TOKEN_SECRET, kit.now.ms);
    assert.ok(link.ok);
    assert.equal(link.payload.paymentLinkId, linkId);
    assert.equal(link.payload.booking.payMethod, payMethod);
    assert.equal((await readRecord(kit.deps.kv, linkId))?.payMethod, payMethod);
    // No personal data reached Beam, Redis or the logs. Each value must stand alone (never inside a longer random id).
    const leaked = JSON.stringify([kit.fakeBeam.calls, kv.writes, kit.logs]);
    for (const pii of [TEST_EMAIL, "Owner", "952466011", "95 246 6011", "Late dinner"]) {
      const alone = new RegExp(`(?<![A-Za-z0-9])${pii.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`);
      assert.ok(!alone.test(leaked), `${payMethod}: ${pii}`);
    }
  }
});

test("runCheckout on Beam without a method (absent, null, ''): 400 'Please choose how to pay' (fixStep payment) before the guest's details, any Cloudbeds call, KV write or Beam call", async () => {
  const { kit, kv } = recordedKit();
  const base = beamRequest();
  const quote = await beamServerQuote(kit, base);
  const priced = { ...base, expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang };
  const cbAt = kit.fakeCb.calls.length;
  const writesAt = kv.writes.length;
  const noMethod: Record<string, unknown> = { ...priced };
  delete noMethod.payMethod;
  for (const [label, body] of [
    ["absent", noMethod],
    ["null", { ...priced, payMethod: null }],
    ["empty", { ...priced, payMethod: "" }],
    ["absent, and no guest details either (the method is asked for first)", { ...noMethod, guest: undefined }],
  ] as const) {
    assert.deepEqual(await runCheckout(body, kit.checkoutDeps()), CHOOSE_HOW_TO_PAY, label);
  }
  assert.deepEqual(kit.fakeCb.calls.slice(cbAt), [], "no Cloudbeds call");
  assert.deepEqual(kv.writes.slice(writesAt), [], "no KV write");
  assert.equal(kit.fakeBeam.calls.length, 0, "no Beam call");
  assert.equal(kit.fakeCb.reservations.size, 0);
  assert.equal(kit.alerts.length, 0);
});

test("runCheckout with BEAM_PROMPTPAY=off: promptpay gets the same 400 with nothing read, written, held or sent; card_ewallet books normally", async () => {
  const now = { ms: NOW };
  const kv = recordingKv(createMemoryKv(() => now.ms));
  const kit = makeBeamKit({ env: { ...BEAM_TEST_ENV, BEAM_PROMPTPAY: "off" }, kv, now });
  assert.deepEqual(await runCheckout(beamRequest(HONEYMOON, { payMethod: "promptpay", expectedTotalSatang: 2_700_000, expectedDueNowSatang: 2_700_000 }), kit.checkoutDeps()), CHOOSE_HOW_TO_PAY);
  assert.deepEqual(kit.fakeCb.calls, [], "no Cloudbeds call");
  assert.deepEqual(kv.writes, [], "no KV write");
  assert.equal(kit.fakeBeam.calls.length, 0, "no Beam call");
  assert.equal(kit.alerts.length, 0, "no page-failed alert: nothing was held");
  const res = await beamRunCheckout(kit, HONEYMOON, { payMethod: "card_ewallet" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual((linkPosts(kit)[0].body as BeamCreatePaymentLinkRequest).linkSettings, { card: { isEnabled: true }, eWallets: { isEnabled: true } });
});

test("runCheckout on Beam: a page priced for the other method group gets the usual 409 price_changed with this group's quote; nothing held or sent", async () => {
  const kit = makeBeamKit();
  const card = await beamServerQuote(kit, beamRequest(HONEYMOON, { payMethod: "card_ewallet" }));
  const qr = await beamServerQuote(kit, beamRequest(HONEYMOON, { payMethod: "promptpay" }));
  assert.ok(card.cardFeeSatang > 0);
  assert.equal(qr.cardFeeSatang, 0);
  assert.equal(card.totalSatang - card.cardFeeSatang, qr.totalSatang);
  for (const [sent, shown, fresh] of [
    ["promptpay", card, qr],
    ["card_ewallet", qr, card],
  ] as const) {
    const res = await runCheckout({ ...beamRequest(HONEYMOON, { payMethod: sent }), expectedTotalSatang: shown.totalSatang, expectedDueNowSatang: shown.dueNowSatang }, kit.checkoutDeps());
    assert.equal(res.status, 409, sent);
    assert.ok(!res.body.ok);
    assert.equal(res.body.error, "price_changed", sent);
    assert.deepEqual(res.body.quote, fresh, sent);
  }
  assert.deepEqual(cbWrites(kit), []);
  assert.equal(kit.fakeCb.reservations.size, 0);
  assert.equal(kit.fakeBeam.calls.length, 0);
});

test("runCheckout on Beam: a stay above Beam's maximum charge is refused (422) after the re-quote and before any Cloudbeds write, KV write or Beam call", async () => {
  const now = { ms: NOW };
  const kv = recordingKv(createMemoryKv(() => now.ms));
  // 30 nights at 40,000 baht: THB 1,236,000 with the 3% fee, above BEAM_MAX_CHARGE_SATANG (THB 999,999.99).
  const kit = makeBeamKit({ cb: { roomTypes: { ...ROOM_TYPES, "462958": { ...ROOM_TYPES["462958"], rate: 40_000 } } }, kv, now });
  const stay = { checkIn: FAR_CHECKIN, checkOut: addDays(FAR_CHECKIN, 30) };
  const quote = await beamServerQuote(kit, beamRequest(HONEYMOON, stay));
  assert.ok(quote.dueNowSatang > BEAM_MAX_CHARGE_SATANG);
  const reads = kit.fakeCb.calls.length;
  const res = await runCheckout({ ...beamRequest(HONEYMOON, stay), expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang }, kit.checkoutDeps());
  assert.deepEqual(res, {
    status: 422,
    body: {
      ok: false,
      error: "payment_unavailable",
      message: "A stay of this size can't be paid online in one payment. Nothing has been reserved or charged - please message us on WhatsApp and we'll book it for you.",
    },
  });
  assert.deepEqual(cbWrites(kit), [], "no Cloudbeds write");
  assert.ok(
    kit.fakeCb.calls.slice(reads).every((c) => c.method === "getAvailableRoomTypes" || (c.method === "getRatePlans" && c.params.roomTypeID === undefined)),
    "only the re-quote's reads (no stay-rule read under a lock)",
  );
  assert.deepEqual(kv.writes, [], "no KV write");
  assert.equal(kit.fakeBeam.calls.length, 0, "no Beam call");
  assert.ok(logged(kit, "checkout_refused_over_max_charge").some((l) => l.data?.amount === quote.dueNowSatang));
});

test("runCheckout on Beam: DIRECT sells Cloudbeds' Direct rate (held on its roomRateID with the promo code), the link for its total; an unknown code is ignored (base rate), never refused", async () => {
  const kit = makeBeamKit({ cb: { roomTypes: { ...ROOM_TYPES, "462958": { ...ROOM_TYPES["462958"], directRateId: "rate-hm-direct" } } } });
  assert.equal(kit.config.promo.mode, "direct-rate");
  const res = await beamRunCheckout(kit, HONEYMOON, { promo: " direct " });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.ok);
  const { quote } = res.body;
  const direct = 3 * 720_000;
  assert.equal(quote.roomsSubtotalSatang, direct);
  assert.deepEqual(quote.directRate, { code: "DIRECT", label: "Direct rate - code DIRECT", baseRoomsSatang: 3 * 900_000, savingSatang: 3 * 900_000 - direct });
  assert.equal(quote.cardFeeSatang, Math.round(direct * 0.03));
  const post = postOf(kit);
  assert.equal(post?.params["rooms[0][roomRateID]"], "rate-hm-direct");
  assert.equal(post?.params.promoCode, FAKE_DIRECT_PROMO_CODE);
  assert.match(onlyReservation(kit).notes.join("\n"), /Direct rate \(code DIRECT\)\./);
  assert.equal((linkPosts(kit)[0].body as BeamCreatePaymentLinkRequest).order.netAmount, quote.dueNowSatang);
  const page = pageTokenOf(kit, linkIdOf(res.body.redirectUrl));
  assert.ok(page.ok);
  assert.equal(page.payload.booking.promoCode, "DIRECT");
  assert.deepEqual(page.payload.booking.itemDiscounts, [{ kind: "direct", label: "Direct rate - code DIRECT", listSatang: 3 * 900_000 }]);

  // Until S4.6 a code sent to a Beam checkout was refused (promo_invalid); now an unknown one is ignored, as on Stripe.
  const other = await beamRunCheckout(kit, GARDEN, { promo: "NOPE" });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  assert.ok(other.body.ok);
  assert.equal(other.body.quote.promo, null);
  assert.equal(other.body.quote.directRate, null);
  assert.equal(other.body.quote.roomsSubtotalSatang, 3 * 300_000);
});

test("runCheckout on Beam: a code plan (LONGSTAY, 7 nights) is held on its roomRateID with Cloudbeds' promo code and labelled with the plan's name", async () => {
  const kit = makeBeamKit({ cb: { roomTypes: { ...ROOM_TYPES, "462958": { ...ROOM_TYPES["462958"], plans: [fakeLongStayCodePlan("rate-hm-ls")] } } } });
  const res = await beamRunCheckout(kit, HONEYMOON, { ...SEVEN_NIGHTS, promo: "longstay" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.ok);
  const { quote } = res.body;
  const longStay = 7 * 666_000;
  assert.equal(quote.roomsSubtotalSatang, longStay);
  assert.deepEqual(quote.directRate, { code: "LONGSTAY", label: "Long term - code LONGSTAY", baseRoomsSatang: HM_BASE_7, savingSatang: HM_BASE_7 - longStay });
  const post = postOf(kit);
  assert.equal(post?.params["rooms[0][roomRateID]"], "rate-hm-ls");
  assert.equal(post?.params.promoCode, FAKE_LONGSTAY_PROMO_CODE);
  assert.match(onlyReservation(kit).notes.join("\n"), /Long term \(code LONGSTAY\)\./);
  assert.equal((linkPosts(kit)[0].body as BeamCreatePaymentLinkRequest).order.netAmount, quote.dueNowSatang);
  const page = pageTokenOf(kit, linkIdOf(res.body.redirectUrl));
  assert.ok(page.ok);
  assert.equal(page.payload.booking.promoCode, "LONGSTAY");
});

test("runCheckout on Beam: an automatic discount (Long term booking, 7 nights) is held on its roomRateID with no promo code", async () => {
  const kit = makeBeamKit({ cb: { roomTypes: { ...ROOM_TYPES, "462958": { ...ROOM_TYPES["462958"], plans: [fakeLongTermPlan("rate-hm-lt")] } } } });
  const res = await beamRunCheckout(kit, HONEYMOON, SEVEN_NIGHTS);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.ok);
  const { quote } = res.body;
  const longTerm = 7 * 846_000;
  assert.equal(quote.roomsSubtotalSatang, longTerm);
  assert.deepEqual(quote.autoDiscount, { names: ["Long term booking"], baseRoomsSatang: HM_BASE_7, savingSatang: HM_BASE_7 - longTerm });
  assert.equal(quote.directRate, null);
  const post = postOf(kit);
  assert.equal(post?.params["rooms[0][roomRateID]"], "rate-hm-lt");
  assert.equal(post?.params.promoCode, undefined, "an automatic discount needs no code");
  assert.match(onlyReservation(kit).notes.join("\n"), /Automatic discount: Long term booking\./);
  assert.equal((linkPosts(kit)[0].body as BeamCreatePaymentLinkRequest).order.netAmount, quote.dueNowSatang);
});

test("availability and checkout on Beam read Cloudbeds with the same baseRateOnly and plans: the search's price is the checkout's, with and without a code", async () => {
  const roomTypes = {
    ...ROOM_TYPES,
    "462958": { ...ROOM_TYPES["462958"], directRateId: "rate-hm-direct", plans: [fakeLongTermPlan("rate-hm-lt"), fakeLongStayCodePlan("rate-hm-ls")] },
  };
  const kit = makeBeamKit({ cb: { roomTypes } });
  const inv = getInventoryConfig(BEAM_TEST_ENV);
  assert.deepEqual(inv.cloudbeds, kit.config.cloudbeds);
  assert.equal(inv.cloudbeds?.baseRateOnly, true);
  assert.ok((inv.cloudbeds?.autoDiscountPlans ?? []).length > 0);
  assert.deepEqual(inv.promo, kit.config.promo);
  assert.deepEqual(inv.ratePlans, kit.config.ratePlans);
  for (const [code, expected] of [
    [null, 7 * 846_000],
    ["DIRECT", 7 * 720_000],
    ["LONGSTAY", 7 * 666_000],
  ] as const) {
    // The availability route's own steps (route.ts): promoAskFor -> getInventory -> buildOffers.
    const ask = promoAskFor(code, inv.promo);
    const search = await getInventory(SEVEN_NIGHTS.checkIn, SEVEN_NIGHTS.checkOut, inv, {
      fetchImpl: kit.fakeCb.fetch,
      allowDemoFallback: false,
      cacheTtlMs: 0,
      autoDiscountsBestEffort: true,
      ...(ask ? { promo: ask } : {}),
    });
    const offer = buildOffers(search.inventory, 2, inv.ratePlans).find((o) => o.slug === "honeymoon-suite");
    const quote = await beamServerQuote(kit, beamRequest(HONEYMOON, { ...SEVEN_NIGHTS, ...(code ? { promo: code } : {}) }));
    assert.equal(offer?.rates[0].totalSatang, expected, `${code}: search`);
    assert.equal(quote.roomsSubtotalSatang, expected, `${code}: checkout`);
  }
});

test("runCheckout on Beam: the circuit breaker's paused answer is passed through unchanged (503, no fixStep) and nothing is held", async () => {
  const kit = makeBeamKit();
  await kit.deps.kv.set(keys.beamPaused(SCOPE), String(NOW), 300);
  const res = await beamRunCheckout(kit);
  assert.deepEqual(res, { status: 503, body: { ok: false, error: "payment_unavailable", message: BEAM_PAUSED_MESSAGE } });
  assert.equal(kit.fakeCb.reservations.size, 0);
  assert.equal(kit.fakeBeam.calls.length, 0);
});

test("runCheckout on Beam without the route's Beam deps: 503 before anything is held (a Stripe or demo config never builds them)", async () => {
  const { kit, kv } = recordedKit();
  const req = beamRequest();
  const quote = await beamServerQuote(kit, req);
  const deps = { ...kit.checkoutDeps(), beam: undefined };
  const res = await runCheckout({ ...req, expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang }, deps);
  assert.deepEqual(res, { status: 503, body: { ok: false, error: "payment_unavailable", message: "Online payment is not available right now. Nothing has been charged." } });
  assert.deepEqual(cbWrites(kit), []);
  assert.deepEqual(kv.writes, []);
  assert.equal(kit.fakeBeam.calls.length, 0);
});

test("runCheckout on Beam: a failing Cloudbeds read counts against the Beam deps (noteCheckoutReadFailure): the third refusal within half an hour tells the owner; nothing reaches Beam", async () => {
  const kit = makeBeamKit();
  const down = (async () => new Response("down", { status: 500 })) as unknown as typeof fetch;
  for (let i = 0; i < 3; i++) {
    const res = await runCheckout({ ...beamRequest(), expectedTotalSatang: 1, expectedDueNowSatang: 1 }, { ...kit.checkoutDeps(), fetchImpl: down });
    assert.equal(res.status, 503, `refusal ${i + 1}`);
    assert.ok(!res.body.ok);
    assert.equal(res.body.error, "payment_unavailable");
  }
  assert.equal(await kit.deps.kv.get(keys.checkoutReadFailures(SCOPE)), "3");
  assert.deepEqual(
    kit.alerts.map((a) => a.subject),
    ["Online bookings failing: Cloudbeds availability can't be read"],
  );
  assert.equal(logged(kit, "checkout_refused_cloudbeds_down").length, 3);
  assert.equal(kit.fakeBeam.calls.length, 0);
});

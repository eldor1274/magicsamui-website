// The Beam checkout (design S4.3): startBeamCheckout - the hold-first core (holdFirstCheckout.ts) with
// beamCheckoutAdapter (payments/beamCheckoutAdapter.ts) - driven directly on the in-repo fake Beam and the fake
// Cloudbeds (beamTestkit.ts makeBeamKit), with the real Cloudbeds writer, alerter, gateway and sweeper. Not wired
// into the checkout route yet (S4.6).
//
// Covered: the happy path for card_ewallet and for PromptPay (the hold and its -B-TEST identifier, the folio read
// back, the link request per group with the fee item only on card_ewallet, the signed note, the PaymentRecord and
// its links-open entry, the hold record and pointer, the hold note's Beam deadline); the adapter's words; a price
// mismatch; link 5xx and 4xx; a lost answer retried with the same key; a create lost twice (the hold cancelled, and a
// charge that ever appears on that link found by the sweeper's charge scan -> the cancelled-hold CRITICAL); afterCreate
// failures; a crash after the page; the test guard; the PromptPay switch; the circuit breaker; the budget; no personal
// data anywhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BEAM_MAX_CHARGE_SATANG } from "./beam.ts";
import type { BeamCreatePaymentLinkRequest } from "./beam.ts";
import { beamCheckoutAdapter, startBeamCheckout } from "./beamCheckout.ts";
import { BEAM_LIVE_ENV, BEAM_MERCHANT_ID, BEAM_TEST_ENV, beamCheckout, beamHeld, beamQuote, makeBeamKit } from "./beamTestkit.ts";
import type { BeamKit } from "./beamTestkit.ts";
import { POLICY_VERSION } from "./catalogue.ts";
import type { StripeCheckoutInput } from "./checkoutShared.ts";
import { todayInBangkok } from "./dates.ts";
import { DEFAULT_CLOSED_WORD, DEFAULT_HOLD_NOTE_DEADLINE } from "./holdFirstCheckout.ts";
import type { CheckoutPageInput } from "./holdFirstCheckout.ts";
import { createMemoryKv } from "./kv.ts";
import type { KvStore } from "./kv.ts";
import { keyScope, keys, readJson } from "./lock.ts";
import type { HoldRecord } from "./lock.ts";
import { BEAM_PAUSED_MESSAGE, beamHoldNoteDeadline } from "./payments/beamCheckoutAdapter.ts";
import { readRecord, verifyBeamNote } from "./payments/beamRecord.ts";
import { runSweep } from "./sweep.ts";
import { FAR_CHECKIN, FAR_CHECKOUT, GUEST, HONEYMOON, NOW, ORIGIN, TEST_EMAIL, TOKEN_SECRET, recordingKv } from "./testkit.ts";
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

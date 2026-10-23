// Fulfil's folio check and its owner alert for Beam bookings (fulfil.ts with the Beam gateway's settleFolio and
// text.noFeeNote), from the first live Beam booking (MSV-20261024-N2DC, 24 Oct 2026, PromptPay):
// - "Cloudbeds balance is not zero after payment" was sent although the folio showed 0: the balance was read a moment
//   after postPayment, before Cloudbeds had updated it. Beam now waits BEAM_FOLIO_SETTLE_MS (through the gateway's
//   sleep seam) and reads the folio once more before warning; with too little of the deadline left it reads once.
// - "New direct booking ... confirmed" said "the payment and the fee line are on the folio" for a PromptPay booking,
//   which has no fee and no fee line: it now says "the payment is on the folio (no fee: PromptPay)".
// Stripe sets neither hook, so its reading, its alert and its words are what they were (stripeGolden.test.ts).
// Deterministic: the Beam test kit on the in-repo fake Beam and fake Cloudbeds; nothing leaves the process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BEAM_CLOUDBEDS_METHOD, beamHeld, makeBeamKit, makeParityKit } from "./beamTestkit.ts";
import type { BeamKit } from "./beamTestkit.ts";
import { fulfilPayment } from "./fulfil.ts";
import { FAKE_PAYMENT_METHODS, createFakeCloudbeds } from "./mock/fakeCloudbeds.ts";
import type { FakeCloudbeds } from "./mock/fakeCloudbeds.ts";
import { BEAM_FOLIO_SETTLE_MIN_LEFT_MS, BEAM_FOLIO_SETTLE_MS } from "./payments/beamGateway.ts";
import { beamGatewayText } from "./payments/beamText.ts";
import { STRIPE_GATEWAY_TEXT, stripeGateway } from "./payments/stripeGateway.ts";
import { satangToBahtString } from "./quote.ts";
import type { StripeDeps } from "./stripeDeps.ts";
import { NOW, ROOM_TYPES } from "./testkit.ts";

const money = (satang: number) => `THB ${satangToBahtString(satang)}`;
const BALANCE_ALERT = /Cloudbeds balance is not zero after payment$/;

/**
 * The kit's fake Cloudbeds whose next `staleReads` getReservation answers after the first postPayment still show the
 * balance as before the payment (Cloudbeds not updated yet); every other answer is the fake's own.
 */
function lateBalanceCloudbeds(now: { ms: number }, staleReads: number): FakeCloudbeds & { stale: { left: number; served: number } } {
  const cb = createFakeCloudbeds({
    roomTypes: ROOM_TYPES,
    createdStatus: "confirmed",
    now: () => now.ms,
    paymentMethods: [...FAKE_PAYMENT_METHODS, { method: BEAM_CLOUDBEDS_METHOD, code: BEAM_CLOUDBEDS_METHOD, name: "Beam (website)" }],
  });
  const stale = { left: staleReads, served: 0 };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await cb.fetch(input, init);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.pathname.endsWith("/getReservation") || stale.left === 0 || cb.count("postPayment") === 0) return res;
    const body = (await res.json()) as { data?: { total?: number; balance?: number } };
    if (body.data && typeof body.data.total === "number") {
      stale.left--;
      stale.served++;
      body.data.balance = body.data.total;
    }
    return Response.json(body, { status: res.status });
  }) as typeof fetch;
  return { ...cb, fetch: fetchImpl, stale };
}

/** The pauses settleFolio asked for (the kit's gateway reads deps.sleep when it pauses). */
function recordSleeps(kit: BeamKit): number[] {
  const slept: number[] = [];
  kit.deps.sleep = async (ms: number) => {
    slept.push(ms);
  };
  return slept;
}

test("a balance Cloudbeds has not updated yet right after postPayment: Beam pauses 3 s once, reads the folio again and does not warn (MSV-20261024-N2DC)", async () => {
  for (const payMethod of ["promptpay", "card_ewallet"] as const) {
    const now = { ms: NOW };
    const fakeCb = lateBalanceCloudbeds(now, 1);
    const kit = makeBeamKit({ fakeCb, now });
    const h = await beamHeld(kit, payMethod);
    const slept = recordSleeps(kit);
    kit.fakeBeam.pay(h.linkId, payMethod === "promptpay" ? "QR_PROMPT_PAY" : "CARD");
    assert.equal((await fulfilPayment(h.key, kit.deps, kit.gw)).state, "confirmed");
    assert.equal(BEAM_FOLIO_SETTLE_MS, 3_000);
    assert.deepEqual(slept, [BEAM_FOLIO_SETTLE_MS], payMethod);
    assert.equal(fakeCb.stale.served, 1, "the first reading was the stale one");
    assert.equal(fakeCb.balance(h.reservationId), 0);
    assert.deepEqual(kit.alerts.filter((a) => BALANCE_ALERT.test(a.subject)), [], payMethod);
    const reread = kit.logs.filter((l) => l.message === "fulfil_balance_reread");
    assert.deepEqual(reread.map((l) => l.data), [{ ref: h.ref, reservationId: h.reservationId, firstBalanceSatang: h.quote.totalSatang, balanceSatang: 0 }]);
    assert.equal(kit.fakeCb.reservations.get(h.reservationId)?.status, "confirmed");
    assert.equal(kit.alerts.filter((a) => a.subject.startsWith(`New direct booking ${h.ref} confirmed`)).length, 1);
  }
});

test("a balance that reads 0 at once: no pause and no second reading", async () => {
  const counts: number[] = [];
  for (const staleReads of [0, 1]) {
    const now = { ms: NOW };
    const fakeCb = lateBalanceCloudbeds(now, staleReads);
    const kit = makeBeamKit({ fakeCb, now });
    const h = await beamHeld(kit, "promptpay");
    const slept = recordSleeps(kit);
    kit.fakeBeam.pay(h.linkId, "QR_PROMPT_PAY");
    const before = fakeCb.count("getReservation");
    assert.equal((await fulfilPayment(h.key, kit.deps, kit.gw)).state, "confirmed");
    counts.push(fakeCb.count("getReservation") - before);
    assert.deepEqual(slept, staleReads === 0 ? [] : [BEAM_FOLIO_SETTLE_MS]);
    assert.equal(kit.logs.some((l) => l.message === "fulfil_balance_reread"), staleReads === 1);
  }
  assert.equal(counts[1], counts[0] + 1, "exactly one more folio reading, only when the first one was not zero");
});

test("a balance still not zero after the pause (a real difference): the warning goes out with the second reading", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit, "promptpay");
  const slept = recordSleeps(kit);
  kit.fakeCb.reservations.get(h.reservationId)!.subTotal += 100; // e.g. the rate was raised after the hold
  kit.fakeBeam.pay(h.linkId, "QR_PROMPT_PAY");
  assert.equal((await fulfilPayment(h.key, kit.deps, kit.gw)).state, "confirmed");
  assert.deepEqual(slept, [BEAM_FOLIO_SETTLE_MS]);
  const alert = kit.alerts.filter((a) => a.subject === `Booking ${h.ref}: Cloudbeds balance is not zero after payment`);
  assert.equal(alert.length, 1);
  assert.equal(alert[0].severity, "warning");
  assert.equal(alert[0].lines[0], `Cloudbeds reservation ${h.reservationId} shows a balance of THB 100.00 after we recorded ${money(h.quote.totalSatang)} from Beam.`);
  assert.deepEqual(kit.logs.find((l) => l.message === "fulfil_balance_reread")?.data, {
    ref: h.ref,
    reservationId: h.reservationId,
    firstBalanceSatang: 10_000,
    balanceSatang: 10_000,
  });
});

test("too little of the deadline left for the pause, or a pause that fails: one reading, the warning as before, the booking confirmed", async () => {
  // The deadline: just under BEAM_FOLIO_SETTLE_MIN_LEFT_MS left on the gateway's clock.
  const now = { ms: NOW };
  const fakeCb = lateBalanceCloudbeds(now, 1);
  const kit = makeBeamKit({ fakeCb, now, gateway: { deadlineMs: 1_000_000 + BEAM_FOLIO_SETTLE_MIN_LEFT_MS - 1, clock: () => 1_000_000 } });
  const h = await beamHeld(kit, "promptpay");
  const slept = recordSleeps(kit);
  kit.fakeBeam.pay(h.linkId, "QR_PROMPT_PAY");
  assert.equal((await fulfilPayment(h.key, kit.deps, kit.gw)).state, "confirmed");
  assert.deepEqual(slept, [], "no pause");
  assert.equal(kit.alerts.filter((a) => BALANCE_ALERT.test(a.subject)).length, 1, "the first reading stands");
  assert.equal(kit.logs.some((l) => l.message === "fulfil_balance_reread"), false);
  assert.equal(await kit.gw.settleFolio?.(), false);

  // The pause throws: logged, the first reading stands.
  const now2 = { ms: NOW };
  const cb2 = lateBalanceCloudbeds(now2, 1);
  const k2 = makeBeamKit({ fakeCb: cb2, now: now2 });
  const h2 = await beamHeld(k2, "promptpay");
  k2.deps.sleep = async () => {
    throw new Error("timer gone");
  };
  k2.fakeBeam.pay(h2.linkId, "QR_PROMPT_PAY");
  assert.equal((await fulfilPayment(h2.key, k2.deps, k2.gw)).state, "confirmed");
  assert.equal(k2.alerts.filter((a) => BALANCE_ALERT.test(a.subject)).length, 1);
  assert.deepEqual(k2.logs.find((l) => l.message === "fulfil_balance_reread_failed")?.data, { ref: h2.ref, reservationId: h2.reservationId, error: "timer gone" });
});

test("the 'New direct booking' alert: a PromptPay booking (no fee) says 'the payment is on the folio (no fee: PromptPay)'; a card booking keeps 'and the fee line'", async () => {
  const kit = makeBeamKit();
  const qrHeld = await beamHeld(kit, "promptpay");
  assert.equal(qrHeld.quote.cardFeeSatang, 0);
  const qr = kit.fakeBeam.pay(qrHeld.linkId, "QR_PROMPT_PAY");
  assert.equal((await fulfilPayment(qrHeld.key, kit.deps, kit.gw)).state, "confirmed");
  const cardHeld = await beamHeld(kit, "card_ewallet", [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }]);
  const card = kit.fakeBeam.pay(cardHeld.linkId, "CARD");
  assert.equal((await fulfilPayment(cardHeld.key, kit.deps, kit.gw)).state, "confirmed");
  const booked = (ref: string) => kit.alerts.find((a) => a.subject.startsWith(`New direct booking ${ref} confirmed`));
  assert.equal(
    booked(qrHeld.ref)?.lines[1],
    `Paid ${money(qrHeld.quote.totalSatang)} via Beam (${qr.chargeId}); the payment is on the folio (no fee: PromptPay) and the reservation is confirmed.`,
  );
  assert.equal(
    booked(cardHeld.ref)?.lines[1],
    `Paid ${money(cardHeld.quote.totalSatang)} via Beam (${card.chargeId}); the payment and the fee line are on the folio and the reservation is confirmed.`,
  );
  const text = beamGatewayText(kit.beam);
  assert.equal(text.noFeeNote?.({ primaryId: "chrg_1", description: "x", methodType: "QR_PROMPT_PAY" }), "no fee: PromptPay");
  assert.equal(text.noFeeNote?.({ primaryId: null, description: "x" }), "no fee", "a method Beam has not reported yet");
});

test("Stripe sets neither hook: a balance not zero after payment warns after one reading, exactly as before", async () => {
  assert.equal(STRIPE_GATEWAY_TEXT.noFeeNote, undefined);
  const stripe = makeParityKit("stripe");
  assert.equal(stripeGateway(stripe.deps as StripeDeps).settleFolio, undefined);
  assert.equal(stripe.gw.settleFolio, undefined);
  const counts: number[] = [];
  for (const differs of [false, true]) {
    const k = makeParityKit("stripe");
    const h = await k.held();
    if (differs) k.fakeCb.reservations.get(h.reservationId)!.subTotal += 100;
    k.pay(h);
    const before = k.fakeCb.count("getReservation");
    assert.equal((await k.fulfil(h)).state, "confirmed");
    counts.push(k.fakeCb.count("getReservation") - before);
    assert.equal(k.alerts.filter((a) => BALANCE_ALERT.test(a.subject)).length, differs ? 1 : 0);
    assert.equal(k.logs.some((l) => l.message.startsWith("fulfil_balance_reread")), false);
  }
  assert.equal(counts[1], counts[0], "no second reading for Stripe");
});

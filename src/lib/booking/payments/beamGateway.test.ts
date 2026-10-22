// The Beam gateway (design S4.1) through the real core: fulfilPayment, releasePayment and abandonPayment on the
// in-repo fake Beam and the fake Cloudbeds (beamTestkit.ts makeBeamKit). Each hold is a real one from the
// hold-first core (beamCheckout, with the kit's stand-in Beam adapter until S4.3).
//
// Covered: every state a link can read (open, processing, paid - also PAID after DISABLED and PAID before its
// charge is listed -, expired, unconfirmed, refunded); the record and the signed note (a missing record, a forged
// or foreign note, another mode's record); the mismatches that hand a paid booking to the owner (amount, ref,
// merchant) and are never "not ours"; duplicate charges and the stored primary; cancel's fresh idempotency key;
// the release guard; a late success on a cancelled hold for every method (owner decision 3), before fulfil's
// step 5 and between its steps 5 and 7; a refunded link with several successes; an unreadable link expiresAt;
// the texts (no Beam text names Stripe, the Stripe text is unchanged); the card's last digits never logged or stored.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ALERT_WINDOW_SECONDS } from "../alerts.ts";
import { createPaymentLink, isBeamLinkId, BeamApiError } from "../beam.ts";
import type { BeamCreatePaymentLinkRequest } from "../beam.ts";
import { BEAM_TEST_ENV, BEAM_LIVE_ENV, BEAM_CLOUDBEDS_METHOD, beamHeld, makeBeamKit } from "../beamTestkit.ts";
import type { BeamKit } from "../beamTestkit.ts";
import { resolveCloudbedsPaymentMethod } from "../config.ts";
import { abandonPayment, alertFulfilPaymentFailure, feeItemFor, fulfilPayment, releasePayment } from "../fulfil.ts";
import { createMemoryKv } from "../kv.ts";
import { BEAM_RECORD_TTL_SECONDS, keyScope, keys, readJson } from "../lock.ts";
import { satangToBahtString } from "../quote.ts";
import { NOW, TEST_EMAIL, TOKEN_SECRET, recordingKv } from "../testkit.ts";
import { beamGateway } from "./beamGateway.ts";
import type { BeamChargeIndexEntry } from "./beamGateway.ts";
import { buildBeamNote, readRecord, writeRecord } from "./beamRecord.ts";
import { BEAM_EXPIRY_SKEW_MS } from "./beamState.ts";
import { BEAM_GATEWAY_TEXT, beamGatewayText } from "./beamText.ts";
import type { GatewayPayment, GatewayReceipt } from "./gateway.ts";
import { STRIPE_GATEWAY_TEXT } from "./stripeGateway.ts";

const MIN = 60_000;
/** Past the alerter's own repeat window (alerts.ts ALERT_WINDOW_SECONDS): only our set-once markers keep a repeat out. */
const PAST_ALERT_WINDOW_MS = ALERT_WINDOW_SECONDS * 1000 + MIN;
const GRACE_MS = 20 * MIN;
const money = (satang: number) => `THB ${satangToBahtString(satang)}`;
const res = (kit: BeamKit, id: string) => {
  const r = kit.fakeCb.reservations.get(id);
  assert.ok(r, `no reservation ${id}`);
  return r;
};
const calls = (kit: BeamKit, method: string) => kit.fakeCb.calls.filter((c) => c.method === method);
const critical = (kit: BeamKit) => kit.alerts.filter((a) => a.severity === "critical");
const withSubject = (kit: BeamKit, re: RegExp) => kit.alerts.filter((a) => re.test(a.subject));
const cbWrites = (kit: BeamKit) => kit.fakeCb.calls.filter((c) => ["postPayment", "postCustomItem", "putReservation", "postReservationNote"].includes(c.method)).length;
/** A link's expiry as the stand-in adapter set it (the kit's clock at checkout + 30 minutes). */
const expiryOf = (kit: BeamKit, linkId: string) => {
  const ms = kit.fakeBeam.link(linkId).expiresAtMs;
  assert.ok(ms !== null);
  return ms;
};

/** A link body of someone else's making (the owner's own Lighthouse link, or a forgery). */
function foreignLinkBody(kit: BeamKit, internalNote: string, referenceId: string): BeamCreatePaymentLinkRequest {
  return {
    order: { currency: "THB", netAmount: 150_000, description: "Dinner voucher", referenceId, internalNote, orderItems: [] },
    linkSettings: { card: { isEnabled: true } },
    collectPhoneNumber: false,
    collectDeliveryAddress: false,
    redirectUrl: "https://example.com/done",
    cancelUrl: "https://example.com/cancel",
    expiresAt: new Date(kit.now.ms + 30 * MIN).toISOString(),
  };
}

/* ----------------------------------- the gateway itself ----------------------------------- */

test("the Beam gateway: provider, brand, keys, ids, hold identifiers and the 708-day markers", async () => {
  const kit = makeBeamKit();
  const gw = kit.gw;
  assert.equal(gw.provider, "beam");
  assert.equal(gw.brand, "Beam");
  assert.equal(gw.keyOf("rGtqz6DafS"), "beam:rGtqz6DafS");
  assert.equal(gw.idOf("beam:rGtqz6DafS"), "rGtqz6DafS");
  assert.throws(() => gw.idOf("cs_test_abc"), (e: unknown) => gw.isMissing(e));
  assert.equal(gw.isPaymentId?.("rGtqz6DafS"), true);
  assert.equal(gw.isPaymentId?.("beam:rGtqz6DafS"), false, "tokens carry the bare link id");
  assert.equal(gw.isPaymentId?.("a/b"), false);
  assert.equal(gw.isPaymentId, isBeamLinkId);
  assert.deepEqual(gw.parseHoldId?.("MSV-20261005-ABCD-B-TEST"), { ref: "MSV-20261005-ABCD", live: false });
  assert.deepEqual(gw.parseHoldId?.("MSV-20261005-ABCD-B"), { ref: "MSV-20261005-ABCD", live: true });
  assert.equal(gw.parseHoldId?.("MSV-20261005-ABCD"), null, "a Stripe hold is never a Beam one");
  assert.equal(gw.doneTtlSeconds, BEAM_RECORD_TTL_SECONDS);
  assert.ok(gw.releaseGuard);
  await assert.rejects(gw.sweepRecent(NOW - 3_600_000), /S4\.2/, "nothing sweeps Beam before S4.2: a throw, never an empty listing");
});

test("a key that is not a Beam key, and a link Beam does not know, read as missing: abandon answers closed", async () => {
  const kit = makeBeamKit();
  const before = kit.fakeBeam.calls.length;
  for (const key of ["cs_test_a1b2c3", "beam:", "beam:a/b", "rGtqz6DafS"]) {
    await assert.rejects(kit.gw.get(key), (e: unknown) => kit.gw.isMissing(e), key);
    await assert.rejects(kit.gw.cancel(key), (e: unknown) => kit.gw.isMissing(e), key);
  }
  assert.equal(kit.fakeBeam.calls.length, before, "no Beam call for a key that is not a Beam key");
  await assert.rejects(kit.gw.get("beam:NoSuchLnk1"), (e: unknown) => kit.gw.isMissing(e) && e instanceof BeamApiError && e.status === 404);
  assert.deepEqual(await abandonPayment("beam:NoSuchLnk1", kit.deps, kit.gw, null), { state: "closed" });
});

test("every Beam call is sized to the caller's deadline: a spent budget makes no call; a 429 is counted", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const late = beamGateway({ ...kit.deps, deadlineMs: 1_000, clock: () => 2_000 });
  const before = kit.fakeBeam.calls.length;
  await assert.rejects(late.get(h.key), (e: unknown) => e instanceof BeamApiError && e.errorCode === "BUDGET_EXHAUSTED");
  await assert.rejects(late.cancel(h.key), (e: unknown) => e instanceof BeamApiError && e.errorCode === "BUDGET_EXHAUSTED");
  assert.equal(kit.fakeBeam.calls.length, before, "nothing reached Beam");
  let limited = 0;
  const inTime = beamGateway({ ...kit.deps, deadlineMs: 50_000, clock: () => 2_000, onRateLimited: () => limited++ });
  kit.fakeBeam.rateLimitNext(1);
  assert.equal((await inTime.get(h.key)).state, "open", "the read is retried once inside the budget");
  assert.equal(limited, 1);
});

/* ------------------------------------- states ------------------------------------- */

test("open: fulfil answers not_paid, release refuses it, abandon disables the link and releases the hold", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const p = await kit.gw.get(h.key);
  assert.equal(p.state, "open");
  assert.equal(p.key, h.key);
  assert.equal(p.paymentId, h.linkId);
  assert.equal(p.attempted, false);
  assert.equal(p.amountSatang, h.quote.dueNowSatang);
  assert.equal(p.meta?.ref, h.ref);
  assert.equal(p.meta?.reservationId, h.reservationId);
  assert.equal(p.meta?.totalSatang, h.quote.totalSatang);
  assert.deepEqual(p.receipt, { primaryId: null, description: `Beam link ${h.linkId} charge pending (method pending)` });
  assert.equal(p.mismatch, undefined);
  assert.deepEqual(await fulfilPayment(h.key, kit.deps, kit.gw), { state: "not_paid", payment: "open" });
  assert.deepEqual(await releasePayment(h.key, kit.deps, kit.gw, "test"), { state: "refused_open" });
  assert.equal(res(kit, h.reservationId).status, "not_confirmed");
  assert.deepEqual(await abandonPayment(h.key, kit.deps, kit.gw, "MSV-20261005-ZZZZ"), { state: "closed" }, "another booking's token cancels nothing");
  assert.equal(kit.fakeBeam.link(h.linkId).status, "ACTIVE");
  assert.deepEqual(await abandonPayment(h.key, kit.deps, kit.gw, h.ref), { state: "released" });
  assert.equal(kit.fakeBeam.link(h.linkId).status, "DISABLED");
  assert.equal(res(kit, h.reservationId).status, "canceled");
  assert.equal(await kit.deps.kv.get(keys.abandoned(h.key)), "1");
  assert.equal(critical(kit).length, 0);
});

test("processing: a PENDING charge keeps the hold; abandon disables the link and answers pending", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit, "promptpay");
  const qr = kit.fakeBeam.payPending(h.linkId, "QR_PROMPT_PAY");
  const p = await kit.gw.get(h.key);
  assert.equal(p.state, "processing");
  assert.equal(p.pendingReason, "processing");
  assert.equal(p.attempted, true);
  assert.equal(p.receipt.primaryId, null);
  assert.equal(p.receipt.methodType, "QR_PROMPT_PAY");
  assert.equal(p.receipt.description, `Beam link ${h.linkId} charge pending (PromptPay)`);
  assert.deepEqual(await fulfilPayment(h.key, kit.deps, kit.gw), { state: "not_paid", payment: "processing" });
  assert.deepEqual(await releasePayment(h.key, kit.deps, kit.gw, "test"), { state: "refused_open" });
  assert.deepEqual(await abandonPayment(h.key, kit.deps, kit.gw, h.ref), { state: "pending" });
  assert.equal(kit.fakeBeam.link(h.linkId).status, "DISABLED");
  assert.equal(res(kit, h.reservationId).status, "not_confirmed", "the QR may still be paid: the hold stays");
  // Inside the grace the disabled link is still being confirmed.
  kit.now.ms += GRACE_MS - MIN;
  assert.deepEqual(await releasePayment(h.key, kit.deps, kit.gw, "test"), { state: "refused_open" });
  assert.equal(kit.fakeBeam.charge(qr.chargeId).status, "PENDING");
});

test("paid by card: one postPayment 'Beam(website)', the fee line, the PAID note with method and refund path, 708-day markers", async () => {
  const now = { ms: NOW };
  const kv = recordingKv(createMemoryKv(() => now.ms));
  const kit = makeBeamKit({ kv, now });
  const h = await beamHeld(kit);
  const card = kit.fakeBeam.pay(h.linkId, "CARD");
  const p = await kit.gw.get(h.key);
  assert.equal(p.state, "paid");
  assert.deepEqual(p.receipt, {
    primaryId: card.chargeId,
    description: `Beam link ${h.linkId} charge ${card.chargeId} (card)`,
    methodType: "CARD",
    refundable: true,
    partialRefundable: true,
  });
  const out = await fulfilPayment(h.key, kit.deps, kit.gw);
  assert.deepEqual(out, { state: "confirmed", reservationId: h.reservationId, ref: h.ref, totalSatang: h.quote.totalSatang, alreadyDone: false });
  const r = res(kit, h.reservationId);
  assert.equal(r.status, "confirmed");
  assert.deepEqual(
    r.payments.map((x) => ({ type: x.type, amount: x.amount, description: x.description })),
    [{ type: BEAM_CLOUDBEDS_METHOD, amount: h.quote.totalSatang / 100, description: `TEST MODE - NOT REAL MONEY. Beam link ${h.linkId} charge ${card.chargeId} (card) ref ${h.ref}` }],
  );
  const fee = calls(kit, "postCustomItem");
  assert.equal(fee.length, 1);
  assert.equal(fee[0].params["items[0][appItemID]"], "msv-payment-processing-fee-beam-test");
  assert.equal(fee[0].params["items[0][itemSKU]"], "MSV-BEAM-PAYMENT-FEE-TEST");
  assert.equal(fee[0].params["items[0][itemName]"], "TEST - Payment processing fee");
  assert.equal(fee[0].params["items[0][itemPrice]"], satangToBahtString(h.quote.cardFeeSatang));
  assert.ok(h.quote.cardFeeSatang > 0);
  assert.equal(kit.fakeCb.balance(h.reservationId), 0);
  const paidNote = r.notes.find((n) => n.includes("PAID via"));
  assert.ok(paidNote?.startsWith(
    `TEST MODE - NOT REAL MONEY. PAID via Beam ${card.chargeId} (card, ${money(h.quote.totalSatang)}). Refund path: Beam Lighthouse (full or 50% refunds of the card payment) for online booking ${h.ref} - do NOT cancel.`,
  ), paidNote);
  const booked = withSubject(kit, /^New direct booking/);
  assert.equal(booked.length, 1);
  assert.ok(booked[0].lines.includes("If the guest cancels: Beam Lighthouse (full or 50% refunds of the card payment)."), booked[0].lines.join("\n"));
  // The primary is stored set-once; the charge is indexed to its booking; every fulfil marker lives 708 days.
  assert.equal(await kit.deps.kv.get(keys.beamPrimary(h.linkId)), card.chargeId);
  assert.deepEqual(await readJson<BeamChargeIndexEntry>(kit.deps.kv, keys.beamCharge(card.chargeId)), {
    v: 1,
    linkId: h.linkId,
    ref: h.ref,
    reservationId: h.reservationId,
    mode: "beam-playground",
  });
  const fulfilKeys = [keys.fulfilDone(h.key), keys.reservationPaid(h.reservationId), keys.paidPending(h.key)];
  const fulfilWrites = kv.writes.filter((w) => w.op === "set" && (fulfilKeys.includes(w.key) || w.key.startsWith(`msv:step:fulfil:${h.key}:`)));
  assert.equal(fulfilWrites.length, 7, JSON.stringify(fulfilWrites.map((w) => w.key)));
  for (const w of fulfilWrites) assert.equal(w.ttl, BEAM_RECORD_TTL_SECONDS, w.key);
  for (const w of kv.writes.filter((x) => x.key.startsWith("msv:beam:"))) assert.equal(w.ttl, BEAM_RECORD_TTL_SECONDS, w.key);
  // Paid: never released; abandon after paying finds the link not open and answers paid.
  assert.deepEqual(await releasePayment(h.key, kit.deps, kit.gw, "test"), { state: "refused_paid", reservationId: h.reservationId });
  assert.deepEqual(await abandonPayment(h.key, kit.deps, kit.gw, h.ref), { state: "paid" });
  assert.equal(kit.fakeBeam.link(h.linkId).status, "PAID");
  assert.equal(r.payments.length, 1);
  assert.equal(critical(kit).length, 0);
  // Nothing written about this payment names Stripe.
  assert.doesNotMatch(JSON.stringify([r.notes, r.payments, kit.alerts]), /stripe/i);
});

test("paid by PromptPay: no fee line, the folio balances, the refund path is a full Lighthouse refund or 50% by bank transfer", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit, "promptpay");
  assert.equal(h.quote.cardFeeSatang, 0, "PromptPay is fee-free (owner decision 1)");
  const qr = kit.fakeBeam.pay(h.linkId, "QR_PROMPT_PAY");
  assert.equal((await fulfilPayment(h.key, kit.deps, kit.gw)).state, "confirmed");
  assert.equal(calls(kit, "postCustomItem").length, 0);
  const r = res(kit, h.reservationId);
  assert.deepEqual(r.payments.map((x) => x.amount), [h.quote.totalSatang / 100]);
  assert.equal(kit.fakeCb.balance(h.reservationId), 0);
  assert.ok(
    r.notes.some((n) =>
      n.includes(`PAID via Beam ${qr.chargeId} (PromptPay, ${money(h.quote.totalSatang)}). Refund path: Beam Lighthouse for a full refund; a 50% refund by bank transfer (Beam refunds PromptPay only in full) for online booking`),
    ),
    r.notes.join("\n"),
  );
});

test("PAID after DISABLED: a QR still pending when the guest abandoned succeeds on the disabled link and is confirmed", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit, "promptpay");
  kit.fakeBeam.payPending(h.linkId, "QR_PROMPT_PAY");
  assert.deepEqual(await abandonPayment(h.key, kit.deps, kit.gw, h.ref), { state: "pending" });
  kit.now.ms += 5 * MIN;
  const late = kit.fakeBeam.payAfterClose(h.linkId);
  assert.equal(kit.fakeBeam.link(h.linkId).status, "DISABLED");
  const p = await kit.gw.get(h.key);
  assert.equal(p.state, "paid");
  assert.equal(p.receipt.primaryId, late.chargeId);
  assert.equal((await fulfilPayment(h.key, kit.deps, kit.gw)).state, "confirmed");
  assert.equal(res(kit, h.reservationId).status, "confirmed");
  assert.equal(critical(kit).length, 0);
});

test("PAID before its charge is listed: confirmed with 'charge id pending'; once listed its id is stored, no duplicate", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const hidden = kit.fakeBeam.markPaidWithoutCharge(h.linkId, "CARD");
  const p = await kit.gw.get(h.key);
  assert.equal(p.state, "paid");
  assert.equal(p.amountSatang, h.quote.totalSatang);
  assert.deepEqual(p.receipt, { primaryId: null, description: `Beam link ${h.linkId} charge pending (method pending)` });
  assert.equal((await fulfilPayment(h.key, kit.deps, kit.gw)).state, "confirmed");
  const r = res(kit, h.reservationId);
  assert.equal(r.payments[0].description, `TEST MODE - NOT REAL MONEY. Beam link ${h.linkId} charge pending (method pending) ref ${h.ref}`);
  assert.ok(r.notes.some((n) => n.includes(`PAID via Beam charge id pending (method pending, ${money(h.quote.totalSatang)}). Refund path: check the charge's method in Beam Lighthouse`)));
  assert.equal(await kit.deps.kv.get(keys.beamPrimary(h.linkId)), null);
  kit.fakeBeam.revealCharges(h.linkId);
  const listed = await kit.gw.get(h.key);
  assert.equal(listed.receipt.primaryId, hidden.chargeId);
  assert.equal(await kit.deps.kv.get(keys.beamPrimary(h.linkId)), hidden.chargeId);
  assert.equal(withSubject(kit, /charged twice/).length, 0);
});

test("expired: fulfil answers not_paid; release (guarded) and abandon give the hold back; nothing alerts", async () => {
  const kit = makeBeamKit();
  const a = await beamHeld(kit);
  kit.fakeBeam.expire(a.linkId);
  const p = await kit.gw.get(a.key);
  assert.equal(p.state, "expired");
  assert.equal(p.pendingReason, undefined);
  assert.deepEqual(await fulfilPayment(a.key, kit.deps, kit.gw), { state: "not_paid", payment: "expired" });
  const reads = kit.fakeBeam.count(/^GET \/api\/v1\/payment-links\//);
  assert.deepEqual(await releasePayment(a.key, kit.deps, kit.gw, "sweeper: expired"), { state: "released", reservationId: a.reservationId });
  assert.equal(kit.fakeBeam.count(/^GET \/api\/v1\/payment-links\//) - reads, 2, "release reads the link, then the guard reads it again");
  assert.equal(res(kit, a.reservationId).status, "canceled");

  const kit2 = makeBeamKit();
  const b = await beamHeld(kit2);
  kit2.fakeBeam.expire(b.linkId);
  assert.deepEqual(await abandonPayment(b.key, kit2.deps, kit2.gw, b.ref), { state: "released" });
  assert.equal(await kit2.deps.kv.get(keys.abandoned(b.key)), null, "Beam answered not_open: nothing was cancelled by us");
  assert.equal(res(kit2, b.reservationId).status, "canceled");
  assert.equal(kit.alerts.length + kit2.alerts.length, 0);
});

test("unconfirmed: a QR still pending after the grace is released with the pending warning; abandon answers pending", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit, "promptpay");
  kit.fakeBeam.payPending(h.linkId, "QR_PROMPT_PAY");
  kit.fakeBeam.expire(h.linkId);
  kit.now.ms += GRACE_MS - MIN;
  assert.equal((await kit.gw.get(h.key)).state, "processing", "inside the grace");
  kit.now.ms += 2 * MIN;
  const p = await kit.gw.get(h.key);
  assert.equal(p.state, "expired");
  assert.equal(p.pendingReason, "unconfirmed");
  assert.deepEqual(await releasePayment(h.key, kit.deps, kit.gw, "sweeper"), { state: "released", reservationId: h.reservationId });
  const warned = withSubject(kit, /^Beam payment still pending/);
  assert.equal(warned.length, 1);
  assert.equal(warned[0].severity, "warning");
  assert.equal(warned[0].subject, `Beam payment still pending: hold ${h.reservationId} released (booking ${h.ref})`);
  assert.equal(
    warned[0].lines[0],
    `A PromptPay payment on Beam link ${h.linkId} was still waiting for the bank's confirmation 20 minutes after the payment window closed, so the Cloudbeds hold was released and the unit is back on sale.`,
  );

  const kit2 = makeBeamKit({ env: { ...BEAM_TEST_ENV, BEAM_PENDING_GRACE_MINUTES: "45" } });
  const g = await beamHeld(kit2, "promptpay");
  kit2.fakeBeam.payPending(g.linkId, "QR_PROMPT_PAY");
  kit2.fakeBeam.expire(g.linkId);
  kit2.now.ms += 30 * MIN;
  assert.equal((await kit2.gw.get(g.key)).state, "processing", "BEAM_PENDING_GRACE_MINUTES=45 is honoured");
  kit2.now.ms += 16 * MIN;
  assert.deepEqual(await abandonPayment(g.key, kit2.deps, kit2.gw, g.ref), { state: "pending" }, "released, but the guest is never invited to pay again");
  assert.equal(res(kit2, g.reservationId).status, "canceled");
  assert.match(withSubject(kit2, /^Beam payment still pending/)[0].lines[0], / 45 minutes after /);
});

test("refunded before confirmation: needs_attention (never confirmed, never released); abandon answers closed", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const card = kit.fakeBeam.pay(h.linkId, "CARD");
  kit.fakeBeam.refund(card.chargeId);
  assert.equal(kit.fakeBeam.link(h.linkId).status, "REFUNDED");
  assert.equal((await kit.gw.get(h.key)).state, "refunded");
  const out = await fulfilPayment(h.key, kit.deps, kit.gw);
  assert.equal(out.state, "needs_attention");
  assert.ok("reason" in out && out.reason.startsWith("REFUNDED at Beam before the booking was confirmed: the guest's payment was refunded in Beam."), JSON.stringify(out));
  const urgent = critical(kit);
  assert.equal(urgent.length, 1);
  assert.equal(urgent[0].subject, `URGENT: paid booking ${h.ref} needs attention`);
  assert.match(urgent[0].lines[1], new RegExp(`^Beam payment link beam:${h.linkId}, Cloudbeds reservation ${h.reservationId}, `));
  assert.deepEqual(await releasePayment(h.key, kit.deps, kit.gw, "sweeper"), { state: "refused_paid", reservationId: h.reservationId });
  assert.deepEqual(await abandonPayment(h.key, kit.deps, kit.gw, h.ref), { state: "closed" });
  assert.equal(res(kit, h.reservationId).status, "not_confirmed", "left for a person");
  assert.equal(calls(kit, "postPayment").length, 0);
});

/* -------------------------------- whose link it is -------------------------------- */

test("record missing: the signed note recognises the link, one warning however often it is read", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const viaRecord = await kit.gw.get(h.key);
  kit.fakeBeam.pay(h.linkId, "CARD");
  await kit.deps.kv.del(keys.beamPayment(h.linkId));
  assert.equal(await readRecord(kit.deps.kv, h.linkId), null);
  const viaNote = await kit.gw.get(h.key);
  assert.deepEqual(viaNote.meta, viaRecord.meta);
  kit.now.ms += PAST_ALERT_WINDOW_MS;
  await kit.gw.get(h.key);
  assert.equal((await fulfilPayment(h.key, kit.deps, kit.gw)).state, "confirmed");
  const warned = withSubject(kit, /^Beam payment record missing/);
  assert.equal(warned.length, 1);
  assert.equal(warned[0].subject, `Beam payment record missing for link ${h.linkId} (booking ${h.ref})`);
  assert.equal(warned[0].severity, "warning");
  assert.equal(await kit.deps.kv.get(keys.beamReported(keyScope("beam-playground"), "record-missing", h.linkId)), "1");
});

test("not ours: the owner's own link, a note signed with another secret, an edited note - nothing is confirmed, released or disabled", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const record = await readRecord(kit.deps.kv, h.linkId);
  assert.ok(record);
  const genuine = buildBeamNote(record, TOKEN_SECRET);
  assert.equal(genuine, kit.fakeBeam.link(h.linkId).order.internalNote, "the link carries exactly our note");
  const notes = [
    "Lighthouse link: dinner voucher",
    buildBeamNote(record, "another-secret-0123456789abcdef"),
    genuine.replace(`tot=${record.totalSatang}`, `tot=${record.totalSatang - 100}`).replace(`fee=${record.feeSatang}`, `fee=${record.feeSatang - 100}`),
  ];
  const writesBefore = cbWrites(kit);
  for (const note of notes) {
    const link = await createPaymentLink(kit.beam, foreignLinkBody(kit, note, h.ref), `foreign-${note.length}-${Math.random()}`, kit.fakeBeam.fetch);
    kit.fakeBeam.pay(link.id, "CARD");
    const key = kit.gw.keyOf(link.id);
    const p = await kit.gw.get(key);
    assert.equal(p.meta, null, note);
    assert.equal(p.state, "paid");
    assert.deepEqual(await fulfilPayment(key, kit.deps, kit.gw), { state: "not_ours" });
    assert.deepEqual(await releasePayment(key, kit.deps, kit.gw, "test"), { state: "not_ours" });
    assert.deepEqual(await abandonPayment(key, kit.deps, kit.gw, null), { state: "closed" });
    assert.equal(kit.fakeBeam.count(new RegExp(`^PATCH /api/v1/payment-links/${link.id}/disable$`)), 0);
    assert.equal(await kit.deps.kv.get(keys.reservationPaid(h.reservationId)), null);
  }
  assert.equal(cbWrites(kit), writesBefore, "no Cloudbeds write");
  assert.equal(res(kit, h.reservationId).status, "not_confirmed");
  assert.equal(kit.alerts.length, 0);
});

test("a record of the other payment mode is not ours (a log line, no alert)", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const record = await readRecord(kit.deps.kv, h.linkId);
  assert.ok(record);
  await writeRecord(kit.deps.kv, { ...record, mode: "beam-live" });
  kit.fakeBeam.pay(h.linkId, "CARD");
  assert.equal((await kit.gw.get(h.key)).meta, null);
  assert.deepEqual(await fulfilPayment(h.key, kit.deps, kit.gw), { state: "not_ours" });
  assert.ok(kit.logs.some((l) => l.message === "beam_payment_other_mode" && l.data?.linkId === h.linkId && l.data?.mode === "beam-live"));
  assert.equal(kit.alerts.length, 0);
});

/* ------------------------------------ mismatches ------------------------------------ */

for (const c of [
  {
    name: "a charge of another amount",
    setup: (kit: BeamKit, linkId: string) => void kit.fakeBeam.pay(linkId, "CARD", { amount: kit.fakeBeam.link(linkId).order.netAmount - 10_000 }),
    expect: /^Beam charge ch_\w+ on payment link \w+: amount \d+ does not match the link's netAmount \d+\. Nothing was confirmed/,
  },
  {
    name: "a link naming another booking",
    setup: (kit: BeamKit, linkId: string) => {
      kit.fakeBeam.links.get(linkId)!.order.referenceId = "MSV-20270101-ZZZZ";
      kit.fakeBeam.pay(linkId, "CARD");
    },
    expect: /^Beam payment link \w+ names booking MSV-20270101-ZZZZ, but our record of it is booking MSV-/,
  },
  {
    name: "a link under another merchant",
    setup: (kit: BeamKit, linkId: string) => {
      kit.fakeBeam.links.get(linkId)!.merchantId = "m_SomeoneElse0000000000000";
      kit.fakeBeam.pay(linkId, "CARD");
    },
    expect: /^Beam payment link \w+ belongs to another Beam merchant than this deployment's BEAM_MERCHANT_ID\./,
  },
  {
    name: "a record written under another merchant",
    setup: async (kit: BeamKit, linkId: string) => {
      const record = await readRecord(kit.deps.kv, linkId);
      await writeRecord(kit.deps.kv, { ...record!, merchantId: "m_SomeoneElse0000000000000" });
      kit.fakeBeam.pay(linkId, "CARD");
    },
    expect: /^Beam payment link \w+ was created under another Beam merchant than this deployment's BEAM_MERCHANT_ID\./,
  },
]) {
  test(`mismatch - ${c.name}: CRITICAL needs_attention, never not_ours, nothing recorded or confirmed`, async () => {
    const kit = makeBeamKit();
    const h = await beamHeld(kit);
    await c.setup(kit, h.linkId);
    const p = await kit.gw.get(h.key);
    assert.equal(p.state, "paid");
    assert.notEqual(p.meta, null);
    assert.match(p.mismatch ?? "", c.expect);
    assert.match(p.mismatch ?? "", new RegExp(`check the payment in Beam Lighthouse and Cloudbeds reservation ${h.reservationId} by hand\\.$`));
    const out = await fulfilPayment(h.key, kit.deps, kit.gw);
    assert.equal(out.state, "needs_attention");
    assert.ok("reason" in out && out.reason === p.mismatch);
    assert.equal(critical(kit).length, 1);
    assert.equal(critical(kit)[0].subject, `URGENT: paid booking ${h.ref} needs attention`);
    assert.equal(calls(kit, "postPayment").length, 0);
    assert.equal(res(kit, h.reservationId).status, "not_confirmed");
    assert.deepEqual(await releasePayment(h.key, kit.deps, kit.gw, "test"), { state: "refused_paid", reservationId: h.reservationId });
  });
}

/* --------------------------------- duplicates and the primary --------------------------------- */

test("two successful charges before confirmation: the first is recorded, one 'charged twice' alert for the second", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const first = kit.fakeBeam.pay(h.linkId, "CARD");
  kit.now.ms += MIN;
  const second = kit.fakeBeam.secondCharge(h.linkId, "CARD");
  assert.equal((await fulfilPayment(h.key, kit.deps, kit.gw)).state, "confirmed");
  assert.match(res(kit, h.reservationId).payments[0].description, new RegExp(` charge ${first.chargeId} \\(card\\) `));
  kit.now.ms += PAST_ALERT_WINDOW_MS;
  await kit.gw.get(h.key);
  await releasePayment(h.key, kit.deps, kit.gw, "test");
  const dup = withSubject(kit, /charged twice/);
  assert.equal(dup.length, 1);
  assert.equal(dup[0].severity, "critical");
  assert.equal(dup[0].subject, `URGENT: guest charged twice for booking ${h.ref}`);
  assert.deepEqual(dup[0].lines, [
    `Beam payment link ${h.linkId} (booking ${h.ref}, Cloudbeds reservation ${h.reservationId}) has 2 successful charges. ${first.chargeId} (card, ${money(first.amount)}) is the one recorded in Cloudbeds; ${second.chargeId} (card, ${money(second.amount)}) is an extra charge.`,
    `Refund ${second.chargeId} in full in Beam Lighthouse (bank transfer for LINE Pay, TrueMoney or ShopeePay). Do NOT record it in Cloudbeds and do not cancel the booking.`,
  ]);
  for (const c of [first, second]) assert.equal((await readJson<BeamChargeIndexEntry>(kit.deps.kv, keys.beamCharge(c.chargeId)))?.ref, h.ref);
});

test("a second charge after the done marker: one 'charged twice' alert from the next reading, never repeated", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.fakeBeam.pay(h.linkId, "CARD");
  assert.equal((await fulfilPayment(h.key, kit.deps, kit.gw)).state, "confirmed");
  kit.now.ms += 10 * MIN;
  const wallet = kit.fakeBeam.secondCharge(h.linkId, "LINE_PAY");
  assert.equal((await fulfilPayment(h.key, kit.deps, kit.gw)).state, "confirmed", "the done marker answers at once");
  assert.equal(withSubject(kit, /charged twice/).length, 0, "fulfil never re-reads a finished payment");
  await kit.gw.get(h.key);
  kit.now.ms += PAST_ALERT_WINDOW_MS;
  assert.deepEqual(await releasePayment(h.key, kit.deps, kit.gw, "test"), { state: "refused_paid", reservationId: h.reservationId });
  assert.deepEqual(await abandonPayment(h.key, kit.deps, kit.gw, h.ref), { state: "paid" });
  const dup = withSubject(kit, /charged twice/);
  assert.equal(dup.length, 1);
  assert.match(dup[0].lines[0], new RegExp(`${wallet.chargeId} \\(LINE Pay, ${money(wallet.amount).replace(".", "\\.")}\\) is an extra charge\\.$`));
  assert.equal(res(kit, h.reservationId).payments.length, 1);
});

test("the stored primary wins over a later reading's: a charge listed later with an earlier success is the extra one", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const recorded = kit.fakeBeam.pay(h.linkId, "CARD");
  assert.equal((await kit.gw.get(h.key)).receipt.primaryId, recorded.chargeId);
  kit.now.ms += 2 * MIN;
  const earlier = kit.fakeBeam.secondCharge(h.linkId, "ALIPAY");
  const stored = kit.fakeBeam.charges.get(earlier.chargeId)!;
  stored.transactionMs = (recorded.transactionMs ?? NOW) - MIN;
  const p = await kit.gw.get(h.key);
  assert.equal(p.receipt.primaryId, recorded.chargeId);
  assert.equal(p.receipt.methodType, "CARD");
  assert.equal(p.receipt.description, `Beam link ${h.linkId} charge ${recorded.chargeId} (card)`);
  assert.equal(await kit.deps.kv.get(keys.beamPrimary(h.linkId)), recorded.chargeId);
  const dup = withSubject(kit, /charged twice/);
  assert.equal(dup.length, 1);
  assert.match(dup[0].lines[0], new RegExp(`${recorded.chargeId} \\(card, [^)]+\\) is the one recorded in Cloudbeds; ${earlier.chargeId} \\(Alipay, `));
});

/* -------------------------------------- cancel -------------------------------------- */

test("cancel: ACTIVE -> cancelled, PAID -> not_open, and a fresh idempotency key per attempt (a cached failure is never replayed)", async () => {
  const kit = makeBeamKit();
  const a = await beamHeld(kit);
  assert.equal(await kit.gw.cancel(a.key), "cancelled");
  assert.equal(kit.fakeBeam.link(a.linkId).status, "DISABLED");
  assert.equal(await kit.gw.cancel(a.key), "not_open", "a link that is no longer ACTIVE");

  const kit2 = makeBeamKit();
  const b = await beamHeld(kit2);
  kit2.fakeBeam.pay(b.linkId, "CARD");
  assert.equal(await kit2.gw.cancel(b.key), "not_open");
  assert.equal(kit2.fakeBeam.link(b.linkId).status, "PAID");

  const kit3 = makeBeamKit();
  const c = await beamHeld(kit3);
  kit3.fakeBeam.replayErrorsForKey();
  kit3.fakeBeam.failNext(/^PATCH \/api\/v1\/payment-links\/.+\/disable$/, 500);
  await assert.rejects(kit3.gw.cancel(c.key), (e: unknown) => e instanceof BeamApiError && e.status === 500);
  assert.equal(kit3.fakeBeam.link(c.linkId).status, "ACTIVE");
  assert.equal(await kit3.gw.cancel(c.key), "cancelled", "the second attempt is not answered from Beam's cache");
  const keysUsed = kit3.fakeBeam.calls.filter((x) => x.method === "PATCH").map((x) => x.idempotencyKey ?? "");
  assert.equal(keysUsed.length, 2);
  assert.notEqual(keysUsed[0], keysUsed[1]);
  for (const k of keysUsed) assert.match(k, new RegExp(`^msv-bd-${c.linkId}-[0-9a-f]{24}$`));
});

/* ----------------------------------- the release guard ----------------------------------- */

test("the release guard: a QR that succeeds between the reading and the Cloudbeds cancel keeps the hold, then it is confirmed", async () => {
  for (const via of ["release", "abandon"] as const) {
    const kit = makeBeamKit();
    const h = await beamHeld(kit, "promptpay");
    const qr = kit.fakeBeam.payPending(h.linkId, "QR_PROMPT_PAY");
    kit.fakeBeam.expire(h.linkId);
    kit.now.ms += GRACE_MS + MIN;
    assert.equal((await kit.gw.get(h.key)).pendingReason, "unconfirmed");
    // releaseHold reads the folio under its lock; the bank confirms the QR at that moment.
    kit.fakeCb.failNext("getReservation", "pass", undefined, () => void kit.fakeBeam.succeed(qr.chargeId));
    if (via === "release") assert.deepEqual(await releasePayment(h.key, kit.deps, kit.gw, "sweeper"), { state: "refused_open" });
    else assert.deepEqual(await abandonPayment(h.key, kit.deps, kit.gw, h.ref), { state: "pending" });
    assert.equal(res(kit, h.reservationId).status, "not_confirmed", via);
    assert.ok(kit.logs.some((l) => l.message === "release_refused_still_payable"), via);
    assert.equal(withSubject(kit, /still pending/).length, 0, via);
    assert.equal((await fulfilPayment(h.key, kit.deps, kit.gw)).state, "confirmed", via);
  }
});

test("the release guard: a QR attempt the charge list had not shown yet appears before the cancel - still inside its grace, the hold stays", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit, "promptpay");
  const qr = kit.fakeBeam.payPending(h.linkId, "QR_PROMPT_PAY");
  kit.fakeBeam.charges.get(qr.chargeId)!.listed = false;
  kit.fakeBeam.expire(h.linkId);
  const p = await kit.gw.get(h.key);
  assert.equal(p.state, "expired");
  assert.equal(p.attempted, false, "the reading saw no charge at all");
  kit.fakeCb.failNext("getReservation", "pass", undefined, () => void kit.fakeBeam.revealCharges(h.linkId));
  assert.deepEqual(await releasePayment(h.key, kit.deps, kit.gw, "sweeper"), { state: "refused_open" });
  assert.equal(res(kit, h.reservationId).status, "not_confirmed");
  assert.equal((await kit.gw.get(h.key)).state, "processing");
});

/* ------------------------- a late success on a cancelled hold (decision 3) ------------------------- */

const LIGHTHOUSE = (chargeId: string) => `the full amount in Beam Lighthouse (Payments > charge ${chargeId} > Refund). Nothing is refunded automatically`;
const BANK = (name: string) => `the full amount by bank transfer: Beam can't refund ${name}. Nothing is refunded automatically`;
const METHODS = [
  { type: "CARD", group: "card_ewallet", refund: LIGHTHOUSE },
  { type: "QR_PROMPT_PAY", group: "promptpay", refund: LIGHTHOUSE },
  { type: "ALIPAY", group: "card_ewallet", refund: LIGHTHOUSE },
  { type: "WECHAT_PAY", group: "card_ewallet", refund: LIGHTHOUSE },
  { type: "LINE_PAY", group: "card_ewallet", refund: () => BANK("LINE Pay") },
  { type: "TRUE_MONEY", group: "card_ewallet", refund: () => BANK("TrueMoney") },
  { type: "SHOPEE_PAY", group: "card_ewallet", refund: () => BANK("ShopeePay") },
] as const;

test("a late success after the hold was released (before fulfil's step 5): CRITICAL needs_attention with the method's full refund path", async () => {
  for (const m of METHODS) {
    const kit = makeBeamKit();
    const h = await beamHeld(kit, m.group);
    kit.fakeBeam.expire(h.linkId);
    assert.equal((await releasePayment(h.key, kit.deps, kit.gw, "sweeper")).state, "released", m.type);
    kit.now.ms += 3 * MIN;
    const late = kit.fakeBeam.payAfterClose(h.linkId, m.type);
    const out = await fulfilPayment(h.key, kit.deps, kit.gw);
    const reason = `The guest PAID but the Cloudbeds hold is CANCELLED. Re-instate or re-book the guest in Cloudbeds (if the unit is still free) or refund ${m.refund(late.chargeId)}.`;
    assert.deepEqual(out, { state: "needs_attention", reservationId: h.reservationId, ref: h.ref, reason }, m.type);
    const urgent = critical(kit);
    assert.equal(urgent.length, 1, m.type);
    assert.equal(urgent[0].subject, `URGENT: paid booking ${h.ref} needs attention`);
    assert.equal(urgent[0].lines[0], reason);
    assert.equal(calls(kit, "postPayment").length, 0, m.type);
    assert.equal(res(kit, h.reservationId).status, "canceled", `${m.type}: never re-instated automatically`);
    assert.ok(res(kit, h.reservationId).notes.some((n) => n.includes(`PAID via Beam ${late.chargeId}`)), m.type);
  }
});

test("a late success while a release cancels the hold between fulfil's steps 5 and 7: the step-7 reason ends with the method's refund path", async () => {
  for (const m of METHODS.filter((x) => x.type === "CARD" || x.type === "TRUE_MONEY" || x.type === "QR_PROMPT_PAY")) {
    const kit = makeBeamKit();
    const h = await beamHeld(kit, m.group);
    const charge = kit.fakeBeam.pay(h.linkId, m.type);
    // Right after the payment is posted, something cancels the hold in Cloudbeds before the confirm step reads it.
    kit.fakeCb.failNext("postPayment", "pass", undefined, () =>
      kit.fakeCb.failNext("getReservation", "pass", undefined, () => {
        res(kit, h.reservationId).status = "canceled";
      }),
    );
    const out = await fulfilPayment(h.key, kit.deps, kit.gw);
    assert.equal(out.state, "needs_attention", m.type);
    const reason = "reason" in out ? out.reason : "";
    assert.ok(reason.startsWith(`The guest PAID (${money(h.quote.totalSatang)} via Beam, ${charge.chargeId}) and the payment is recorded on the folio, but Cloudbeds reservation ${h.reservationId} is "canceled"`), reason);
    assert.ok(reason.endsWith(`re-instate and confirm it, or refund ${m.refund(charge.chargeId)}.`), reason);
    assert.equal(calls(kit, "postPayment").length, 1, m.type);
  }
});

/* ------------------------------ a refunded link with two successes ------------------------------ */

test("refund ambiguous: a REFUNDED link with two successes is paid with a mismatch - one CRITICAL, never released, never 'refunded'", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.fakeBeam.pay(h.linkId, "CARD");
  kit.now.ms += MIN;
  const second = kit.fakeBeam.secondCharge(h.linkId, "CARD");
  kit.fakeBeam.refund(second.chargeId);
  assert.equal(kit.fakeBeam.link(h.linkId).status, "REFUNDED");
  const p = await kit.gw.get(h.key);
  assert.equal(p.state, "paid");
  assert.match(p.mismatch ?? "", /is REFUNDED but has 2 SUCCEEDED charges .*check in Lighthouse which charges were refunded/);
  const out = await fulfilPayment(h.key, kit.deps, kit.gw);
  assert.ok(out.state === "needs_attention" && out.reason === p.mismatch);
  assert.deepEqual(await releasePayment(h.key, kit.deps, kit.gw, "sweeper"), { state: "refused_paid", reservationId: h.reservationId });
  assert.deepEqual(await abandonPayment(h.key, kit.deps, kit.gw, h.ref), { state: "paid" });
  for (let i = 0; i < 3; i++) {
    kit.now.ms += PAST_ALERT_WINDOW_MS;
    assert.notEqual((await kit.gw.get(h.key)).state, "refunded");
  }
  assert.equal(withSubject(kit, /charged twice/).length, 1, "the extra charge is reported once too");
  const ambiguous = withSubject(kit, /check in Lighthouse which charges were refunded$/);
  assert.equal(ambiguous.length, 1);
  assert.equal(ambiguous[0].severity, "critical");
  assert.equal(ambiguous[0].subject, `URGENT: Beam payment link ${h.linkId} for booking ${h.ref} is REFUNDED but has 2 successful charges - check in Lighthouse which charges were refunded`);
  assert.equal(res(kit, h.reservationId).status, "not_confirmed");
  assert.equal(calls(kit, "putReservation").filter((c) => c.params.status === "canceled").length, 0);
});

test("refund ambiguous after the booking was confirmed: the next reading raises the CRITICAL once; the booking stays", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.fakeBeam.pay(h.linkId, "CARD");
  assert.equal((await fulfilPayment(h.key, kit.deps, kit.gw)).state, "confirmed");
  kit.now.ms += 30 * MIN;
  const second = kit.fakeBeam.secondCharge(h.linkId, "CARD");
  kit.fakeBeam.refund(second.chargeId);
  await kit.gw.get(h.key);
  kit.now.ms += PAST_ALERT_WINDOW_MS;
  await kit.gw.get(h.key);
  assert.deepEqual(await releasePayment(h.key, kit.deps, kit.gw, "test"), { state: "refused_paid", reservationId: h.reservationId });
  assert.equal(withSubject(kit, /check in Lighthouse which charges were refunded$/).length, 1);
  assert.equal(res(kit, h.reservationId).status, "confirmed");
});

/* -------------------------------- an unreadable expiresAt -------------------------------- */

test("an unreadable link expiresAt: the record's expiry decides when the link needs disabling and when its hold is released", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit, "promptpay");
  const expiresAt = expiryOf(kit, h.linkId);
  assert.equal((await readRecord(kit.deps.kv, h.linkId))?.expiresAt, expiresAt);
  // Beam answers without an expiresAt (and so never expires the link on its own).
  kit.fakeBeam.links.get(h.linkId)!.expiresAtMs = null;
  kit.now.ms += 5 * MIN;
  kit.fakeBeam.payPending(h.linkId, "QR_PROMPT_PAY");
  kit.now.ms = expiresAt + BEAM_EXPIRY_SKEW_MS - 1;
  assert.equal((await kit.gw.readLink(h.key)).state.needsDisable, false);
  kit.now.ms = expiresAt + BEAM_EXPIRY_SKEW_MS;
  const read = await kit.gw.readLink(h.key);
  assert.equal(read.state.state, "processing");
  assert.equal(read.state.needsDisable, true, "past the record's expiry + skew");
  assert.equal(await kit.gw.cancel(h.key), "cancelled");
  assert.deepEqual(await releasePayment(h.key, kit.deps, kit.gw, "sweeper"), { state: "refused_open" }, "the QR is inside its grace");
  kit.now.ms = expiresAt + GRACE_MS;
  const p = await kit.gw.get(h.key);
  assert.equal(p.state, "expired");
  assert.equal(p.pendingReason, "unconfirmed");
  assert.deepEqual(await releasePayment(h.key, kit.deps, kit.gw, "sweeper"), { state: "released", reservationId: h.reservationId });
  assert.equal(withSubject(kit, /^Beam payment still pending/).length, 1);
  // Nothing attempted, and the record lost too: the signed note's expiry stands in; once disabled the link is expired.
  const kit2 = makeBeamKit();
  const g = await beamHeld(kit2);
  const gExpires = expiryOf(kit2, g.linkId);
  kit2.fakeBeam.links.get(g.linkId)!.expiresAtMs = null;
  await kit2.deps.kv.del(keys.beamPayment(g.linkId));
  kit2.now.ms = gExpires + BEAM_EXPIRY_SKEW_MS;
  const open = await kit2.gw.readLink(g.key);
  assert.equal(open.owner?.source, "note");
  assert.equal(open.state.state, "open");
  assert.equal(open.state.needsDisable, true);
  assert.equal(await kit2.gw.cancel(g.key), "cancelled");
  assert.deepEqual(await releasePayment(g.key, kit2.deps, kit2.gw, "sweeper"), { state: "released", reservationId: g.reservationId });
  assert.equal(withSubject(kit2, /^Beam payment still pending/).length, 0);
});

/* ------------------------------ Cloudbeds method and beam-live ------------------------------ */

test("without CLOUDBEDS_BEAM_PAYMENT_METHOD the paid booking is not recorded: the CRITICAL names the Beam variable", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.fakeBeam.pay(h.linkId, "CARD");
  const unset = resolveCloudbedsPaymentMethod({}, "beam-playground");
  const deps = { ...kit.deps, config: { ...kit.config, cloudbedsPaymentMethod: unset.method, cloudbedsPaymentMethodProblem: unset.problem } };
  const gw = beamGateway(deps);
  const failed = await fulfilPayment(h.key, deps, gw).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(failed instanceof Error && /not sent: CLOUDBEDS_BEAM_PAYMENT_METHOD is not set/.test(failed.message), String(failed));
  await alertFulfilPaymentFailure(deps, gw, h.key, failed);
  const refused = critical(kit).find((a) => a.subject === `URGENT: paid booking ${h.ref}: Cloudbeds refused to record the payment`);
  assert.ok(refused, JSON.stringify(kit.alerts));
  assert.ok(refused.lines[1].startsWith("Payment method sent: none, from CLOUDBEDS_BEAM_PAYMENT_METHOD (outside live: CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD when set)."), refused.lines[1]);
  assert.equal(calls(kit, "postPayment").length, 0);
  // The texts name exactly the variables the Beam config reads.
  assert.match(resolveCloudbedsPaymentMethod({}, "beam-live").problem ?? "", new RegExp(`^${BEAM_GATEWAY_TEXT.methodEnvVar} is not set`));
  assert.match(resolveCloudbedsPaymentMethod({ CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD: "credit" }, "beam-playground").problem ?? "", new RegExp(`^${BEAM_GATEWAY_TEXT.testMethodEnvVar} "credit"`));
});

test("the mock Cloudbeds writer without a Beam method records the payment as 'mock-beam' (text.mockMethod)", async () => {
  const env = { ...BEAM_TEST_ENV };
  delete env.CLOUDBEDS_API_KEY_BOOKING;
  delete env.CLOUDBEDS_BEAM_PAYMENT_METHOD;
  const kit = makeBeamKit({ env, cb: { paymentMethods: [{ method: "mock-beam", code: "mock-beam", name: "Mock Beam" }] } });
  assert.deepEqual(kit.config.cloudbedsWrite, { mode: "mock" });
  assert.equal(kit.config.cloudbedsPaymentMethod, null);
  const h = await beamHeld(kit);
  kit.fakeBeam.pay(h.linkId, "CARD");
  assert.equal((await fulfilPayment(h.key, kit.deps, kit.gw)).state, "confirmed");
  assert.deepEqual(res(kit, h.reservationId).payments.map((p) => p.type), ["mock-beam"]);
});

test("beam-live: the live fee item, no TEST label, a '-B' hold, the live API base", async () => {
  const kit = makeBeamKit({ env: BEAM_LIVE_ENV });
  assert.equal(kit.config.paymentMode, "beam-live");
  assert.equal(kit.fakeBeam.apiBase, "https://api.beamcheckout.com");
  const h = await beamHeld(kit);
  assert.equal(res(kit, h.reservationId).thirdPartyIdentifier, `${h.ref}-B`);
  const charge = kit.fakeBeam.pay(h.linkId, "SHOPEE_PAY");
  assert.equal((await fulfilPayment(h.key, kit.deps, kit.gw)).state, "confirmed");
  const r = res(kit, h.reservationId);
  assert.equal(r.payments[0].type, BEAM_CLOUDBEDS_METHOD);
  assert.equal(r.payments[0].description, `Beam link ${h.linkId} charge ${charge.chargeId} (ShopeePay) ref ${h.ref}`);
  const fee = calls(kit, "postCustomItem")[0].params;
  assert.equal(fee["items[0][appItemID]"], "msv-payment-processing-fee-beam");
  assert.equal(fee["items[0][itemSKU]"], "MSV-BEAM-PAYMENT-FEE");
  assert.equal(fee["items[0][itemName]"], "Payment processing fee");
  assert.equal(fee["items[0][itemNote]"], "Online booking payment processing fee (card or e-wallet), paid via Beam.");
  assert.ok(r.notes.some((n) => n.startsWith(`PAID via Beam ${charge.chargeId} (ShopeePay, `) && n.includes("Refund path: bank transfer only (Beam can't refund ShopeePay)")));
  assert.doesNotMatch(JSON.stringify([r.notes, r.payments]), /TEST MODE/);
});

/* ---------------------------------------- privacy ---------------------------------------- */

test("the card's last digits and the guest's details never reach a log, an alert, Redis, Cloudbeds or Beam", async () => {
  const now = { ms: NOW };
  const kv = recordingKv(createMemoryKv(() => now.ms));
  const kit = makeBeamKit({ kv, now });
  const h = await beamHeld(kit);
  const first = kit.fakeBeam.pay(h.linkId, "CARD", { card: { brand: "VISA", last4: "4729", countryAlpha2: "TH" } });
  kit.fakeBeam.secondCharge(h.linkId, "CARD", { card: { brand: "MASTERCARD", last4: "5831", countryAlpha2: "GB" } });
  await fulfilPayment(h.key, kit.deps, kit.gw);
  kit.fakeBeam.refund(first.chargeId);
  await kit.gw.get(h.key);
  await abandonPayment(h.key, kit.deps, kit.gw, h.ref);
  assert.ok(kit.alerts.length >= 3);
  const everything = JSON.stringify([kit.logs, kit.alerts, kv.writes, kit.fakeCb.calls.filter((c) => c.method !== "postReservation")]);
  for (const digits of ["4729", "5831"]) assert.ok(!everything.includes(digits), digits);
  const beamCalls = JSON.stringify(kit.fakeBeam.calls);
  for (const pii of [TEST_EMAIL, "Owner", "952466011", "95 246 6011", "Late dinner"]) assert.ok(!beamCalls.includes(pii), pii);
});

/* ----------------------------------------- texts ----------------------------------------- */

const receipts: GatewayReceipt[] = [
  ...["CARD", "CARD_INSTALLMENTS", "QR_PROMPT_PAY", "ALIPAY", "WECHAT_PAY", "LINE_PAY", "TRUE_MONEY", "SHOPEE_PAY", "KPLUS"].map((methodType) => ({
    primaryId: "ch_TestCharge000000000000000000",
    description: `Beam link rGtqz6DafS charge ch_TestCharge000000000000000000 (${methodType})`,
    methodType,
    refundable: ["CARD", "CARD_INSTALLMENTS", "QR_PROMPT_PAY", "ALIPAY", "WECHAT_PAY"].includes(methodType),
    partialRefundable: methodType === "CARD",
  })),
  { primaryId: null, description: "Beam link rGtqz6DafS charge pending (method pending)" },
];

function beamTexts(text = BEAM_GATEWAY_TEXT): string[] {
  const out: string[] = [
    text.sessionLabel.long,
    text.sessionLabel.short,
    text.refundWhere,
    text.methodEnvVar,
    text.testMethodEnvVar,
    text.feeItemName,
    text.webhookRetryHint,
    text.mockMethod ?? "",
    ...["beam-live", "beam-playground"].flatMap((mode) => Object.values(text.feeItem(mode))),
    ...[[], [{ state: "expired", attempted: false }], [{ state: "expired", attempted: true }], [{ state: "expired", attempted: true, pendingReason: "unconfirmed" }]].map((p) =>
      text.releaseNoteText(p as Pick<GatewayPayment, "state" | "attempted" | "pendingReason">[]),
    ),
  ];
  for (const r of receipts) {
    out.push(text.paidVia(r, "THB 9,270.00"), text.paymentDescription(r, "MSV-20271110-ABCD"), text.refundHow?.(r) ?? "", text.bookedExtra?.(r) ?? "");
    const payment: GatewayPayment = {
      key: "beam:rGtqz6DafS",
      paymentId: "rGtqz6DafS",
      state: "expired",
      meta: null,
      amountSatang: 927_000,
      currency: "THB",
      attempted: true,
      receipt: r,
      pendingReason: "unconfirmed",
    };
    const a = text.pendingReleasedAlert?.(payment, "7000000000001");
    if (a) out.push(a.subject, ...a.lines, a.key);
  }
  return out;
}

test("texts: no Beam text names Stripe; the Beam fee items, labels and env names are pinned", () => {
  const all = beamTexts();
  assert.ok(all.length > 60);
  for (const t of all) assert.doesNotMatch(t, /stripe/i, t);
  for (const t of beamTexts(beamGatewayText({ pendingGraceMinutes: 45 }))) assert.doesNotMatch(t, /stripe/i, t);
  assert.deepEqual(BEAM_GATEWAY_TEXT.feeItem("beam-live"), {
    appItemId: "msv-payment-processing-fee-beam",
    itemSku: "MSV-BEAM-PAYMENT-FEE",
    name: "Payment processing fee",
    note: "Online booking payment processing fee (card or e-wallet), paid via Beam.",
  });
  assert.deepEqual(BEAM_GATEWAY_TEXT.feeItem("beam-playground"), {
    appItemId: "msv-payment-processing-fee-beam-test",
    itemSku: "MSV-BEAM-PAYMENT-FEE-TEST",
    name: "TEST - Payment processing fee",
    note: "TEST MODE - NOT REAL MONEY. Test fee line.",
  });
  assert.deepEqual(BEAM_GATEWAY_TEXT.sessionLabel, { long: "payment link", short: "link" });
  assert.equal(BEAM_GATEWAY_TEXT.refundWhere, "in full in Beam Lighthouse (nothing is refunded automatically)");
  assert.equal(BEAM_GATEWAY_TEXT.webhookRetryHint, "Beam webhook retries");
  assert.equal(BEAM_GATEWAY_TEXT.mockMethod, "mock-beam");
  assert.equal(BEAM_GATEWAY_TEXT.methodEnvVar, "CLOUDBEDS_BEAM_PAYMENT_METHOD");
  assert.equal(BEAM_GATEWAY_TEXT.testMethodEnvVar, "CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD");
  assert.equal(BEAM_GATEWAY_TEXT.paymentDescription(receipts[0], "MSV-20271110-ABCD"), `${receipts[0].description} ref MSV-20271110-ABCD`);
  assert.equal(
    BEAM_GATEWAY_TEXT.releaseNoteText([]),
    "Hold released by the sweeper: no payment link was ever created (the booking page failed before Beam). Nothing was charged.",
  );
  assert.equal(
    BEAM_GATEWAY_TEXT.paidVia(receipts[0], "THB 9,270.00"),
    "via Beam ch_TestCharge000000000000000000 (card, THB 9,270.00). Refund path: Beam Lighthouse (full or 50% refunds of the card payment)",
  );
  assert.ok(BEAM_GATEWAY_TEXT.paidVia(receipts[receipts.length - 1], "THB 1.00").startsWith("via Beam charge id pending (method pending, THB 1.00). Refund path: check the charge's method in Beam Lighthouse"));
});

test("texts: the Stripe gateway's words are unchanged and set none of the Beam hooks", () => {
  const r: GatewayReceipt = { primaryId: "pi_123", description: "Stripe pi_123 charge ch_1 session cs_test_1" };
  assert.equal(STRIPE_GATEWAY_TEXT.paidVia(r, "THB 18,900.00"), "via Stripe pi_123 (THB 18,900.00)");
  assert.equal(STRIPE_GATEWAY_TEXT.paidVia({ ...r, primaryId: null }, "THB 1.00"), "via Stripe - (THB 1.00)");
  assert.equal(STRIPE_GATEWAY_TEXT.paymentDescription(r, "MSV-20261005-ABCD"), "Stripe pi_123 charge ch_1 session cs_test_1 ref MSV-20261005-ABCD");
  assert.deepEqual(STRIPE_GATEWAY_TEXT.sessionLabel, { long: "Checkout Session", short: "session" });
  assert.equal(STRIPE_GATEWAY_TEXT.refundWhere, "in Stripe");
  assert.equal(STRIPE_GATEWAY_TEXT.methodEnvVar, "CLOUDBEDS_STRIPE_PAYMENT_METHOD");
  assert.equal(STRIPE_GATEWAY_TEXT.testMethodEnvVar, "CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD");
  assert.equal(STRIPE_GATEWAY_TEXT.feeItemName, "Payment processing fee");
  assert.equal(STRIPE_GATEWAY_TEXT.webhookRetryHint, "Stripe webhook retries");
  for (const mode of ["stripe-live", "stripe-test", "stripe-mock"]) assert.deepEqual(STRIPE_GATEWAY_TEXT.feeItem(mode), feeItemFor(mode), mode);
  assert.deepEqual(STRIPE_GATEWAY_TEXT.feeItem("stripe-live"), {
    appItemId: "msv-payment-processing-fee",
    itemSku: "MSV-PAYMENT-FEE",
    name: "Payment processing fee",
    note: "Online booking payment processing fee, paid via Stripe.",
  });
  assert.equal(
    STRIPE_GATEWAY_TEXT.releaseNoteText([]),
    "Hold released by the sweeper: no payment page was ever created (the booking page failed before Stripe). Nothing was charged.",
  );
  assert.equal(
    STRIPE_GATEWAY_TEXT.releaseNoteText([{ state: "failed", attempted: true }]),
    "Hold released by the sweeper: a payment was attempted on the Stripe page but did not go through. Nothing was charged.",
  );
  assert.equal(
    STRIPE_GATEWAY_TEXT.releaseNoteText([{ state: "expired", attempted: true }]),
    "Hold released by the sweeper: the Stripe payment page was opened and a payment was started but never completed. Nothing was charged.",
  );
  assert.equal(
    STRIPE_GATEWAY_TEXT.releaseNoteText([{ state: "expired", attempted: false }]),
    "Hold released by the sweeper: the Stripe payment page was created but no payment was ever attempted. Nothing was charged.",
  );
  for (const hook of ["refundHow", "mockMethod", "bookedExtra", "pendingReleasedAlert"] as const) assert.equal(STRIPE_GATEWAY_TEXT[hook], undefined, hook);
});

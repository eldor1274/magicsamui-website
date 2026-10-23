// The Beam webhook handler (design S4.4) through the real core: fulfilPayment, releasePayment and the sweeper
// on the in-repo fake Beam (signed events exactly as Beam sends them) and the fake Cloudbeds
// (beamTestkit.ts makeBeamKit). Each hold is a real one from the Beam checkout (startBeamCheckout).
//
// Covered: unconfigured, bad signatures (the 3rd alerts), bodies that are not JSON or name nothing of ours, the
// owner's own links; payment_link.paid and charge.succeeded (card + fee line, PromptPay without), both events of
// one payment, 5 concurrent deliveries, a replay, in_progress, Cloudbeds down, Redis or Beam failing, a missing
// record, open / processing / expired / refunded links, a second charge after the booking is done; the event
// kind taken from the body whatever the header says; refunds (the real status re-read, the charge index 40 days
// later, the referenceId fallback, another mode's charge); transactions (logged once, chargebacks CRITICAL);
// no card digits or guest details in any log, alert or Redis write.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ALERT_WINDOW_SECONDS } from "./alerts.ts";
import { createPaymentLink } from "./beam.ts";
import type { BeamCreatePaymentLinkRequest } from "./beam.ts";
import { BEAM_CLOUDBEDS_METHOD, beamHeld, cardDigitsShown, makeBeamKit } from "./beamTestkit.ts";
import type { BeamHeld, BeamKit } from "./beamTestkit.ts";
import { BEAM_BAD_SIGNATURE_ALERT_THRESHOLD, BEAM_TXN_TTL_SECONDS, beamWebhookEventOf, handleBeamWebhook } from "./beamWebhook.ts";
import type { BeamWebhookResult } from "./beamWebhook.ts";
import { createMemoryKv } from "./kv.ts";
import type { KvStore } from "./kv.ts";
import { keyScope, keys } from "./lock.ts";
import { beamSignature } from "./mock/fakeBeam.ts";
import type { FakeBeamSignedEvent } from "./mock/fakeBeam.ts";
import type { BeamChargeIndexEntry, BeamGatewayDeps } from "./payments/beamGateway.ts";
import { satangToBahtString } from "./quote.ts";
import { runSweep } from "./sweep.ts";
import { NOW, recordingKv } from "./testkit.ts";
import type { CartItemInput } from "./types.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const PAST_ALERT_WINDOW_MS = ALERT_WINDOW_SECONDS * 1000 + MIN;
const SCOPE = keyScope("beam-playground");
const money = (satang: number) => `THB ${satangToBahtString(satang)}`;

const deliver = (kit: BeamKit, ev: FakeBeamSignedEvent, deps: BeamGatewayDeps | null = kit.deps): Promise<BeamWebhookResult> =>
  handleBeamWebhook(ev.raw, ev.headers, deps, kit.config.beamWebhookHmacKey);
/** A hand-made body, signed with the kit's key exactly as Beam signs (the header unsigned, as Beam's is). */
function signed(kit: BeamKit, body: unknown, header = "charge.succeeded"): FakeBeamSignedEvent {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const key = kit.config.beamWebhookHmacKey;
  assert.ok(key);
  return { raw, headers: { "x-beam-signature": beamSignature(raw, key), "x-beam-event": header } };
}
const res = (kit: BeamKit, id: string) => {
  const r = kit.fakeCb.reservations.get(id);
  assert.ok(r, `no reservation ${id}`);
  return r;
};
const calls = (kit: BeamKit, method: string) => kit.fakeCb.calls.filter((c) => c.method === method);
const cbWrites = (kit: BeamKit) => kit.fakeCb.calls.filter((c) => ["postPayment", "postCustomItem", "putReservation", "postReservationNote"].includes(c.method)).length;
const critical = (kit: BeamKit) => kit.alerts.filter((a) => a.severity === "critical");
const withSubject = (kit: BeamKit, re: RegExp) => kit.alerts.filter((a) => re.test(a.subject));
const logged = (kit: BeamKit, message: string) => kit.logs.filter((l) => l.message === message);
const paidIndex = (kit: BeamKit) => kit.deps.kv.zrangeByScore(keys.paidIndex(SCOPE), 0, Number.MAX_SAFE_INTEGER, 100);

/** A card-paid, confirmed Beam booking (through payment_link.paid). */
async function confirmedBooking(kit: BeamKit): Promise<{ h: BeamHeld; chargeId: string }> {
  const h = await beamHeld(kit);
  const card = kit.fakeBeam.pay(h.linkId, "CARD");
  assert.deepEqual(await deliver(kit, kit.fakeBeam.signedEvent("payment_link.paid", h.linkId)), { status: 200, body: "confirmed" });
  return { h, chargeId: card.chargeId };
}

/** A link body of someone else's making (the owner's own Lighthouse link): no signed note. */
function foreignLinkBody(kit: BeamKit, referenceId = "dinner-voucher-7"): BeamCreatePaymentLinkRequest {
  return {
    order: { currency: "THB", netAmount: 150_000, description: "Dinner voucher", referenceId, internalNote: "Lighthouse link", orderItems: [] },
    linkSettings: { card: { isEnabled: true } },
    collectPhoneNumber: false,
    collectDeliveryAddress: false,
    redirectUrl: "https://example.com/done",
    cancelUrl: "https://example.com/cancel",
    expiresAt: new Date(kit.now.ms + 30 * MIN).toISOString(),
  };
}

/** A memory KV on `now` whose operations matching `fail` throw while it says so. */
function switchableKv(now: { ms: number }, fail: { when: (op: "get" | "set" | "zadd" | "setNx", key: string) => boolean }): KvStore {
  const inner = createMemoryKv(() => now.ms);
  const boom = () => Promise.reject(new Error("simulated Redis failure"));
  return {
    ...inner,
    kind: inner.kind,
    get: (key) => (fail.when("get", key) ? boom() : inner.get(key)),
    set: (key, value, ttl) => (fail.when("set", key) ? boom() : inner.set(key, value, ttl)),
    setNx: (key, value, ttl) => (fail.when("setNx", key) ? boom() : inner.setNx(key, value, ttl)),
    zadd: (key, score, member) => (fail.when("zadd", key) ? boom() : inner.zadd(key, score, member)),
  };
}

/* ------------------------------------- configuration and signature ------------------------------------- */

test("unconfigured: no HMAC key or no Beam deps -> 503 (Beam retries), nothing read or written", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.fakeBeam.pay(h.linkId, "CARD");
  const ev = kit.fakeBeam.signedEvent("payment_link.paid", h.linkId);
  const beamCalls = kit.fakeBeam.calls.length;
  for (const key of [null, undefined, "", "   "]) {
    assert.deepEqual(await handleBeamWebhook(ev.raw, ev.headers, kit.deps, key), { status: 503, body: "webhook not configured" }, String(key));
  }
  assert.deepEqual(await handleBeamWebhook(ev.raw, ev.headers, null, kit.config.beamWebhookHmacKey), { status: 503, body: "webhook not configured" });
  assert.equal(kit.fakeBeam.calls.length, beamCalls);
  assert.equal(await kit.deps.kv.get(keys.reservationPaid(h.reservationId)), null);
  assert.equal(logged(kit, "beam_webhook_unconfigured").length, 4);
  assert.equal(res(kit, h.reservationId).status, "not_confirmed");
});

test("a bad signature -> 401 and counted; the 3rd in an hour alerts once, naming BEAM_WEBHOOK_HMAC_KEY", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.fakeBeam.pay(h.linkId, "CARD");
  const good = kit.fakeBeam.signedEvent("payment_link.paid", h.linkId);
  const otherKey = Buffer.from("playground-key-not-production-1!").toString("base64");
  const bad: FakeBeamSignedEvent[] = [
    kit.fakeBeam.signedEvent("payment_link.paid", h.linkId, { hmacKeyB64: otherKey }),
    { raw: good.raw, headers: { "x-beam-event": "payment_link.paid" } as FakeBeamSignedEvent["headers"] },
    { raw: `${good.raw} `, headers: good.headers },
    { raw: good.raw, headers: { ...good.headers, "x-beam-signature": "not base64 at all" } },
  ];
  const beamCalls = kit.fakeBeam.calls.length;
  const cb = cbWrites(kit);
  for (const [i, ev] of bad.entries()) {
    assert.deepEqual(await deliver(kit, ev), { status: 401, body: "invalid signature" }, String(i));
    assert.equal(withSubject(kit, /signatures are being rejected/).length, i + 1 >= BEAM_BAD_SIGNATURE_ALERT_THRESHOLD ? 1 : 0, String(i));
  }
  const [warned] = withSubject(kit, /signatures are being rejected/);
  assert.equal(warned.subject, "Beam webhook: signatures are being rejected");
  assert.equal(warned.severity, "warning");
  assert.deepEqual(warned.lines, [
    "3 Beam webhook deliveries in the last hour failed the signature check (mode beam-playground). Check BEAM_WEBHOOK_HMAC_KEY is the key of THIS environment's Lighthouse webhook (Playground and Production keys differ). Paid bookings are still confirmed by the return page and the sweeper.",
  ]);
  assert.equal(await kit.deps.kv.get(keys.beamBadSignatures(SCOPE)), "4");
  // Asked once (the 3rd), not merely held back by the alerter's own repeat window on the 4th.
  assert.equal(logged(kit, "alert_warning").filter((l) => l.data?.subject === "Beam webhook: signatures are being rejected").length, 1);
  assert.equal(kit.fakeBeam.calls.length, beamCalls, "nothing unsigned reaches Beam");
  assert.equal(cbWrites(kit), cb);
  assert.deepEqual(logged(kit, "beam_webhook_bad_signature").map((l) => l.data?.hasHeader), [true, false, true, true]);
  assert.ok(!kit.logText().includes(good.headers["x-beam-signature"]), "the signature is never logged");
  // The genuine delivery still works.
  assert.equal((await deliver(kit, good)).body, "confirmed");
});

test("signed but not a JSON object -> 200 and a log line; bodies that name nothing of ours -> 200 ignored, no Beam call", async () => {
  const kit = makeBeamKit();
  const beamCalls = kit.fakeBeam.calls.length;
  for (const raw of ["not json {", "[1,2,3]", "null", "\"text\"", ""]) {
    assert.deepEqual(await deliver(kit, signed(kit, raw)), { status: 200, body: "ignored: not a JSON object" }, raw);
  }
  assert.equal(logged(kit, "beam_webhook_unparseable").length, 5);
  const ignored: [unknown, string][] = [
    [{}, "no payment link, charge, refund or transaction id"],
    [{ hello: "world" }, "no payment link, charge, refund or transaction id"],
    [{ chargeId: "ch_Api0000000000000000000000000", source: "API", sourceId: "x", status: "SUCCEEDED" }, "not a payment-link charge"],
    [{ chargeId: "ch_Store000000000000000000000000", source: "STORE_LINK", sourceId: "abc", status: "SUCCEEDED" }, "not a payment-link charge"],
    [{ chargeId: "ch_Bad00000000000000000000000000", source: "PAYMENT_LINK", sourceId: "a/b", status: "SUCCEEDED" }, "unexpected payment link id"],
    [{ paymentLinkId: "../x", order: {} }, "unexpected payment link id"],
    [{ paymentLinkId: "rGtqz6DafS" }, "no payment link, charge, refund or transaction id"],
    [{ refundId: "re bad id" }, "unexpected refund id"],
    [{ transactionId: "tx_1" }, "no payment link, charge, refund or transaction id"],
    [{ transactionId: "tx 1", transactionType: "PAYMENT" }, "unexpected transaction id"],
  ];
  for (const [body, reason] of ignored) {
    assert.deepEqual(beamWebhookEventOf(body as Record<string, unknown>), { kind: "ignored", reason }, JSON.stringify(body));
    assert.deepEqual(await deliver(kit, signed(kit, body)), { status: 200, body: "ignored" }, JSON.stringify(body));
  }
  assert.equal(kit.fakeBeam.calls.length, beamCalls);
  assert.equal(logged(kit, "beam_webhook_ignored").length, ignored.length);
  assert.equal(kit.alerts.length, 0);
});

test("the kind comes from the body's ids, the header only hints", () => {
  assert.deepEqual(beamWebhookEventOf({ paymentLinkId: "rGtqz6DafS", order: { netAmount: 100 } }), { kind: "link", linkId: "rGtqz6DafS" });
  assert.deepEqual(beamWebhookEventOf({ chargeId: "ch_A", source: "PAYMENT_LINK", sourceId: "rGtqz6DafS", status: "FAILED" }), {
    kind: "charge",
    linkId: "rGtqz6DafS",
    chargeId: "ch_A",
    status: "FAILED",
  });
  // A refund body carries its chargeId but no source: a refund, never a charge.
  assert.deepEqual(beamWebhookEventOf({ refundId: "re_A", chargeId: "ch_A", status: "SUCCEEDED" }), { kind: "refund", refundId: "re_A", status: "SUCCEEDED" });
  assert.deepEqual(beamWebhookEventOf({ transactionId: "ch_A", transactionType: "PAYMENT", sourceId: "rGtqz6DafS" }), {
    kind: "transaction",
    transactionId: "ch_A",
    transactionType: "PAYMENT",
  });
});

/* -------------------------------------------- paid -------------------------------------------- */

test("payment_link.paid (card): confirmed with exactly one postPayment 'Beam(website)' and the fee line; Headers and raw bytes as the route passes them", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const card = kit.fakeBeam.pay(h.linkId, "CARD");
  const ev = kit.fakeBeam.signedEvent("payment_link.paid", h.linkId);
  const out = await handleBeamWebhook(Buffer.from(ev.raw, "utf8"), new Headers(ev.headers), kit.deps, kit.config.beamWebhookHmacKey);
  assert.deepEqual(out, { status: 200, body: "confirmed" });
  const r = res(kit, h.reservationId);
  assert.equal(r.status, "confirmed");
  assert.deepEqual(
    r.payments.map((p) => ({ type: p.type, amount: p.amount, description: p.description })),
    [{ type: BEAM_CLOUDBEDS_METHOD, amount: h.quote.totalSatang / 100, description: `TEST MODE - NOT REAL MONEY. Beam link ${h.linkId} charge ${card.chargeId} (card) ref ${h.ref}` }],
  );
  const fee = calls(kit, "postCustomItem");
  assert.equal(fee.length, 1);
  assert.equal(fee[0].params["items[0][itemPrice]"], satangToBahtString(h.quote.cardFeeSatang));
  assert.ok(h.quote.cardFeeSatang > 0);
  assert.equal(kit.fakeCb.balance(h.reservationId), 0);
  assert.equal(await kit.deps.kv.get(keys.reservationPaid(h.reservationId)), h.key);
  assert.deepEqual(await paidIndex(kit), [], "done: off the unconfirmed-paid index");
  assert.equal(withSubject(kit, /^New direct booking/).length, 1);
  assert.equal(critical(kit).length, 0);
  assert.deepEqual(logged(kit, "beam_webhook").map((l) => l.data), [{ kind: "link", event: "payment_link.paid", linkId: h.linkId }]);
});

test("payment_link.paid (PromptPay): confirmed with one postPayment and no fee line", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit, "promptpay");
  assert.equal(h.quote.cardFeeSatang, 0);
  kit.fakeBeam.pay(h.linkId, "QR_PROMPT_PAY");
  assert.deepEqual(await deliver(kit, kit.fakeBeam.signedEvent("payment_link.paid", h.linkId)), { status: 200, body: "confirmed" });
  assert.equal(calls(kit, "postPayment").length, 1);
  assert.deepEqual(res(kit, h.reservationId).payments.map((p) => p.type), [BEAM_CLOUDBEDS_METHOD]);
  assert.equal(calls(kit, "postCustomItem").length, 0);
  assert.equal(kit.fakeCb.balance(h.reservationId), 0);
  assert.equal(res(kit, h.reservationId).status, "confirmed");
});

test("charge.succeeded then payment_link.paid: one fulfilment; the second answers confirmed from the done marker", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const card = kit.fakeBeam.pay(h.linkId, "CARD");
  assert.deepEqual(await deliver(kit, kit.fakeBeam.signedEvent("charge.succeeded", card.chargeId)), { status: 200, body: "confirmed" });
  assert.deepEqual(await deliver(kit, kit.fakeBeam.signedEvent("payment_link.paid", h.linkId)), { status: 200, body: "confirmed" });
  assert.equal(calls(kit, "postPayment").length, 1);
  assert.equal(calls(kit, "postCustomItem").length, 1);
  assert.equal(withSubject(kit, /^New direct booking/).length, 1);
  assert.deepEqual(logged(kit, "beam_webhook_payment").map((l) => l.data?.outcome), ["confirmed", "confirmed"]);
});

test("5 concurrent deliveries (both events, retries): one postPayment, every answer 200", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const card = kit.fakeBeam.pay(h.linkId, "CARD");
  const linkEv = kit.fakeBeam.signedEvent("payment_link.paid", h.linkId);
  const chargeEv = kit.fakeBeam.signedEvent("charge.succeeded", card.chargeId);
  const answers = await Promise.all([linkEv, chargeEv, linkEv, chargeEv, linkEv].map((ev) => deliver(kit, ev)));
  for (const a of answers) assert.equal(a.status, 200, JSON.stringify(answers));
  assert.ok(answers.some((a) => a.body === "confirmed"));
  assert.ok(answers.every((a) => a.body === "confirmed" || a.body === "in_progress"), JSON.stringify(answers));
  assert.equal(calls(kit, "postPayment").length, 1);
  assert.equal(calls(kit, "postCustomItem").length, 1);
  assert.equal(res(kit, h.reservationId).status, "confirmed");
  assert.deepEqual(await paidIndex(kit), []);
});

test("a replay of a finished payment's events: no new write in Redis or Cloudbeds, no alert", async () => {
  const now = { ms: NOW };
  const kv = recordingKv(createMemoryKv(() => now.ms));
  const kit = makeBeamKit({ kv, now });
  const h = await beamHeld(kit);
  const card = kit.fakeBeam.pay(h.linkId, "CARD");
  const linkEv = kit.fakeBeam.signedEvent("payment_link.paid", h.linkId);
  const chargeEv = kit.fakeBeam.signedEvent("charge.succeeded", card.chargeId);
  assert.equal((await deliver(kit, linkEv)).body, "confirmed");
  kit.now.ms += PAST_ALERT_WINDOW_MS;
  const writes = kv.writes.length;
  const cb = cbWrites(kit);
  const alerts = kit.alerts.length;
  for (const ev of [linkEv, chargeEv, linkEv]) assert.deepEqual(await deliver(kit, ev), { status: 200, body: "confirmed" });
  const fresh = kv.writes.slice(writes);
  assert.ok(fresh.every((w) => w.op === "setNx" && w.result === false), JSON.stringify(fresh));
  assert.equal(cbWrites(kit), cb);
  assert.equal(kit.alerts.length, alerts);
  assert.deepEqual(await paidIndex(kit), []);
});

test("in_progress (another caller holds the fulfil lock) -> 200 with the paid marker and the paid entry; the sweeper confirms it", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.fakeBeam.pay(h.linkId, "CARD");
  assert.ok(await kit.deps.kv.setNx(keys.fulfilLock(h.key), "the-return-page", 120));
  assert.deepEqual(await deliver(kit, kit.fakeBeam.signedEvent("payment_link.paid", h.linkId)), { status: 200, body: "in_progress" });
  assert.equal(await kit.deps.kv.get(keys.reservationPaid(h.reservationId)), h.key, "release refuses the hold from now on");
  assert.deepEqual(await paidIndex(kit), [h.key], "the sweeper retries it");
  assert.ok(await kit.deps.kv.get(keys.paidPending(h.key)));
  assert.equal(calls(kit, "postPayment").length, 0);
  // The other caller died without finishing: its lock times out and the next sweeper run confirms the booking.
  kit.now.ms += 3 * MIN;
  const s = await runSweep(kit.deps, kit.gw);
  assert.equal(s.fulfilled, 1);
  assert.equal(res(kit, h.reservationId).status, "confirmed");
  assert.equal(calls(kit, "postPayment").length, 1);
  assert.deepEqual(await paidIndex(kit), []);
});

test("Cloudbeds down -> 200 and the owner alerted (retrying); the next sweeper run confirms it", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.fakeBeam.pay(h.linkId, "CARD");
  kit.fakeCb.failNext("postReservationNote", "http500");
  kit.fakeCb.failNext("getReservation", "http500");
  const out = await deliver(kit, kit.fakeBeam.signedEvent("payment_link.paid", h.linkId));
  assert.deepEqual(out, { status: 200, body: "fulfilment failed - retried by the sweeper" });
  const warned = withSubject(kit, /not yet confirmed in Cloudbeds \(retrying\)/);
  assert.equal(warned.length, 1);
  assert.equal(warned[0].subject, `Paid booking ${h.ref} not yet confirmed in Cloudbeds (retrying)`);
  assert.equal(await kit.deps.kv.get(keys.reservationPaid(h.reservationId)), h.key);
  assert.deepEqual(await paidIndex(kit), [h.key]);
  assert.equal(res(kit, h.reservationId).status, "not_confirmed");
  kit.now.ms += 10 * MIN;
  const s = await runSweep(kit.deps, kit.gw);
  assert.equal(s.fulfilled, 1);
  assert.equal(res(kit, h.reservationId).status, "confirmed");
  assert.equal(calls(kit, "postPayment").length, 1);
  assert.deepEqual(await paidIndex(kit), []);
});

test("a failing Redis write of the paid marker or the paid entry -> 503, nothing in Cloudbeds; Beam's retry confirms it", async () => {
  const cases: [string, (op: string, key: string) => boolean][] = [
    ["the paid marker", (op, key) => op === "set" && key.startsWith("msv:paid:res:")],
    ["the paid entry", (op, key) => op === "zadd" && key === keys.paidIndex(SCOPE)],
    ["the done check", (op, key) => op === "get" && key.startsWith("msv:done:fulfil:beam:")],
  ];
  for (const [label, when] of cases) {
    const now = { ms: NOW };
    const fail = { on: false, when: (op: "get" | "set" | "zadd" | "setNx", key: string) => fail.on && when(op, key) };
    const kit = makeBeamKit({ kv: switchableKv(now, fail), now });
    const h = await beamHeld(kit);
    kit.fakeBeam.pay(h.linkId, "CARD");
    const ev = kit.fakeBeam.signedEvent("payment_link.paid", h.linkId);
    const before = cbWrites(kit);
    fail.on = true;
    assert.deepEqual(await deliver(kit, ev), { status: 503, body: "payment could not be recorded - retry" }, label);
    assert.equal(cbWrites(kit), before, `${label}: nothing written to Cloudbeds`);
    assert.equal(logged(kit, "beam_webhook_paid_marker_failed").length, 1, label);
    fail.on = false;
    kit.now.ms += MIN;
    assert.deepEqual(await deliver(kit, ev), { status: 200, body: "confirmed" }, label);
    assert.equal(calls(kit, "postPayment").length, 1, label);
  }
});

test("Beam or Redis unreadable -> 503 with nothing decided; a link Beam does not know -> 200 not ours", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.fakeBeam.pay(h.linkId, "CARD");
  const ev = kit.fakeBeam.signedEvent("payment_link.paid", h.linkId);
  const cb = cbWrites(kit);
  kit.fakeBeam.failNext(new RegExp(`^GET /api/v1/payment-links/${h.linkId}$`), 500, null);
  kit.fakeBeam.failNext(new RegExp(`^GET /api/v1/payment-links/${h.linkId}$`), 500, null);
  assert.deepEqual(await deliver(kit, ev), { status: 503, body: "payment could not be read - retry" });
  assert.equal(await kit.deps.kv.get(keys.reservationPaid(h.reservationId)), null);
  assert.equal(logged(kit, "beam_webhook_read_failed").length, 1);
  assert.equal(cbWrites(kit), cb);
  // The deadline is spent: no call is made at all, and Beam is asked to retry.
  const late = { ...kit.deps, deadlineMs: 1_000, clock: () => 5_000 };
  const beamCalls = kit.fakeBeam.calls.length;
  assert.equal((await deliver(kit, ev, late)).status, 503);
  assert.equal(kit.fakeBeam.calls.length, beamCalls);
  assert.deepEqual(await deliver(kit, ev), { status: 200, body: "confirmed" });

  const missing = signed(kit, { chargeId: "ch_Unknown000000000000000000000", source: "PAYMENT_LINK", sourceId: "NoSuchLnk1", status: "SUCCEEDED", amount: 100, currency: "THB" });
  assert.deepEqual(await deliver(kit, missing), { status: 200, body: "not ours" });
  assert.equal(logged(kit, "beam_webhook_not_ours").at(-1)?.data?.reason, "missing");

  // Redis down while the gateway reads the record: never "not ours", Beam retries.
  const now = { ms: NOW };
  const fail = { on: false, when: (op: string, key: string) => fail.on && op === "get" && key.startsWith("msv:beam:pay:") };
  const kit2 = makeBeamKit({ kv: switchableKv(now, fail), now });
  const g = await beamHeld(kit2);
  kit2.fakeBeam.pay(g.linkId, "CARD");
  const cb2 = cbWrites(kit2);
  fail.on = true;
  assert.deepEqual(await deliver(kit2, kit2.fakeBeam.signedEvent("payment_link.paid", g.linkId)), { status: 503, body: "payment could not be read - retry" });
  assert.equal(cbWrites(kit2), cb2);
});

test("the owner's own Lighthouse link -> 200 not ours: no Cloudbeds call, no Redis marker, no alert", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const link = await createPaymentLink(kit.beam, foreignLinkBody(kit, h.ref), "owner-link-1", kit.fakeBeam.fetch);
  const charge = kit.fakeBeam.pay(link.id, "CARD");
  const cbCalls = kit.fakeCb.calls.length;
  for (const ev of [kit.fakeBeam.signedEvent("payment_link.paid", link.id), kit.fakeBeam.signedEvent("charge.succeeded", charge.chargeId)]) {
    assert.deepEqual(await deliver(kit, ev), { status: 200, body: "not ours" });
  }
  assert.equal(kit.fakeCb.calls.length, cbCalls, "no Cloudbeds call at all");
  assert.equal(await kit.deps.kv.get(keys.fulfilDone(kit.gw.keyOf(link.id))), null);
  assert.deepEqual(await paidIndex(kit), []);
  assert.equal(await kit.deps.kv.get(keys.beamCharge(charge.chargeId)), null);
  assert.equal(kit.alerts.length, 0);
  assert.equal(res(kit, h.reservationId).status, "not_confirmed");
});

test("record missing: fulfilled from the signed note with one 'record missing' warning", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const card = kit.fakeBeam.pay(h.linkId, "CARD");
  await kit.deps.kv.del(keys.beamPayment(h.linkId));
  assert.deepEqual(await deliver(kit, kit.fakeBeam.signedEvent("charge.succeeded", card.chargeId)), { status: 200, body: "confirmed" });
  kit.now.ms += PAST_ALERT_WINDOW_MS;
  assert.deepEqual(await deliver(kit, kit.fakeBeam.signedEvent("payment_link.paid", h.linkId)), { status: 200, body: "confirmed" });
  assert.equal(res(kit, h.reservationId).status, "confirmed");
  const warned = withSubject(kit, /^Beam payment record missing/);
  assert.equal(warned.length, 1);
  assert.equal(warned[0].subject, `Beam payment record missing for link ${h.linkId} (booking ${h.ref})`);
  assert.equal(calls(kit, "postPayment").length, 1);
});

test("a second charge.succeeded after the booking is done: one 'charged twice' CRITICAL, nothing recorded twice", async () => {
  const kit = makeBeamKit();
  const { h, chargeId } = await confirmedBooking(kit);
  kit.now.ms += 10 * MIN;
  const wallet = kit.fakeBeam.secondCharge(h.linkId, "LINE_PAY");
  const ev = kit.fakeBeam.signedEvent("charge.succeeded", wallet.chargeId);
  assert.deepEqual(await deliver(kit, ev), { status: 200, body: "confirmed" });
  kit.now.ms += PAST_ALERT_WINDOW_MS;
  assert.deepEqual(await deliver(kit, ev), { status: 200, body: "confirmed" });
  const dup = withSubject(kit, /charged twice/);
  assert.equal(dup.length, 1);
  assert.equal(dup[0].severity, "critical");
  assert.equal(dup[0].subject, `URGENT: guest charged twice for booking ${h.ref}`);
  assert.match(dup[0].lines[0], new RegExp(`${chargeId} \\(card, [^)]+\\) is the one recorded in Cloudbeds; ${wallet.chargeId} \\(LINE Pay, `));
  assert.equal(calls(kit, "postPayment").length, 1);
  assert.equal(res(kit, h.reservationId).payments.length, 1);
});

test("a paid link that disagrees with our record (the charge's amount): paid marker first, then 200 needs_attention, never not ours", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.fakeBeam.pay(h.linkId, "CARD", { amount: h.quote.totalSatang - 100 });
  assert.deepEqual(await deliver(kit, kit.fakeBeam.signedEvent("payment_link.paid", h.linkId)), { status: 200, body: "needs_attention" });
  const urgent = critical(kit);
  assert.equal(urgent.length, 1);
  assert.equal(urgent[0].subject, `URGENT: paid booking ${h.ref} needs attention`);
  assert.equal(calls(kit, "postPayment").length, 0);
  assert.equal(await kit.deps.kv.get(keys.reservationPaid(h.reservationId)), h.key, "release refuses the hold: a person settles it");
  assert.equal(res(kit, h.reservationId).status, "not_confirmed");
});

test("the header never decides: a payment_link.paid body sent as refund.succeeded is still a paid link (the disagreement is logged)", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.fakeBeam.pay(h.linkId, "CARD");
  const ev = kit.fakeBeam.signedEvent("payment_link.paid", h.linkId, { header: "refund.succeeded" });
  assert.deepEqual(await deliver(kit, ev), { status: 200, body: "confirmed" });
  assert.deepEqual(logged(kit, "beam_webhook_event_mismatch").map((l) => l.data), [{ event: "refund.succeeded", kind: "link", expected: "payment_link.paid" }]);
  assert.equal(withSubject(kit, /refund/i).length, 0);
});

/* ------------------------------------ open, processing, closed, refunded ------------------------------------ */

test("charge.failed leaves the link ACTIVE: 200 'open', the hold stays; a pending attempt beside it -> 'processing'", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const cb = cbWrites(kit);
  const declined = kit.fakeBeam.decline(h.linkId, "CARD");
  assert.deepEqual(await deliver(kit, kit.fakeBeam.signedEvent("charge.failed", declined.chargeId)), { status: 200, body: "open" });
  kit.fakeBeam.payPending(h.linkId, "CARD");
  const again = kit.fakeBeam.decline(h.linkId, "CARD");
  assert.deepEqual(await deliver(kit, kit.fakeBeam.signedEvent("charge.failed", again.chargeId)), { status: 200, body: "processing" });
  assert.equal(kit.fakeBeam.link(h.linkId).status, "ACTIVE");
  assert.equal(res(kit, h.reservationId).status, "not_confirmed");
  assert.equal(await kit.deps.kv.get(keys.reservationPaid(h.reservationId)), null);
  assert.equal(cbWrites(kit), cb);
});

test("a charge.failed after the link expired releases the hold through the guard; one still pending inside the grace keeps it", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const declined = kit.fakeBeam.decline(h.linkId, "CARD");
  kit.fakeBeam.expire(h.linkId);
  assert.deepEqual(await deliver(kit, kit.fakeBeam.signedEvent("charge.failed", declined.chargeId)), { status: 200, body: "released" });
  assert.equal(res(kit, h.reservationId).status, "canceled");
  assert.equal(await kit.deps.kv.get(keys.releaseDone(h.reservationId)), "Beam webhook: payment link expired");

  const kit2 = makeBeamKit();
  const g = await beamHeld(kit2);
  kit2.fakeBeam.payPending(g.linkId, "CARD");
  const failed = kit2.fakeBeam.decline(g.linkId, "CARD");
  kit2.fakeBeam.expire(g.linkId);
  assert.deepEqual(await deliver(kit2, kit2.fakeBeam.signedEvent("charge.failed", failed.chargeId)), { status: 200, body: "processing" });
  assert.equal(res(kit2, g.reservationId).status, "not_confirmed", "a 3-D Secure attempt may still succeed");

  // A release that fails is left to the sweeper: still 200.
  const kit3 = makeBeamKit();
  const k = await beamHeld(kit3);
  const no = kit3.fakeBeam.decline(k.linkId, "CARD");
  kit3.fakeBeam.expire(k.linkId);
  kit3.fakeCb.failNext("getReservation", "http500");
  assert.deepEqual(await deliver(kit3, kit3.fakeBeam.signedEvent("charge.failed", no.chargeId)), { status: 200, body: "release left to the sweeper" });
  assert.equal(res(kit3, k.reservationId).status, "not_confirmed");
  assert.equal(logged(kit3, "beam_webhook_release_failed").length, 1);
});

test("refunded before confirmation -> 200 needs_attention once (never confirmed, never released)", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const card = kit.fakeBeam.pay(h.linkId, "CARD");
  kit.fakeBeam.refund(card.chargeId);
  const ev = kit.fakeBeam.signedEvent("charge.succeeded", card.chargeId);
  assert.deepEqual(await deliver(kit, ev), { status: 200, body: "needs_attention" });
  kit.now.ms += PAST_ALERT_WINDOW_MS;
  assert.deepEqual(await deliver(kit, ev), { status: 200, body: "needs_attention" });
  const urgent = critical(kit);
  assert.equal(urgent.length, 1);
  assert.equal(urgent[0].subject, `URGENT: paid booking ${h.ref} needs attention`);
  assert.match(urgent[0].lines[0], /^REFUNDED at Beam before the booking was confirmed/);
  assert.equal(res(kit, h.reservationId).status, "not_confirmed");
  assert.equal(calls(kit, "postPayment").length, 0);
  assert.equal(await kit.deps.kv.get(keys.reservationPaid(h.reservationId)), null);
});

/* ------------------------------------------- refunds ------------------------------------------- */

test("refund.succeeded: the info alert keyed refund:{id}:SUCCEEDED with the folio steps; 40 days later still mapped to its booking", async () => {
  const kit = makeBeamKit();
  const { h, chargeId } = await confirmedBooking(kit);
  kit.now.ms += 40 * DAY;
  assert.equal(await kit.deps.kv.get(keys.booking(h.ref)), null, "the 48-hour booking pointer is long gone");
  const refundId = kit.fakeBeam.refund(chargeId);
  assert.deepEqual(await deliver(kit, kit.fakeBeam.signedEvent("refund.succeeded", refundId)), { status: 200, body: "refund succeeded" });
  const done = withSubject(kit, /^Beam refund done/);
  assert.equal(done.length, 1);
  assert.equal(done[0].severity, "info");
  assert.equal(done[0].subject, `Beam refund done for booking ${h.ref} (${money(h.quote.totalSatang)})`);
  assert.deepEqual(done[0].lines, [
    `Beam refunded ${money(h.quote.totalSatang)} of charge ${chargeId} (card), refund ${refundId} (Beam accepted it; the guest's bank may take days).`,
    `Record it in Cloudbeds by hand: a negative adjustment on reservation ${h.reservationId}; cancel the reservation if the stay is cancelled; retract (full refund) or restate (partial refund) the Google Ads conversion (docs section 8).`,
  ]);
  assert.ok(await kit.deps.kv.get(keys.alerted(SCOPE, `refund:${refundId}:SUCCEEDED`)), "keyed refund:{refundId}:{status}");
  assert.equal(res(kit, h.reservationId).status, "confirmed", "a refund changes nothing in Cloudbeds by itself");
  // A partial card refund of another booking names its own amount.
  const kit2 = makeBeamKit();
  const b = await confirmedBooking(kit2);
  const half = Math.round(b.h.quote.totalSatang / 2);
  const partial = kit2.fakeBeam.refund(b.chargeId, half);
  await deliver(kit2, kit2.fakeBeam.signedEvent("refund.succeeded", partial));
  assert.equal(withSubject(kit2, /^Beam refund done/)[0].subject, `Beam refund done for booking ${b.h.ref} (${money(half)})`);
});

test("refund.succeeded by case (round 8): the extra charge of a duplicate payment and a payment never recorded in Cloudbeds have nothing to record on the folio; the recorded payment keeps the folio steps", async () => {
  const folioLine = (kit: BeamKit) => {
    const done = withSubject(kit, /^Beam refund done/);
    assert.equal(done.length, 1);
    assert.equal(done[0].severity, "info");
    return done[0].lines[1];
  };

  // (a) The extra charge of a duplicate payment: the booking stands, nothing to record ('charged twice' says the same).
  const kit = makeBeamKit();
  const { h, chargeId } = await confirmedBooking(kit);
  kit.now.ms += 10 * MIN;
  const extra = kit.fakeBeam.secondCharge(h.linkId, "CARD");
  assert.deepEqual(await deliver(kit, kit.fakeBeam.signedEvent("charge.succeeded", extra.chargeId)), { status: 200, body: "confirmed" });
  assert.equal(withSubject(kit, /charged twice/).length, 1);
  const cb = cbWrites(kit);
  const extraRefund = kit.fakeBeam.refund(extra.chargeId);
  assert.deepEqual(await deliver(kit, kit.fakeBeam.signedEvent("refund.succeeded", extraRefund)), { status: 200, body: "refund succeeded" });
  assert.equal(
    folioLine(kit),
    `It is an extra charge (the booking's own payment is charge ${chargeId}), never recorded in Cloudbeds: nothing to record on the folio; the booking and its Google Ads conversion stand (docs section 8, item 6).`,
  );
  assert.equal(cbWrites(kit), cb, "nothing written to Cloudbeds");
  assert.equal(res(kit, h.reservationId).status, "confirmed");

  // (b) Refunded before the booking was confirmed: fulfil handed it to the owner and never recorded the payment.
  const kit2 = makeBeamKit();
  const g = await beamHeld(kit2);
  const card = kit2.fakeBeam.pay(g.linkId, "CARD");
  const refundId = kit2.fakeBeam.refund(card.chargeId);
  assert.deepEqual(await deliver(kit2, kit2.fakeBeam.signedEvent("charge.succeeded", card.chargeId)), { status: 200, body: "needs_attention" });
  assert.match(critical(kit2)[0].lines[0], /^REFUNDED at Beam before the booking was confirmed/);
  assert.deepEqual(await deliver(kit2, kit2.fakeBeam.signedEvent("refund.succeeded", refundId)), { status: 200, body: "refund succeeded" });
  const unrecorded = (reservationId: string) =>
    `No payment was recorded in Cloudbeds for this booking (the booking engine never confirmed it): nothing to adjust on the folio unless someone recorded the payment there by hand (then add a negative adjustment); make sure reservation ${reservationId} is cancelled so the unit goes back on sale (docs section 8, items 5 and 7).`;
  assert.equal(folioLine(kit2), unrecorded(g.reservationId));
  assert.equal(calls(kit2, "postPayment").length, 0);

  // (c) A late payment after its hold was released ("the guest PAID but the Cloudbeds hold is CANCELLED"), refunded in full.
  const kit3 = makeBeamKit();
  const k = await beamHeld(kit3);
  const declined = kit3.fakeBeam.decline(k.linkId, "CARD");
  kit3.fakeBeam.expire(k.linkId);
  assert.deepEqual(await deliver(kit3, kit3.fakeBeam.signedEvent("charge.failed", declined.chargeId)), { status: 200, body: "released" });
  const late = kit3.fakeBeam.payAfterClose(k.linkId, "CARD");
  assert.deepEqual(await deliver(kit3, kit3.fakeBeam.signedEvent("charge.succeeded", late.chargeId)), { status: 200, body: "needs_attention" });
  assert.match(critical(kit3)[0].lines[0], /^The guest PAID but the Cloudbeds hold is CANCELLED/);
  const lateRefund = kit3.fakeBeam.refund(late.chargeId);
  assert.deepEqual(await deliver(kit3, kit3.fakeBeam.signedEvent("refund.succeeded", lateRefund)), { status: 200, body: "refund succeeded" });
  assert.equal(folioLine(kit3), unrecorded(k.reservationId));
  assert.equal(calls(kit3, "postPayment").length, 0);

  // (d) The recorded payment, refunded in part: the folio steps, the conversion restated.
  const kit4 = makeBeamKit();
  const p = await confirmedBooking(kit4);
  const part = kit4.fakeBeam.refund(p.chargeId, 1_000);
  await deliver(kit4, kit4.fakeBeam.signedEvent("refund.succeeded", part));
  assert.equal(
    folioLine(kit4),
    `Record it in Cloudbeds by hand: a negative adjustment on reservation ${p.h.reservationId}; cancel the reservation if the stay is cancelled; retract (full refund) or restate (partial refund) the Google Ads conversion (docs section 8).`,
  );

  // Redis unreadable while the case is read: 503, Beam retries; nothing told yet.
  const kit5 = makeBeamKit();
  const q = await confirmedBooking(kit5);
  const r5 = kit5.fakeBeam.refund(q.chargeId);
  const failing: BeamGatewayDeps = {
    ...kit5.deps,
    kv: { ...kit5.deps.kv, get: (key) => (key === keys.beamPrimary(q.h.linkId) ? Promise.reject(new Error("simulated Redis failure")) : kit5.deps.kv.get(key)) },
  };
  assert.deepEqual(await deliver(kit5, kit5.fakeBeam.signedEvent("refund.succeeded", r5), failing), { status: 503, body: "refund could not be mapped - retry" });
  assert.equal(withSubject(kit5, /^Beam refund done/).length, 0);
  assert.deepEqual(await deliver(kit5, kit5.fakeBeam.signedEvent("refund.succeeded", r5)), { status: 200, body: "refund succeeded" });
  assert.equal(withSubject(kit5, /^Beam refund done/).length, 1);
});

test("a signed refund.failed body sent with the header refund.succeeded: no 'done' alert, the FAILED CRITICAL, the disagreement logged", async () => {
  const kit = makeBeamKit();
  const { h, chargeId } = await confirmedBooking(kit);
  const refundId = kit.fakeBeam.refund(chargeId, undefined, { status: "FAILED", failureCode: "RE_PROCESSING_FAILED" });
  const ev = kit.fakeBeam.signedEvent("refund.failed", refundId, { header: "refund.succeeded" });
  assert.deepEqual(await deliver(kit, ev), { status: 200, body: "refund failed" });
  assert.equal(withSubject(kit, /refund done/i).length, 0);
  const failed = withSubject(kit, /^Beam refund FAILED/);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].severity, "critical", "the guest is still owed money: stored and re-sent until delivered (round 5)");
  assert.equal(failed[0].subject, `Beam refund FAILED for booking ${h.ref}`);
  assert.deepEqual(failed[0].lines, [
    `Refund ${refundId} of ${money(h.quote.totalSatang)} on charge ${chargeId} failed (RE_PROCESSING_FAILED). Try again in Lighthouse; if Beam keeps refusing (low balance or the method), pay the guest back by bank transfer.`,
  ]);
  assert.deepEqual(logged(kit, "beam_webhook_event_mismatch").map((l) => l.data), [{ event: "refund.succeeded", kind: "refund", expected: "refund.failed" }]);
});

test("refund.failed while the mail relay is down: 200 (Beam won't retry), the CRITICAL is stored and the next sweeper run delivers it; only an alert that throws answers 503", async () => {
  const kit = makeBeamKit();
  const { h, chargeId } = await confirmedBooking(kit);
  const refundId = kit.fakeBeam.refund(chargeId, undefined, { status: "FAILED", failureCode: "RE_INSUFFICIENT_BALANCE" });
  const ev = kit.fakeBeam.signedEvent("refund.failed", refundId);
  kit.mail.ok = false;
  assert.deepEqual(await deliver(kit, ev), { status: 200, body: "refund failed" });
  assert.equal(withSubject(kit, /^Beam refund FAILED/).length, 0);
  assert.notEqual(await kit.deps.kv.get(keys.pendingAlert(SCOPE, `refund:${refundId}:FAILED`)), null, "stored under its key for the sweeper");
  kit.mail.ok = true;
  kit.now.ms += 10 * MIN;
  const s = await runSweep(kit.deps, kit.gw);
  assert.equal(s.undeliveredAlerts, 1);
  const failed = withSubject(kit, /^Beam refund FAILED/);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].severity, "critical");
  assert.equal(failed[0].subject, `Beam refund FAILED for booking ${h.ref}`);
  assert.ok(failed[0].lines[0].includes("failed (RE_INSUFFICIENT_BALANCE)"), failed[0].lines[0]);
  assert.equal(await kit.deps.kv.get(keys.pendingAlert(SCOPE, `refund:${refundId}:FAILED`)), null, "delivered: no longer pending");
  assert.notEqual(await kit.deps.kv.get(keys.alerted(SCOPE, `refund:${refundId}:FAILED`)), null, "keyed refund:{id}:FAILED");
  // A deps.alert that throws (never the production alerter) is the one case Beam is asked to retry.
  const throwing: BeamGatewayDeps = { ...kit.deps, alert: async () => Promise.reject(new Error("alert down")) };
  assert.deepEqual(await deliver(kit, ev, throwing), { status: 503, body: "refund alert failed - retry" });
  assert.equal(logged(kit, "beam_webhook_alert_failed").length, 1);
});

test("a refund's status is Beam's, never the body's: a PENDING refund tells nothing; unreadable -> 503; unknown -> not ours", async () => {
  const kit = makeBeamKit();
  const { h, chargeId } = await confirmedBooking(kit);
  const refundId = kit.fakeBeam.refund(chargeId, undefined, { status: "PENDING" });
  const forged = signed(kit, { refundId, chargeId, referenceId: h.ref, amount: h.quote.totalSatang, currency: "THB", status: "SUCCEEDED" }, "refund.succeeded");
  assert.deepEqual(await deliver(kit, forged), { status: 200, body: "refund pending" });
  assert.equal(withSubject(kit, /refund/i).length, 0);
  kit.fakeBeam.failNext(/^GET \/api\/v1\/refunds\//, 500, null);
  kit.fakeBeam.failNext(/^GET \/api\/v1\/refunds\//, 500, null);
  kit.fakeBeam.settleRefund(refundId, "SUCCEEDED");
  assert.deepEqual(await deliver(kit, forged), { status: 503, body: "refund could not be read - retry" });
  assert.equal(withSubject(kit, /refund/i).length, 0);
  assert.deepEqual(await deliver(kit, forged), { status: 200, body: "refund succeeded" });
  assert.equal(withSubject(kit, /^Beam refund done/).length, 1);
  const unknown = signed(kit, { refundId: "re_NoSuchRefund00000000000000000", chargeId, status: "SUCCEEDED" }, "refund.succeeded");
  assert.deepEqual(await deliver(kit, unknown), { status: 200, body: "not ours" });
});

test("refund mapping: the referenceId when the charge index is gone; another mode's charge and the owner's own link are not ours", async () => {
  const kit = makeBeamKit();
  const { h, chargeId } = await confirmedBooking(kit);
  await kit.deps.kv.del(keys.beamCharge(chargeId));
  const first = kit.fakeBeam.refund(chargeId, 1_000);
  await deliver(kit, kit.fakeBeam.signedEvent("refund.succeeded", first));
  // Inside 48 hours the pointer still names the link: its record gives the reservation (and the method).
  let done = withSubject(kit, /^Beam refund done/);
  assert.equal(done.length, 1);
  assert.match(done[0].lines[0], new RegExp(`of charge ${chargeId} \\(card\\), refund ${first} `));
  assert.match(done[0].lines[1], new RegExp(`on reservation ${h.reservationId};`));
  kit.now.ms += 3 * DAY;
  const second = kit.fakeBeam.refund(chargeId, 1_000);
  await deliver(kit, kit.fakeBeam.signedEvent("refund.succeeded", second));
  done = withSubject(kit, /^Beam refund done/);
  assert.equal(done.length, 2);
  assert.equal(done[1].subject, `Beam refund done for booking ${h.ref} (THB 10.00)`);
  assert.match(done[1].lines[0], /\(method not known\)/);
  assert.match(done[1].lines[1], new RegExp(`on the reservation of booking ${h.ref} \\(search the booking reference in Cloudbeds\\);`));

  // Another payment mode's charge (a deployment sharing the Redis): not ours.
  const kit2 = makeBeamKit();
  const b = await confirmedBooking(kit2);
  const entry: BeamChargeIndexEntry = { v: 1, linkId: b.h.linkId, ref: b.h.ref, reservationId: b.h.reservationId, mode: "beam-live" };
  await kit2.deps.kv.set(keys.beamCharge(b.chargeId), JSON.stringify(entry), 3600);
  const other = kit2.fakeBeam.refund(b.chargeId);
  assert.deepEqual(await deliver(kit2, kit2.fakeBeam.signedEvent("refund.succeeded", other)), { status: 200, body: "not ours" });
  assert.equal(withSubject(kit2, /refund/i).length, 0);

  // The owner's own Lighthouse link: no index entry, no MSV ref.
  const kit3 = makeBeamKit();
  const link = await createPaymentLink(kit3.beam, foreignLinkBody(kit3), "owner-link-2", kit3.fakeBeam.fetch);
  const charge = kit3.fakeBeam.pay(link.id, "CARD");
  const own = kit3.fakeBeam.refund(charge.chargeId);
  assert.deepEqual(await deliver(kit3, kit3.fakeBeam.signedEvent("refund.succeeded", own)), { status: 200, body: "not ours" });
  assert.equal(kit3.alerts.length, 0);
});

/* ----------------------------------------- transactions ----------------------------------------- */

test("a duplicated transaction.created is logged once (type, gross, fee, VAT, net, sourceId; no personal data)", async () => {
  const now = { ms: NOW };
  const kv = recordingKv(createMemoryKv(() => now.ms));
  const kit = makeBeamKit({ kv, now });
  const { h, chargeId } = await confirmedBooking(kit);
  const t = kit.fakeBeam.transactions.get(chargeId);
  assert.ok(t);
  const ev = kit.fakeBeam.signedEvent("transaction.created", chargeId);
  assert.deepEqual(await deliver(kit, ev), { status: 200, body: "logged" });
  kit.now.ms += DAY;
  assert.deepEqual(await deliver(kit, ev), { status: 200, body: "duplicate" });
  assert.deepEqual(logged(kit, "beam_transaction").map((l) => l.data), [
    { transactionId: chargeId, type: "PAYMENT", currency: "THB", gross: t.grossAmount, fee: t.feeAmount, vat: t.vatAmount, net: t.netAmount, sourceId: h.linkId },
  ]);
  const marker = kv.writes.filter((w) => w.key === keys.beamTxn(SCOPE, chargeId));
  assert.deepEqual(marker.map((w) => [w.op, w.ttl, w.result]), [["setNx", BEAM_TXN_TTL_SECONDS, true], ["setNx", BEAM_TXN_TTL_SECONDS, false]]);
  assert.equal(BEAM_TXN_TTL_SECONDS, 90 * 24 * 3600);
  // A refund's REFUND transaction is logged the same way; neither alerts.
  const refundId = kit.fakeBeam.refund(chargeId);
  assert.equal((await deliver(kit, kit.fakeBeam.signedEvent("transaction.created", refundId))).body, "logged");
  assert.equal(logged(kit, "beam_transaction").at(-1)?.data?.type, "REFUND");
  assert.equal(critical(kit).length, 0);
  // A Redis failure on the marker: Beam retries.
  const fail = { on: true, when: (op: string, key: string) => fail.on && op === "setNx" && key.startsWith(`msv:${SCOPE}:beam:txn:`) };
  const now2 = { ms: NOW };
  const kit2 = makeBeamKit({ kv: switchableKv(now2, fail), now: now2 });
  const b = await confirmedBooking(kit2);
  assert.equal((await deliver(kit2, kit2.fakeBeam.signedEvent("transaction.created", b.chargeId))).status, 503);
  assert.equal(logged(kit2, "beam_transaction").length, 0);
});

test("a chargeback -> CRITICAL 'URGENT: chargeback on Beam payment for booking {ref}', once; unmatched ones still alert", async () => {
  const kit = makeBeamKit();
  const { h, chargeId } = await confirmedBooking(kit);
  kit.now.ms += 60 * DAY;
  const cb = kit.fakeBeam.chargeback(chargeId);
  const ev = kit.fakeBeam.signedEvent("transaction.created", cb);
  assert.deepEqual(await deliver(kit, ev), { status: 200, body: "alerted" });
  assert.notEqual(await kit.deps.kv.get(keys.alerted(SCOPE, `beam-chargeback:${cb}`)), null, "keyed per transaction");
  kit.now.ms += PAST_ALERT_WINDOW_MS;
  assert.deepEqual(await deliver(kit, ev), { status: 200, body: "duplicate" });
  const urgent = critical(kit);
  assert.equal(urgent.length, 1);
  assert.equal(urgent[0].subject, `URGENT: chargeback on Beam payment for booking ${h.ref}`);
  assert.deepEqual(urgent[0].lines, [
    `Beam recorded a CHARGEBACK of ${money(h.quote.totalSatang)} on charge ${chargeId} (booking ${h.ref}, Cloudbeds reservation ${h.reservationId}). Collect the booking evidence (agreed terms version, PAID note, guest messages) and answer Beam's dispute process: docs section 8.`,
  ]);
  assert.equal(logged(kit, "beam_transaction").at(-1)?.data?.type, "CHARGEBACK");

  // Redis failing while the booking is looked up: the marker is dropped and Beam's retry alerts.
  const now = { ms: NOW };
  const fail = { on: false, when: (op: string, key: string) => fail.on && op === "get" && key.startsWith("msv:beam:pay:") };
  const kit2 = makeBeamKit({ kv: switchableKv(now, fail), now });
  const b = await confirmedBooking(kit2);
  await kit2.deps.kv.del(keys.beamCharge(b.chargeId));
  const cb2 = kit2.fakeBeam.chargeback(b.chargeId);
  fail.on = true;
  assert.deepEqual(await deliver(kit2, kit2.fakeBeam.signedEvent("transaction.created", cb2)), { status: 503, body: "chargeback could not be handled - retry" });
  assert.equal(critical(kit2).length, 0);
  fail.on = false;
  assert.deepEqual(await deliver(kit2, kit2.fakeBeam.signedEvent("transaction.created", cb2)), { status: 200, body: "alerted" });
  assert.equal(critical(kit2)[0].subject, `URGENT: chargeback on Beam payment for booking ${b.h.ref}`, "found through the link's record");

  // The owner's own Lighthouse link: no booking of ours, but a chargeback still costs money.
  const kit3 = makeBeamKit();
  const link = await createPaymentLink(kit3.beam, foreignLinkBody(kit3), "owner-link-3", kit3.fakeBeam.fetch);
  const charge = kit3.fakeBeam.pay(link.id, "CARD");
  const cb3 = kit3.fakeBeam.chargeback(charge.chargeId);
  assert.equal((await deliver(kit3, kit3.fakeBeam.signedEvent("transaction.created", cb3))).body, "alerted");
  assert.equal(critical(kit3)[0].subject, "URGENT: chargeback on a Beam payment");
  assert.notEqual(await kit3.deps.kv.get(keys.alerted(SCOPE, `beam-chargeback:${cb3}`)), null, "keyed per transaction");
  assert.ok(
    critical(kit3)[0].lines[0].startsWith(`Beam recorded a CHARGEBACK of ${money(150_000)} (transaction ${cb3}, payment link ${link.id}) that matches no booking of ours`),
    critical(kit3)[0].lines[0],
  );

  // Another payment mode's record: not ours, no alert.
  const kit4 = makeBeamKit();
  const c = await confirmedBooking(kit4);
  const entry: BeamChargeIndexEntry = { v: 1, linkId: c.h.linkId, ref: c.h.ref, reservationId: c.h.reservationId, mode: "beam-live" };
  await kit4.deps.kv.set(keys.beamCharge(c.chargeId), JSON.stringify(entry), 3600);
  const cb4 = kit4.fakeBeam.chargeback(c.chargeId);
  const tx = kit4.fakeBeam.transactions.get(cb4);
  assert.ok(tx);
  const withCharge = signed(kit4, { ...JSON.parse(kit4.fakeBeam.signedEvent("transaction.created", cb4).raw), chargeId: c.chargeId }, "transaction.created");
  assert.deepEqual(await deliver(kit4, withCharge), { status: 200, body: "not ours" });
  assert.equal(critical(kit4).length, 0);
  // ... and a link record of another mode, the route a chargeback body without a chargeId takes.
  const kit5 = makeBeamKit();
  const d = await confirmedBooking(kit5);
  const rawRecord = await kit5.deps.kv.get(keys.beamPayment(d.h.linkId));
  assert.ok(rawRecord);
  await kit5.deps.kv.set(keys.beamPayment(d.h.linkId), JSON.stringify({ ...JSON.parse(rawRecord), mode: "beam-live" }), 3600);
  const cb5 = kit5.fakeBeam.chargeback(d.chargeId);
  assert.deepEqual(await deliver(kit5, kit5.fakeBeam.signedEvent("transaction.created", cb5)), { status: 200, body: "not ours" });
  assert.equal(critical(kit5).length, 0);
  assert.equal(logged(kit5, "beam_transaction").length, 1, "still logged for reconciliation");
});

/* -------------------------------------------- privacy -------------------------------------------- */

test("the card's last digits and the guest's details in Beam's charge body never reach a log, an alert or Redis", async () => {
  const now = { ms: NOW };
  const kv = recordingKv(createMemoryKv(() => now.ms));
  const kit = makeBeamKit({ kv, now });
  const h = await beamHeld(kit);
  const card = kit.fakeBeam.pay(h.linkId, "CARD", { card: { brand: "VISA", last4: "4729", countryAlpha2: "TH" } });
  const ev = kit.fakeBeam.signedEvent("charge.succeeded", card.chargeId);
  assert.ok(cardDigitsShown(ev.raw, "4729"), "Beam sends them");
  assert.match(ev.raw, /guest@example\.com/);
  await deliver(kit, ev);
  await deliver(kit, kit.fakeBeam.signedEvent("transaction.created", card.chargeId));
  const refundId = kit.fakeBeam.refund(card.chargeId);
  await deliver(kit, kit.fakeBeam.signedEvent("refund.succeeded", refundId));
  assert.ok(kit.alerts.length >= 2);
  const everything = JSON.stringify([kit.logs, kit.alerts, kv.writes, kit.fakeCb.calls.filter((c) => c.method !== "postReservation")]);
  for (const pii of ["guest@example.com", "0812345678", "Refund requested by"]) assert.ok(!everything.includes(pii), pii);
  // The digits standing alone, as a leak would show them (random ids can carry them by chance), and no last4 field.
  assert.equal(cardDigitsShown(everything, "4729"), false);
  assert.doesNotMatch(everything, /"last4"/);
});

/* ------------------------- round 5: readings the round-4 tests left open ------------------------- */

const GARDEN: CartItemInput[] = [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];

test("header names in a plain record are compared without regard to case: a mixed-case record verifies", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.fakeBeam.pay(h.linkId, "CARD");
  const ev = kit.fakeBeam.signedEvent("payment_link.paid", h.linkId);
  const mixed = { "X-Beam-Signature": ev.headers["x-beam-signature"], "X-BEAM-EVENT": "payment_link.paid" };
  assert.deepEqual(await handleBeamWebhook(ev.raw, mixed, kit.deps, kit.config.beamWebhookHmacKey), { status: 200, body: "confirmed" });
  assert.deepEqual(logged(kit, "beam_webhook").map((l) => l.data?.event), ["payment_link.paid"]);
});

test("the header hint is compared lower-cased, by the body's kind AND status: only a real disagreement is logged", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const declined = kit.fakeBeam.decline(h.linkId, "CARD");
  const card = kit.fakeBeam.pay(h.linkId, "CARD");
  // Upper case is the same event.
  assert.equal((await deliver(kit, kit.fakeBeam.signedEvent("payment_link.paid", h.linkId, { header: "PAYMENT_LINK.PAID" }))).status, 200);
  assert.equal(logged(kit, "beam_webhook_event_mismatch").length, 0);
  assert.equal(logged(kit, "beam_webhook").at(-1)?.data?.event, "payment_link.paid");
  // A SUCCEEDED charge sent as charge.failed, and a FAILED one sent as charge.succeeded, disagree.
  await deliver(kit, kit.fakeBeam.signedEvent("charge.succeeded", card.chargeId, { header: "charge.failed" }));
  await deliver(kit, kit.fakeBeam.signedEvent("charge.failed", declined.chargeId, { header: "charge.succeeded" }));
  assert.deepEqual(logged(kit, "beam_webhook_event_mismatch").map((l) => l.data), [
    { event: "charge.failed", kind: "charge", expected: "charge.succeeded" },
    { event: "charge.succeeded", kind: "charge", expected: "charge.failed" },
  ]);
});

test("a refunded payment whose fulfil throws (Redis refuses the done marker): 200 'refunded - left to the sweeper', which then hands it to fulfil", async () => {
  const now = { ms: NOW };
  const fail = { on: false, when: (op: "get" | "set" | "zadd" | "setNx", key: string) => fail.on && op === "set" && key.startsWith("msv:done:fulfil:") };
  const kit = makeBeamKit({ kv: switchableKv(now, fail), now });
  const h = await beamHeld(kit);
  const card = kit.fakeBeam.pay(h.linkId, "CARD");
  kit.fakeBeam.refund(card.chargeId);
  fail.on = true;
  assert.deepEqual(await deliver(kit, kit.fakeBeam.signedEvent("charge.succeeded", card.chargeId)), { status: 200, body: "refunded - left to the sweeper" });
  assert.equal(logged(kit, "beam_webhook_refunded_fulfil_failed").length, 1);
  assert.equal(critical(kit).length, 0);
  fail.on = false;
  kit.now.ms += 10 * MIN;
  await runSweep(kit.deps, kit.gw);
  const urgent = critical(kit);
  assert.equal(urgent.length, 1);
  assert.match(urgent[0].lines[0], /^REFUNDED at Beam before the booking was confirmed/);
  assert.equal(res(kit, h.reservationId).status, "not_confirmed");
});

test("refund.succeeded while Beam rate-limits the charge list: 200 and the alert says '(method not known)'", async () => {
  const kit = makeBeamKit();
  const { h, chargeId } = await confirmedBooking(kit);
  const refundId = kit.fakeBeam.refund(chargeId);
  kit.fakeBeam.rateLimitNext(2, /^GET \/api\/v1\/charges$/);
  assert.deepEqual(await deliver(kit, kit.fakeBeam.signedEvent("refund.succeeded", refundId)), { status: 200, body: "refund succeeded" });
  const done = withSubject(kit, /^Beam refund done/);
  assert.equal(done.length, 1);
  assert.equal(done[0].subject, `Beam refund done for booking ${h.ref} (${money(h.quote.totalSatang)})`);
  assert.match(done[0].lines[0], new RegExp(`of charge ${chargeId} \\(method not known\\), refund ${refundId} `));
  assert.ok(logged(kit, "beam_refund_method_unread").some((l) => l.data?.status === 429));
});

test("refund mapping: a booking pointer whose link names another booking is not used - the refund's own ref is", async () => {
  const kit = makeBeamKit();
  const a = await confirmedBooking(kit);
  const b = await beamHeld(kit, "card_ewallet", GARDEN);
  await kit.deps.kv.del(keys.beamCharge(a.chargeId));
  // A's pointer (as if overwritten) names B's link, whose record is booking B.
  await kit.deps.kv.set(keys.booking(a.h.ref), JSON.stringify({ sessionId: b.key, reservationId: b.reservationId }), 3600);
  const refundId = kit.fakeBeam.refund(a.chargeId, 1_000);
  assert.deepEqual(await deliver(kit, kit.fakeBeam.signedEvent("refund.succeeded", refundId)), { status: 200, body: "refund succeeded" });
  const done = withSubject(kit, /^Beam refund done/);
  assert.equal(done.length, 1);
  assert.equal(done[0].subject, `Beam refund done for booking ${a.h.ref} (THB 10.00)`);
  assert.match(done[0].lines[1], new RegExp(`on the reservation of booking ${a.h.ref} \\(search the booking reference in Cloudbeds\\);`));
  assert.doesNotMatch(JSON.stringify(done), new RegExp(`${b.ref}|${b.reservationId}`));
});

test("a CHARGEBACK body with no chargeId, sourceId or referenceId: its transactionId found in the charge index maps the booking", async () => {
  const kit = makeBeamKit();
  const { h, chargeId } = await confirmedBooking(kit);
  const body = { transactionId: chargeId, transactionType: "CHARGEBACK", currency: "THB", grossAmount: h.quote.totalSatang, feeAmount: 0, vatAmount: 0, netAmount: h.quote.totalSatang };
  assert.deepEqual(await deliver(kit, signed(kit, body, "transaction.created")), { status: 200, body: "alerted" });
  const urgent = critical(kit);
  assert.equal(urgent.length, 1);
  assert.equal(urgent[0].subject, `URGENT: chargeback on Beam payment for booking ${h.ref}`);
  assert.ok(urgent[0].lines[0].includes(`on charge ${chargeId} (booking ${h.ref}, Cloudbeds reservation ${h.reservationId})`), urgent[0].lines[0]);
  assert.notEqual(await kit.deps.kv.get(keys.alerted(SCOPE, `beam-chargeback:${chargeId}`)), null, "keyed per transaction");
});

test("bad signatures are counted per hour: 3 of them 61 minutes apart send no alert", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.fakeBeam.pay(h.linkId, "CARD");
  const bad = kit.fakeBeam.signedEvent("payment_link.paid", h.linkId, { hmacKeyB64: Buffer.from("playground-key-not-production-1!").toString("base64") });
  for (let i = 0; i < BEAM_BAD_SIGNATURE_ALERT_THRESHOLD; i++) {
    assert.deepEqual(await deliver(kit, bad), { status: 401, body: "invalid signature" });
    assert.equal(await kit.deps.kv.get(keys.beamBadSignatures(SCOPE)), "1", `${i}: a new hour, a new count`);
    kit.now.ms += 61 * MIN;
  }
  assert.equal(withSubject(kit, /signatures are being rejected/).length, 0);
});

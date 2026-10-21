// StripeGateway (payments/stripeGateway.ts) against the in-repo fake Stripe:
// get() gives back exactly the meta and state the old functions give
// (retrieveSession + parseSessionMeta + fulfil's modeMatches +
// sessionPaymentState), with one Stripe request; cancel() is one expire; and
// the text is a snapshot of the words fulfil.ts and sweep.ts write today,
// checked against what the real fulfil, alerts and sweeper produce.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudbedsWriteError } from "../cloudbedsWrite.ts";
import { alertFulfilFailure, alertPaidStuck, feeItemFor, fulfilSession, testMoneyLabel } from "../fulfil.ts";
import { keys, writeJson, DONE_TTL_SECONDS } from "../lock.ts";
import type { PaidPending } from "../lock.ts";
import { satangToBahtString } from "../quote.ts";
import { releaseNoteText, runSweep } from "../sweep.ts";
import { STRIPE_LIVE_ENV, checkout, makeKit, sessionIdOf } from "../testkit.ts";
import type { Kit } from "../testkit.ts";
import type { CheckoutSuccess, PaymentMode } from "../types.ts";
import type { GatewayPayment } from "./gateway.ts";
import { chargeId, paymentIntentId, parseSessionMeta, retrieveSession, sessionPaymentState } from "./stripe.ts";
import { STRIPE_GATEWAY_TEXT, stripeGateway } from "./stripeGateway.ts";

const MODES: PaymentMode[] = ["demo", "beam-playground", "beam-live", "stripe-mock", "stripe-test", "stripe-live"];

async function held(kit: Kit = makeKit()) {
  const res = await checkout(kit);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  return { kit, gw: stripeGateway(kit.deps), sessionId: sessionIdOf(body), reservationId: body.holdReservationId as string, ref: body.ref };
}

/** gw.get(id) next to the old functions on the same session; asserts they agree and that get made exactly one Stripe request. */
async function getBoth(kit: Kit, id: string): Promise<GatewayPayment> {
  const gw = stripeGateway(kit.deps);
  const before = kit.fakeStripe.calls.length;
  const p = await gw.get(id);
  const made = kit.fakeStripe.calls.slice(before);
  const session = await retrieveSession(kit.deps.stripe, id);
  assert.equal(made.length, 1, "one Stripe request");
  assert.deepEqual(made, kit.fakeStripe.calls.slice(before + 1), "the same request as retrieveSession");
  const meta = parseSessionMeta(session);
  const matches = session.livemode === (kit.config.stripe?.livemode ?? false);
  assert.deepEqual(p.meta, meta && matches ? meta : null, "meta");
  assert.equal(p.state, sessionPaymentState(session), "state");
  assert.equal(p.key, id);
  assert.equal(p.paymentId, id);
  assert.equal(p.amountSatang, session.amount_total);
  assert.equal(p.currency, session.currency);
  assert.equal(p.attempted, session.payment_intent !== null);
  assert.equal(p.receipt.primaryId, paymentIntentId(session));
  assert.equal(p.receipt.description, `Stripe ${paymentIntentId(session) ?? "-"} charge ${chargeId(session) ?? "-"} session ${id}`);
  return p;
}

/* -------------------------------- get -------------------------------- */

test("get: an open session is ours and open, nothing attempted yet", async () => {
  const { kit, gw, sessionId, ref, reservationId } = await held();
  const p = await getBoth(kit, sessionId);
  assert.equal(p.state, "open");
  assert.equal(p.meta?.ref, ref);
  assert.equal(p.meta?.reservationId, reservationId);
  assert.equal(p.attempted, false);
  assert.deepEqual(p.receipt, { primaryId: null, description: `Stripe - charge - session ${sessionId}` });
  assert.equal(p.currency, "thb");
  assert.equal(p.amountSatang, p.meta?.totalSatang);
  assert.equal(gw.provider, "stripe");
  assert.equal(gw.brand, "Stripe");
  assert.equal(gw.keyOf(sessionId), sessionId, "key = the session id: Redis keys keep their names");
  assert.equal(gw.idOf(sessionId), sessionId);
});

test("get: a completed, paid session carries the PaymentIntent and charge ids", async () => {
  const { kit, sessionId } = await held();
  kit.fakeStripe.complete(sessionId);
  const p = await getBoth(kit, sessionId);
  assert.equal(p.state, "paid");
  assert.equal(p.attempted, true);
  const pi = kit.fakeStripe.session(sessionId)!.payment_intent!;
  const charge = kit.fakeStripe.intents.get(pi)!.latest_charge!;
  assert.match(pi, /^pi_/);
  assert.deepEqual(p.receipt, { primaryId: pi, description: `Stripe ${pi} charge ${charge} session ${sessionId}` });
});

test("get: completed but unpaid (a delayed method) is processing; its async failure is failed", async () => {
  const { kit, sessionId } = await held();
  kit.fakeStripe.completeDelayed(sessionId);
  const processing = await getBoth(kit, sessionId);
  assert.equal(processing.state, "processing");
  assert.equal(processing.attempted, true);
  assert.equal(processing.receipt.description, `Stripe ${processing.receipt.primaryId} charge - session ${sessionId}`);
  kit.fakeStripe.asyncFail(sessionId);
  assert.equal((await getBoth(kit, sessionId)).state, "failed");
});

test("get: an expired session is expired", async () => {
  const { kit, sessionId } = await held();
  kit.fakeStripe.expire(sessionId);
  const p = await getBoth(kit, sessionId);
  assert.equal(p.state, "expired");
  assert.equal(p.attempted, false);
  assert.notEqual(p.meta, null);
});

test("get: a session of the other livemode is not ours (meta null), whatever its state", async () => {
  const { kit, sessionId } = await held();
  kit.fakeStripe.complete(sessionId);
  kit.fakeStripe.sessions.get(sessionId)!.livemode = true;
  const p = await getBoth(kit, sessionId);
  assert.equal(p.meta, null);
  assert.equal(p.state, "paid");

  // A live deployment reads its own live sessions as ours, and a test one as not.
  const live = await held(makeKit({ env: STRIPE_LIVE_ENV }));
  assert.match(live.sessionId, /^cs_live_/);
  assert.notEqual((await getBoth(live.kit, live.sessionId)).meta, null);
  live.kit.fakeStripe.sessions.get(live.sessionId)!.livemode = false;
  assert.equal((await getBoth(live.kit, live.sessionId)).meta, null);
});

test("get: a session without our metadata (another app on the shared account) is not ours", async () => {
  const kit = makeKit();
  const foreign = await kit.deps.stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ quantity: 1, price_data: { currency: "thb", unit_amount: 150_000, product_data: { name: "Room charge" } } }],
    success_url: "https://hotels.cloudbeds.com/done?s={CHECKOUT_SESSION_ID}",
    expires_at: Math.floor(kit.now.ms / 1000) + 3600,
  });
  const p = await getBoth(kit, foreign.id);
  assert.equal(p.meta, null);
  assert.equal(p.state, "open");
  assert.equal(p.amountSatang, 150_000);
});

test("get: an unknown session throws and isMissing says so; a 5xx is not 'missing'", async () => {
  const { kit, gw, sessionId } = await held();
  const missing = await gw.get("cs_test_doesnotexist0001").then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(missing, "throws");
  assert.equal(gw.isMissing(missing), true);
  kit.fakeStripe.failNext(/^GET \/v1\/checkout\/sessions\//, 500);
  const down = await gw.get(sessionId).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(down, "throws");
  assert.equal(gw.isMissing(down), false);
});

/* ------------------------------- cancel ------------------------------- */

test("cancel: expires an open session with one request; anything no longer open is not_open", async () => {
  const { kit, gw, sessionId } = await held();
  const before = kit.fakeStripe.calls.length;
  assert.equal(await gw.cancel(sessionId), "cancelled");
  assert.deepEqual(
    kit.fakeStripe.calls.slice(before).map((c) => `${c.method} ${c.path}`),
    [`POST /v1/checkout/sessions/${sessionId}/expire`],
  );
  assert.equal(kit.fakeStripe.session(sessionId)?.status, "expired");
  assert.equal(await gw.cancel(sessionId), "not_open", "already expired");

  const paid = await held();
  paid.kit.fakeStripe.complete(paid.sessionId);
  assert.equal(await paid.gw.cancel(paid.sessionId), "not_open", "a paid session is never expired");
  assert.equal(paid.kit.fakeStripe.session(paid.sessionId)?.status, "complete");
  assert.equal(await paid.gw.cancel("cs_test_doesnotexist0001"), "not_open", "unknown");
});

test("cancel: a network/5xx answer throws (the caller answers an error; the sweeper covers it)", async () => {
  const { kit, gw, sessionId } = await held();
  kit.fakeStripe.failNext(/\/expire$/, 503);
  await assert.rejects(gw.cancel(sessionId));
  assert.equal(kit.fakeStripe.session(sessionId)?.status, "open");
});

/* -------------------------------- text -------------------------------- */

test("text: a snapshot of the Stripe words fulfil.ts and sweep.ts use today", () => {
  const t = STRIPE_GATEWAY_TEXT;
  const receipt = { primaryId: "pi_123", description: "Stripe pi_123 charge ch_456 session cs_live_789" };
  assert.equal(t.paidVia(receipt, "THB 18,900.00"), "via Stripe pi_123 (THB 18,900.00)");
  assert.equal(t.paidVia({ primaryId: null, description: "" }, "THB 1.00"), "via Stripe - (THB 1.00)");
  assert.equal(t.paymentDescription(receipt, "MSV-20261005-ABCD"), "Stripe pi_123 charge ch_456 session cs_live_789 ref MSV-20261005-ABCD");
  assert.deepEqual(t.sessionLabel, { long: "Checkout Session", short: "session" });
  assert.equal(t.refundWhere, "in Stripe");
  assert.equal(t.methodEnvVar, "CLOUDBEDS_STRIPE_PAYMENT_METHOD");
  assert.equal(t.testMethodEnvVar, "CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD");
  assert.equal(t.feeItemName, "Payment processing fee");
  assert.equal(t.webhookRetryHint, "Stripe webhook retries");
  assert.deepEqual(t.feeItem("stripe-live"), {
    appItemId: "msv-payment-processing-fee",
    itemSku: "MSV-PAYMENT-FEE",
    name: "Payment processing fee",
    note: "Online booking payment processing fee, paid via Stripe.",
  });
  assert.deepEqual(t.feeItem("stripe-test"), {
    appItemId: "msv-payment-processing-fee-test",
    itemSku: "MSV-PAYMENT-FEE-TEST",
    name: "TEST - Payment processing fee",
    note: "TEST MODE - NOT REAL MONEY. Test fee line.",
  });
  assert.deepEqual(
    [
      t.releaseNoteText([]),
      t.releaseNoteText([{ state: "expired", attempted: true }, { state: "failed", attempted: true }]),
      t.releaseNoteText([{ state: "expired", attempted: true }]),
      t.releaseNoteText([{ state: "expired", attempted: false }]),
    ],
    [
      "Hold released by the sweeper: no payment page was ever created (the booking page failed before Stripe). Nothing was charged.",
      "Hold released by the sweeper: a payment was attempted on the Stripe page but did not go through. Nothing was charged.",
      "Hold released by the sweeper: the Stripe payment page was opened and a payment was started but never completed. Nothing was charged.",
      "Hold released by the sweeper: the Stripe payment page was created but no payment was ever attempted. Nothing was charged.",
    ],
  );
});

test("text: feeItem and releaseNoteText answer exactly what fulfil.ts feeItemFor and sweep.ts releaseNoteText answer", () => {
  for (const mode of [...MODES, "", "live"]) assert.deepEqual(STRIPE_GATEWAY_TEXT.feeItem(mode), feeItemFor(mode), mode);
  const pi = (attempted: boolean) => (attempted ? "pi_1" : null);
  const cases: { state: "open" | "processing" | "paid" | "failed" | "expired"; attempted: boolean }[][] = [
    [],
    [{ state: "expired", attempted: false }],
    [{ state: "expired", attempted: true }],
    [{ state: "failed", attempted: true }],
    [{ state: "failed", attempted: false }],
    [
      { state: "expired", attempted: false },
      { state: "expired", attempted: true },
    ],
    [
      { state: "expired", attempted: false },
      { state: "failed", attempted: true },
    ],
  ];
  for (const c of cases) {
    assert.equal(
      STRIPE_GATEWAY_TEXT.releaseNoteText(c),
      releaseNoteText(c.map((x) => ({ session: { payment_intent: pi(x.attempted) }, state: x.state }))),
      JSON.stringify(c),
    );
  }
});

const money = (satang: number) => `THB ${satangToBahtString(satang)}`;

test("text: rebuilds the paid note, the payment description and the fee line fulfil writes (test and live)", async () => {
  for (const kit of [makeKit(), makeKit({ env: STRIPE_LIVE_ENV })]) {
    const { gw, sessionId, reservationId, ref } = await held(kit);
    kit.fakeStripe.complete(sessionId);
    const p = await gw.get(sessionId);
    assert.equal((await fulfilSession(sessionId, kit.deps)).state, "confirmed");
    const label = testMoneyLabel(kit.deps);
    const r = kit.fakeCb.reservations.get(reservationId)!;
    const paidNote = r.notes.find((n) => n.includes("do NOT cancel"));
    assert.ok(paidNote?.startsWith(`${label}PAID ${gw.text.paidVia(p.receipt, money(p.meta!.totalSatang))} for online booking ${ref} - do NOT cancel.`), paidNote);
    assert.deepEqual(
      r.payments.map((x) => x.description),
      [`${label}${gw.text.paymentDescription(p.receipt, ref)}`],
    );
    assert.deepEqual(
      r.items.map((x) => x.itemName),
      [gw.text.feeItem(kit.config.paymentMode).name],
    );
    const booked = kit.alerts.find((a) => a.subject.startsWith(`New direct booking ${ref}`));
    assert.equal(booked?.lines[1], `Paid ${money(p.meta!.totalSatang)} via ${gw.brand} (${p.receipt.primaryId}); the payment and the fee line are on the folio and the reservation is confirmed.`);
  }
});

test("text: rebuilds the fulfil alerts (needs attention, retrying, payment refused, paid but stuck)", async () => {
  // Needs attention: the guest paid a hold that was cancelled in Cloudbeds.
  const { kit, gw, sessionId, reservationId, ref } = await held();
  kit.fakeCb.reservations.get(reservationId)!.status = "canceled";
  kit.fakeStripe.complete(sessionId);
  assert.equal((await fulfilSession(sessionId, kit.deps)).state, "needs_attention");
  const t = gw.text;
  const urgent = kit.alerts.find((a) => a.subject === `URGENT: paid booking ${ref} needs attention`);
  assert.ok(urgent?.lines[0].endsWith(`or refund ${t.refundWhere}.`), urgent?.lines[0]);
  assert.ok(urgent?.lines[1].startsWith(`${gw.brand} ${t.sessionLabel.long} ${sessionId}, Cloudbeds reservation ${reservationId}, `), urgent?.lines[1]);

  // Not yet confirmed, before fulfil saw it paid: the long label, and who retries it.
  const fresh = makeKit();
  await alertFulfilFailure(fresh.deps, "cs_test_unseen0001", new Error("Cloudbeds down"));
  assert.deepEqual(fresh.alerts.at(-1)?.lines, [
    `${gw.brand} ${t.sessionLabel.long} cs_test_unseen0001 is paid but confirming it in Cloudbeds failed: Cloudbeds down`,
    `It is retried automatically (${t.webhookRetryHint}, the guest's return page and the sweeper). Do NOT cancel the reservation. If this repeats, check Cloudbeds.`,
  ]);

  // Seen paid: the short label after the brand.
  const paid: PaidPending = { sessionId: "cs_test_seen0001", ref: "MSV-20261005-ABCD", reservationId: "48213377", totalSatang: 1_890_000, paidAt: fresh.now.ms, mode: "stripe-test" };
  await writeJson(fresh.deps.kv, keys.paidPending(paid.sessionId), paid, DONE_TTL_SECONDS);
  await alertFulfilFailure(fresh.deps, paid.sessionId, new Error("Cloudbeds down"));
  assert.equal(
    fresh.alerts.at(-1)?.lines[0],
    `Booking ${paid.ref} (Cloudbeds reservation ${paid.reservationId}, ${money(paid.totalSatang)}, ${gw.brand} ${t.sessionLabel.short} ${paid.sessionId}) is PAID, but confirming it in Cloudbeds failed: Cloudbeds down`,
  );

  // Cloudbeds refused the payment: the short label alone, and both method variables (outside live).
  await alertFulfilFailure(fresh.deps, paid.sessionId, new CloudbedsWriteError("postPayment", "rejected", "unknown method", 200, null, false));
  const refused = fresh.alerts.at(-1);
  assert.equal(refused?.subject, `URGENT: paid booking ${paid.ref}: Cloudbeds refused to record the payment`);
  assert.ok(refused?.lines[0].startsWith(`Booking ${paid.ref} (Cloudbeds reservation ${paid.reservationId}) was PAID via ${gw.brand} (${money(paid.totalSatang)}, ${t.sessionLabel.short} ${paid.sessionId}), `), refused?.lines[0]);
  assert.ok(refused?.lines[1].includes(`, from ${t.methodEnvVar} (outside live: ${t.testMethodEnvVar} when set). `), refused?.lines[1]);
  assert.ok(refused?.lines[3].includes(`Do NOT add the "${t.feeItemName}" line by hand`), refused?.lines[3]);

  // Paid but stuck: the method variable named as a cause.
  await alertPaidStuck(fresh.deps, paid, "130 minutes");
  assert.ok(fresh.alerts.at(-1)?.lines[1].includes(`(the custom ${gw.brand} method) and confirm it by hand - or fix the cause (${t.methodEnvVar}, the booking key's scopes)`));
});

test("text: the sweeper's release note for an expired session is the gateway's releaseNoteText", async () => {
  const { kit, gw, sessionId, reservationId } = await held();
  kit.fakeStripe.expire(sessionId);
  const p = await gw.get(sessionId);
  const summary = await runSweep(kit.deps);
  assert.equal(summary.released, 1);
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.notes.at(-1), gw.text.releaseNoteText([p]));
  assert.match(gw.text.releaseNoteText([p]), /no payment was ever attempted/);
});

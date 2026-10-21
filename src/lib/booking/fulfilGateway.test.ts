// The generic fulfil, release and abandon core (Beam design step S1.2): fulfilPayment, releasePayment,
// abandonPayment and their alerts reach the provider only through the PaymentGateway they are given, and
// take every provider word from gw.brand and gw.text. An "Acme" gateway (the Stripe gateway under another
// brand and wording, counting its calls) drives the real flow on the in-repo fakes: no "Stripe" word reaches
// Cloudbeds or the owner, every Redis key is built from the gateway's key, and get/cancel are called exactly
// as often as the Stripe wrappers call Stripe. The Stripe wrappers themselves are pinned by the golden snapshot.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudbedsWriteError } from "./cloudbedsWrite.ts";
import { abandonPayment, alertFulfilPaymentFailure, alertPaidPaymentStuck, fulfilPayment, releasePayment, testMoneyLabel } from "./fulfil.ts";
import { keys, writeJson, DONE_TTL_SECONDS } from "./lock.ts";
import type { PaidPending } from "./lock.ts";
import type { PaymentGateway } from "./payments/gateway.ts";
import { stripeGateway } from "./payments/stripeGateway.ts";
import { satangToBahtString } from "./quote.ts";
import { checkout, makeKit, sessionIdOf } from "./testkit.ts";
import type { Kit } from "./testkit.ts";
import type { CheckoutSuccess } from "./types.ts";

const money = (satang: number) => `THB ${satangToBahtString(satang)}`;

/** The Stripe gateway with every provider word replaced, recording each get/cancel. */
function acmeGateway(kit: Kit): { gw: PaymentGateway; calls: string[] } {
  const inner = stripeGateway(kit.deps);
  const calls: string[] = [];
  const gw: PaymentGateway = {
    ...inner,
    brand: "Acme",
    async get(key) {
      calls.push(`get ${key}`);
      const p = await inner.get(key);
      return { ...p, receipt: { ...p.receipt, description: `Acme ${p.receipt.primaryId ?? "-"} link ${key}` } };
    },
    async cancel(key) {
      calls.push(`cancel ${key}`);
      return inner.cancel(key);
    },
    text: {
      ...inner.text,
      paidVia: (receipt, amount) => `via Acme ${receipt.primaryId ?? "-"} (${amount})`,
      paymentDescription: (receipt, ref) => `${receipt.description} ref ${ref}`,
      sessionLabel: { long: "payment link", short: "link" },
      refundWhere: "in the Acme dashboard",
      methodEnvVar: "CLOUDBEDS_ACME_PAYMENT_METHOD",
      testMethodEnvVar: "CLOUDBEDS_ACME_TEST_PAYMENT_METHOD",
      webhookRetryHint: "Acme webhook retries",
    },
  };
  return { gw, calls };
}

async function held(kit: Kit = makeKit()) {
  const res = await checkout(kit);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  return { kit, ...acmeGateway(kit), key: sessionIdOf(body), reservationId: body.holdReservationId as string, ref: body.ref };
}

/** No provider word of Stripe's in what fulfil wrote since `from` (notes and payment descriptions) or alerted. */
function assertNoStripeWords(kit: Kit, reservationId: string, from: { notes: number; alerts: number }): void {
  const r = kit.fakeCb.reservations.get(reservationId)!;
  for (const text of [...r.notes.slice(from.notes), ...r.payments.map((p) => p.description)]) assert.doesNotMatch(text, /Stripe/, text);
  for (const a of kit.alerts.slice(from.alerts)) assert.doesNotMatch([a.subject, ...a.lines].join("\n"), /Stripe/, a.subject);
}

test("fulfilPayment: one gw.get, the gateway's words in Cloudbeds and the alerts, Redis keys from its key", async () => {
  const { kit, gw, calls, key, reservationId, ref } = await held();
  kit.fakeStripe.complete(key);
  const from = { notes: kit.fakeCb.reservations.get(reservationId)!.notes.length, alerts: kit.alerts.length };
  const out = await fulfilPayment(key, kit.deps, gw);
  assert.equal(out.state, "confirmed");
  assert.deepEqual(calls, [`get ${key}`], "the payment is re-read once, through the gateway");

  const pi = kit.fakeStripe.session(key)!.payment_intent!;
  const total = out.state === "confirmed" ? out.totalSatang : NaN;
  const label = testMoneyLabel(kit.deps);
  const r = kit.fakeCb.reservations.get(reservationId)!;
  assert.equal(r.status, "confirmed");
  assert.ok(r.notes.at(-1)?.startsWith(`${label}PAID via Acme ${pi} (${money(total)}) for online booking ${ref} - do NOT cancel.`), r.notes.at(-1));
  assert.deepEqual(
    r.payments.map((p) => p.description),
    [`${label}Acme ${pi} link ${key} ref ${ref}`],
  );
  const booked = kit.alerts.find((a) => a.subject.startsWith(`New direct booking ${ref}`));
  assert.equal(booked?.lines[1], `Paid ${money(total)} via Acme (${pi}); the payment and the fee line are on the folio and the reservation is confirmed.`);
  assertNoStripeWords(kit, reservationId, from);

  assert.equal(await kit.deps.kv.get(keys.reservationPaid(reservationId)), key);
  assert.notEqual(await kit.deps.kv.get(keys.fulfilDone(key)), null);
  assert.notEqual(await kit.deps.kv.get(keys.fulfilStep(key, "payment")), null);
  assert.notEqual(await kit.deps.kv.get(keys.paidPending(key)), null);

  // Done: the marker answers without asking the provider again.
  assert.deepEqual(await fulfilPayment(key, kit.deps, gw), { state: "confirmed", reservationId, ref, totalSatang: total, alreadyDone: true });
  assert.equal(calls.length, 1);
});

test("fulfilPayment: needs attention names the gateway's payment label and where to refund", async () => {
  const { kit, gw, key, reservationId, ref } = await held();
  kit.fakeCb.reservations.get(reservationId)!.status = "canceled";
  kit.fakeStripe.complete(key);
  const from = { notes: kit.fakeCb.reservations.get(reservationId)!.notes.length, alerts: kit.alerts.length };
  assert.equal((await fulfilPayment(key, kit.deps, gw)).state, "needs_attention");
  const urgent = kit.alerts.find((a) => a.subject === `URGENT: paid booking ${ref} needs attention`);
  assert.ok(urgent?.lines[0].endsWith("or refund in the Acme dashboard."), urgent?.lines[0]);
  assert.ok(urgent?.lines[1].startsWith(`Acme payment link ${key}, Cloudbeds reservation ${reservationId}, `), urgent?.lines[1]);
  assertNoStripeWords(kit, reservationId, from);
  assert.notEqual(await kit.deps.kv.get(keys.fulfilDone(key)), null);
});

test("fulfilPayment: a payment that is not ours, or not paid, is left alone", async () => {
  const { kit, gw, key, reservationId } = await held();
  assert.deepEqual(await fulfilPayment(key, kit.deps, gw), { state: "not_paid", payment: "open" });
  const foreign: PaymentGateway = { ...gw, get: async (k) => ({ ...(await gw.get(k)), meta: null }) };
  kit.fakeStripe.complete(key);
  assert.deepEqual(await fulfilPayment(key, kit.deps, foreign), { state: "not_ours" });
  assert.equal(await kit.deps.kv.get(keys.reservationPaid(reservationId)), null, "never marked paid");
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "not_confirmed");
});

test("fulfil failure alerts: the gateway's brand, labels, retry hint and method variables", async () => {
  const kit = makeKit();
  const { gw } = acmeGateway(kit);
  await alertFulfilPaymentFailure(kit.deps, gw, "lnk_unseen0001", new Error("Cloudbeds down"));
  assert.deepEqual(kit.alerts.at(-1)?.lines, [
    "Acme payment link lnk_unseen0001 is paid but confirming it in Cloudbeds failed: Cloudbeds down",
    "It is retried automatically (Acme webhook retries, the guest's return page and the sweeper). Do NOT cancel the reservation. If this repeats, check Cloudbeds.",
  ]);

  const paid: PaidPending = { sessionId: "lnk_seen0001", ref: "MSV-20261005-ABCD", reservationId: "48213377", totalSatang: 1_890_000, paidAt: kit.now.ms, mode: "stripe-test" };
  await writeJson(kit.deps.kv, keys.paidPending(paid.sessionId), paid, DONE_TTL_SECONDS);
  await alertFulfilPaymentFailure(kit.deps, gw, paid.sessionId, new Error("Cloudbeds down"));
  assert.equal(
    kit.alerts.at(-1)?.lines[0],
    `Booking ${paid.ref} (Cloudbeds reservation ${paid.reservationId}, ${money(paid.totalSatang)}, Acme link ${paid.sessionId}) is PAID, but confirming it in Cloudbeds failed: Cloudbeds down`,
  );
  assert.equal(kit.alerts.at(-1)?.subject, `Paid booking ${paid.ref} not yet confirmed in Cloudbeds (retrying)`);

  await alertFulfilPaymentFailure(kit.deps, gw, paid.sessionId, new CloudbedsWriteError("postPayment", "rejected", "unknown method", 200, null, false));
  const refused = kit.alerts.at(-1)!;
  assert.equal(refused.subject, `URGENT: paid booking ${paid.ref}: Cloudbeds refused to record the payment`);
  assert.ok(refused.lines[0].startsWith(`Booking ${paid.ref} (Cloudbeds reservation ${paid.reservationId}) was PAID via Acme (${money(paid.totalSatang)}, link ${paid.sessionId}), `), refused.lines[0]);
  assert.ok(refused.lines[1].includes(", from CLOUDBEDS_ACME_PAYMENT_METHOD (outside live: CLOUDBEDS_ACME_TEST_PAYMENT_METHOD when set). "), refused.lines[1]);
  // The method value itself is the configured Cloudbeds method ("Stripe(website)" in the kit): every other word is Acme's.
  const method = JSON.stringify(kit.config.cloudbedsPaymentMethod);
  assert.doesNotMatch([refused.subject, ...refused.lines].join("\n").replaceAll(method, "<method>"), /Stripe/);

  await alertPaidPaymentStuck(kit.deps, gw, paid, "130 minutes");
  const stuck = kit.alerts.at(-1)!;
  assert.equal(stuck.subject, `URGENT: paid booking ${paid.ref} still not confirmed in Cloudbeds`);
  assert.ok(stuck.lines[0].includes(`was PAID via Acme (${money(paid.totalSatang)}, link ${paid.sessionId})`), stuck.lines[0]);
  assert.ok(stuck.lines[1].includes("(the custom Acme method) and confirm it by hand - or fix the cause (CLOUDBEDS_ACME_PAYMENT_METHOD, the booking key's scopes)"), stuck.lines[1]);
  assert.doesNotMatch([stuck.subject, ...stuck.lines].join("\n"), /Stripe/);
});

test("releasePayment: one gw.get decides; only a payment that can no longer be paid releases its hold", async () => {
  const open = await held();
  assert.deepEqual(await releasePayment(open.key, open.kit.deps, open.gw, "x"), { state: "refused_open" });
  assert.deepEqual(open.calls, [`get ${open.key}`]);

  const paid = await held();
  paid.kit.fakeStripe.complete(paid.key);
  assert.deepEqual(await releasePayment(paid.key, paid.kit.deps, paid.gw, "x"), { state: "refused_paid", reservationId: paid.reservationId });

  const foreign = await held();
  foreign.kit.fakeStripe.expire(foreign.key);
  const notOurs: PaymentGateway = { ...foreign.gw, get: async (k) => ({ ...(await foreign.gw.get(k)), meta: null }) };
  assert.deepEqual(await releasePayment(foreign.key, foreign.kit.deps, notOurs, "x"), { state: "not_ours" });
  assert.equal(foreign.kit.fakeCb.reservations.get(foreign.reservationId)?.status, "not_confirmed");

  const expired = await held();
  expired.kit.fakeStripe.expire(expired.key);
  assert.deepEqual(await releasePayment(expired.key, expired.kit.deps, expired.gw, "session expired"), { state: "released", reservationId: expired.reservationId });
  assert.deepEqual(expired.calls, [`get ${expired.key}`]);
  assert.equal(expired.kit.fakeCb.reservations.get(expired.reservationId)?.status, "canceled");
});

test("abandonPayment: get, cancel, get - then release, fulfil through the same gateway, or keep the hold", async () => {
  // Open: cancelled (abandoned marker on the key) and released.
  const a = await held();
  assert.deepEqual(await abandonPayment(a.key, a.kit.deps, a.gw, a.ref), { state: "released" });
  assert.deepEqual(a.calls, [`get ${a.key}`, `cancel ${a.key}`, `get ${a.key}`]);
  assert.equal(await a.kit.deps.kv.get(keys.abandoned(a.key)), "1");
  assert.equal(a.kit.fakeCb.reservations.get(a.reservationId)?.status, "canceled");

  // Another booking's ref: nothing cancelled.
  const b = await held();
  assert.deepEqual(await abandonPayment(b.key, b.kit.deps, b.gw, "MSV-20261005-AAAA"), { state: "closed" });
  assert.deepEqual(b.calls, [`get ${b.key}`]);
  assert.equal(b.kit.fakeStripe.session(b.key)?.status, "open");

  // Paid in another tab: the page was no longer open (no abandoned marker); fulfilled with the gateway's words.
  b.kit.fakeStripe.complete(b.key);
  b.calls.length = 0;
  assert.deepEqual(await abandonPayment(b.key, b.kit.deps, b.gw, b.ref), { state: "paid" });
  assert.deepEqual(b.calls, [`get ${b.key}`, `cancel ${b.key}`, `get ${b.key}`, `get ${b.key}`]);
  assert.equal(await b.kit.deps.kv.get(keys.abandoned(b.key)), null);
  assert.equal(b.kit.fakeCb.reservations.get(b.reservationId)?.status, "confirmed");
  assert.ok(b.kit.fakeCb.reservations.get(b.reservationId)?.notes.some((n) => n.includes("PAID via Acme ")));

  // Processing: the hold is kept.
  const c = await held();
  c.kit.fakeStripe.completeDelayed(c.key);
  assert.deepEqual(await abandonPayment(c.key, c.kit.deps, c.gw, c.ref), { state: "pending" });
  assert.equal(c.kit.fakeCb.reservations.get(c.reservationId)?.status, "not_confirmed");
});

test("abandonPayment: a payment the gateway calls missing is closed; any other read error is thrown", async () => {
  const { kit, gw, key, reservationId, ref } = await held();
  const gone = new Error("no such payment");
  const missing: PaymentGateway = { ...gw, get: async () => Promise.reject(gone), isMissing: (e) => e === gone };
  assert.deepEqual(await abandonPayment(key, kit.deps, missing, ref), { state: "closed" });
  const down: PaymentGateway = { ...missing, get: async () => Promise.reject(new Error("503")) };
  await assert.rejects(() => abandonPayment(key, kit.deps, down, ref), /503/);
  // A cancel that fails on the network is thrown too (the caller answers an error; the sweeper covers it).
  const cancelDown: PaymentGateway = { ...gw, cancel: async () => Promise.reject(new Error("timeout")) };
  await assert.rejects(() => abandonPayment(key, kit.deps, cancelDown, ref), /timeout/);
  assert.equal(await kit.deps.kv.get(keys.abandoned(key)), null);
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "not_confirmed");
});

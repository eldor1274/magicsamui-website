// The optional gateway hooks of fulfil, release and abandon (Beam design step S2.5). An "Acme" gateway (the
// Stripe gateway under another brand, as in fulfilGateway.test.ts) sets every new member - doneTtlSeconds,
// releaseGuard, parseHoldId, isPaymentId and the texts refundHow, mockMethod, bookedExtra and
// pendingReleasedAlert, plus its own fee item - and can make a payment read 'refunded', carry a mismatch or a
// pendingReason, which Stripe never reports. It drives the real flow on the in-repo fakes. The Stripe gateway
// sets none of these, so its calls, texts, KV writes and TTLs are those the golden snapshot pins.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PAID_UNCONFIRMED_ESCALATE_MS,
  abandonPayment,
  afterPaymentReleased,
  alertFulfilPaymentFailure,
  alertPaidPaymentStuck,
  feeItemFor,
  fulfilPayment,
  markPaymentPaid,
  releaseHold,
  releasePayment,
  testMoneyLabel,
} from "./fulfil.ts";
import type { FulfilDone } from "./fulfil.ts";
import { createMemoryKv } from "./kv.ts";
import { keyScope, keys, parseBeamHoldIdentifier, readJson, DONE_TTL_SECONDS } from "./lock.ts";
import type { PaidPending } from "./lock.ts";
import type { GatewayPayment, GatewayReceipt, GatewayState, PaymentGateway } from "./payments/gateway.ts";
import { STRIPE_GATEWAY_TEXT, stripeGateway } from "./payments/stripeGateway.ts";
import { satangToBahtString } from "./quote.ts";
import { runSweep } from "./sweep.ts";
import { FAR_CHECKIN, FAR_CHECKOUT, NOW, STRIPE_TEST_ENV, checkout, makeKit, recordingKv, sessionIdOf } from "./testkit.ts";
import type { Kit, KvWrite } from "./testkit.ts";
import type { CheckoutSuccess } from "./types.ts";

const money = (satang: number) => `THB ${satangToBahtString(satang)}`;

/** Acme's done-marker TTL (any long one: Beam's is lock.ts BEAM_RECORD_TTL_SECONDS). */
const ACME_TTL = 600 * 24 * 3600;
const ACME_FEE_NAME = "Acme handling fee";
const refundHow = (receipt: GatewayReceipt) => `the full amount by bank transfer (Acme can't refund ${receipt.methodType ?? "?"} payments)`;
const bookedExtra = (receipt: GatewayReceipt) => `If the guest cancels: refund the ${receipt.methodType ?? "?"} payment by bank transfer.`;

/** What the next reads of the Acme gateway report on top of the Stripe session underneath. */
interface Override {
  state?: GatewayState;
  mismatch?: string;
  pendingReason?: "processing" | "unconfirmed";
}

interface Acme {
  gw: PaymentGateway;
  /** Every get, cancel and release-guard call, in order. */
  calls: string[];
  override: Override;
  /** releaseGuard's answer (and what the guard itself saw: the release lock held or not). */
  guard: { answer: boolean | Error; sawLock: boolean[] };
}

/** The Stripe gateway under Acme's brand, with every optional hook of S2.5 set. */
function acmeGateway(kit: Kit): Acme {
  const inner = stripeGateway(kit.deps);
  const calls: string[] = [];
  const override: Override = {};
  const guard: Acme["guard"] = { answer: true, sawLock: [] };
  const adjust = (p: GatewayPayment): GatewayPayment => ({
    ...p,
    receipt: { ...p.receipt, description: `Acme ${p.receipt.primaryId ?? "-"} link ${p.key}`, methodType: "QR" },
    ...override,
  });
  const gw: PaymentGateway = {
    ...inner,
    brand: "Acme",
    async get(key) {
      calls.push(`get ${key}`);
      return adjust(await inner.get(key));
    },
    async cancel(key) {
      calls.push(`cancel ${key}`);
      return inner.cancel(key);
    },
    async sweepRecent(sinceMs) {
      return (await inner.sweepRecent(sinceMs)).map((listed) => ({ ...listed, read: async () => adjust(await listed.read()) }));
    },
    doneTtlSeconds: ACME_TTL,
    async releaseGuard(key) {
      calls.push(`guard ${key}`);
      const p = await inner.get(key);
      guard.sawLock.push((await kit.deps.kv.get(keys.releaseLock(p.meta?.reservationId ?? "-"))) !== null);
      if (guard.answer instanceof Error) throw guard.answer;
      return guard.answer;
    },
    parseHoldId: parseBeamHoldIdentifier,
    isPaymentId: (id: unknown): id is string => typeof id === "string" && id.startsWith("lnk_"),
    text: {
      ...inner.text,
      paidVia: (receipt, amount) => `via Acme ${receipt.primaryId ?? "-"} (${amount})`,
      paymentDescription: (receipt, ref) => `${receipt.description} ref ${ref}`,
      sessionLabel: { long: "payment link", short: "link" },
      refundWhere: "in the Acme dashboard",
      methodEnvVar: "CLOUDBEDS_ACME_PAYMENT_METHOD",
      testMethodEnvVar: "CLOUDBEDS_ACME_TEST_PAYMENT_METHOD",
      webhookRetryHint: "Acme webhook retries",
      feeItem: (mode) => ({ appItemId: `acme-fee-${mode}`, itemSku: "ACME-FEE", name: ACME_FEE_NAME, note: "Acme fee line." }),
      feeItemName: ACME_FEE_NAME,
      refundHow,
      mockMethod: "mock-acme",
      bookedExtra,
      pendingReleasedAlert: (payment, reservationId) => ({
        subject: `Acme payment still pending: hold ${reservationId} released (booking ${payment.meta?.ref ?? "-"})`,
        lines: [`A ${payment.receipt.methodType ?? "?"} payment on Acme link ${payment.paymentId} was still waiting for the bank when the hold was released.`],
        key: `acme-pending-released:${payment.paymentId}`,
        severity: "warning",
      }),
    },
  };
  return { gw, calls, override, guard };
}

async function held(kit: Kit = makeKit()) {
  const res = await checkout(kit);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  return { kit, ...acmeGateway(kit), key: sessionIdOf(body), reservationId: body.holdReservationId as string, ref: body.ref };
}

async function holdIndexed(kit: Kit, reservationId: string): Promise<boolean> {
  return (await kit.deps.kv.zrangeByScore(keys.holdIndex(), 0, Number.MAX_SAFE_INTEGER, 500)).includes(reservationId);
}

async function paidIndexOf(kit: Kit): Promise<string[]> {
  return kit.deps.kv.zrangeByScore(keys.paidIndex(keyScope(kit.config.paymentMode)), 0, Number.MAX_SAFE_INTEGER, 500);
}

/* ------------------------------ Stripe: none ------------------------------ */

test("the Stripe gateway sets none of the new hooks, and its payments carry no mismatch or pendingReason", async () => {
  const { kit, key } = await held();
  const gw = stripeGateway(kit.deps);
  for (const member of ["doneTtlSeconds", "releaseGuard", "parseHoldId", "isPaymentId"]) assert.equal(member in gw, false, member);
  for (const member of ["refundHow", "mockMethod", "bookedExtra", "pendingReleasedAlert"]) assert.equal(member in STRIPE_GATEWAY_TEXT, false, member);
  // The fee item and its alert name are fulfil.ts's own (feeItemFor) for every mode.
  for (const mode of ["stripe-live", "stripe-test", "stripe-mock", "beam-live", "demo"]) assert.deepEqual(STRIPE_GATEWAY_TEXT.feeItem(mode), feeItemFor(mode), mode);
  assert.equal(STRIPE_GATEWAY_TEXT.feeItemName, "Payment processing fee");

  const read = async () => {
    const p = await gw.get(key);
    assert.equal("mismatch" in p, false);
    assert.equal("pendingReason" in p, false);
    return p.state;
  };
  assert.equal(await read(), "open");
  kit.fakeStripe.completeDelayed(key);
  assert.equal(await read(), "processing");
  kit.fakeStripe.asyncSucceed(key);
  assert.equal(await read(), "paid");
});

/* ------------------------------- refunded ------------------------------- */

test("refunded before confirmation: one CRITICAL needs_attention, the done marker, the hold closed - never confirmed, never cancelled", async () => {
  const { kit, gw, calls, override, key, reservationId, ref } = await held();
  kit.fakeStripe.complete(key);
  override.state = "refunded";
  const r = kit.fakeCb.reservations.get(reservationId)!;
  const notesBefore = r.notes.length;
  const from = kit.alerts.length;

  const out = await fulfilPayment(key, kit.deps, gw);
  const reason = `REFUNDED at Acme before the booking was confirmed: the guest's payment was refunded in Acme. Do NOT confirm Cloudbeds reservation ${reservationId}: check its folio shows no payment and cancel it by hand so the unit goes back on sale.`;
  assert.deepEqual(out, { state: "needs_attention", reservationId, ref, reason });
  assert.deepEqual(calls, [`get ${key}`]);

  const fresh = kit.alerts.slice(from);
  assert.equal(fresh.length, 1, JSON.stringify(fresh));
  assert.equal(fresh[0].severity, "critical");
  assert.equal(fresh[0].subject, `URGENT: paid booking ${ref} needs attention`);
  assert.equal(fresh[0].lines[0], reason);
  assert.ok(fresh[0].lines[1].startsWith(`Acme payment link ${key}, Cloudbeds reservation ${reservationId}, `), fresh[0].lines[1]);

  const done = await readJson<FulfilDone>(kit.deps.kv, keys.fulfilDone(key));
  assert.equal(done?.state, "needs_attention");
  assert.equal(done?.reason, reason);
  assert.equal(await holdIndexed(kit, reservationId), false, "the hold is closed (no longer swept as open)");
  // Not money we hold: no paid marker, no paid-index entry, nothing written to the folio.
  assert.equal(await kit.deps.kv.get(keys.reservationPaid(reservationId)), null);
  assert.deepEqual(await paidIndexOf(kit), []);
  assert.equal(r.status, "not_confirmed", "neither confirmed nor cancelled");
  assert.equal(kit.fakeCb.count("postPayment"), 0);
  assert.equal(kit.fakeCb.count("postCustomItem"), 0);
  assert.equal(r.notes.length, notesBefore, "no PAID note");

  // Final: the marker answers, without asking the provider again.
  assert.deepEqual(await fulfilPayment(key, kit.deps, gw), out);
  assert.equal(calls.length, 1);
  // Release and abandon never cancel it either.
  assert.deepEqual(await releasePayment(key, kit.deps, gw, "x"), { state: "refused_paid", reservationId });
  assert.deepEqual(await abandonPayment(key, kit.deps, gw, ref), { state: "closed" });
  assert.equal(r.status, "not_confirmed");
  assert.equal(calls.some((c) => c.startsWith("guard")), false, "nothing asked the release guard");
  assert.equal(kit.alerts.length, from + 1, "no second alert");
});

test("refunded after the payment was marked paid: the sweeper hands it to the owner once and then stops alerting", async () => {
  const { kit, gw, override, key, reservationId, ref } = await held();
  kit.fakeStripe.complete(key);
  const meta = (await gw.get(key)).meta!;
  // The webhook's durable ack ran, fulfil never finished; then the payment was refunded at the provider.
  await markPaymentPaid(kit.deps, gw, key, meta);
  override.state = "refunded";
  kit.now.ms += PAID_UNCONFIRMED_ESCALATE_MS + 60_000;
  const from = kit.alerts.length;

  const first = await runSweep(kit.deps, gw);
  assert.deepEqual(
    kit.alerts.slice(from).map((a) => [a.severity, a.subject]),
    [["critical", `URGENT: paid booking ${ref} needs attention`]],
  );
  assert.ok(kit.alerts.at(-1)?.lines[0].startsWith("REFUNDED at Acme before the booking was confirmed"), kit.alerts.at(-1)?.lines[0]);
  assert.equal(first.paidUnconfirmed, 0);
  assert.deepEqual(await paidIndexOf(kit), [], "dropped from the paid index: no 'still not confirmed' escalations");
  assert.equal((await readJson<FulfilDone>(kit.deps.kv, keys.fulfilDone(key)))?.state, "needs_attention");

  // Later runs, each past the alert window: nothing more, and the hold is never cancelled.
  for (let i = 0; i < 3; i++) {
    kit.now.ms += 7 * 3600_000;
    const s = await runSweep(kit.deps, gw);
    assert.equal(s.paidUnconfirmed, 0);
    assert.equal(s.released, 0);
  }
  assert.equal(kit.alerts.length, from + 1, JSON.stringify(kit.alerts.slice(from + 1)));
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "not_confirmed");
});

/* ------------------------------- mismatch ------------------------------- */

test("a payment carrying a mismatch: needs_attention with it, nothing posted, never confirmed, never released", async () => {
  const { kit, gw, override, key, reservationId, ref } = await held();
  kit.fakeStripe.complete(key);
  override.mismatch = "Acme link was paid to merchant m_other, not to this account (m_ours): check the payment in the Acme dashboard before settling the booking.";
  const from = kit.alerts.length;
  const putsBefore = kit.fakeCb.count("putReservation");

  const out = await fulfilPayment(key, kit.deps, gw);
  assert.deepEqual(out, { state: "needs_attention", reservationId, ref, reason: override.mismatch });
  assert.equal(kit.fakeCb.count("postPayment"), 0);
  assert.equal(kit.fakeCb.count("postCustomItem"), 0);
  assert.equal(kit.fakeCb.count("putReservation"), putsBefore, "not confirmed");
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "not_confirmed");
  const urgent = kit.alerts.slice(from).filter((a) => a.severity === "critical");
  assert.deepEqual(
    urgent.map((a) => [a.subject, a.lines[0]]),
    [[`URGENT: paid booking ${ref} needs attention`, override.mismatch]],
  );
  // Money was taken: the reservation keeps its paid marker, so nothing ever releases it.
  assert.equal(await kit.deps.kv.get(keys.reservationPaid(reservationId)), key);
  assert.deepEqual(await releaseHold(reservationId, kit.deps, "x"), { state: "refused_paid", reservationId });
  assert.equal((await readJson<FulfilDone>(kit.deps.kv, keys.fulfilDone(key)))?.state, "needs_attention");
});

/* -------------------------------- texts -------------------------------- */

test("texts: bookedExtra ends the 'New direct booking' alert; the fee line is the gateway's item, named by feeItemName", async () => {
  const { kit, gw, key, reservationId, ref } = await held();
  kit.fakeStripe.complete(key);
  const out = await fulfilPayment(key, kit.deps, gw);
  assert.equal(out.state, "confirmed");
  const pi = kit.fakeStripe.session(key)!.payment_intent!;
  const total = out.state === "confirmed" ? out.totalSatang : NaN;
  const booked = kit.alerts.find((a) => a.subject.startsWith(`New direct booking ${ref}`));
  assert.deepEqual(booked?.lines, [
    `Cloudbeds reservation ${reservationId}, ${FAR_CHECKIN} to ${FAR_CHECKOUT}.`,
    `Paid ${money(total)} via Acme (${pi}); the payment and the fee line are on the folio and the reservation is confirmed.`,
    "If the guest cancels: refund the QR payment by bank transfer.",
  ]);
  const r = kit.fakeCb.reservations.get(reservationId)!;
  assert.deepEqual(
    r.items.map((i) => i.itemName),
    [ACME_FEE_NAME],
  );
  const item = kit.fakeCb.calls.find((c) => c.method === "postCustomItem")?.params ?? {};
  assert.deepEqual(
    [item["items[0][appItemID]"], item["items[0][itemSKU]"], item["items[0][itemName]"], item["items[0][itemNote]"]],
    [`acme-fee-${kit.config.paymentMode}`, "ACME-FEE", ACME_FEE_NAME, "Acme fee line."],
  );
});

test("texts: the paid-but-cancelled reason ends with the gateway's refundHow for the payment", async () => {
  const { kit, gw, key, reservationId } = await held();
  kit.fakeCb.reservations.get(reservationId)!.status = "canceled";
  kit.fakeStripe.complete(key);
  const out = await fulfilPayment(key, kit.deps, gw);
  assert.equal(out.state, "needs_attention");
  assert.equal(
    out.state === "needs_attention" ? out.reason : "",
    "The guest PAID but the Cloudbeds hold is CANCELLED. Re-instate or re-book the guest in Cloudbeds (if the unit is still free) or refund the full amount by bank transfer (Acme can't refund QR payments).",
  );
  // Without refundHow: refundWhere, as before.
  const plain = await held();
  plain.kit.fakeCb.reservations.get(plain.reservationId)!.status = "canceled";
  plain.kit.fakeStripe.complete(plain.key);
  const noHow: PaymentGateway = { ...plain.gw, text: { ...plain.gw.text, refundHow: undefined } };
  const again = await fulfilPayment(plain.key, plain.kit.deps, noHow);
  assert.ok((again.state === "needs_attention" ? again.reason : "").endsWith("or refund in the Acme dashboard."));
});

test("texts: the fee-line alerts quote feeItemName", async () => {
  const { kit, gw, key, ref } = await held();
  kit.fakeStripe.complete(key);
  kit.fakeCb.failNext("postCustomItem", "rejected", "Access denied (write:item)");
  kit.fakeCb.failNext("postCustomItem", "rejected", "Access denied (write:item)");
  assert.equal((await fulfilPayment(key, kit.deps, gw)).state, "confirmed");
  const missing = kit.alerts.find((a) => a.subject === `Booking ${ref}: the processing fee line is missing in Cloudbeds`);
  const text = missing?.lines.join(" ") ?? "";
  assert.match(text, /adding the "Acme handling fee" item \(THB [\d,.]+\) to the folio failed/);
  assert.doesNotMatch(text, /Payment processing fee/);

  const paid: PaidPending = { sessionId: key, ref, reservationId: "48213377", totalSatang: 1_890_000, paidAt: kit.now.ms, mode: kit.config.paymentMode };
  await alertPaidPaymentStuck(kit.deps, gw, paid, "130 minutes");
  const stuck = kit.alerts.at(-1)!;
  assert.ok(stuck.lines[2].startsWith(`If the "${ACME_FEE_NAME}" line is not on the folio yet`), stuck.lines[2]);
  assert.doesNotMatch(stuck.lines.join("\n"), /Payment processing fee/);

  // The folio already carries additional items: the fee line is skipped, and the alert names the gateway's line.
  {
    const h = await held();
    h.kit.fakeStripe.complete(h.key);
    h.kit.fakeCb.reservations.get(h.reservationId)!.items.push({ referenceID: null, itemPrice: 50_000, itemName: "Airport transfer" });
    assert.equal((await fulfilPayment(h.key, h.kit.deps, h.gw)).state, "confirmed");
    const skipped = h.kit.alerts.find((a) => a.subject === `Booking ${h.ref}: the processing fee line was not added (the folio already has items)`);
    const lines = skipped?.lines.join("\n") ?? "";
    assert.match(lines, /before we added our "Acme handling fee" line \(THB [\d,.]+\), so we did NOT add it/);
    assert.match(lines, /exactly one "Acme handling fee" line of THB [\d,.]+ should be listed/);
    assert.doesNotMatch(lines, /Payment processing fee/);
  }
  // Cloudbeds' own taxes/fees on top of the fee line.
  {
    const h = await held();
    h.kit.fakeStripe.complete(h.key);
    h.kit.fakeCb.reservations.get(h.reservationId)!.taxesFees = 1350;
    assert.equal((await fulfilPayment(h.key, h.kit.deps, h.gw)).state, "confirmed");
    const taxes = h.kit.alerts.find((a) => a.subject === `Booking ${h.ref}: Cloudbeds added taxes/fees on top of our fee line`);
    const lines = taxes?.lines.join("\n") ?? "";
    assert.match(lines, /on top of our "Acme handling fee" line/);
    assert.doesNotMatch(lines, /Payment processing fee/);
  }
  // Cloudbeds refuses to record the payment: the CRITICAL's last line names the gateway's line.
  {
    const h = await held();
    h.kit.fakeStripe.complete(h.key);
    h.kit.fakeCb.failNext("postPayment", "rejected", "Invalid payment type");
    const error = await fulfilPayment(h.key, h.kit.deps, h.gw).then(
      () => assert.fail("fulfil should throw"),
      (e: unknown) => e,
    );
    await alertFulfilPaymentFailure(h.kit.deps, h.gw, h.key, error);
    const refused = h.kit.alerts.find((a) => a.subject === `URGENT: paid booking ${h.ref}: Cloudbeds refused to record the payment`);
    assert.equal(refused?.severity, "critical");
    assert.ok(refused?.lines.at(-1)?.startsWith(`If the "${ACME_FEE_NAME}" line is not on the folio yet`), refused?.lines.at(-1));
    assert.match(refused?.lines.at(-1) ?? "", /Do NOT add the "Acme handling fee" line by hand/);
    assert.doesNotMatch(refused?.lines.join("\n") ?? "", /Payment processing fee/);
  }
});

test("texts: a paid booking whose reservation is no longer pending at the confirm step (step 7) ends with refundHow, else refundWhere", async () => {
  // A release that raced the payment cancels the hold after step 5 read it, before step 7 confirms it.
  const raced = async (gwOf: (gw: PaymentGateway) => PaymentGateway) => {
    const h = await held();
    h.kit.fakeStripe.complete(h.key);
    const writer = h.kit.deps.writer;
    const deps = {
      ...h.kit.deps,
      writer: {
        ...writer,
        recordPayment: async (input: Parameters<typeof writer.recordPayment>[0]) => {
          const recorded = await writer.recordPayment(input);
          h.kit.fakeCb.reservations.get(h.reservationId)!.status = "canceled";
          return recorded;
        },
      },
    };
    const out = await fulfilPayment(h.key, deps, gwOf(h.gw));
    assert.equal(out.state, "needs_attention");
    assert.equal(h.kit.fakeCb.count("postPayment"), 1, "the payment was recorded before the hold was found cancelled");
    return { h, reason: out.state === "needs_attention" ? out.reason : "" };
  };
  const { h, reason } = await raced((gw) => gw);
  const pi = h.kit.fakeStripe.session(h.key)!.payment_intent!;
  assert.match(reason, new RegExp(`^The guest PAID \\(THB [\\d,.]+ via Acme, ${pi}\\) and the payment is recorded on the folio, but Cloudbeds reservation ${h.reservationId} is "canceled"`));
  assert.ok(reason.endsWith("Check it in Cloudbeds: re-instate and confirm it, or refund the full amount by bank transfer (Acme can't refund QR payments)."), reason);
  const critical = h.kit.alerts.filter((a) => a.severity === "critical" && a.subject === `URGENT: paid booking ${h.ref} needs attention`);
  assert.deepEqual(
    critical.map((a) => a.lines[0]),
    [reason],
  );
  // Without refundHow: refundWhere, as before (and as Stripe, which sets no refundHow).
  const plain = await raced((gw) => ({ ...gw, text: { ...gw.text, refundHow: undefined } }));
  assert.ok(plain.reason.endsWith("Check it in Cloudbeds: re-instate and confirm it, or refund in the Acme dashboard."), plain.reason);

  // A status staff set by hand (here no_show) reads the same way.
  const noShow = await held();
  noShow.kit.fakeStripe.complete(noShow.key);
  // The fake's type lists three statuses; Cloudbeds also reports checked_in, checked_out and no_show.
  (noShow.kit.fakeCb.reservations.get(noShow.reservationId)! as { status: string }).status = "no_show";
  const out = await fulfilPayment(noShow.key, noShow.kit.deps, noShow.gw);
  assert.ok((out.state === "needs_attention" ? out.reason : "").endsWith('is "no_show", so it was not confirmed automatically. Check it in Cloudbeds: re-instate and confirm it, or refund the full amount by bank transfer (Acme can\'t refund QR payments).'), JSON.stringify(out));
});

test("texts: with the MOCK writer and no method configured, the payment is recorded under the gateway's mockMethod", async () => {
  const env = { ...STRIPE_TEST_ENV, CLOUDBEDS_API_KEY_BOOKING: undefined, CLOUDBEDS_STRIPE_PAYMENT_METHOD: undefined };
  for (const [name, gwOf] of [
    ["mock-acme", (kit: Kit) => acmeGateway(kit).gw],
    ["mock-stripe", (kit: Kit) => stripeGateway(kit.deps)],
  ] as const) {
    const kit = makeKit({ env, cb: { lenient: true } });
    assert.equal(kit.deps.writer.mode, "mock");
    const res = await checkout(kit);
    const key = sessionIdOf(res.body);
    const reservationId = (res.body as CheckoutSuccess).holdReservationId as string;
    kit.fakeStripe.complete(key);
    assert.equal((await fulfilPayment(key, kit.deps, gwOf(kit))).state, "confirmed", name);
    assert.deepEqual(
      kit.fakeCb.reservations.get(reservationId)!.payments.map((p) => p.type),
      [name],
    );
  }
});

/* ------------------------------ release guard ------------------------------ */

test("releaseHold: stillReleasable runs inside the release lock right before the cancel; false -> refused_open, nothing cancelled", async () => {
  const { kit, reservationId } = await held();
  const seen: boolean[] = [];
  const no = async () => {
    seen.push((await kit.deps.kv.get(keys.releaseLock(reservationId))) !== null);
    return false;
  };
  assert.deepEqual(await releaseHold(reservationId, kit.deps, "x", { stillReleasable: no }), { state: "refused_open" });
  assert.deepEqual(seen, [true], "asked once, under the release lock");
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "not_confirmed");
  assert.equal(await kit.deps.kv.get(keys.releaseDone(reservationId)), null);
  assert.equal(await holdIndexed(kit, reservationId), true, "still swept");
  assert.ok(kit.logs.some((l) => l.message === "release_refused_still_payable" && l.data?.reservationId === reservationId));

  // Not asked when an earlier check already refuses (the folio shows a payment).
  const paidFolio = await held();
  paidFolio.kit.fakeCb.reservations.get(paidFolio.reservationId)!.payments.push({ paymentID: "p-1", type: "cash", amount: 100, description: "front desk" });
  const asked: string[] = [];
  const guard = async () => {
    asked.push("asked");
    return true;
  };
  assert.deepEqual(await releaseHold(paidFolio.reservationId, paidFolio.kit.deps, "x", { stillReleasable: guard }), { state: "refused_paid", reservationId: paidFolio.reservationId });
  assert.deepEqual(asked, []);

  // A guard that throws: nothing cancelled, the error is thrown on.
  await assert.rejects(releaseHold(reservationId, kit.deps, "x", { stillReleasable: async () => Promise.reject(new Error("provider down")) }), /provider down/);
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "not_confirmed");

  // true: released.
  assert.deepEqual(await releaseHold(reservationId, kit.deps, "x", { stillReleasable: guard }), { state: "released", reservationId });
  assert.deepEqual(asked, ["asked"]);
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "canceled");
});

test("releasePayment passes gw.releaseGuard for the payment's key: false keeps the hold; true releases it", async () => {
  const { kit, gw, calls, guard, key, reservationId } = await held();
  kit.fakeStripe.expire(key);
  guard.answer = false;
  assert.deepEqual(await releasePayment(key, kit.deps, gw, "link expired"), { state: "refused_open" });
  assert.deepEqual(calls, [`get ${key}`, `guard ${key}`]);
  assert.deepEqual(guard.sawLock, [true]);
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "not_confirmed");
  assert.equal(
    kit.fakeCb.calls.some((c) => c.method === "putReservation" && c.params.status === "canceled"),
    false,
    "no Cloudbeds cancel",
  );

  guard.answer = new Error("provider down");
  await assert.rejects(releasePayment(key, kit.deps, gw, "link expired"), /provider down/);
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "not_confirmed");

  guard.answer = true;
  assert.deepEqual(await releasePayment(key, kit.deps, gw, "link expired"), { state: "released", reservationId });
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "canceled");
  assert.equal(calls.filter((c) => c.startsWith("guard")).length, 3);
});

/* -------------------------- unconfirmed payments -------------------------- */

test("abandon on an 'unconfirmed' payment: the hold is released (guarded), the owner warned once, and the answer is 'pending'", async () => {
  const { kit, gw, calls, override, key, reservationId, ref } = await held();
  kit.fakeStripe.expire(key);
  Object.assign(override, { state: "expired", pendingReason: "unconfirmed" });
  const from = kit.alerts.length;
  assert.deepEqual(await abandonPayment(key, kit.deps, gw, ref), { state: "pending" });
  assert.deepEqual(calls, [`get ${key}`, `cancel ${key}`, `get ${key}`, `guard ${key}`]);
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "canceled", "the unit is back on sale");
  assert.deepEqual(kit.alerts.slice(from), [
    {
      subject: `Acme payment still pending: hold ${reservationId} released (booking ${ref})`,
      lines: [`A QR payment on Acme link ${key} was still waiting for the bank when the hold was released.`],
      severity: "warning",
    },
  ]);
  // Asked again (the browser retries): still 'pending', and no second release or warning.
  assert.deepEqual(await abandonPayment(key, kit.deps, gw, ref), { state: "pending" });
  assert.equal(kit.alerts.length, from + 1);
});

test("abandon: a release the guard refuses answers 'pending' (never 'closed', which would let the guest pay again)", async () => {
  for (const pendingReason of ["unconfirmed", undefined] as const) {
    const { kit, gw, override, guard, key, reservationId, ref } = await held();
    kit.fakeStripe.expire(key);
    Object.assign(override, { state: "expired", pendingReason });
    guard.answer = false;
    const from = kit.alerts.length;
    assert.deepEqual(await abandonPayment(key, kit.deps, gw, ref), { state: "pending" }, String(pendingReason));
    assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "not_confirmed");
    assert.equal(kit.alerts.length, from, "no 'released' warning for a hold that was kept");
  }
  // A plain expired payment the guard lets go: released, as before.
  const { kit, gw, key, reservationId, ref } = await held();
  kit.fakeStripe.expire(key);
  assert.deepEqual(await abandonPayment(key, kit.deps, gw, ref), { state: "released" });
  assert.equal(kit.fakeCb.reservations.get(reservationId)?.status, "canceled");
});

test("releasePayment on an 'unconfirmed' payment releases it and warns once; afterPaymentReleased warns only for 'unconfirmed' and never throws", async () => {
  const { kit, gw, override, key, reservationId, ref } = await held();
  kit.fakeStripe.expire(key);
  Object.assign(override, { state: "expired", pendingReason: "unconfirmed" });
  const from = kit.alerts.length;
  assert.deepEqual(await releasePayment(key, kit.deps, gw, "link expired"), { state: "released", reservationId });
  assert.deepEqual(await releasePayment(key, kit.deps, gw, "link expired"), { state: "already_released", reservationId });
  assert.deepEqual(
    kit.alerts.slice(from).map((a) => [a.severity, a.subject]),
    [["warning", `Acme payment still pending: hold ${reservationId} released (booking ${ref})`]],
  );

  const payment = await gw.get(key);
  const quiet = makeKit();
  const before = quiet.alerts.length;
  await afterPaymentReleased(quiet.deps, stripeGateway(quiet.deps), payment, reservationId); // no text: nothing
  await afterPaymentReleased(quiet.deps, gw, { ...payment, pendingReason: "processing" }, reservationId);
  await afterPaymentReleased(quiet.deps, gw, { ...payment, pendingReason: undefined }, reservationId);
  assert.equal(quiet.alerts.length, before);
  const broken: PaymentGateway = {
    ...gw,
    text: {
      ...gw.text,
      pendingReleasedAlert: () => {
        throw new Error("bad text");
      },
    },
  };
  await afterPaymentReleased(quiet.deps, broken, payment, reservationId);
  assert.ok(quiet.logs.some((l) => l.message === "release_pending_alert_failed"));
  await afterPaymentReleased(quiet.deps, gw, payment, reservationId);
  assert.equal(quiet.alerts.length, before + 1);
});

/* ------------------------------ TTL and marks ------------------------------ */

const FULFIL_KEY = /^msv:(done:fulfil|paid:res|paid:session|step:fulfil):/;

/** Each marker fulfil wrote (set) with its TTL, keyed by its kind. */
function fulfilMarks(writes: KvWrite[], key: string, reservationId: string): Map<string, number | undefined> {
  const kinds = new Map<string, number | undefined>();
  for (const w of writes) {
    if (w.op !== "set" || !FULFIL_KEY.test(w.key)) continue;
    const kind = w.key.replace(key, "{key}").replace(reservationId, "{res}");
    kinds.set(kind, w.ttl);
  }
  return kinds;
}

/** A kit whose KV records every write, with one paid hold. */
async function recordedPaidHold() {
  const now = { ms: NOW };
  const kv = recordingKv(createMemoryKv(() => now.ms));
  const kit = makeKit({ kv, now });
  const res = await checkout(kit);
  const key = sessionIdOf(res.body);
  const reservationId = (res.body as CheckoutSuccess).holdReservationId as string;
  kit.fakeStripe.complete(key);
  return { kit, kv, key, reservationId };
}

test("doneTtlSeconds is the TTL of every marker fulfil writes (the Stripe gateway keeps DONE_TTL_SECONDS)", async () => {
  for (const [name, ttl, gwOf] of [
    ["acme", ACME_TTL, (kit: Kit) => acmeGateway(kit).gw],
    ["stripe", DONE_TTL_SECONDS, (kit: Kit) => stripeGateway(kit.deps)],
  ] as const) {
    const { kit, kv, key, reservationId } = await recordedPaidHold();
    const from = kv.writes.length;
    assert.equal((await fulfilPayment(key, kit.deps, gwOf(kit))).state, "confirmed", name);
    const marks = fulfilMarks(kv.writes.slice(from), key, reservationId);
    assert.deepEqual(
      [...marks.keys()].sort(),
      [
        "msv:done:fulfil:{key}",
        "msv:paid:res:{res}",
        "msv:paid:session:{key}",
        "msv:step:fulfil:{key}:fee",
        "msv:step:fulfil:{key}:paid-note",
        "msv:step:fulfil:{key}:payment",
        "msv:step:fulfil:{key}:payment-attempt",
      ],
      name,
    );
    for (const [kind, t] of marks) assert.equal(t, ttl, `${name} ${kind}`);

    // The needs_attention marker too (a paid hold that was cancelled meanwhile).
    const other = await recordedPaidHold();
    other.kit.fakeCb.reservations.get(other.reservationId)!.status = "canceled";
    const mark = other.kv.writes.length;
    assert.equal((await fulfilPayment(other.key, other.kit.deps, gwOf(other.kit))).state, "needs_attention", name);
    const attention = fulfilMarks(other.kv.writes.slice(mark), other.key, other.reservationId);
    assert.equal(attention.get("msv:done:fulfil:{key}"), ttl, name);
    for (const [kind, t] of attention) assert.equal(t, ttl, `${name} ${kind}`);
  }
});

test("markPaymentPaid: fulfil's first writes, in fulfil's order and with the gateway's TTL; idempotent (the first paid time is kept)", async () => {
  const now = { ms: NOW };
  const kv = recordingKv(createMemoryKv(() => now.ms));
  const kit = makeKit({ kv, now });
  const { gw, key, reservationId } = await held(kit);
  kit.fakeStripe.complete(key);
  const meta = (await gw.get(key)).meta!;
  const t0 = kit.now.ms;

  const from = kv.writes.length;
  await markPaymentPaid(kit.deps, gw, key, meta);
  const marked = kv.writes.slice(from).map((w) => ({ op: w.op, key: w.key, ttl: w.ttl, score: w.score }));
  const scope = keyScope(kit.config.paymentMode);
  assert.deepEqual(marked, [
    { op: "set", key: keys.reservationPaid(reservationId), ttl: ACME_TTL, score: undefined },
    { op: "set", key: keys.paidPending(key), ttl: ACME_TTL, score: undefined },
    { op: "zadd", key: keys.paidIndex(scope), ttl: undefined, score: t0 },
  ]);

  kit.now.ms += 60_000;
  await markPaymentPaid(kit.deps, gw, key, meta);
  assert.equal(await kit.deps.kv.get(keys.reservationPaid(reservationId)), key);
  const pending = await readJson<PaidPending>(kit.deps.kv, keys.paidPending(key));
  assert.equal(pending?.paidAt, t0, "the first paid time is kept");
  assert.equal(pending?.ref, meta.ref);
  assert.deepEqual(await kit.deps.kv.zrangeByScore(keys.paidIndex(scope), t0, t0, 10), [key]);
  assert.deepEqual(await kit.deps.kv.zrangeByScore(keys.paidIndex(scope), t0 + 1, Number.MAX_SAFE_INTEGER, 10), []);

  // fulfil makes the same writes first (right after its lock), then finishes and drops the paid-index entry.
  const fulfilFrom = kv.writes.length;
  assert.equal((await fulfilPayment(key, kit.deps, gw)).state, "confirmed");
  const fulfilWrites = kv.writes.slice(fulfilFrom);
  assert.equal(fulfilWrites[0].op, "setNx");
  assert.equal(fulfilWrites[0].key, keys.fulfilLock(key));
  assert.deepEqual(
    fulfilWrites.slice(1, 3).map((w) => ({ op: w.op, key: w.key, ttl: w.ttl })),
    [
      { op: "set", key: keys.reservationPaid(reservationId), ttl: ACME_TTL },
      { op: "zadd", key: keys.paidIndex(scope), ttl: undefined },
    ],
    "the record already exists: only the marker and the index entry are written again",
  );
  assert.deepEqual(await kit.deps.kv.zrangeByScore(keys.paidIndex(scope), 0, Number.MAX_SAFE_INTEGER, 10), []);
  assert.equal(testMoneyLabel(kit.deps), "TEST MODE - NOT REAL MONEY. ");
});

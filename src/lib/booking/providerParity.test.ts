// Provider parity (Beam design S4.10): the core money invariants, asserted once and in the same words for Stripe
// and for Beam (beamTestkit.ts forEachProvider). Each provider's kit is the real thing end to end on its in-repo
// fake: the checkout route's path (runCheckout), the guest paying or leaving on the provider's page, and the core's
// fulfil, release, abandon (runAbandon), status (runStatus) and sweep (runSweep) with that provider's gateway, the
// real Cloudbeds writer on the fake Cloudbeds, a memory Redis and the real alerter.
//
// For both providers: exactly one postPayment under 5 concurrent fulfils (also against a slow Cloudbeds, with the
// return page and the sweeper among the callers); a paid hold is never cancelled (its paid marker, a payment on its
// folio, a hold staff confirmed or checked in); a postPayment whose answer was lost is not posted again inside the
// 10-minute cool-down, and goes to the owner when the folio is unreadable; an expired payment releases its hold;
// abandon releases at once and closes the page (a paid one is confirmed instead); a crash after the hold closes the
// page and cancels the hold; the folio price check refuses Cloudbeds taxes and fees before any payment page; 'TEST
// MODE' never on live money and always on test money; live and test sharing one Redis (and one Cloudbeds) never touch
// each other's holds, alerts or heartbeats; the exact configured Cloudbeds method is sent; a refunded payment is
// never confirmed or cancelled automatically; a payment that succeeds after its hold was released raises one
// CRITICAL per booking (keyed by its payment); a finished booking's status answers the same fulfilment; a payment
// the provider can't read keeps its hold for that run; with both providers configured, the other provider hanging
// never keeps the active one's sweep from confirming and releasing.
//
// Stripe only: with both providers configured, the Stripe run of a sweep request equals a lone runSweep(deps),
// whatever Beam does (answers, throws, is slow, is skipped). Beam only: a checkout the circuit breaker refuses
// writes nothing; a payment whose reading fails in step 1 never has its hold released in that run (an orphan
// through RecentPayments.unread, a link without a record through sweepRecent throwing); a link Beam answers 404 for
// is released only once it is this merchant's and past its expiry plus the grace (another merchant's link keeps its
// hold, one CRITICAL); a late success also on a charge that stays PENDING past BEAM_LATE_WATCH_DAYS. That the
// abandon, sweep and Stripe webhook routes never load beam.ts is importGraph.test.ts's (no Stripe-only route was
// added since).
//
// Where the providers differ by nature, the kit says how each one gets there (ParityKit.refund, releaseUnpaid,
// payLate): Stripe's gateway never reports a refund, and a Checkout Session can't be paid once expired.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ALERT_WINDOW_SECONDS } from "./alerts.ts";
import { BEAM_CLOUDBEDS_METHOD, beamHeld, forEachProvider, makeBeamKit, makeParityKit } from "./beamTestkit.ts";
import type { BeamKit, ParityHeld, ParityKit, ParityProvider } from "./beamTestkit.ts";
import { createCloudbedsWriter } from "./cloudbedsWrite.ts";
import { DEFAULT_BEAM_LATE_WATCH_DAYS } from "./config.ts";
import { PAYMENT_DOUBT_COOLDOWN_MS, fulfilPayment, releaseHold } from "./fulfil.ts";
import { createMemoryKv } from "./kv.ts";
import type { KvStore } from "./kv.ts";
import { keyScope, keys } from "./lock.ts";
import { createFakeBeam } from "./mock/fakeBeam.ts";
import { FAKE_PAYMENT_METHODS } from "./mock/fakeCloudbeds.ts";
import type { FakeCloudbeds, FakeRoomType } from "./mock/fakeCloudbeds.ts";
import { BEAM_PAUSED_MESSAGE } from "./payments/beamCheckoutAdapter.ts";
import { beamGateway } from "./payments/beamGateway.ts";
import type { BeamGateway, BeamGatewayDeps } from "./payments/beamGateway.ts";
import { stripeGateway } from "./payments/stripeGateway.ts";
import { satangToBaht } from "./quote.ts";
import { runStatus } from "./status.ts";
import type { StatusResult } from "./status.ts";
import type { CoreDeps, StripeDeps } from "./stripeDeps.ts";
import { STALE_HOLD_MS, runSweep, sweepRecentPayments } from "./sweep.ts";
import type { SweepSummary } from "./sweep.ts";
import { SWEEP_HOLD_SIDE_RESERVE_MS, SWEEP_MIN_SLICE_MS, sweepProviders } from "./sweepProviders.ts";
import type { SweepProvidersAnswer, SweepRun, SweepRunReport } from "./sweepProviders.ts";
import { HONEYMOON, NOW, ROOM_TYPES, recordingKv, refCharSequence } from "./testkit.ts";
import type { KvWrite } from "./testkit.ts";
import type { CartItemInput, StatusResponse } from "./types.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Past every payment page's life: Stripe's Checkout Session expires 31 minutes after checkout, Beam's link after 30. */
const PAST_PAGE_MS = 32 * MIN;
/** Past the alerter's own repeat window: only our set-once markers keep a repeat out. */
const PAST_ALERT_WINDOW_MS = ALERT_WINDOW_SECONDS * 1000 + MIN;
const GARDEN: CartItemInput[] = [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
const SUNRISE: CartItemInput[] = [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
/** Every room with a few units: two kits on one property hold the same rooms. */
const ROOMS: Record<string, FakeRoomType> = Object.fromEntries(Object.entries(ROOM_TYPES).map(([id, r]) => [id, { ...r, units: 4 }]));
const CLOUDBEDS_WRITES = ["postReservation", "postReservationNote", "putReservation", "postPayment", "postCustomItem"];
const TEST_LABEL = "TEST MODE - NOT REAL MONEY. ";

const res = (kit: ParityKit, id: string) => {
  const r = kit.fakeCb.reservations.get(id);
  assert.ok(r, `no reservation ${id}`);
  return r;
};
const cbCalls = (kit: ParityKit, method: string) => kit.fakeCb.calls.filter((c) => c.method === method);
/** putReservation calls that cancelled this reservation. */
const cancels = (kit: ParityKit, id: string) => cbCalls(kit, "putReservation").filter((c) => c.params.reservationID === id && c.params.status === "canceled").length;
const critical = (kit: ParityKit) => kit.alerts.filter((a) => a.severity === "critical");
const withSubject = (kit: ParityKit, subject: string) => kit.alerts.filter((a) => a.subject === subject);
const logged = (kit: ParityKit, message: string) => kit.logs.filter((l) => l.message === message);
const answer = (r: StatusResult): StatusResponse => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as StatusResponse;
};
const nameOf = (provider: ParityProvider) => (provider === "stripe" ? "Stripe" : "Beam");

/** The kit's deps with every Cloudbeds call taking `ms` (the callers then really overlap inside fulfil). */
function slowCloudbeds(kit: ParityKit, ms: number): CoreDeps {
  const slow = (async (input: string | URL | Request, init?: RequestInit) => {
    await new Promise((r) => setTimeout(r, ms));
    return kit.fakeCb.fetch(input, init);
  }) as typeof fetch;
  const mode = kit.deps.writer.mode === "live" ? "live" : "mock";
  return { ...kit.deps, writer: createCloudbedsWriter({ apiKey: "cbat_write_testkit", propertyId: "235064", mode, fetchImpl: slow, budget: null, log: () => undefined }) };
}

/** The "needs attention" reason of a paid booking whose hold is cancelled, with the gateway's refund words for its payment. */
async function lateReason(kit: ParityKit, h: ParityHeld): Promise<string> {
  const { receipt } = await kit.gw.get(h.key);
  const refund = kit.gw.text.refundHow?.(receipt) ?? kit.gw.text.refundWhere;
  return `The guest PAID but the Cloudbeds hold is CANCELLED. Re-instate or re-book the guest in Cloudbeds (if the unit is still free) or refund ${refund}.`;
}

forEachProvider(["stripe", "beam"], ({ provider, kit: make }) => {
  const P = nameOf(provider);

  test(`${P}: 5 concurrent fulfils of a paid booking post exactly one payment and one fee line, also on a slow Cloudbeds beside the return page and the sweeper`, async () => {
    const kit = make();
    const h = await kit.held();
    kit.pay(h);
    const results = await Promise.all(Array.from({ length: 5 }, () => kit.fulfil(h)));
    assert.deepEqual(results.map((r) => r.state).sort(), ["confirmed", "in_progress", "in_progress", "in_progress", "in_progress"]);
    assert.equal(cbCalls(kit, "postPayment").length, 1);
    assert.equal(cbCalls(kit, "postCustomItem").length, 1);
    assert.equal(res(kit, h.reservationId).status, "confirmed");
    assert.equal(kit.fakeCb.balance(h.reservationId), 0);
    // Every later caller reads the done marker.
    assert.deepEqual(await kit.fulfil(h), { state: "confirmed", reservationId: h.reservationId, ref: h.ref, totalSatang: h.quote.totalSatang, alreadyDone: true });
    assert.equal(cbCalls(kit, "postPayment").length, 1);

    // Five fulfils, the return page and a sweeper run at once, every Cloudbeds call taking 5 ms.
    const k2 = make();
    const g = await k2.held(GARDEN);
    k2.pay(g);
    const slow = slowCloudbeds(k2, 5);
    const gw = k2.gw;
    const all = await Promise.all([
      ...Array.from({ length: 5 }, () => fulfilPayment(g.key, slow, gw)),
      runStatus(
        { t: g.t, p: null, l: g.l, ...(provider === "stripe" ? { s: g.paymentId } : {}) },
        { config: k2.config, providerDeps: (p) => (p === provider ? { deps: slow, gw } : null), nowMs: k2.now.ms },
      ),
      runSweep(slow, gw),
    ]);
    assert.equal(all.slice(0, 5).filter((r) => "state" in r && r.state === "confirmed").length <= 1, true);
    assert.equal(cbCalls(k2, "postPayment").length, 1);
    assert.equal(cbCalls(k2, "postCustomItem").length, 1);
    assert.equal((await k2.fulfil(g)).state, "confirmed");
    assert.equal(cbCalls(k2, "postPayment").length, 1);
    assert.equal(res(k2, g.reservationId).payments.length, 1);
    assert.equal(k2.fakeCb.balance(g.reservationId), 0);
  });

  test(`${P}: a paid hold is never cancelled - not with its paid marker, a payment on its folio, or confirmed (or checked in) by staff`, async () => {
    // 1. Paid; confirming failed after the paid marker was written (Cloudbeds down). Every release refuses it.
    const kit = make();
    const h = await kit.held();
    kit.pay(h);
    kit.fakeCb.failNext("postReservationNote", "http500");
    kit.fakeCb.failNext("getReservation", "http500");
    await assert.rejects(kit.fulfil(h));
    assert.equal(await kit.deps.kv.get(keys.reservationPaid(h.reservationId)), h.key);
    assert.deepEqual(await releaseHold(h.reservationId, kit.deps, "parity"), { state: "refused_paid", reservationId: h.reservationId });
    assert.deepEqual(await kit.release(h), { state: "refused_paid", reservationId: h.reservationId });
    // Stale and past its page's life: the sweeper confirms it.
    kit.now.ms += STALE_HOLD_MS + MIN;
    const s = await kit.sweep();
    assert.equal(s.released, 0);
    assert.equal(res(kit, h.reservationId).status, "confirmed");
    assert.equal(cancels(kit, h.reservationId), 0);
    assert.deepEqual((await kit.abandon(h)).body, { ok: true, state: "paid" });
    assert.equal(cancels(kit, h.reservationId), 0);
    assert.equal(res(kit, h.reservationId).payments.length, 1);

    // 2. The front desk took a payment on the folio; the page expires: nothing releases the hold.
    const k2 = make();
    const g = await k2.held();
    await k2.deps.writer.recordPayment({ reservationId: g.reservationId, amountSatang: 10_000, method: "cash", description: "front desk" });
    k2.now.ms += PAST_PAGE_MS;
    assert.equal((await k2.sweep()).released, 0);
    assert.deepEqual(await k2.release(g), { state: "refused_paid", reservationId: g.reservationId });
    assert.deepEqual((await k2.abandon(g)).body, { ok: true, state: "closed" });
    k2.now.ms += STALE_HOLD_MS;
    assert.equal((await k2.sweep()).released, 0);
    assert.equal(res(k2, g.reservationId).status, "not_confirmed");
    assert.equal(cancels(k2, g.reservationId), 0);
    assert.equal(withSubject(k2, `Hold ${g.reservationId} was not cancelled: the folio shows a payment`).length, 1);
    assert.notEqual(await k2.deps.kv.get(keys.alerted(k2.scope, `release-paid:${g.reservationId}`)), null);

    // 3. Staff confirmed the unpaid hold by hand; the page expires: never cancelled, the owner is told. Checked in: never either.
    const k3 = make();
    const c = await k3.held();
    res(k3, c.reservationId).status = "confirmed";
    k3.now.ms += STALE_HOLD_MS + MIN;
    assert.equal((await k3.sweep()).released, 0);
    assert.equal(res(k3, c.reservationId).status, "confirmed");
    assert.equal(cancels(k3, c.reservationId), 0);
    assert.equal(withSubject(k3, `Hold ${c.reservationId} is confirmed but unpaid`).length, 1);
    (res(k3, c.reservationId) as { status: string }).status = "checked_in";
    assert.deepEqual(await releaseHold(c.reservationId, k3.deps, "parity"), { state: "refused_confirmed", reservationId: c.reservationId });
    assert.equal(cancels(k3, c.reservationId), 0);
  });

  test(`${P}: a postPayment whose answer was lost is not posted again inside the 10-minute cool-down; an unreadable folio then goes to the owner`, async () => {
    // Never reached Cloudbeds (we can't tell): no second post for 10 minutes, then exactly one more.
    const kit = make();
    const h = await kit.held();
    kit.pay(h);
    kit.fakeCb.failNext("postPayment", "network");
    await assert.rejects(kit.fulfil(h));
    for (const wait of [3_000, MIN, PAYMENT_DOUBT_COOLDOWN_MS - MIN - 3_000 - 1]) {
      kit.now.ms += wait;
      assert.equal((await kit.fulfil(h)).state, "in_progress");
      assert.equal(cbCalls(kit, "postPayment").length, 1);
    }
    kit.now.ms += 1;
    assert.equal((await kit.fulfil(h)).state, "confirmed");
    assert.equal(cbCalls(kit, "postPayment").length, 2);
    assert.equal(res(kit, h.reservationId).payments.length, 1);
    assert.equal(logged(kit, "fulfil_payment_reposted").length, 1);

    // Landed after our timeout: the retry waits, the folio then shows it, nothing is posted twice.
    const k2 = make();
    const g = await k2.held();
    k2.pay(g);
    k2.fakeCb.failNext("postPayment", "network_late");
    await assert.rejects(k2.fulfil(g));
    k2.now.ms += 3_000;
    assert.equal((await k2.fulfil(g)).state, "in_progress");
    assert.equal(await k2.fakeCb.commitLate(), 1);
    k2.now.ms += PAYMENT_DOUBT_COOLDOWN_MS;
    assert.equal((await k2.fulfil(g)).state, "confirmed");
    assert.equal(cbCalls(k2, "postPayment").length, 1);
    assert.equal(res(k2, g.reservationId).payments.length, 1);
    assert.equal(k2.fakeCb.balance(g.reservationId), 0);

    // Landed, its answer lost, and the folio's paid amount can't be read: the owner settles it (CRITICAL, keyed by the payment).
    const k3 = make();
    const c = await k3.held();
    k3.pay(c);
    k3.fakeCb.failNext("postPayment", "network_after");
    await assert.rejects(k3.fulfil(c));
    k3.fakeCb.setOpaqueFolio(true);
    k3.now.ms += PAYMENT_DOUBT_COOLDOWN_MS + MIN;
    assert.equal((await k3.fulfil(c)).state, "needs_attention");
    assert.equal(res(k3, c.reservationId).payments.length, 1, "no second payment");
    const urgent = critical(k3);
    assert.equal(urgent.length, 1);
    assert.equal(urgent[0].subject, `URGENT: paid booking ${c.ref} needs attention`);
    assert.match(urgent[0].lines[0], /^PAYMENT RECORD IN DOUBT: recording the (Stripe|Beam) payment in Cloudbeds got no clear answer/);
    assert.ok(urgent[0].lines[0].includes(`recording the ${k3.brand} payment`));
    assert.notEqual(await k3.deps.kv.get(keys.alerted(k3.scope, `attention:${c.key}`)), null);
  });

  test(`${P}: an expired payment releases its hold - by the sweeper, once, with the provider's note; nobody is alerted`, async () => {
    const kit = make();
    const h = await kit.held();
    kit.now.ms += PAST_PAGE_MS;
    assert.equal(kit.pageOpen(h), false);
    const s = await kit.sweep();
    assert.deepEqual([s.released, s.errors], [1, 0]);
    assert.equal(res(kit, h.reservationId).status, "canceled");
    assert.equal(cancels(kit, h.reservationId), 1);
    assert.equal(await kit.deps.kv.get(keys.releaseDone(h.reservationId)), `sweeper: ${kit.gw.text.sessionLabel.short} expired`);
    assert.equal(res(kit, h.reservationId).notes.at(-1), kit.gw.text.releaseNoteText([{ state: "expired", attempted: false }]));
    // Later runs and the return page change nothing.
    kit.now.ms += STALE_HOLD_MS;
    assert.equal((await kit.sweep()).released, 0);
    const r = answer(await kit.status(h));
    assert.deepEqual([r.status, r.fulfilment], ["expired", { state: "released", reservationId: null }]);
    assert.equal(cancels(kit, h.reservationId), 1);
    assert.deepEqual(kit.alerts.filter((a) => a.severity !== "info"), []);
  });

  test(`${P}: the guest's Cancel releases the hold at once and closes the payment page for good; a paid one is confirmed instead`, async () => {
    const kit = make();
    const h = await kit.held();
    assert.deepEqual(await kit.abandon(h), { status: 200, body: { ok: true, state: "released" } });
    assert.equal(kit.pageOpen(h), false);
    assert.throws(() => kit.pay(h), "the page can never be paid afterwards");
    assert.equal(res(kit, h.reservationId).status, "canceled");
    assert.equal(cancels(kit, h.reservationId), 1);
    assert.equal(await kit.deps.kv.get(keys.abandoned(h.key)), "1");
    const r = answer(await kit.status(h));
    assert.deepEqual([r.status, r.fulfilment], ["cancelled", { state: "released", reservationId: null }]);

    // Paid in another tab before the Cancel: confirmed, never cancelled.
    const g = await kit.held(GARDEN);
    kit.pay(g);
    assert.deepEqual(await kit.abandon(g), { status: 200, body: { ok: true, state: "paid" } });
    assert.equal(res(kit, g.reservationId).status, "confirmed");
    assert.equal(cancels(kit, g.reservationId), 0);
    assert.equal(res(kit, g.reservationId).payments.length, 1);
  });

  test(`${P}: a crash after the hold closes the payment page and cancels the hold; nothing can be paid`, async () => {
    const kit = make();
    const log = kit.deps.log;
    kit.deps.log = (message, data) => {
      log(message, data);
      if (message === `${provider}_session_created`) throw new Error("simulated crash after the page");
    };
    const out = await kit.checkout();
    assert.equal(out.status, 500);
    assert.equal(out.body.ok ? "" : out.body.error, "server_error");
    assert.equal(kit.pagesCreated(), 1);
    const crashed = logged(kit, "checkout_crashed_after_hold");
    assert.equal(crashed.length, 1);
    const paymentId = kit.gw.idOf(String(crashed[0].data?.sessionId));
    assert.equal(kit.pageOpen({ paymentId }), false);
    assert.throws(() => kit.pay({ paymentId }));
    const [hold, ...more] = [...kit.fakeCb.reservations.values()];
    assert.deepEqual(more, []);
    assert.equal(hold.status, "canceled");
    const alert = withSubject(kit, "Booking stopped: unexpected error after the hold");
    assert.equal(alert.length, 1);
    assert.ok(
      alert[0].lines.some((l) => new RegExp(`^The ${kit.brand} payment page ${paymentId} was (expired|disabled), the hold was cancelled and nothing was charged\\.$`).test(l)),
      alert[0].lines.join("\n"),
    );
    assert.equal(cbCalls(kit, "postPayment").length, 0);
  });

  test(`${P}: the folio price check refuses a hold that carries Cloudbeds taxes or fees - cancelled before any payment page`, async () => {
    for (const cb of [{ sourceFeePct: { default: 5 } }, { sourceFeePct: { default: 5 }, feeOnlyOnFolio: true }]) {
      const label = cb.feeOnlyOnFolio ? "the fee only on the folio" : "the fee on the hold";
      const kit = make({ cb });
      const out = await kit.checkout();
      assert.equal(out.status, 503, label);
      assert.equal(out.body.ok ? "" : out.body.error, "payment_unavailable", label);
      assert.match(out.body.ok ? "" : out.body.message, /Nothing has been charged\. Message us on WhatsApp/, label);
      const [hold, ...more] = [...kit.fakeCb.reservations.values()];
      assert.deepEqual(more, [], label);
      assert.deepEqual([hold.status, hold.taxesFees], ["canceled", 1350], label);
      assert.equal(kit.pagesCreated(), 0, `${label}: no payment page`);
      assert.equal(cbCalls(kit, "postCustomItem").length + cbCalls(kit, "postPayment").length, 0, label);
      const blocked = withSubject(kit, "Online bookings blocked: Cloudbeds adds taxes/fees to online holds");
      assert.equal(blocked.length, 1, label);
      assert.match(blocked[0].lines.join(" "), /THB 1350\.00 of taxes\/fees \(5\.00% of the rooms\)/, label);
    }
  });

  test(`${P}: 'TEST MODE' is never written on live money and always on test money`, async () => {
    for (const live of [true, false]) {
      const kit = make({ live });
      const h = await kit.held();
      kit.pay(h);
      assert.equal((await kit.fulfil(h)).state, "confirmed", `live ${live}`);
      const r = res(kit, h.reservationId);
      const identifier = cbCalls(kit, "postReservation")[0].params.thirdPartyIdentifier;
      const fee = cbCalls(kit, "postCustomItem")[0].params;
      const paidNote = r.notes.find((n) => n.includes("PAID via"));
      assert.ok(paidNote, r.notes.join("\n"));
      if (live) {
        assert.doesNotMatch(JSON.stringify(kit.fakeCb.calls.filter((c) => CLOUDBEDS_WRITES.includes(c.method))), /TEST/);
        assert.doesNotMatch(JSON.stringify([r.notes, r.payments, r.items, r.thirdPartyIdentifier]), /TEST/);
        assert.equal(identifier, provider === "stripe" ? h.ref : `${h.ref}-B`);
      } else {
        for (const text of [r.notes[0], paidNote, r.payments[0].description, fee["items[0][itemNote]"]]) assert.ok(text.startsWith(TEST_LABEL), text);
        assert.match(fee["items[0][itemName]"], /^TEST - /);
        assert.match(identifier, /-TEST$/);
      }
    }
  });

  test(`${P}: live and test on one Redis and one Cloudbeds never touch each other's holds, alerts or heartbeats`, async () => {
    const now = { ms: NOW };
    const kv = createMemoryKv(() => now.ms);
    const live = make({ live: true, kv, now, cb: { roomTypes: ROOMS } });
    const stage = make({ kv, now, fakeCb: live.fakeCb });
    assert.notEqual(live.scope, stage.scope);
    const l = await live.held();
    const t = await stage.held(GARDEN);
    // A live CRITICAL the mail relay did not take, and a test alert under a key the live deployment uses too.
    live.mail.ok = false;
    await live.deps.alert("URGENT: parity live alert", ["Raised while the mail relay was down."], { key: "parity-live", severity: "critical" });
    live.mail.ok = true;
    await stage.deps.alert("Parity shared key", ["test"], { key: "parity-shared", severity: "warning" });
    await live.deps.alert("Parity shared key", ["live"], { key: "parity-shared", severity: "warning" });
    assert.equal(withSubject(live, "Parity shared key").length, 1, "a test claim never suppresses the live alert");
    const pendingLive = () => kv.zrangeByScore(keys.pendingAlertIndex(live.scope), 0, Number.MAX_SAFE_INTEGER, 10);
    assert.equal((await pendingLive()).length, 1);

    // Both pages expired, both holds stale: the test sweeper releases its own hold only, re-sends nothing of live's.
    now.ms += STALE_HOLD_MS + MIN;
    const ts = await stage.sweep();
    assert.equal(ts.released, 1);
    assert.equal(res(stage, t.reservationId).status, "canceled");
    assert.equal(res(live, l.reservationId).status, "not_confirmed", "the live hold is untouched by the test sweeper");
    assert.ok(ts.skippedOtherMode >= 1);
    // Not even read: the test gateway is never asked about the live payment (its record names the live mode).
    assert.deepEqual([ts.errors, logged(stage, "sweep_hold_error").length], [0, 0]);
    assert.equal(ts.undeliveredAlerts, 0);
    assert.equal((await pendingLive()).length, 1, "the live CRITICAL is neither re-sent nor cleared");
    assert.equal(withSubject(stage, "URGENT: parity live alert").length, 0);
    assert.equal(await kv.get(keys.lastSweep(live.scope)), null, "a test run is no live sweep");
    assert.equal(await kv.get(keys.lastSweep(stage.scope)), String(now.ms));

    // The live sweeper releases its own hold and re-sends its own CRITICAL.
    const ls = await live.sweep();
    assert.deepEqual([ls.released, ls.errors], [1, 0]);
    assert.equal(res(live, l.reservationId).status, "canceled");
    assert.equal(ls.undeliveredAlerts, 1);
    assert.equal(withSubject(live, "URGENT: parity live alert").length, 1);
    assert.equal((await pendingLive()).length, 0);
    assert.equal(await kv.get(keys.lastSweep(live.scope)), String(now.ms));
    assert.equal(cancels(live, l.reservationId) + cancels(stage, t.reservationId), 2, "each hold cancelled once");
  });

  test(`${P}: the exact configured Cloudbeds payment method is sent - its TEST variable outside live, never in live`, async () => {
    const LIVE_METHOD = "MSV.WebPay_v2(Online)";
    const TEST_METHOD = "MSV-WebPay_TEST";
    const paymentMethods = [...FAKE_PAYMENT_METHODS, ...[LIVE_METHOD, TEST_METHOD].map((m) => ({ method: m, code: m, name: m }))];
    const { methodEnvVar, testMethodEnvVar } = make().gw.text;
    assert.deepEqual([methodEnvVar, testMethodEnvVar], [`CLOUDBEDS_${P.toUpperCase()}_PAYMENT_METHOD`, `CLOUDBEDS_${P.toUpperCase()}_TEST_PAYMENT_METHOD`]);
    const both = { [methodEnvVar]: LIVE_METHOD, [testMethodEnvVar]: TEST_METHOD };
    for (const [label, live, env, want] of [
      ["test mode, the method variable alone", false, { [methodEnvVar]: LIVE_METHOD }, LIVE_METHOD],
      ["test mode with the TEST variable", false, both, TEST_METHOD],
      ["live mode ignores the TEST variable", true, both, LIVE_METHOD],
    ] as const) {
      const kit = make({ live, env, cb: { paymentMethods } });
      assert.equal(kit.config.cloudbedsPaymentMethod, want, label);
      const h = await kit.held();
      kit.pay(h);
      assert.equal((await kit.fulfil(h)).state, "confirmed", label);
      assert.deepEqual(cbCalls(kit, "postPayment").map((c) => c.params.type), [want], label);
      assert.deepEqual(res(kit, h.reservationId).payments.map((p) => p.type), [want], label);
    }
  });

  test(`${P}: a refunded payment is never confirmed or cancelled automatically - one CRITICAL, the hold left for a person`, async () => {
    const kit = make();
    const h = await kit.held();
    kit.pay(h);
    kit.refund(h);
    assert.equal((await kit.gw.get(h.key)).state, "refunded");
    const out = await kit.fulfil(h);
    assert.equal(out.state, "needs_attention");
    assert.ok("reason" in out && out.reason.startsWith(`REFUNDED at ${kit.brand} before the booking was confirmed: the guest's payment was refunded in ${kit.brand}.`), JSON.stringify(out));
    assert.notEqual(await kit.deps.kv.get(keys.alerted(kit.scope, `attention:${h.key}`)), null, `keyed attention:${h.key}`);
    assert.deepEqual(await kit.release(h), { state: "refused_paid", reservationId: h.reservationId });
    // What the guest is told is the return page's (design S5.3): Beam answers from the needs_attention done marker
    // (the attention view), Stripe never reports a refund. Here only that nothing is cancelled or confirmed.
    assert.equal((await kit.abandon(h)).status, 200);
    // Stale, then past the alert window: the sweeper hands it to fulfil, which answers from its done marker.
    for (const wait of [STALE_HOLD_MS + MIN, PAST_ALERT_WINDOW_MS]) {
      kit.now.ms += wait;
      assert.equal((await kit.sweep()).released, 0);
    }
    assert.equal(res(kit, h.reservationId).status, "not_confirmed");
    assert.equal(cancels(kit, h.reservationId), 0);
    assert.equal(cbCalls(kit, "postPayment").length, 0);
    const urgent = critical(kit);
    assert.equal(urgent.length, 1);
    assert.equal(urgent[0].subject, `URGENT: paid booking ${h.ref} needs attention`);
  });

  test(`${P}: a payment that succeeds after its hold was released raises one CRITICAL per booking, keyed by its payment; nothing is re-booked or refunded automatically`, async () => {
    const kit = make();
    const a = await kit.held();
    const b = await kit.held(GARDEN);
    await kit.releaseUnpaid([a, b]);
    for (const h of [a, b]) assert.equal(res(kit, h.reservationId).status, "canceled");
    assert.equal(critical(kit).length, 0);
    kit.payLate(a);
    kit.payLate(b);
    await kit.sweep();
    const urgent = critical(kit);
    assert.deepEqual(urgent.map((u) => u.subject).sort(), [a, b].map((h) => `URGENT: paid booking ${h.ref} needs attention`).sort());
    for (const h of [a, b]) {
      const alert = urgent.find((u) => u.subject.includes(h.ref));
      assert.equal(alert?.lines[0], await lateReason(kit, h));
      assert.notEqual(await kit.deps.kv.get(keys.alerted(kit.scope, `attention:${h.key}`)), null, `keyed attention:${h.key}`);
      assert.equal(res(kit, h.reservationId).status, "canceled", "never re-instated automatically");
    }
    assert.equal(cbCalls(kit, "postPayment").length, 0);
    assert.deepEqual(kit.providerCallLog().filter((c) => /refund/i.test((c as { path: string }).path)), [], "nothing is refunded automatically");
    // Later runs never raise them again.
    kit.now.ms += PAST_ALERT_WINDOW_MS;
    await kit.sweep();
    assert.equal(critical(kit).length, 2);
  });

  test(`${P}: a finished booking's status answers its fulfilment - paid, confirmed or needs attention; the GA4 purchase only live`, async () => {
    for (const live of [false, true]) {
      const kit = make({ live });
      const h = await kit.held();
      kit.pay(h);
      assert.equal((await kit.fulfil(h)).state, "confirmed");
      const calls = kit.providerCalls();
      const r = answer(await kit.status(h));
      assert.deepEqual(
        [r.ref, r.status, r.fulfilment, r.purchase],
        [h.ref, "paid", { state: "confirmed", reservationId: h.reservationId }, live ? { transactionId: h.reservationId, valueBaht: satangToBaht(h.quote.dueNowSatang), currency: "THB" } : null],
        `live ${live}`,
      );
      // Beam answers from the done marker without a Beam call; Stripe reads the session again, as it always did.
      assert.equal(kit.providerCalls() - calls, provider === "beam" ? 0 : 1);
      assert.equal(cbCalls(kit, "postPayment").length, 1);
    }
    // A booking handed to the owner: paid, needs attention.
    const kit = make();
    const h = await kit.held(SUNRISE);
    await kit.releaseUnpaid([h]);
    kit.payLate(h);
    assert.equal((await kit.fulfil(h)).state, "needs_attention");
    const r = answer(await kit.status(h));
    assert.deepEqual([r.status, r.fulfilment, r.purchase], ["paid", { state: "needs_attention", reservationId: h.reservationId }, null]);
  });

  test(`${P}: a payment the provider can't read keeps its hold for that sweep; the next readable run settles it`, async () => {
    const kit = make();
    const h = await kit.held(HONEYMOON);
    kit.failAttempt(h);
    // Past the page's life (Beam: the link expired) and stale.
    kit.now.ms += STALE_HOLD_MS + MIN;
    kit.unreadable(h);
    for (let run = 0; run < 2; run++) {
      const s = await kit.sweep();
      assert.equal(s.released, 0, `run ${run}`);
      assert.ok(s.errors >= 1, `run ${run}`);
      assert.equal(res(kit, h.reservationId).status, "not_confirmed", `run ${run}: its state is unknown, so its hold stays`);
      kit.now.ms += 10 * MIN;
    }
    kit.unreadable(h, false);
    const s = await kit.sweep();
    assert.deepEqual([s.released, s.errors], [1, 0]);
    assert.equal(res(kit, h.reservationId).status, "canceled");
    assert.equal(cancels(kit, h.reservationId), 1);
    const seen = await kit.gw.get(h.key);
    assert.equal(seen.attempted, true);
    assert.equal(res(kit, h.reservationId).notes.at(-1), kit.gw.text.releaseNoteText([seen]), "the note says a payment was attempted");
  });
});

/* --------------------------------------- both providers configured (S4.8) --------------------------------------- */

/** The sweep route's budget (maxDuration 60 s minus a margin). */
const BUDGET_MS = 55_000;
/** The Stripe holds' stay when both providers hold rooms (our own open-holds brake refuses a second hold on the same rooms and nights). */
const STRIPE_STAY = { checkIn: "2027-11-20", checkOut: "2027-11-23" };

/** A Stripe and a Beam parity kit on one fake Cloudbeds and one Redis, each writing through its own recording view of it. */
interface Both {
  /** The business clock of both kits. */
  now: { ms: number };
  /** The deadline's clock (SweepTiming.clock): moved only by a slow or hanging provider. */
  wall: { ms: number };
  stripe: ParityKit;
  stripeKv: KvStore & { writes: KvWrite[] };
  beam: ParityKit;
  /** Indexes of the shared fake Cloudbeds' calls made through the Beam kit. */
  beamCalls: Set<number>;
  /** How the providers' APIs answer right now. */
  api: {
    /** Every Beam call takes 6 s of the wall clock and times out. */
    beamSlow: boolean;
    /** Beam's charge scan (the unfiltered charge list) answers 503. */
    beamScanFails: boolean;
    /** Stripe's Checkout Session list takes this long (wall clock). */
    stripeListMs: number;
    /** Stripe's Checkout Session list hangs until this wall time (as stripeWithin cuts it) and fails. */
    stripeListHangsUntil: number | null;
  };
  sweeperLogs: { message: string; data?: Record<string, unknown> }[];
}

function both(): Both {
  const now = { ms: NOW };
  const wall = { ms: 1_000_000 };
  const inner = createMemoryKv(() => now.ms);
  const stripeKv = recordingKv(inner);
  const api: Both["api"] = { beamSlow: false, beamScanFails: false, stripeListMs: 0, stripeListHangsUntil: null };
  const urlOf = (input: string | URL | Request) => new URL(String(input instanceof Request ? input.url : input));
  const stripe = makeParityKit("stripe", {
    kv: stripeKv,
    now,
    pickRefChar: refCharSequence(),
    cb: { roomTypes: ROOMS, paymentMethods: [...FAKE_PAYMENT_METHODS, { method: BEAM_CLOUDBEDS_METHOD, code: BEAM_CLOUDBEDS_METHOD, name: "Beam (website)" }] },
    providerFetch: (fake) =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET" && urlOf(input).pathname === "/v1/checkout/sessions") {
          if (api.stripeListHangsUntil !== null) {
            wall.ms = api.stripeListHangsUntil;
            throw new TypeError("fetch failed: the request timed out");
          }
          wall.ms += api.stripeListMs;
        }
        return fake(input, init);
      }) as typeof fetch,
  });
  const cb = stripe.fakeCb;
  const beamCalls = new Set<number>();
  const tagged: FakeCloudbeds = {
    ...cb,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const from = cb.calls.length;
      try {
        return await cb.fetch(input, init);
      } finally {
        for (let i = from; i < cb.calls.length; i++) beamCalls.add(i);
      }
    }) as typeof fetch,
  };
  let i = 0;
  const beam = makeParityKit("beam", {
    kv: recordingKv(inner),
    now,
    fakeCb: tagged,
    pickRefChar: (max) => (i++ * 11 + 5) % max,
    providerFetch: (fake) =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        if (api.beamSlow) {
          wall.ms += 6_000;
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }
        const url = urlOf(input);
        if (api.beamScanFails && url.pathname === "/api/v1/charges" && !url.searchParams.has("sourceId")) {
          return new Response(JSON.stringify({ code: 503, message: "simulated", error: { errorCode: "INTERNAL_SERVER_ERROR", errorMessage: "simulated" } }), { status: 503 });
        }
        return fake(input, init);
      }) as typeof fetch,
  });
  return { now, wall, stripe, stripeKv, beam, beamCalls, api, sweeperLogs: [] };
}

/** The sweep route's runs for both kits (runtime.ts getFulfilmentProviderDeps' shape): every Beam phase bounded by its timing. */
function runsOf(w: Both, primary: ParityProvider | null): SweepRun[] {
  return [
    { provider: "stripe", primary: primary === "stripe", open: () => ({ deps: w.stripe.deps, gw: stripeGateway(w.stripe.deps as StripeDeps) }) },
    {
      provider: "beam",
      primary: primary === "beam",
      open: (timing) => {
        const deps: BeamGatewayDeps = { ...(w.beam.deps as BeamGatewayDeps), ...timing };
        return { deps, gw: beamGateway(deps) };
      },
    },
  ];
}

/** One sweeper request for both providers, `primary` the active one. */
function sweepBoth(w: Both, primary: ParityProvider | null): Promise<SweepProvidersAnswer> {
  return sweepProviders(runsOf(w, primary), { deadlineMs: w.wall.ms + BUDGET_MS, clock: () => w.wall.ms, log: (message, data) => w.sweeperLogs.push({ message, data }) });
}

const runOf = (a: SweepProvidersAnswer, provider: ParityProvider) => {
  const r = a.body.runs.find((x) => x.provider === provider);
  assert.ok(r, `no ${provider} run`);
  return r;
};

/** Each provider: a paid booking whose webhook was lost and a hold whose page expired, all stale (a second apart: one listing order). */
async function scenario(w: Both) {
  const stripePaid = await w.stripe.held(HONEYMOON, STRIPE_STAY);
  w.stripe.pay(stripePaid);
  w.now.ms += 1000;
  const stripeExpired = await w.stripe.held(GARDEN, STRIPE_STAY);
  w.now.ms += 1000;
  const beamPaid = await w.beam.held();
  w.beam.pay(beamPaid);
  w.now.ms += 1000;
  const beamExpired = await w.beam.held(GARDEN);
  w.now.ms += STALE_HOLD_MS + MIN;
  return { stripe: { paid: stripePaid, expired: stripeExpired }, beam: { paid: beamPaid, expired: beamExpired } };
}

forEachProvider(["stripe", "beam"], ({ provider }) => {
  const P = nameOf(provider);
  const other: ParityProvider = provider === "stripe" ? "beam" : "stripe";
  test(`${P} active, the ${nameOf(other)} drain's API hanging: ${P}'s sweep still confirms its paid booking and releases its expired hold in the same request`, async () => {
    const w = both();
    const held = await scenario(w);
    const start = w.wall.ms;
    if (other === "beam") w.api.beamSlow = true;
    // The bounded Stripe client gives a drain's request what is left of the step-1 slice and no retry: it fails at the slice's end.
    else w.api.stripeListHangsUntil = start + BUDGET_MS - SWEEP_HOLD_SIDE_RESERVE_MS;
    const answer = await sweepBoth(w, provider);
    assert.equal(answer.status, 502);
    assert.equal(answer.body.mode, (provider === "stripe" ? w.stripe : w.beam).config.paymentMode);
    const mine = runOf(answer, provider);
    assert.deepEqual([mine.ok, mine.fulfilled, mine.released, mine.errors], [true, 1, 1, 0]);
    const kit = provider === "stripe" ? w.stripe : w.beam;
    assert.equal(res(kit, held[provider].paid.reservationId).status, "confirmed");
    assert.equal(res(kit, held[provider].expired.reservationId).status, "canceled");
    assert.equal(await kit.deps.kv.get(keys.lastSweep(kit.scope)), String(w.now.ms), `${P}'s heartbeat`);
    const theirs = runOf(answer, other);
    assert.equal(theirs.ok, false);
    assert.equal(theirs.error, "payments_unavailable");
    const drain = other === "stripe" ? w.stripe : w.beam;
    assert.equal(res(drain, held[other].paid.reservationId).status, "not_confirmed", "the hanging provider's paid booking waits for the next request, never cancelled");
    assert.equal(cancels(drain, held[other].paid.reservationId), 0);
    assert.ok(w.wall.ms - start <= BUDGET_MS, `the request took ${w.wall.ms - start} ms of its ${BUDGET_MS}`);
  });
});

/* --------------------------------- Stripe only: the Stripe run is a lone run --------------------------------- */

/** Random ids numbered in the order they first appear (sessions, intents, reservations, lock tokens, request ids). */
function numbered(value: unknown): unknown {
  const seen = new Map<string, string>();
  const re = /cs_(?:test|live)_fake_[0-9a-f]+|(?:pi|ch|req|evt)_fake_[0-9a-f]+|\b7\d{12}\b|\b[0-9a-f]{64}\b|\b[0-9a-f]{24}\b|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|fake-\d+/g;
  const text = JSON.stringify(value).replace(re, (id) => {
    if (!seen.has(id)) seen.set(id, `<id_${seen.size + 1}>`);
    return seen.get(id)!;
  });
  return JSON.parse(text);
}

interface Mark {
  cb: number;
  stripe: number;
  kv: number;
  logs: number;
  alerts: number;
}
const mark = (w: Both): Mark => ({
  cb: w.stripe.fakeCb.calls.length,
  stripe: w.stripe.providerCallLog().length,
  kv: w.stripeKv.writes.length,
  logs: w.stripe.logs.length,
  alerts: w.stripe.alerts.length,
});

/** Everything the Stripe side did since `from`: its Cloudbeds calls (not the Beam kit's), Stripe calls, KV writes, logs, alerts. */
function stripeTape(w: Both, from: Mark, summary: unknown): unknown {
  return numbered({
    summary,
    cloudbeds: w.stripe.fakeCb.calls.slice(from.cb).filter((_, i) => !w.beamCalls.has(from.cb + i)),
    stripe: w.stripe.providerCallLog().slice(from.stripe),
    kv: w.stripeKv.writes.slice(from.kv),
    logs: w.stripe.logs.slice(from.logs),
    alerts: w.stripe.alerts.slice(from.alerts),
  });
}

/** A run report's summary (without provider, mode, ok, error, skipped). */
function summaryOf(report: SweepRunReport): Partial<SweepSummary> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(report)) if (!["provider", "mode", "ok", "error", "skipped"].includes(k)) out[k] = v;
  return out as Partial<SweepSummary>;
}

const BEAM_BEHAVIOURS: [string, (w: Both) => void, boolean][] = [
  ["answers", () => undefined, true],
  ["throws (its charge scan answers 503)", (w) => void (w.api.beamScanFails = true), true],
  ["is slow (every call times out)", (w) => void (w.api.beamSlow = true), true],
  // Stripe's session list takes most of the step-1 slice: Beam is skipped and never called.
  ["is skipped (out of time)", (w) => void (w.api.stripeListMs = BUDGET_MS - SWEEP_HOLD_SIDE_RESERVE_MS - SWEEP_MIN_SLICE_MS + 1_000), false],
];

test("Stripe: with both providers configured, the Stripe run of a sweep request equals a lone runSweep(deps), whatever Beam does (answers, throws, is slow, is skipped)", async () => {
  for (const [does, behave, beamStep1Ran] of BEAM_BEHAVIOURS) {
    const a = both();
    const heldA = await scenario(a);
    behave(a);
    const at = mark(a);
    const answer = await sweepBoth(a, "stripe");
    const stripeRun = runOf(answer, "stripe");
    assert.equal(stripeRun.ok, true, does);
    assert.deepEqual([stripeRun.fulfilled, stripeRun.released], [1, 1], does);
    assert.equal(res(a.stripe, heldA.stripe.paid.reservationId).status, "confirmed", does);
    assert.equal(res(a.stripe, heldA.stripe.expired.reservationId).status, "canceled", does);
    assert.equal(answer.status === 200, does === "answers", `${does}: ${answer.status}`);

    // The twin world: Beam's step 1 alone (as the request runs it, in its slice), then a lone Stripe sweep.
    const b = both();
    await scenario(b);
    behave(b);
    if (beamStep1Ran) {
      const deps: BeamGatewayDeps = { ...(b.beam.deps as BeamGatewayDeps), deadlineMs: b.wall.ms + BUDGET_MS - SWEEP_HOLD_SIDE_RESERVE_MS, clock: () => b.wall.ms };
      await sweepRecentPayments(deps, beamGateway(deps)).catch(() => undefined);
    }
    const bt = mark(b);
    const lone = await runSweep(b.stripe.deps as StripeDeps);
    assert.deepEqual(stripeTape(a, at, summaryOf(stripeRun)), stripeTape(b, bt, lone), `Beam ${does}: the Stripe run is a lone runSweep(deps)`);
  }
});

/* ------------------------------------------------- Beam only ------------------------------------------------- */

const GRACE_MS = 20 * MIN;
const DAY = 24 * HOUR;
const BEAM_SCOPE = keyScope("beam-playground");
/** An orphan is aged by Cloudbeds' own clock, read cautiously (up to 7 h young): past this it is stale. */
const ORPHAN_STALE_MS = STALE_HOLD_MS + 7 * HOUR + MIN;
const beamRes = (kit: BeamKit, id: string) => {
  const r = kit.fakeCb.reservations.get(id);
  assert.ok(r, `no reservation ${id}`);
  return r;
};
const beamCritical = (kit: BeamKit) => kit.alerts.filter((a) => a.severity === "critical");
const expiryOf = (kit: BeamKit, linkId: string) => {
  const ms = kit.fakeBeam.link(linkId).expiresAtMs;
  assert.ok(ms !== null);
  return ms;
};

/** The kit's gateway whose GETs of one link answer 429 while `gate.on`, after letting `gate.pass` through. */
function rateLimitedLink(kit: BeamKit, linkId: string): { gw: BeamGateway; gate: { on: boolean; pass: number } } {
  const gate = { on: true, pass: 0 };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (gate.on && (init?.method ?? "GET") === "GET" && url.pathname === `/api/v1/payment-links/${linkId}`) {
      if (gate.pass > 0) gate.pass--;
      else return new Response(JSON.stringify({ code: 429, message: "simulated", error: { errorCode: "TOO_MANY_REQUESTS_ERROR", errorMessage: "simulated" } }), { status: 429 });
    }
    return kit.fakeBeam.fetch(input, init);
  }) as typeof fetch;
  return { gw: beamGateway({ ...kit.deps, fetchImpl }), gate };
}

test("Beam: a checkout the circuit breaker refuses (keys.beamPaused) writes nothing - both method groups, test and live, through the checkout route's path", async () => {
  for (const live of [false, true]) {
    for (const payMethod of ["card_ewallet", "promptpay"] as const) {
      const label = `${live ? "beam-live" : "beam-playground"}, ${payMethod}`;
      const now = { ms: NOW };
      const kv = recordingKv(createMemoryKv(() => now.ms));
      const kit = makeParityKit("beam", { live, kv, now });
      await kv.set(keys.beamPaused(kit.scope), String(now.ms), 300);
      const at = { kv: kv.writes.length, cb: kit.fakeCb.calls.length, beam: kit.providerCalls(), alerts: kit.alerts.length };
      const out = await kit.checkout(HONEYMOON, { payMethod });
      assert.deepEqual(out, { status: 503, body: { ok: false, error: "payment_unavailable", message: BEAM_PAUSED_MESSAGE } }, label);
      assert.deepEqual(kv.writes.slice(at.kv), [], `${label}: no KV write`);
      assert.deepEqual(kit.fakeCb.calls.slice(at.cb).filter((c) => CLOUDBEDS_WRITES.includes(c.method)), [], `${label}: no Cloudbeds write`);
      assert.equal(kit.fakeCb.reservations.size, 0, `${label}: no hold`);
      assert.equal(kit.providerCalls(), at.beam, `${label}: no Beam call`);
      assert.equal(kit.alerts.length, at.alerts, label);
    }
  }
});

test("Beam: a payment whose reading fails in step 1 never has its hold released in that run - an orphan (its records lost) and a link without a record", async () => {
  for (const where of ["the step-1 reading", "the reading for its signed note"] as const) {
    const kit = makeBeamKit();
    const h = await beamHeld(kit);
    kit.now.ms += 5 * MIN;
    kit.fakeBeam.decline(h.linkId, "CARD");
    // Redis lost the link's record, its tracking and the hold record: only the charge scan, the signed note and Cloudbeds know it.
    await kit.deps.kv.del(keys.beamPayment(h.linkId));
    await kit.deps.kv.zrem(keys.beamLinksOpen(BEAM_SCOPE), h.linkId);
    await kit.deps.kv.del(keys.hold(h.reservationId));
    await kit.deps.kv.zrem(keys.holdIndex(), h.reservationId);
    kit.now.ms = NOW + ORPHAN_STALE_MS;
    const { gw, gate } = rateLimitedLink(kit, h.linkId);
    gate.pass = where === "the step-1 reading" ? 1 : 0;
    if (where === "the step-1 reading") {
      // The orphan's payment is listed but unread (RecentPayments.unread): its hold side keeps the hold.
      const s = await runSweep(kit.deps, gw);
      assert.equal(s.released, 0, where);
      assert.ok(kit.logs.some((l) => l.message === "sweep_hold_payment_unread" && l.data?.reservationId === h.reservationId), where);
    } else {
      // A scanned link without a record that can't be read for its note: sweepRecent throws, the run releases nothing.
      await assert.rejects(runSweep(kit.deps, gw), where);
    }
    assert.equal(beamRes(kit, h.reservationId).status, "not_confirmed", `${where}: kept`);
    // Beam answers again: the declined payment's hold is released.
    gate.on = false;
    kit.now.ms += 10 * MIN;
    assert.equal((await runSweep(kit.deps, gw)).released, 1, where);
    assert.equal(beamRes(kit, h.reservationId).status, "canceled", where);
  }
});

test("Beam: a link Beam answers 404 for is released only once it is this merchant's and past its expiry plus the grace; another merchant's link keeps its hold and raises one CRITICAL", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const expiresAt = expiryOf(kit, h.linkId);
  kit.fakeBeam.links.delete(h.linkId);
  kit.now.ms = expiresAt + GRACE_MS - MIN;
  assert.equal((await kit.gw.sweepRecent(NOW)).length, 1);
  assert.equal((await runSweep(kit.deps, kit.gw)).released, 0);
  assert.equal(beamRes(kit, h.reservationId).status, "not_confirmed", "inside the grace: the guest may still be paying");
  kit.now.ms = expiresAt + GRACE_MS;
  assert.equal((await runSweep(kit.deps, kit.gw)).released, 1);
  assert.equal(beamRes(kit, h.reservationId).status, "canceled");

  // The deployment switched BEAM_MERCHANT_ID: Beam knows none of the older merchant's links.
  const k2 = makeBeamKit();
  const g = await beamHeld(k2);
  const newMerchant = "m_NewMerchantAfterSwitch00000";
  const fake = createFakeBeam({ now: () => k2.now.ms, merchantId: newMerchant, apiKey: k2.beam.apiKey, base: "playground" });
  const beam = { ...k2.beam, merchantId: newMerchant };
  const deps: BeamGatewayDeps = { ...k2.deps, beam, config: { ...k2.config, beam }, fetchImpl: fake.fetch };
  for (let i = 0; i < 12; i++) {
    k2.now.ms += 30 * MIN;
    assert.equal((await runSweep(deps, beamGateway(deps))).released, 0, `run ${i}`);
  }
  assert.equal(beamRes(k2, g.reservationId).status, "not_confirmed", "never released");
  const urgent = beamCritical(k2).filter((a) => a.subject === `URGENT: Beam payment link ${g.linkId} for booking ${g.ref} belongs to another Beam merchant`);
  assert.equal(urgent.length, 1);
  assert.equal(await k2.deps.kv.get(keys.beamReported(BEAM_SCOPE, "merchant-switch", g.linkId)), "1");
});

test("Beam: a late success is a CRITICAL also on a charge that stays PENDING past BEAM_LATE_WATCH_DAYS (the pending watch, keys.beamLinksPending)", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit, "promptpay");
  kit.now.ms += 5 * MIN;
  const qr = kit.fakeBeam.payPending(h.linkId, "QR_PROMPT_PAY");
  kit.now.ms = expiryOf(kit, h.linkId) + GRACE_MS + MIN;
  assert.equal((await runSweep(kit.deps, kit.gw)).released, 1);
  kit.now.ms += 10 * MIN;
  await runSweep(kit.deps, kit.gw);
  const releasedAt = kit.now.ms;
  const pending = () => kit.deps.kv.zrangeByScore(keys.beamLinksPending(BEAM_SCOPE), 0, Number.MAX_SAFE_INTEGER, 10);
  assert.deepEqual(await pending(), [h.linkId]);
  // Past the 7-day late watch, the PENDING charge keeps the link read; on day 9 the bank confirms it (webhook lost).
  kit.now.ms = releasedAt + (DEFAULT_BEAM_LATE_WATCH_DAYS + 1) * DAY;
  await runSweep(kit.deps, kit.gw);
  kit.now.ms = releasedAt + (DEFAULT_BEAM_LATE_WATCH_DAYS + 2) * DAY;
  kit.fakeBeam.succeed(qr.chargeId);
  await runSweep(kit.deps, kit.gw);
  const urgent = beamCritical(kit);
  assert.equal(urgent.length, 1);
  assert.equal(urgent[0].subject, `URGENT: paid booking ${h.ref} needs attention`);
  assert.ok(urgent[0].lines[0].startsWith("The guest PAID but the Cloudbeds hold is CANCELLED."), urgent[0].lines[0]);
  assert.notEqual(await kit.deps.kv.get(keys.alerted(BEAM_SCOPE, `attention:${h.key}`)), null);
  assert.deepEqual(await pending(), [], "settled: no longer watched");
  assert.equal(beamRes(kit, h.reservationId).status, "canceled");
});

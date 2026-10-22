// The sweeper's ownership rule between payment providers (Beam design step S1.4). runSweep sweeps for ONE
// provider, reached through its PaymentGateway (gw.sweepRecent lists step 1's payments). With several
// configured, every provider's step 1 runs first (sweepRecentPayments), then one run per provider - the active
// one primary, each drain not - sharing one Cloudbeds listing (opts.listed) and seeing each other's step 1
// (opts.peers):
// - a drain run (primary: false) never touches an orphan hold (no record, no intent: Redis lost them) - no
//   release, no "no record" report - but still finishes and releases the holds of its own mode;
// - a hold with an intent of another mode is that mode's run's to adopt, never an orphan;
// - the primary run releases an orphan only when no peer sees a payment for it that is not over, so a paid or
//   still-payable booking of the other provider whose record was lost is never cancelled by it;
// - the options change nothing on their own: primary: true with no peers gives the same answer, Cloudbeds and
//   Stripe calls, alerts, log events and KV writes as runSweep(deps), also when the listing or step 1 is handed
//   in. Both sides run the refactored code, so this is an options-equivalence test, not parity with cd6dae8:
//   only the golden snapshot (stripeGolden.test.ts) pins the sweep to the pre-refactor behaviour.
// Only Stripe exists so far: the other provider here is "Acme" (the Stripe gateway under another brand and
// wording), either blind to Stripe's sessions or reading them in its own words.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { SweepSummary } from "./sweep.ts";
import { STALE_HOLD_MS, SWEEP_LOOKBACK_MS, listSweepReservations, runSweep, sweepRecentPayments } from "./sweep.ts";
import type { RecentPayments } from "./sweep.ts";
import { createMemoryKv } from "./kv.ts";
import { holdIdentifier, keys, recordHold, recordIntent, DONE_TTL_SECONDS } from "./lock.ts";
import type { GatewayPayment, GatewayState, PaymentGateway } from "./payments/gateway.ts";
import { stripeGateway } from "./payments/stripeGateway.ts";
import type { CoreDeps } from "./stripeDeps.ts";
import { HONEYMOON, NOW, checkout, makeKit, recordingKv, refCharSequence, sessionIdOf } from "./testkit.ts";
import type { Kit } from "./testkit.ts";
import type { CartItemInput, CheckoutSuccess } from "./types.ts";

const GARDEN: CartItemInput[] = [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
/** An orphan is aged by Cloudbeds' own clock, read cautiously (up to 7 h young): past this it is stale. */
const ORPHAN_STALE_MS = STALE_HOLD_MS + 7 * 3600_000 + 60_000;

/** A Cloudbeds hold carrying an MSV id of the kit's mode that we hold neither a record nor an intent of. */
async function orphan(kit: Kit, ref: string, status: "not_confirmed" | "confirmed", roomTypeId = "462958", identifier = holdIdentifier(ref, kit.config.paymentMode)): Promise<string> {
  const hold = await kit.deps.writer.createHold({
    ref,
    identifier,
    checkIn: "2027-12-01",
    checkOut: "2027-12-02",
    rooms: [{ roomTypeId, rateId: null, adults: 2 }],
    guest: { firstName: "A", lastName: "B", email: "a@b.co", phone: "+1 5555555", country: "US", zip: "1" },
    estimatedArrivalTime: null,
    paymentMethod: "credit",
    expectedRoomsSatang: 0,
  });
  kit.fakeCb.reservations.get(hold.reservationId)!.status = status;
  return hold.reservationId;
}

async function held(kit: Kit, items: CartItemInput[] = HONEYMOON) {
  const res = await checkout(kit, items);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  return { sessionId: sessionIdOf(body), reservationId: body.holdReservationId as string, ref: body.ref };
}

/** Redis lost the hold record (the hold leaves the open-holds index with it): Cloudbeds' list is all that is left. */
async function loseRecord(kit: Kit, reservationId: string): Promise<void> {
  await kit.deps.kv.del(keys.hold(reservationId));
  await kit.deps.kv.zrem(keys.holdIndex(), reservationId);
}

const status = (kit: Kit, reservationId: string) => kit.fakeCb.reservations.get(reservationId)?.status;
const notes = (kit: Kit, reservationId: string) => kit.fakeCb.reservations.get(reservationId)?.notes ?? [];
const logged = (kit: Kit, message: string) => kit.logs.filter((l) => l.message === message).map((l) => l.data?.reservationId);

/** The Stripe gateway under another provider, brand and wording (it still reads Stripe's sessions). */
function acmeGateway(kit: Kit, overrides: Partial<PaymentGateway> = {}): PaymentGateway {
  const inner = stripeGateway(kit.deps);
  return {
    ...inner,
    provider: "beam",
    brand: "Acme",
    text: {
      ...inner.text,
      sessionLabel: { long: "payment link", short: "link" },
      releaseNoteText: (payments) => `Hold released by the sweeper: Acme link ${payments.map((p) => p.state).join(", ") || "never created"}.`,
    },
    ...overrides,
  };
}

/** A provider that has never seen Stripe's sessions: its own list is empty. */
const blindGateway = (kit: Kit) => acmeGateway(kit, { sweepRecent: async () => [] });

/** The deps of a run in another mode (its own key scope) on the same Cloudbeds and Redis. */
const acmeDeps = (kit: Kit): CoreDeps => ({ ...kit.deps, config: { ...kit.config, paymentMode: "beam-playground" } });

/** A peer's step 1 as it would come back: one payment per state for the reservation, in the peer's words. */
function peerView(kit: Kit, reservationId: string, states: GatewayState[]): RecentPayments {
  const payment = (state: GatewayState, i: number): GatewayPayment => ({
    key: `acme:link_${i}`,
    paymentId: `link_${i}`,
    state,
    meta: { ref: "MSV-20261005-PEER", reservationId, roomsSatang: 1_800_000, feeSatang: 90_000, totalSatang: 1_890_000, checkIn: "2027-12-01", checkOut: "2027-12-02", mode: "beam-playground" },
    amountSatang: 1_890_000,
    currency: "THB",
    attempted: true,
    receipt: { primaryId: null, description: `Acme link_${i}` },
  });
  return {
    text: acmeGateway(kit).text,
    byReservation: new Map([[reservationId, states.map(payment)]]),
    triedPaid: new Set(),
    counts: { sessionsChecked: states.length, fulfilled: 0, released: 0, errors: 0 },
  };
}

/* ------------------------------ the drain run ------------------------------ */

test("primary=false never releases or reports an orphan with neither a record nor an intent; the primary run then does, as today", async () => {
  const kit = makeKit();
  const pending = await orphan(kit, "MSV-20261005-PNDG", "not_confirmed");
  const confirmed = await orphan(kit, "MSV-20261005-CNFD", "confirmed", "462961");
  kit.now.ms += ORPHAN_STALE_MS;
  const noRecordAlerts = () => kit.alerts.filter((a) => a.subject.includes("carries an online-booking id we have no record of"));

  const drain = await runSweep(kit.deps, stripeGateway(kit.deps), { primary: false });
  assert.equal(status(kit, pending), "not_confirmed", "a drain never releases an orphan");
  assert.equal(status(kit, confirmed), "confirmed");
  assert.equal(kit.fakeCb.count("putReservation"), 0);
  assert.equal(noRecordAlerts().length, 0, "nor reports one: the primary run tells the owner, once");
  assert.equal(await kit.deps.kv.get(keys.noRecordReported("stripe-test", confirmed)), null);
  assert.deepEqual(logged(kit, "sweep_orphan_left_to_primary").sort(), [pending, confirmed].sort());
  assert.equal(drain.released, 0);
  assert.equal(drain.holdsChecked, 0);
  assert.equal(drain.errors, 0);
  assert.equal(drain.cloudbedsOk, true);

  const primary = await runSweep(kit.deps);
  assert.equal(status(kit, pending), "canceled", "the primary run releases it");
  assert.match(notes(kit, pending).at(-1) ?? "", /no payment page was ever created/);
  assert.equal(status(kit, confirmed), "confirmed", "a confirmed one is never cancelled ...");
  assert.equal(noRecordAlerts().length, 1, "... the owner is told");
  assert.equal(primary.released, 1);
});

test("primary=false still handles its own mode's holds: a paid session is confirmed, expired, session-less and lost-answer holds are released", async () => {
  const kit = makeKit();
  const paid = await held(kit);
  kit.fakeStripe.complete(paid.sessionId); // paid, the webhook never arrived
  const expired = await held(kit, GARDEN);
  kit.fakeStripe.expire(expired.sessionId);
  // A record without a session (the page failed after the hold) and an attempt whose postReservation answer was lost.
  const sessionless = await orphan(kit, "MSV-20261005-NSSN", "not_confirmed", "462960");
  await recordHold(kit.deps.kv, { ref: "MSV-20261005-NSSN", reservationId: sessionless, sessionId: null, createdAt: kit.now.ms, mode: kit.config.paymentMode });
  await recordIntent(kit.deps.kv, { ref: "MSV-20261005-LSTT", identifier: "MSV-20261005-LSTT-TEST", mode: kit.config.paymentMode, createdAt: kit.now.ms, reservationId: null });
  const lost = await orphan(kit, "MSV-20261005-LSTT", "not_confirmed", "462958");
  kit.now.ms += STALE_HOLD_MS + 5 * 60_000;

  const s = await runSweep(kit.deps, stripeGateway(kit.deps), { primary: false });
  assert.equal(status(kit, paid.reservationId), "confirmed", "a paid booking of its own is finished");
  assert.equal(kit.fakeCb.reservations.get(paid.reservationId)!.payments.length, 1);
  assert.equal(status(kit, expired.reservationId), "canceled");
  assert.equal(status(kit, sessionless), "canceled", "its own record says it is its");
  assert.equal(status(kit, lost), "canceled", "its own intent says it is its");
  assert.equal(s.fulfilled, 1);
  assert.equal(s.released, 3);
  assert.equal(s.errors, 0);
  assert.deepEqual(logged(kit, "sweep_orphan_left_to_primary"), []);
});

test("an orphan whose intent is another mode's belongs to that mode's run: the other run never takes it for a record-less orphan", async () => {
  const kit = makeKit();
  // An Acme attempt (beam-playground: -TEST ids like stripe-test) whose postReservation answer was lost.
  const ref = "MSV-20261005-ACME";
  await recordIntent(kit.deps.kv, { ref, identifier: holdIdentifier(ref, "beam-playground"), mode: "beam-playground", createdAt: kit.now.ms, reservationId: null });
  const hold = await orphan(kit, ref, "not_confirmed", "462958", holdIdentifier(ref, "beam-playground"));
  kit.now.ms += ORPHAN_STALE_MS;

  const stripe = await runSweep(kit.deps);
  assert.equal(status(kit, hold), "not_confirmed", "the Stripe run leaves Acme's attempt to Acme");
  assert.ok(stripe.skippedOtherMode >= 2, "the intent and its reservation");
  assert.equal(stripe.released, 0);

  // Acme's run, even as a drain, adopts it through its intent and releases it in its own words.
  const acme = await runSweep(acmeDeps(kit), acmeGateway(kit), { primary: false });
  assert.equal(status(kit, hold), "canceled");
  assert.equal(notes(kit, hold).at(-1), "Hold released by the sweeper: Acme link never created.");
  assert.equal(acme.released, 1);
});

/* --------------------------- the peers' payments --------------------------- */

test("a primary run never releases an orphan a peer sees paid, open, processing or refunded; it does once the peer's payments are over", async () => {
  const kit = makeKit();
  const hold = await orphan(kit, "MSV-20261005-PEER", "not_confirmed");
  kit.now.ms += ORPHAN_STALE_MS;
  const gw = stripeGateway(kit.deps);

  for (const states of [["paid"], ["open"], ["processing"], ["refunded"], ["expired", "processing"], ["failed", "paid"]] as GatewayState[][]) {
    // A second peer that saw nothing of it changes nothing.
    const s = await runSweep(kit.deps, gw, { peers: [peerView(kit, hold, []), peerView(kit, hold, states)] });
    assert.equal(status(kit, hold), "not_confirmed", states.join(","));
    assert.equal(s.released, 0, states.join(","));
    assert.equal(s.skippedOpen, 1, states.join(","));
    assert.equal(s.openHolds, 1, "still open: no provider switch while it lasts");
  }
  assert.equal(kit.fakeCb.count("putReservation"), 0);
  assert.deepEqual(kit.logs.filter((l) => l.message === "sweep_hold_left_to_peer").at(-1)?.data, { reservationId: hold, states: ["paid"] });

  // The peer's payments are over: released, with the note in the words of the provider whose page it was.
  const s = await runSweep(kit.deps, gw, { peers: [peerView(kit, hold, ["expired", "failed"])] });
  assert.equal(status(kit, hold), "canceled");
  assert.equal(notes(kit, hold).at(-1), "Hold released by the sweeper: Acme link expired, failed.");
  assert.equal(s.released, 1);
});

test("an orphan's paid marker is left to the provider that took the money when peers are present (never read through the wrong gateway)", async () => {
  const kit = makeKit();
  const hold = await orphan(kit, "MSV-20261005-PAYD", "not_confirmed");
  kit.now.ms += ORPHAN_STALE_MS;
  await kit.deps.kv.set(keys.reservationPaid(hold), "acme:link_9", DONE_TTL_SECONDS);
  const stripeCalls = kit.fakeStripe.calls.length;

  const s = await runSweep(kit.deps, stripeGateway(kit.deps), { peers: [peerView(kit, "other", [])] });
  assert.equal(status(kit, hold), "not_confirmed");
  assert.deepEqual(
    kit.fakeStripe.calls.slice(stripeCalls).map((c) => `${c.method} ${c.path}`),
    ["GET /v1/checkout/sessions"],
    "only step 1's list: Acme's payment is never asked of Stripe",
  );
  assert.equal(s.errors, 0);
  assert.equal(kit.alerts.length, 0);
});

test("the hazard the peers close: a Stripe payment still processing on a hold whose record Redis lost is never cancelled by the other provider's run", async () => {
  const kit = makeKit();
  const h = await held(kit);
  kit.fakeStripe.completeDelayed(h.sessionId); // e.g. a delayed method: complete, unpaid, PaymentIntent processing
  await loseRecord(kit, h.reservationId);
  kit.now.ms += ORPHAN_STALE_MS;
  assert.equal(status(kit, h.reservationId), "not_confirmed");

  // One request, Acme active and Stripe draining: both step 1s first, then the runs, on one Cloudbeds listing.
  const stripe = stripeGateway(kit.deps);
  const acme = blindGateway(kit);
  const listingsBefore = kit.fakeCb.count("getReservations");
  const stripeRecent = await sweepRecentPayments(kit.deps, stripe);
  const acmeRecent = await sweepRecentPayments(acmeDeps(kit), acme);
  const listed = await listSweepReservations(kit.deps, kit.now.ms);
  const primary = await runSweep(acmeDeps(kit), acme, { primary: true, recent: acmeRecent, peers: [stripeRecent], listed });
  const drain = await runSweep(kit.deps, stripe, { primary: false, recent: stripeRecent, peers: [acmeRecent], listed });
  assert.equal(status(kit, h.reservationId), "not_confirmed", "the guest's payment is still on its way");
  assert.equal(kit.fakeCb.count("getReservations") - listingsBefore, 1, "Cloudbeds listed once for both runs");
  assert.deepEqual(logged(kit, "sweep_hold_left_to_peer"), [h.reservationId]);
  assert.equal(primary.skippedOpen, 1);
  assert.equal(primary.sessionsChecked, 0);
  assert.equal(drain.sessionsChecked, 1, "the drain's own step 1, handed in");
  assert.equal(drain.released + primary.released, 0);

  // Without the Stripe view the same run would have cancelled it ...
  await runSweep(acmeDeps(kit), acme, { primary: true, listed });
  assert.equal(status(kit, h.reservationId), "canceled");
  // ... and the payment that succeeds afterwards lands on a cancelled hold: an URGENT refund-or-rebook case.
  kit.fakeStripe.asyncSucceed(h.sessionId);
  await runSweep(kit.deps, stripe, { primary: false });
  assert.ok(kit.alerts.some((a) => a.severity === "critical" && a.lines.some((l) => l.includes("The guest PAID but the Cloudbeds hold is CANCELLED"))));
});

/* ------------------------------ the gateway seam ------------------------------ */

test("step 1 runs through gw.sweepRecent: the release reason and note are the gateway's words", async () => {
  const kit = makeKit();
  const h = await held(kit);
  kit.fakeStripe.expire(h.sessionId);
  const s = await runSweep(kit.deps, acmeGateway(kit));
  assert.equal(s.sessionsChecked, 1);
  assert.equal(s.released, 1);
  assert.equal(status(kit, h.reservationId), "canceled");
  assert.equal(await kit.deps.kv.get(keys.releaseDone(h.reservationId)), "sweeper: link expired");
  assert.equal(notes(kit, h.reservationId).at(-1), "Hold released by the sweeper: Acme link expired.");
});

test("the Stripe gateway's sweepRecent: ours and of this mode only; read() re-reads only a complete but unpaid session", async () => {
  const kit = makeKit();
  const open = await held(kit);
  kit.now.ms += 1000;
  const delayed = await held(kit, GARDEN);
  kit.fakeStripe.completeDelayed(delayed.sessionId);
  kit.now.ms += 1000;
  const other = await held(kit, [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }]);
  kit.fakeStripe.sessions.get(other.sessionId)!.livemode = true; // the other Stripe mode's
  await kit.deps.stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ quantity: 1, price_data: { currency: "thb", unit_amount: 150_000, product_data: { name: "Room charge" } } }],
    success_url: "https://hotels.cloudbeds.com/done?s={CHECKOUT_SESSION_ID}",
    expires_at: Math.floor(kit.now.ms / 1000) + 3600,
  }); // another app's on the shared account

  const gw = stripeGateway(kit.deps);
  const before = kit.fakeStripe.calls.length;
  const recent = await gw.sweepRecent(kit.now.ms - SWEEP_LOOKBACK_MS);
  assert.deepEqual(
    recent.map((r) => [r.key, r.reservationId, r.listedPaid]),
    [
      [delayed.sessionId, delayed.reservationId, false],
      [open.sessionId, open.reservationId, false],
    ],
  );
  assert.deepEqual(kit.fakeStripe.calls.slice(before).map((c) => `${c.method} ${c.path}`), ["GET /v1/checkout/sessions"], "one list page");

  const listedOnly = kit.fakeStripe.calls.length;
  const [d, o] = [await recent[0].read(), await recent[1].read()];
  assert.deepEqual(kit.fakeStripe.calls.slice(listedOnly).map((c) => `${c.method} ${c.path}`), [`GET /v1/checkout/sessions/${delayed.sessionId}`]);
  assert.deepEqual([d.state, d.attempted, o.state, o.attempted], ["processing", true, "open", false]);
  assert.deepEqual(d, await gw.get(delayed.sessionId), "the same payment get() answers");
});

/* ------------------------- primary: true is today's sweep ------------------------- */

/** Random ids numbered in the order they first appear: Stripe sessions and intents, Cloudbeds reservations, lock tokens. */
function numbered(value: unknown): unknown {
  const seen = new Map<string, string>();
  const kind = (id: string) => (/^(cs|pi|ch|req)_/.exec(id)?.[1] ?? (/^7\d{12}$/.test(id) ? "res" : "tok"));
  const text = JSON.stringify(value).replace(/cs_(?:test|live)_fake_[0-9a-f]+|(?:pi|ch|req)_fake_[0-9a-f]+|\b7\d{12}\b|\b[0-9a-f]{24}\b/g, (id) => {
    if (!seen.has(id)) seen.set(id, `<${kind(id)}_${seen.size + 1}>`);
    return seen.get(id)!;
  });
  return JSON.parse(text);
}

/** The same scenario on a fresh kit: a paid booking whose webhook was lost, an expired one, an unpaid and a confirmed orphan. */
async function scenario() {
  const now = { ms: NOW };
  const kv = recordingKv(createMemoryKv(() => now.ms));
  const kit = makeKit({ kv, now, pickRefChar: refCharSequence() });
  const paid = await held(kit);
  kit.fakeStripe.complete(paid.sessionId);
  kit.now.ms += 1000; // the sessions' list order follows their creation time
  const expired = await held(kit, GARDEN);
  kit.fakeStripe.expire(expired.sessionId);
  await orphan(kit, "MSV-20261005-PNDG", "not_confirmed", "462960");
  await orphan(kit, "MSV-20261005-CNFD", "confirmed", "462964");
  kit.now.ms += ORPHAN_STALE_MS;
  const at = { cb: kit.fakeCb.calls.length, stripe: kit.fakeStripe.calls.length, alerts: kit.alerts.length, logs: kit.logs.length, kv: kv.writes.length };
  /** Everything the sweep did from here on. */
  const tape = (summary: SweepSummary) =>
    numbered({
      summary,
      cloudbeds: kit.fakeCb.calls.slice(at.cb),
      stripe: kit.fakeStripe.calls.slice(at.stripe),
      alerts: kit.alerts.slice(at.alerts),
      logs: kit.logs.slice(at.logs).map((l) => l.message),
      kv: kv.writes.slice(at.kv),
      reservations: [...kit.fakeCb.reservations.values()].map((r) => ({ id: r.reservationID, status: r.status, notes: r.notes, payments: r.payments.map((p) => p.description) })),
    });
  return { kit, tape };
}

test("options equivalence: primary=true with no peers gives the same answer and the same calls, alerts, logs and KV writes as runSweep(deps), also with step 1 and the listing handed in", async () => {
  const today = await scenario();
  const reference = await runSweep(today.kit.deps);
  assert.equal(reference.fulfilled, 1);
  assert.equal(reference.released, 2);
  assert.equal(today.kit.alerts.filter((a) => a.subject.includes("carries an online-booking id we have no record of")).length, 1);

  const explicit = await scenario();
  assert.deepEqual(explicit.tape(await runSweep(explicit.kit.deps, stripeGateway(explicit.kit.deps), { primary: true })), today.tape(reference));

  const phased = await scenario();
  const gw = stripeGateway(phased.kit.deps);
  const recent = await sweepRecentPayments(phased.kit.deps, gw);
  assert.deepEqual(phased.tape(await runSweep(phased.kit.deps, gw, { primary: true, recent, peers: [] })), today.tape(reference), "step 1 handed in");

  // As a request with several providers does it: every step 1 first, then one listing for every run.
  const shared = await scenario();
  const sharedGw = stripeGateway(shared.kit.deps);
  const sharedRecent = await sweepRecentPayments(shared.kit.deps, sharedGw);
  const listed = await listSweepReservations(shared.kit.deps, shared.kit.now.ms);
  const listings = shared.kit.fakeCb.count("getReservations");
  const s = await runSweep(shared.kit.deps, undefined, { recent: sharedRecent, listed });
  assert.equal(shared.kit.fakeCb.count("getReservations"), listings, "not listed again");
  assert.deepEqual(shared.tape(s), today.tape(reference), "step 1 and the listing handed in");
});

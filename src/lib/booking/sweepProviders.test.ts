// The sweep route's runs (Beam design S4.8): sweepProviders sweeps every configured provider in one request,
// Stripe first - every step 1, then one run per provider (sweep.ts runSweep) on one Cloudbeds listing - and the
// sweep route builds those runs from runtime.ts while a Beam config (active or drain) exists.
//
// The library tests run on a Stripe kit (testkit.ts makeKit, stripe-test) and a Beam kit (beamTestkit.ts
// makeBeamKit, beam-playground) sharing one fake Cloudbeds and one Redis. Each kit writes through its own
// recording view of the store, so each provider's KV writes are told apart, and the Beam writer's Cloudbeds calls
// are tagged. The Stripe run's identity: its Cloudbeds calls, Stripe calls, KV writes, logs, alerts and summary are
// those of a lone runSweep(deps) on a twin world in which Beam's step 1 ran first (the Stripe run sees Beam's work
// only through the shared hold index and listing, which Beam's step 1 has changed by the time Stripe's hold side
// runs).
//
// Covered: Stripe-primary with a Beam drain, Beam-primary with a Stripe drain, and no active run (the first one is
// primary); one shared listing; Beam-tagged and untagged orphans each released only by their own run; heartbeats
// per scope; a Beam step 1 that throws (its holds kept; its paid booking confirmed and its stored CRITICAL re-sent by
// sweepPaidAndAlerts; 502), a Beam link read that throws (that hold kept), a refused scan (no failure); a slow Beam
// step 1 kept to its slice; a Beam run out of time (skipped, reported, nothing done) at the hold side and at step 1;
// a Stripe step 1 that throws; a failed shared listing. The route: both runs with the active config's provider
// primary, and the single Stripe answer (no runs) without a Beam config.

import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";
import { buildOffers } from "./availability.ts";
import { BEAM_API_KEY, BEAM_CLOUDBEDS_METHOD, BEAM_HMAC_KEY_B64, BEAM_MERCHANT_ID, beamHeld, makeBeamKit } from "./beamTestkit.ts";
import type { BeamHeld, BeamKit } from "./beamTestkit.ts";
import { POLICY_VERSION } from "./catalogue.ts";
import { checkSweeperFresh } from "./checkoutShared.ts";
import type { ListedReservation } from "./cloudbedsWrite.ts";
import type { CloudbedsWriter } from "./cloudbedsWrite.ts";
import { BEAM_PLAYGROUND_BASE, MOCK_STRIPE_WEBHOOK_SECRET, getFulfilmentConfig } from "./config.ts";
import type { Env } from "./config.ts";
import { addDays } from "./dates.ts";
import { demoInventory } from "./demoProvider.ts";
import { fulfilPayment } from "./fulfil.ts";
import { createMemoryKv } from "./kv.ts";
import type { KvStore } from "./kv.ts";
import { holdIdentifier, keyScope, keys } from "./lock.ts";
import { createFakeBeam } from "./mock/fakeBeam.ts";
import type { FakeBeam } from "./mock/fakeBeam.ts";
import { FAKE_PAYMENT_METHODS, createFakeCloudbeds } from "./mock/fakeCloudbeds.ts";
import type { FakeCloudbeds, FakeRoomType } from "./mock/fakeCloudbeds.ts";
import { createFakeStripe } from "./mock/fakeStripe.ts";
import { beamGateway } from "./payments/beamGateway.ts";
import type { BeamGatewayDeps } from "./payments/beamGateway.ts";
import { beamGatewayText } from "./payments/beamText.ts";
import type { StripeClient } from "./payments/stripe.ts";
import { stripeGateway } from "./payments/stripeGateway.ts";
import { STALE_HOLD_MS, SWEEP_STALE_ALERT_MS, runSweep, sweepRecentPayments } from "./sweep.ts";
import type { SweepSummary } from "./sweep.ts";
import { SWEEP_HOLD_SIDE_RESERVE_MS, SWEEP_MIN_SLICE_MS, stripeWithin, sweepProviders } from "./sweepProviders.ts";
import type { SweepProvidersAnswer, SweepRun, SweepRunReport, SweepTiming } from "./sweepProviders.ts";
import { GUEST, HONEYMOON, NOW, ROOM_TYPES, STRIPE_LIVE_ENV, TOKEN_SECRET, checkout, makeKit, recordingKv, refCharSequence, sessionIdOf } from "./testkit.ts";
import type { Kit, KvWrite } from "./testkit.ts";
import type { CartItemInput, CheckoutSuccess, Quote } from "./types.ts";

const MIN = 60_000;
/** The sweep route's budget (maxDuration 60 s minus a margin). */
const BUDGET_MS = 55_000;
/** An orphan is aged by Cloudbeds' own clock, read cautiously (up to 7 h young): past this it is stale. */
const ORPHAN_STALE_MS = STALE_HOLD_MS + 7 * 3600_000 + MIN;
const GARDEN: CartItemInput[] = [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
const STRIPE_SCOPE = keyScope("stripe-test");
const BEAM_SCOPE = keyScope("beam-playground");
/** Every room with a few units: both providers hold the same rooms on the one property. */
const ROOMS: Record<string, FakeRoomType> = Object.fromEntries(Object.entries(ROOM_TYPES).map(([id, r]) => [id, { ...r, units: 4 }]));
const STRIPE_ORPHAN_REF = "MSV-20261005-STRP";
const BEAM_ORPHAN_REF = "MSV-20261005-BEAM";
/** The Stripe holds' stay (13 months ahead: the stripe-test guard); the Beam kit holds FAR_CHECKIN to FAR_CHECKOUT. */
const STRIPE_STAY = { checkIn: "2027-11-20", checkOut: "2027-11-23" };

/* ---------------------------------------------- the shared world ---------------------------------------------- */

interface World {
  /** The business clock of both kits (deps.now). */
  now: { ms: number };
  /** The deadline's clock (SweepTiming.clock), moved only by the tests' slow fakes. */
  wall: { ms: number };
  cb: FakeCloudbeds;
  stripe: Kit;
  stripeKv: KvStore & { writes: KvWrite[] };
  beam: BeamKit;
  beamKv: KvStore & { writes: KvWrite[] };
  /** Indexes of cb.calls made through the Beam kit's writer and reads. */
  beamCalls: Set<number>;
  /** Beam's fetch for the deps each Beam run opens (a test puts a fault in front of the fake Beam). */
  beamFetch: { current: typeof fetch };
  /** The timings every Beam run was opened with. */
  beamOpens: SweepTiming[];
  /** sweepProviders' own log lines. */
  sweeperLogs: { message: string; data?: Record<string, unknown> }[];
}

/** A Stripe and a Beam kit on one fake Cloudbeds and one Redis. `stripeFetch` wraps the fake Stripe (it sees the wall clock). */
function world(options: { stripeFetch?: (fake: typeof fetch, wall: { ms: number }) => typeof fetch } = {}): World {
  const now = { ms: NOW };
  const wall = { ms: 1_000_000 };
  const inner = createMemoryKv(() => now.ms);
  const stripeKv = recordingKv(inner);
  const beamKv = recordingKv(inner);
  const stripe = makeKit({
    kv: stripeKv,
    now,
    pickRefChar: refCharSequence(),
    cb: { roomTypes: ROOMS, paymentMethods: [...FAKE_PAYMENT_METHODS, { method: BEAM_CLOUDBEDS_METHOD, code: BEAM_CLOUDBEDS_METHOD, name: "Beam (website)" }] },
    ...(options.stripeFetch ? { stripeFetch: (fake: typeof fetch) => options.stripeFetch!(fake, wall) } : {}),
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
  const beam = makeBeamKit({ kv: beamKv, now, fakeCb: tagged, pickRefChar: (max) => (i++ * 11 + 5) % max });
  return { now, wall, cb, stripe, stripeKv, beam, beamKv, beamCalls, beamFetch: { current: beam.fakeBeam.fetch }, beamOpens: [], sweeperLogs: [] };
}

const stripeRun = (w: World, primary: boolean): SweepRun => ({ provider: "stripe", primary, open: () => ({ deps: w.stripe.deps, gw: stripeGateway(w.stripe.deps) }) });

function beamDepsFor(w: World, timing: SweepTiming): BeamGatewayDeps {
  return { ...w.beam.deps, ...timing, fetchImpl: w.beamFetch.current };
}

const beamRun = (w: World, primary: boolean): SweepRun => ({
  provider: "beam",
  primary,
  open: (timing) => {
    w.beamOpens.push(timing);
    const deps = beamDepsFor(w, timing);
    return { deps, gw: beamGateway(deps) };
  },
});

/** One sweeper request for both providers, `primary` the active one (null: neither, e.g. the demo with drains). */
function sweepBoth(w: World, primary: "stripe" | "beam" | null, order: "stripe first" | "beam first" = "stripe first"): Promise<SweepProvidersAnswer> {
  const runs = [stripeRun(w, primary === "stripe"), beamRun(w, primary === "beam")];
  return sweepProviders(order === "stripe first" ? runs : runs.reverse(), {
    deadlineMs: w.wall.ms + BUDGET_MS,
    clock: () => w.wall.ms,
    log: (message, data) => w.sweeperLogs.push({ message, data }),
  });
}

/** Beam's step 1 alone, as the request runs it (its slice of the budget), for the twin world of a lone Stripe run. */
async function beamStep1(w: World): Promise<void> {
  const deps = beamDepsFor(w, { deadlineMs: w.wall.ms + BUDGET_MS - SWEEP_HOLD_SIDE_RESERVE_MS, clock: () => w.wall.ms });
  await sweepRecentPayments(deps, beamGateway(deps)).catch(() => undefined);
}

interface Built {
  w: World;
  s1: { sessionId: string; reservationId: string };
  s2: { sessionId: string; reservationId: string };
  b1: BeamHeld;
  b2: BeamHeld;
  stripeOrphan: string;
  beamOrphan: string;
}

/** A Stripe hold on STRIPE_STAY (our open-holds brake refuses a second hold of ours on the same rooms and nights). */
async function held(kit: Kit, items: CartItemInput[] = HONEYMOON) {
  const res = await checkout(kit, items, STRIPE_STAY);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { sessionId: sessionIdOf(res.body), reservationId: (res.body as CheckoutSuccess).holdReservationId as string };
}

/** A hold of ours in Cloudbeds that Redis lost every record of (no hold record, no intent, no payment). */
async function orphan(writer: CloudbedsWriter, cb: FakeCloudbeds, ref: string, mode: "stripe-test" | "beam-playground"): Promise<string> {
  const hold = await writer.createHold({
    ref,
    identifier: holdIdentifier(ref, mode),
    checkIn: "2027-12-01",
    checkOut: "2027-12-02",
    rooms: [{ roomTypeId: "462960", rateId: null, adults: 2 }],
    guest: { firstName: "A", lastName: "B", email: "a@b.co", phone: "+1 5555555", country: "US", zip: "1" },
    estimatedArrivalTime: null,
    paymentMethod: "credit",
    expectedRoomsSatang: 0,
  });
  cb.reservations.get(hold.reservationId)!.status = "not_confirmed";
  return hold.reservationId;
}

/**
 * The same world every time: Stripe - a paid session whose webhook was lost, an expired one, an orphan; Beam - a
 * paid link whose webhook was lost, a link that expired, an orphan ('-B'); all stale. `extra` adds to it.
 */
async function scenario(options: Parameters<typeof world>[0] = {}, extra?: (w: World) => Promise<void>): Promise<Built> {
  const w = world(options);
  const s1 = await held(w.stripe);
  w.stripe.fakeStripe.complete(s1.sessionId);
  w.now.ms += 1000;
  const s2 = await held(w.stripe, GARDEN);
  w.stripe.fakeStripe.expire(s2.sessionId);
  w.now.ms += 1000;
  const b1 = await beamHeld(w.beam);
  w.beam.fakeBeam.pay(b1.linkId, "CARD");
  w.now.ms += 1000;
  const b2 = await beamHeld(w.beam, "card_ewallet", GARDEN);
  const stripeOrphan = await orphan(w.stripe.deps.writer, w.cb, STRIPE_ORPHAN_REF, "stripe-test");
  const beamOrphan = await orphan(w.beam.deps.writer, w.cb, BEAM_ORPHAN_REF, "beam-playground");
  if (extra) await extra(w);
  w.now.ms += ORPHAN_STALE_MS;
  return { w, s1, s2, b1, b2, stripeOrphan, beamOrphan };
}

/* ------------------------------------------------- the tapes ------------------------------------------------- */

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
const mark = (w: World): Mark => ({ cb: w.cb.calls.length, stripe: w.stripe.fakeStripe.calls.length, kv: w.stripeKv.writes.length, logs: w.stripe.logs.length, alerts: w.stripe.alerts.length });

/** Everything the Stripe side did since `from`: Cloudbeds calls (not the Beam writer's), Stripe calls, KV writes, logs, alerts. */
function stripeTape(w: World, from: Mark, summary: unknown): unknown {
  return numbered({
    summary,
    cloudbeds: w.cb.calls.slice(from.cb).filter((_, i) => !w.beamCalls.has(from.cb + i)),
    stripe: w.stripe.fakeStripe.calls.slice(from.stripe),
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

const runOf = (answer: SweepProvidersAnswer, provider: "stripe" | "beam") => {
  const r = answer.body.runs.find((x) => x.provider === provider);
  assert.ok(r, `no ${provider} run`);
  return r;
};
const status = (w: World, reservationId: string) => w.cb.reservations.get(reservationId)?.status;
const notes = (w: World, reservationId: string) => w.cb.reservations.get(reservationId)?.notes ?? [];
const sweeperLogged = (w: World, message: string) => w.sweeperLogs.filter((l) => l.message === message);

/**
 * The Stripe run of `answer` (on `a`) against a lone runSweep(deps) on the twin world `b`, run after Beam's step 1
 * (`twinBeamStep1: false` when the request ran none).
 */
async function assertStripeAsLone(a: World, at: Mark, answer: SweepProvidersAnswer, b: World, twinBeamStep1 = true): Promise<SweepSummary> {
  if (twinBeamStep1) await beamStep1(b);
  const bt = mark(b);
  const lone = await runSweep(b.stripe.deps);
  assert.deepEqual(stripeTape(a, at, summaryOf(runOf(answer, "stripe"))), stripeTape(b, bt, lone), "the Stripe run is a lone runSweep(deps)");
  return lone;
}

/* ------------------------------------------------ both providers ------------------------------------------------ */

for (const primary of ["stripe", "beam", null] as const) {
  const label = primary === "stripe" ? "Stripe-primary with a Beam drain" : primary === "beam" ? "Beam-primary with a Stripe drain" : "no active run (the demo with both drains), Beam passed first";
  // Round 6: the Beam primary goes first in both phases (its hold side takes the listing); the Stripe drain after it.
  const claim =
    primary === "beam"
      ? "Beam runs first and takes the one listing, the Stripe drain after it; each orphan released by its own run; heartbeats per scope"
      : "the Stripe run is a lone runSweep; one listing; each orphan released by its own run; heartbeats per scope";
  test(`${label}: ${claim}`, async () => {
    const a = await scenario();
    const at = mark(a.w);
    const listings = a.w.cb.count("getReservations");
    const answer = await sweepBoth(a.w, primary, primary === null ? "beam first" : "stripe first");

    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.ok, true);
    assert.equal(answer.body.error, undefined);
    assert.deepEqual(
      answer.body.runs.map((r) => [r.provider, r.mode, r.ok]),
      [
        ["stripe", "stripe-test", true],
        ["beam", "beam-playground", true],
      ],
      "Stripe first, whatever the order handed in",
    );
    const primaryRun = primary === "beam" ? runOf(answer, "beam") : runOf(answer, "stripe");
    assert.equal(answer.body.mode, primaryRun.mode, "the primary run's mode (the first run's when no run is the active one)");
    assert.deepEqual(summaryOf(answer.body as unknown as SweepRunReport), { ...summaryOf(primaryRun), runs: answer.body.runs }, "the primary run's summary, then runs");
    assert.equal(a.w.cb.count("getReservations") - listings, 1, "one Cloudbeds listing for both runs");
    if (primary === "beam") {
      assert.equal(
        a.w.cb.calls.slice(at.cb).filter((c, i) => c.method === "getReservations" && a.w.beamCalls.has(at.cb + i)).length,
        1,
        "taken by the Beam run (the first) at its own listing point",
      );
      // Beam's step 1 (confirming b1) came before the Stripe drain's (confirming s1).
      const first = (viaBeam: boolean) => a.w.cb.calls.findIndex((c, i) => i >= at.cb && c.method === "postPayment" && a.w.beamCalls.has(i) === viaBeam);
      assert.ok(first(true) >= 0 && first(true) < first(false), `Beam first: ${first(true)} < ${first(false)}`);
    } else {
      assert.equal(
        a.w.cb.calls.slice(at.cb).filter((c, i) => c.method === "getReservations" && a.w.beamCalls.has(at.cb + i)).length,
        0,
        "taken by the Stripe run (the first) at its own listing point",
      );
    }

    // Stripe: paid -> confirmed, expired -> released, its orphan released in its words. Beam: the same for its own.
    const stripe = runOf(answer, "stripe");
    const beam = runOf(answer, "beam");
    assert.deepEqual([stripe.sessionsChecked, stripe.fulfilled, stripe.released, stripe.errors], [2, 1, 2, 0]);
    assert.deepEqual([beam.sessionsChecked, beam.fulfilled, beam.released, beam.errors], [2, 1, 2, 0]);
    const { s1, s2, b1, b2, stripeOrphan, beamOrphan } = a;
    assert.deepEqual(
      [s1, s2, b1, b2].map((h) => status(a.w, h.reservationId)),
      ["confirmed", "canceled", "confirmed", "canceled"],
    );
    assert.equal(status(a.w, stripeOrphan), "canceled");
    assert.equal(status(a.w, beamOrphan), "canceled");
    assert.equal(notes(a.w, stripeOrphan).at(-1), stripeGateway(a.w.stripe.deps).text.releaseNoteText([]));
    assert.equal(notes(a.w, beamOrphan).at(-1), beamGatewayText(a.w.beam.beam).releaseNoteText([]));
    assert.notEqual(stripeGateway(a.w.stripe.deps).text.releaseNoteText([]), beamGatewayText(a.w.beam.beam).releaseNoteText([]));
    // Each orphan's cancel went through its own provider's run (the Beam writer's calls are tagged).
    const cancelBy = (reservationId: string) =>
      a.w.cb.calls
        .map((c, i) => ({ c, beam: a.w.beamCalls.has(i) }))
        .filter(({ c }) => c.method === "putReservation" && c.params.reservationID === reservationId)
        .map(({ beam: viaBeam }) => (viaBeam ? "beam" : "stripe"));
    assert.deepEqual(cancelBy(stripeOrphan), ["stripe"]);
    assert.deepEqual(cancelBy(beamOrphan), ["beam"]);
    assert.equal(a.w.stripe.logs.filter((l) => l.message === "sweep_orphan_left_to_primary").length, 0, "every run owns its orphans");
    assert.equal(a.w.beam.logs.filter((l) => l.message === "sweep_orphan_left_to_primary").length, 0);

    // Heartbeats per scope; Beam's phases opened with the step-1 slice, then the deadline.
    assert.equal(await a.w.stripeKv.get(keys.lastSweep(STRIPE_SCOPE)), String(a.w.now.ms));
    assert.equal(await a.w.beamKv.get(keys.lastSweep(BEAM_SCOPE)), String(a.w.now.ms));
    const deadline = a.w.wall.ms + BUDGET_MS;
    assert.deepEqual(
      a.w.beamOpens.map((o) => o.deadlineMs),
      [deadline - SWEEP_HOLD_SIDE_RESERVE_MS, deadline],
    );
    assert.deepEqual(a.w.sweeperLogs, [], "nothing failed, nothing skipped");

    // A Stripe drain behind the Beam primary is a later run (it sees Beam's hold side): no lone-run identity.
    if (primary === "beam") return;
    const b = await scenario();
    const lone = await assertStripeAsLone(a.w, at, answer, b.w);
    assert.equal(lone.released, 2);
  });
}

/** Beam answering 503 to the requests `matches` picks (the fake Beam for every other one). */
function beamFailing(w: World, matches: (method: string, url: URL) => boolean): void {
  const fake = w.beam.fakeBeam.fetch;
  w.beamFetch.current = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (matches(init?.method ?? "GET", url)) {
      return new Response(JSON.stringify({ code: 503, message: "simulated", error: { errorCode: "INTERNAL_SERVER_ERROR", errorMessage: "simulated" } }), { status: 503 });
    }
    return fake(input, init);
  }) as typeof fetch;
}

const STEP1_FAILURES: [string, (b: Built) => Promise<void>][] = [
  ["a 5xx charge scan", async ({ w }) => beamFailing(w, (_, url) => url.pathname === "/api/v1/charges" && !url.searchParams.has("sourceId"))],
  [
    "a tracked link without a record that can't be read for its note",
    async ({ w, b1 }) => {
      await w.beamKv.del(keys.beamPayment(b1.linkId));
      beamFailing(w, (method, url) => method === "GET" && url.pathname === `/api/v1/payment-links/${b1.linkId}`);
    },
  ],
];

for (const [cause, fault] of STEP1_FAILURES) {
  test(`a Beam step 1 that throws (${cause}): every Beam hold kept, its paid booking confirmed and stored CRITICAL re-sent, 502; Stripe untouched`, async () => {
    // A paid Beam booking whose first confirmation failed (on the paid index), and a CRITICAL whose mail failed.
    let paid: BeamHeld | null = null;
    const extra = async (w: World) => {
      paid = await beamHeld(w.beam, "card_ewallet", [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }]);
      w.beam.fakeBeam.pay(paid.linkId, "CARD");
      w.cb.failNext("postReservationNote", "http500");
      w.cb.failNext("getReservation", "http500");
      await assert.rejects(fulfilPayment(paid.key, w.beam.deps, w.beam.gw));
      w.beam.mail.ok = false;
      await w.beam.deps.alert("URGENT: stored test alert", ["Raised while the mail relay was down."], { key: "stored-test-alert", severity: "critical" });
      w.beam.mail.ok = true;
    };
    const a = await scenario({}, extra);
    const held3 = paid as unknown as BeamHeld;
    await fault(a);
    const at = mark(a.w);
    const answer = await sweepBoth(a.w, "stripe");

    assert.equal(answer.status, 502);
    assert.equal(answer.body.ok, false);
    assert.equal(answer.body.error, "payments_unavailable");
    assert.equal(answer.body.mode, "stripe-test");
    assert.equal(runOf(answer, "stripe").ok, true);
    const beam = runOf(answer, "beam");
    assert.deepEqual([beam.ok, beam.error, beam.errors, beam.fulfilled, beam.released, beam.undeliveredAlerts, beam.cloudbedsOk], [false, "payments_unavailable", 1, 1, 0, 1, true]);
    // No hold side: the expired link's hold, the orphan and the paid link whose webhook was lost all wait.
    assert.equal(status(a.w, a.b2.reservationId), "not_confirmed");
    assert.equal(status(a.w, a.beamOrphan), "not_confirmed");
    assert.equal(status(a.w, a.b1.reservationId), "not_confirmed");
    // sweepPaidAndAlerts: the paid-unconfirmed booking confirmed, the stored CRITICAL re-sent, the heartbeat written.
    assert.equal(status(a.w, held3.reservationId), "confirmed");
    assert.equal(a.w.beam.alerts.filter((x) => x.subject === "URGENT: stored test alert").length, 1);
    assert.equal(await a.w.beamKv.get(keys.lastSweep(BEAM_SCOPE)), String(a.w.now.ms));
    assert.ok(a.w.beam.logs.some((l) => l.message === "sweep_done" && l.data?.step1Failed === true));
    assert.deepEqual(
      sweeperLogged(a.w, "sweep_step1_failed").map((l) => [l.data?.provider, l.data?.mode]),
      [["beam", "beam-playground"]],
    );
    assert.match(String(sweeperLogged(a.w, "sweep_step1_failed")[0].data?.error), /simulated|503|INTERNAL/);

    const b = await scenario({}, extra);
    await fault(b);
    await assertStripeAsLone(a.w, at, answer, b.w);

    // The next request, with Beam answering again, finishes the Beam holds.
    a.w.beamFetch.current = a.w.beam.fakeBeam.fetch;
    const next = await sweepBoth(a.w, "stripe");
    assert.equal(next.status, 200, JSON.stringify(next.body));
    assert.equal(status(a.w, a.b1.reservationId), "confirmed");
    assert.equal(status(a.w, a.b2.reservationId), "canceled");
    assert.equal(status(a.w, a.beamOrphan), "canceled");
  });
}

test("a Beam step 1 whose link read throws keeps that Beam hold in the Beam run; the rest is finished; Stripe untouched", async () => {
  const unreadable = (w: World, linkId: string) => beamFailing(w, (method, url) => method === "GET" && url.pathname === `/api/v1/payment-links/${linkId}`);
  const a = await scenario();
  unreadable(a.w, a.b2.linkId);
  const at = mark(a.w);
  const answer = await sweepBoth(a.w, "stripe");
  const beam = runOf(answer, "beam");
  assert.equal(beam.ok, true, "a payment read that fails is no failed step 1");
  assert.ok((beam.errors ?? 0) >= 1);
  assert.equal(status(a.w, a.b2.reservationId), "not_confirmed", "its state is unknown: kept for the next run");
  assert.equal(status(a.w, a.b1.reservationId), "confirmed");
  assert.equal(status(a.w, a.beamOrphan), "canceled");
  assert.equal(sweeperLogged(a.w, "sweep_step1_failed").length, 0);

  const b = await scenario();
  unreadable(b.w, b.b2.linkId);
  await assertStripeAsLone(a.w, at, answer, b.w);
});

test("a refused scan (a 4xx) is no failure: the Beam run goes on with its tracked links and answers ok", async () => {
  const a = await scenario();
  a.w.beam.fakeBeam.unfilteredListUnsupported();
  const answer = await sweepBoth(a.w, "beam");
  assert.equal(answer.status, 200);
  assert.deepEqual([runOf(answer, "beam").ok, runOf(answer, "beam").errors], [true, 0]);
  assert.equal(status(a.w, a.b1.reservationId), "confirmed");
  assert.equal(status(a.w, a.b2.reservationId), "canceled");
  assert.equal(a.w.beam.alerts.filter((x) => x.subject === "Beam refused the sweeper's payment scan").length, 1);
});

/* --------------------------------------------------- time --------------------------------------------------- */

test("a slow Beam (every call times out) stops at its step-1 slice: the hold sides keep their reserve, Stripe untouched, 502", async () => {
  const slow = (w: World) => {
    w.beamFetch.current = (async () => {
      w.wall.ms += 6_000;
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as typeof fetch;
  };
  const a = await scenario();
  slow(a.w);
  const start = a.w.wall.ms;
  const at = mark(a.w);
  const answer = await sweepBoth(a.w, "stripe");
  assert.equal(answer.status, 502);
  assert.equal(answer.body.error, "payments_unavailable");
  const beam = runOf(answer, "beam");
  assert.deepEqual([beam.ok, beam.error, beam.released], [false, "payments_unavailable", 0]);
  // Every Beam attempt started before the slice's end (each takes 6 s here): Stripe's hold side kept its reserve.
  assert.ok(a.w.wall.ms - start <= BUDGET_MS - SWEEP_HOLD_SIDE_RESERVE_MS + 6_000, `Beam ran until ${a.w.wall.ms - start} ms`);
  assert.ok(a.w.wall.ms - start > 0, "Beam was asked");
  assert.equal(status(a.w, a.b2.reservationId), "not_confirmed");
  assert.equal(status(a.w, a.beamOrphan), "not_confirmed");
  assert.deepEqual([runOf(answer, "stripe").ok, runOf(answer, "stripe").released], [true, 2]);

  const b = await scenario();
  slow(b.w);
  await assertStripeAsLone(a.w, at, answer, b.w);
});

test("a Beam run out of time at its hold side is skipped, reported and does nothing more (no heartbeat); 502; Stripe untouched", async () => {
  // The shared listing (in the Stripe run) takes 52 of the 55 seconds: less than SWEEP_MIN_SLICE_MS is left for Beam.
  const slowListing = (w: World) =>
    w.cb.failNext("getReservations", "pass", undefined, () => {
      w.wall.ms += BUDGET_MS - SWEEP_MIN_SLICE_MS + 2_000;
    });
  const a = await scenario();
  slowListing(a.w);
  const at = mark(a.w);
  const answer = await sweepBoth(a.w, "stripe");
  assert.equal(answer.status, 502);
  assert.equal(answer.body.error, "out_of_time");
  assert.equal(answer.body.mode, "stripe-test");
  assert.equal(runOf(answer, "stripe").ok, true);
  assert.deepEqual(runOf(answer, "beam"), { provider: "beam", mode: "beam-playground", ok: false, error: "out_of_time", skipped: "out of time" });
  assert.deepEqual(
    sweeperLogged(a.w, "sweep_run_skipped").map((l) => [l.data?.provider, l.data?.phase]),
    [["beam", "hold side"]],
  );
  // Its step 1 ran (the paid link confirmed, the expired one released); its hold side did not (the orphan waits).
  assert.equal(status(a.w, a.b1.reservationId), "confirmed");
  assert.equal(status(a.w, a.b2.reservationId), "canceled");
  assert.equal(status(a.w, a.beamOrphan), "not_confirmed");
  assert.equal(await a.w.beamKv.get(keys.lastSweep(BEAM_SCOPE)), null, "a skipped run is no sweep");
  assert.equal(a.w.beam.logs.filter((l) => l.message === "sweep_done").length, 0);
  assert.equal(await a.w.stripeKv.get(keys.lastSweep(STRIPE_SCOPE)), String(a.w.now.ms));

  const b = await scenario();
  slowListing(b.w);
  await assertStripeAsLone(a.w, at, answer, b.w);
});

for (const [took, advanceMs] of [
  ["most of the step-1 slice", BUDGET_MS - SWEEP_HOLD_SIDE_RESERVE_MS - SWEEP_MIN_SLICE_MS + 1_000],
  ["more than the whole budget", BUDGET_MS + 1_000],
] as const) {
  // Round 6: with Stripe primary (the first run). Behind a Beam primary a Stripe drain is a later run (below).
  test(`Stripe's step 1 took ${took} (Stripe primary): Beam is skipped and never called; the Stripe run (the first) still runs in full`, async () => {
    const slowList = (fake: typeof fetch, wall: { ms: number }) =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        if ((init?.method ?? "GET") === "GET" && url.pathname === "/v1/checkout/sessions") wall.ms += advanceMs;
        return fake(input, init);
      }) as typeof fetch;
    const a = await scenario({ stripeFetch: slowList });
    const beamCalls = a.w.beam.fakeBeam.calls.length;
    const at = mark(a.w);
    const answer = await sweepBoth(a.w, "stripe");
    assert.equal(answer.status, 502);
    assert.equal(answer.body.error, "out_of_time");
    assert.equal(answer.body.mode, "stripe-test");
    assert.deepEqual(runOf(answer, "beam"), { provider: "beam", mode: "beam-playground", ok: false, error: "out_of_time", skipped: "out of time" });
    assert.deepEqual(
      sweeperLogged(a.w, "sweep_run_skipped").map((l) => [l.data?.provider, l.data?.phase]),
      [["beam", "step 1"]],
    );
    assert.equal(a.w.beam.fakeBeam.calls.length, beamCalls, "no Beam call");
    assert.equal(a.w.beamOpens.length, 1, "opened once, for step 1");
    assert.equal(status(a.w, a.b1.reservationId), "not_confirmed");
    assert.equal(status(a.w, a.b2.reservationId), "not_confirmed");
    assert.equal(await a.w.beamKv.get(keys.lastSweep(BEAM_SCOPE)), null);
    assert.deepEqual([runOf(answer, "stripe").ok, runOf(answer, "stripe").released], [true, 2]);

    const b = await scenario({ stripeFetch: slowList });
    await assertStripeAsLone(a.w, at, answer, b.w, false);
  });
}

/** The Stripe fake behind `match`ing Checkout Session requests: `onMatch` runs first (it may move the wall clock or throw). */
const stripeOn =
  (match: (method: string, url: URL) => boolean, onMatch: (wall: { ms: number }) => void) =>
  (fake: typeof fetch, wall: { ms: number }) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (match(init?.method ?? "GET", url)) onMatch(wall);
      return fake(input, init);
    }) as typeof fetch;
const isSessionList = (method: string, url: URL) => method === "GET" && url.pathname === "/v1/checkout/sessions";

test("Beam primary, a Stripe drain whose session list takes most of the step-1 slice: Beam's step 1 and hold side go first and in full; the drain still runs", async () => {
  const advanceMs = BUDGET_MS - SWEEP_HOLD_SIDE_RESERVE_MS - SWEEP_MIN_SLICE_MS + 1_000;
  const a = await scenario({ stripeFetch: stripeOn(isSessionList, (wall) => void (wall.ms += advanceMs)) });
  const beamCalls = a.w.beam.fakeBeam.calls.length;
  const answer = await sweepBoth(a.w, "beam");
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.mode, "beam-playground");
  assert.deepEqual(
    answer.body.runs.map((r) => [r.provider, r.ok]),
    [
      ["stripe", true],
      ["beam", true],
    ],
  );
  assert.ok(a.w.beam.fakeBeam.calls.length > beamCalls);
  assert.deepEqual(
    [a.b1, a.b2, a.s1, a.s2].map((h) => status(a.w, h.reservationId)),
    ["confirmed", "canceled", "confirmed", "canceled"],
  );
  assert.equal(status(a.w, a.beamOrphan), "canceled");
  assert.equal(status(a.w, a.stripeOrphan), "canceled");
  assert.equal(await a.w.beamKv.get(keys.lastSweep(BEAM_SCOPE)), String(a.w.now.ms));
  assert.equal(await a.w.stripeKv.get(keys.lastSweep(STRIPE_SCOPE)), String(a.w.now.ms));
  assert.deepEqual(a.w.sweeperLogs, []);
});

test("Beam primary, a Stripe drain whose API hangs (cut at the step-1 slice's end, as stripeWithin cuts it): Beam confirms, releases and writes its heartbeat; the drain gets sweepPaidAndAlerts without a heartbeat; 502", async () => {
  const start = 1_000_000;
  // The bounded client gives the request what is left of the slice and no retry: it fails at the slice's end.
  const hang = (wall: { ms: number }) => {
    wall.ms = start + BUDGET_MS - SWEEP_HOLD_SIDE_RESERVE_MS;
    throw new TypeError("fetch failed: the request timed out");
  };
  const a = await scenario({ stripeFetch: stripeOn(isSessionList, hang) });
  assert.equal(a.w.wall.ms, start);
  const answer = await sweepBoth(a.w, "beam");
  assert.equal(answer.status, 502);
  assert.equal(answer.body.error, "payments_unavailable");
  assert.equal(answer.body.mode, "beam-playground");
  const beam = runOf(answer, "beam");
  assert.deepEqual([beam.ok, beam.fulfilled, beam.released, beam.errors], [true, 1, 2, 0]);
  assert.equal(status(a.w, a.b1.reservationId), "confirmed", "the paid Beam booking whose webhook was lost");
  assert.equal(status(a.w, a.b2.reservationId), "canceled", "the expired Beam hold");
  assert.equal(status(a.w, a.beamOrphan), "canceled");
  assert.equal(await a.w.beamKv.get(keys.lastSweep(BEAM_SCOPE)), String(a.w.now.ms));
  const stripe = runOf(answer, "stripe");
  assert.deepEqual([stripe.ok, stripe.error, stripe.errors, stripe.released, stripe.cloudbedsOk], [false, "payments_unavailable", 1, 0, true]);
  assert.equal(status(a.w, a.s1.reservationId), "not_confirmed");
  assert.equal(status(a.w, a.stripeOrphan), "not_confirmed");
  assert.equal(await a.w.stripeKv.get(keys.lastSweep(STRIPE_SCOPE)), null, "a Stripe run whose session list failed is no sweep");
  assert.deepEqual(
    sweeperLogged(a.w, "sweep_step1_failed").map((l) => l.data?.provider),
    ["stripe"],
  );
  assert.deepEqual(sweeperLogged(a.w, "sweep_run_skipped"), [], "Beam is never skipped");
  assert.equal(a.w.wall.ms - start, BUDGET_MS - SWEEP_HOLD_SIDE_RESERVE_MS, "the request's time: the step-1 slice");
});

test("Beam primary: the Stripe drain's hold side (a slow step 1b retry) comes after Beam's, so it can never eat Beam's hold-side slice", async () => {
  // A paid Stripe booking whose confirmation failed 49 hours ago (only step 1b retries it), whose re-read takes 52 s.
  let late: { sessionId: string; reservationId: string } | null = null;
  const slowRetrieve = stripeOn(
    (method, url) => method === "GET" && late !== null && url.pathname === `/v1/checkout/sessions/${late.sessionId}`,
    (wall) => void (wall.ms += BUDGET_MS - SWEEP_MIN_SLICE_MS + 2_000),
  );
  const w = world({ stripeFetch: slowRetrieve });
  const lateHeld = await held(w.stripe, [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }]);
  w.stripe.fakeStripe.complete(lateHeld.sessionId);
  w.cb.failNext("postReservationNote", "http500");
  w.cb.failNext("getReservation", "http500");
  await assert.rejects(fulfilPayment(lateHeld.sessionId, w.stripe.deps, stripeGateway(w.stripe.deps)));
  late = lateHeld;
  w.now.ms += 49 * 3600_000;
  const b1 = await beamHeld(w.beam);
  w.beam.fakeBeam.pay(b1.linkId, "CARD");
  const beamOrphan = await orphan(w.beam.deps.writer, w.cb, BEAM_ORPHAN_REF, "beam-playground");
  w.now.ms += ORPHAN_STALE_MS;
  const answer = await sweepBoth(w, "beam");
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(runOf(answer, "beam").ok, true);
  assert.equal(status(w, b1.reservationId), "confirmed");
  assert.equal(status(w, beamOrphan), "canceled", "Beam's hold side ran before the drain's slow retry");
  assert.equal(await w.beamKv.get(keys.lastSweep(BEAM_SCOPE)), String(w.now.ms));
  assert.equal(runOf(answer, "stripe").fulfilled, 1, "the drain's own retry still ran, after Beam's");
  assert.equal(status(w, lateHeld.reservationId), "confirmed");
  assert.deepEqual(sweeperLogged(w, "sweep_run_skipped"), []);
});

test("stripeWithin: every Checkout Session request gets what is left before the end as its timeout (read per page) and no retry; none is sent once the time is up", async () => {
  const clock = { ms: 1_000 };
  const sent: { call: string; args: unknown[]; timeout: number; maxNetworkRetries: number }[] = [];
  const record =
    (call: string) =>
    (...args: unknown[]) => {
      const options = args.at(-1) as { timeout: number; maxNetworkRetries: number };
      sent.push({ call, args: args.slice(0, -1), timeout: options.timeout, maxNetworkRetries: options.maxNetworkRetries });
      clock.ms += 400;
      // A second page of a list: the SDK reads the same options object again.
      if (call === "list") sent.push({ call: "list page 2", args: [], timeout: options.timeout, maxNetworkRetries: options.maxNetworkRetries });
      return Promise.resolve({ call });
    };
  const webhooks = { constructEvent: () => "untouched" };
  const real = { checkout: { sessions: { list: record("list"), retrieve: record("retrieve"), expire: record("expire"), create: () => "untouched create" } }, webhooks } as unknown as StripeClient;
  const bounded = stripeWithin(real, { deadlineMs: 2_000, clock: () => clock.ms });
  await bounded.checkout.sessions.list({ limit: 100 });
  await bounded.checkout.sessions.retrieve("cs_test_a1b2c3", { expand: ["payment_intent"] });
  assert.deepEqual(sent, [
    { call: "list", args: [{ limit: 100 }], timeout: 1_000, maxNetworkRetries: 0 },
    { call: "list page 2", args: [], timeout: 600, maxNetworkRetries: 0 },
    { call: "retrieve", args: ["cs_test_a1b2c3", { expand: ["payment_intent"] }], timeout: 600, maxNetworkRetries: 0 },
  ]);
  assert.equal(bounded.webhooks, real.webhooks, "every other member is the client's own");
  assert.equal((bounded.checkout.sessions as unknown as { create?: unknown }).create, undefined, "only list, retrieve and expire are reachable");
  clock.ms = 2_000;
  assert.throws(() => bounded.checkout.sessions.expire("cs_test_a1b2c3"), /Stripe request not sent: the sweeper run's time is up/);
  assert.equal(sent.length, 3, "nothing sent once the time is up");
});

test("a hold another provider's step 1 sees a payable payment for is left to that provider (each run gets the others' step 1)", async () => {
  const a = await scenario();
  // A Stripe Checkout Session of ours (this mode) naming the Beam orphan's reservation, still open.
  const ref = "MSV-20261005-PEER";
  await a.w.stripe.deps.stripe.checkout.sessions.create({
    mode: "payment",
    client_reference_id: ref,
    metadata: { msv_ref: ref, msv_cb_reservation_id: a.beamOrphan, msv_rooms_satang: "100000", msv_fee_satang: "0", msv_total_satang: "100000", msv_mode: "stripe-test" },
    line_items: [{ quantity: 1, price_data: { currency: "thb", unit_amount: 100_000, product_data: { name: "Room" } } }],
    success_url: "https://magicsamui.com/booking/return",
    expires_at: Math.floor(a.w.now.ms / 1000) + 3600,
  });
  const answer = await sweepBoth(a.w, "beam");
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(status(a.w, a.beamOrphan), "not_confirmed", "never released while Stripe's payment for it is payable");
  assert.deepEqual(
    a.w.beam.logs.filter((l) => l.message === "sweep_hold_left_to_peer").map((l) => [l.data?.reservationId, l.data?.states]),
    [[a.beamOrphan, ["open"]]],
  );
  assert.equal(runOf(answer, "stripe").sessionsChecked, 3);
  assert.equal(status(a.w, a.b2.reservationId), "canceled", "the rest is swept as usual");
});

/* ---------------------------------------- Stripe and Cloudbeds failing ---------------------------------------- */

test("a Stripe step 1 that throws: Stripe gets sweepPaidAndAlerts only (its holds kept), Beam's run goes on, 502", async () => {
  const gate = { on: false };
  const failingList = (fake: typeof fetch) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (gate.on && (init?.method ?? "GET") === "GET" && url.pathname === "/v1/checkout/sessions") {
        return new Response(JSON.stringify({ error: { type: "api_error", message: "simulated" } }), { status: 500, headers: { "content-type": "application/json" } });
      }
      return fake(input, init);
    }) as typeof fetch;
  const a = await scenario({ stripeFetch: failingList });
  gate.on = true;
  const answer = await sweepBoth(a.w, "stripe");
  assert.equal(answer.status, 502);
  assert.equal(answer.body.error, "payments_unavailable");
  const stripe = runOf(answer, "stripe");
  assert.deepEqual([stripe.ok, stripe.error, stripe.errors, stripe.released, stripe.cloudbedsOk], [false, "payments_unavailable", 1, 0, true]);
  assert.equal(status(a.w, a.s1.reservationId), "not_confirmed");
  assert.equal(status(a.w, a.s2.reservationId), "not_confirmed");
  assert.equal(status(a.w, a.stripeOrphan), "not_confirmed");
  // Round 6: no Stripe heartbeat though the shared listing worked - Stripe keeps no failure count of its own, so a
  // Stripe run whose session list failed is no sweep (checkout's stale-sweeper warning fires).
  assert.equal(await a.w.stripeKv.get(keys.lastSweep(STRIPE_SCOPE)), null, "a Stripe run whose session list failed writes no heartbeat");
  assert.ok(a.w.stripe.logs.some((l) => l.message === "sweep_done" && l.data?.step1Failed === true));
  const beam = runOf(answer, "beam");
  assert.deepEqual([beam.ok, beam.fulfilled, beam.released], [true, 1, 2]);
  assert.equal(status(a.w, a.beamOrphan), "canceled");
  assert.deepEqual(
    sweeperLogged(a.w, "sweep_step1_failed").map((l) => l.data?.provider),
    ["stripe"],
  );
});

test("a failed shared listing: listed once, each run counts it in its own scope and writes no heartbeat; 502; Stripe untouched", async () => {
  const a = await scenario();
  const listings = a.w.cb.count("getReservations");
  a.w.cb.failNext("getReservations", "http500");
  const at = mark(a.w);
  const answer = await sweepBoth(a.w, "stripe");
  assert.equal(answer.status, 502);
  assert.equal(answer.body.error, "cloudbeds_unavailable");
  for (const provider of ["stripe", "beam"] as const) {
    const r = runOf(answer, provider);
    assert.deepEqual([r.ok, r.error, r.cloudbedsOk], [false, "cloudbeds_unavailable", false], provider);
  }
  assert.equal(await a.w.stripeKv.get(keys.sweepCloudbedsFailures(STRIPE_SCOPE)), "1");
  assert.equal(await a.w.beamKv.get(keys.sweepCloudbedsFailures(BEAM_SCOPE)), "1");
  assert.equal(await a.w.stripeKv.get(keys.lastSweep(STRIPE_SCOPE)), null);
  assert.equal(await a.w.beamKv.get(keys.lastSweep(BEAM_SCOPE)), null);
  assert.ok(a.w.beam.logs.some((l) => l.message === "sweep_find_holds_failed"), "the Beam run handled the shared failure as its own");
  const listedNow = a.w.cb.count("getReservations") - listings;
  assert.equal(
    a.w.cb.calls.slice(at.cb).filter((c, i) => c.method === "getReservations" && a.w.beamCalls.has(at.cb + i)).length,
    0,
    "the Beam run never listed again",
  );

  const b = await scenario();
  await beamStep1(b.w);
  const bListings = b.w.cb.count("getReservations");
  b.w.cb.failNext("getReservations", "http500");
  const bt = mark(b.w);
  const lone = await runSweep(b.w.stripe.deps);
  assert.equal(listedNow, b.w.cb.count("getReservations") - bListings, "as many listing calls as a lone run");
  assert.deepEqual(stripeTape(a.w, at, summaryOf(runOf(answer, "stripe"))), stripeTape(b.w, bt, lone));
});

test("a run whose deps can't be built is reported failed; the others still run", async () => {
  const a = await scenario();
  const answer = await sweepProviders(
    [
      stripeRun(a.w, true),
      {
        provider: "beam",
        open: () => {
          throw new Error("no Beam deps");
        },
      },
    ],
    { deadlineMs: a.w.wall.ms + BUDGET_MS, clock: () => a.w.wall.ms, log: (message, data) => a.w.sweeperLogs.push({ message, data }) },
  );
  assert.equal(answer.status, 502);
  assert.deepEqual(runOf(answer, "beam"), { provider: "beam", mode: null, ok: false, error: "sweep_failed" });
  assert.deepEqual(
    sweeperLogged(a.w, "sweep_failed").map((l) => [l.data?.provider, l.data?.phase, l.data?.error]),
    [["beam", "step 1", "no Beam deps"]],
  );
  assert.deepEqual([runOf(answer, "stripe").ok, runOf(answer, "stripe").released], [true, 2]);
});

test("the shared listing is taken at the Stripe run's own listing point: its step 1b (a paid booking past the 48-hour lookback) runs first, as alone", async () => {
  // A paid Stripe booking whose confirmation failed 49 hours ago: only step 1b (the paid index) still retries it.
  let late: { sessionId: string; reservationId: string } | null = null;
  const build = async () => {
    const w = world();
    late = await held(w.stripe, [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }]);
    w.stripe.fakeStripe.complete(late.sessionId);
    w.cb.failNext("postReservationNote", "http500");
    w.cb.failNext("getReservation", "http500");
    await assert.rejects(fulfilPayment(late.sessionId, w.stripe.deps, stripeGateway(w.stripe.deps)));
    w.now.ms += 49 * 3600_000;
    const b1 = await beamHeld(w.beam);
    w.beam.fakeBeam.pay(b1.linkId, "CARD");
    w.now.ms += STALE_HOLD_MS + MIN;
    return { w, b1, late: late as { sessionId: string; reservationId: string } };
  };
  const a = await build();
  const at = mark(a.w);
  const answer = await sweepBoth(a.w, "stripe");
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(runOf(answer, "stripe").fulfilled, 1);
  assert.equal(runOf(answer, "stripe").sessionsChecked, 0, "past the Stripe list's 48 hours");
  assert.equal(status(a.w, a.late.reservationId), "confirmed");
  assert.equal(status(a.w, a.b1.reservationId), "confirmed");
  // The Stripe run's Cloudbeds calls: step 1b's confirmation first, then the listing - where a lone run lists.
  const stripeCalls = a.w.cb.calls.slice(at.cb).filter((_, i) => !a.w.beamCalls.has(at.cb + i)).map((c) => c.method);
  const listedAt = stripeCalls.indexOf("getReservations");
  assert.ok(listedAt > stripeCalls.indexOf("postPayment") && stripeCalls.indexOf("postPayment") >= 0, stripeCalls.join(", "));

  const b = await build();
  await assertStripeAsLone(a.w, at, answer, b.w);
});

test("the shared listing is the first caller's: a later run gets the same answer without a second call", async () => {
  // runSweep's listed option as a function: called with the run's time, its answer used as the run's own listing.
  const kit = makeKit();
  const seen: number[] = [];
  const rows: ListedReservation[] = [];
  const s = await runSweep(kit.deps, undefined, {
    listed: async (nowMs) => {
      seen.push(nowMs);
      return rows;
    },
  });
  assert.deepEqual(seen, [kit.now.ms]);
  assert.equal(s.cloudbedsOk, true);
  assert.equal(kit.fakeCb.count("getReservations"), 0);
  const failed = await runSweep(kit.deps, undefined, { listed: () => Promise.reject(new Error("listing down")) });
  assert.equal(failed.cloudbedsOk, false);
  assert.ok(kit.logs.some((l) => l.message === "sweep_find_holds_failed" && String(l.data?.error).includes("listing down")));
});

for (const primary of ["stripe", "beam"] as const) {
  test(`only the primary run (${primary}) tells the owner the shared hold index keeps growing`, async () => {
    const a = await scenario();
    // 51 fresh entries (not stale yet: only counted).
    for (let i = 0; i < 51; i++) await a.w.stripeKv.zadd(keys.holdIndex(), a.w.now.ms, `7100000000${String(i).padStart(3, "0")}`);
    const answer = await sweepBoth(a.w, primary);
    assert.equal(answer.status, 200);
    const told = (kit: Kit | BeamKit) => kit.alerts.filter((x) => x.subject === "The booking sweeper's hold index keeps growing").length;
    assert.deepEqual([told(a.w.stripe), told(a.w.beam)], primary === "stripe" ? [1, 0] : [0, 1]);
  });
}

test("a Beam step 1 that throws while the shared listing fails: no Beam heartbeat; the answer's error is the first failed run's", async () => {
  const a = await scenario();
  beamFailing(a.w, (_, url) => url.pathname === "/api/v1/charges" && !url.searchParams.has("sourceId"));
  a.w.cb.failNext("getReservations", "http500");
  const answer = await sweepBoth(a.w, "stripe");
  assert.equal(answer.status, 502);
  assert.equal(answer.body.error, "cloudbeds_unavailable", "Stripe's (the first run's) error");
  assert.deepEqual([runOf(answer, "stripe").error, runOf(answer, "stripe").cloudbedsOk], ["cloudbeds_unavailable", false]);
  assert.deepEqual([runOf(answer, "beam").error, runOf(answer, "beam").cloudbedsOk], ["payments_unavailable", false]);
  assert.equal(await a.w.beamKv.get(keys.lastSweep(BEAM_SCOPE)), null, "a run that could not look for orphan holds is no sweep");
  assert.equal(await a.w.stripeKv.get(keys.lastSweep(STRIPE_SCOPE)), null);
});

test("a run that throws at its hold side is reported sweep_failed; the other run's report stands", async () => {
  const a = await scenario();
  let opens = 0;
  const brokenAtHoldSide: SweepRun = {
    provider: "beam",
    open: (timing) => {
      const deps = beamDepsFor(a.w, timing);
      if (++opens === 2) {
        const kv = deps.kv;
        deps.kv = {
          ...kv,
          zrangeByScore: (key, min, max, limit) => (key === keys.holdIndex() ? Promise.reject(new Error("redis down")) : kv.zrangeByScore(key, min, max, limit)),
        };
      }
      return { deps, gw: beamGateway(deps) };
    },
  };
  const answer = await sweepProviders([stripeRun(a.w, true), brokenAtHoldSide], {
    deadlineMs: a.w.wall.ms + BUDGET_MS,
    clock: () => a.w.wall.ms,
    log: (message, data) => a.w.sweeperLogs.push({ message, data }),
  });
  assert.equal(answer.status, 502);
  assert.equal(answer.body.error, "sweep_failed");
  assert.deepEqual(runOf(answer, "beam"), { provider: "beam", mode: "beam-playground", ok: false, error: "sweep_failed" });
  assert.deepEqual(
    sweeperLogged(a.w, "sweep_failed").map((l) => [l.data?.provider, l.data?.phase, l.data?.error]),
    [["beam", "hold side", "redis down"]],
  );
  assert.deepEqual([runOf(answer, "stripe").ok, runOf(answer, "stripe").released], [true, 2]);
  assert.equal(status(a.w, a.b1.reservationId), "confirmed", "its step 1 had run");
});

/* ------------------------------------------------- the route ------------------------------------------------- */

// The route handlers import "@/..." paths and runtime.ts imports "next/server", which plain Node can't resolve: a
// resolve hook maps them to the same module URLs the relative imports use (as stripeGolden.test.ts does).
type ResolveHook = (specifier: string, context: unknown, nextResolve: (specifier: string, context?: unknown) => { url: string }) => { url: string; shortCircuit?: boolean };
let hooked = false;

async function loadSweepRoute() {
  if (!hooked) {
    hooked = true;
    const { registerHooks } = nodeModule as unknown as { registerHooks?: (hooks: { resolve: ResolveHook }) => void };
    if (!registerHooks) throw new Error("module.registerHooks is required (Node 22.15+ / 23.5+)");
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "next/server") return nextResolve("next/server.js", context);
        if (specifier.startsWith("@/")) {
          for (const ext of ["", ".ts", ".tsx", "/index.ts"]) {
            const url = new URL(`../../${specifier.slice(2)}${ext}`, import.meta.url);
            const path = fileURLToPath(url);
            if (existsSync(path) && statSync(path).isFile()) return { url: url.href, shortCircuit: true };
          }
        }
        return nextResolve(specifier, context);
      },
    });
  }
  return import("../../app/api/booking/sweep/route.ts");
}

interface RuntimeGlobals {
  [key: string]: unknown;
}
function runtimeGlobals(): RuntimeGlobals {
  const g = globalThis as typeof globalThis & { __msvBookingRuntime?: RuntimeGlobals };
  return (g.__msvBookingRuntime ??= {});
}

const SWEEP_SECRET = "sweep-secret-route-test-0123456789";
const BEAM_VARS: Env = { BEAM_API_BASE: BEAM_PLAYGROUND_BASE, BEAM_MERCHANT_ID, BEAM_API_KEY, BEAM_WEBHOOK_HMAC_KEY: BEAM_HMAC_KEY_B64 };
const MOCK_STRIPE: Env = { BOOKING_STRIPE_MOCK: "true", BOOKING_TOKEN_SECRET: TOKEN_SECRET, BOOKING_SWEEP_SECRET: SWEEP_SECRET };

/**
 * GETs the sweep route under `env` (Date frozen at NOW, then moved past the orphans' age), on one fake Cloudbeds,
 * one in-memory store, the stripe-mock fake and a fake Beam (runtime.ts's globals), with a Stripe and a Beam orphan
 * in Cloudbeds. The global fetch and node:http(s) (the Stripe SDK of a stripe-test drain) are blocked and recorded.
 */
interface RouteOptions {
  /** The mocked clock moves this much while the stripe-mock fake answers its session list. */
  stripeListMs?: number;
  /** Every Beam call moves it this much and then times out (counted in beamAttempts). */
  beamTimeoutMs?: number;
  /** Round 6: node:https never answers (a Stripe API that hangs): each request's own timeout fires, the mocked clock moved by it. */
  stripeHttpsHangs?: boolean;
  /** Round 6: Cloudbeds' API host reaches the fake Cloudbeds through the global fetch (the live writer); every other host stays blocked. */
  cloudbedsOverFetch?: boolean;
  /** Round 6: rt.redisKv is the in-memory store for the env's Upstash URL (live configs need Redis). */
  redisAsMemory?: boolean;
  /** Round 6: this runtime global throws when read, so the deps of the provider that reads it can't be built. */
  brokenGlobal?: "memoryKv" | "mock";
  /** Round 6: run at NOW, before the clock moves past the orphans' age (Beam bookings through the real checkout route). */
  seed?: (w: RouteSeed) => Promise<void>;
}

interface RouteSeed {
  cb: FakeCloudbeds;
  kv: KvStore;
  fakeBeam: FakeBeam;
  /** A Beam booking through the checkout route (demo availability), held and awaiting payment. */
  book(items: CartItemInput[]): Promise<{ linkId: string; reservationId: string }>;
}

/** The first 3-night window from Jan 2027 (after `skip` others) where the demo calendar has `slug` free. */
function demoWindow(slug: string, skip = 0): { checkIn: string; checkOut: string } {
  let found = 0;
  for (let i = 0; i < 300; i++) {
    const checkIn = addDays("2027-01-04", i * 4);
    const checkOut = addDays(checkIn, 3);
    if (buildOffers(demoInventory(checkIn, checkOut), 2).find((o) => o.slug === slug)?.available) {
      if (found === skip) return { checkIn, checkOut };
      found++;
    }
  }
  throw new Error(`no demo window for ${slug}`);
}

async function routeSweep(t: TestContext, env: Env, slow: RouteOptions = {}) {
  const stripeListMs = slow.stripeListMs ?? 0;
  const beamAttempts = { n: 0 };
  const savedEnv = process.env;
  const savedFetch = globalThis.fetch;
  const savedHttps = https.request;
  const savedHttp = http.request;
  const rt = runtimeGlobals();
  const savedGlobals = { ...rt };
  const network: string[] = [];
  const lines: string[] = [];
  /** The Stripe SDK's requests on a hanging node:https, with the timeout each one was sent with. */
  const httpsRequests: { target: string; timeoutMs: number | null }[] = [];
  try {
    process.env = { ...env } as NodeJS.ProcessEnv;
    let cloudbedsFetch: typeof fetch | null = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (cloudbedsFetch && new URL(url).host === "api.cloudbeds.com") return cloudbedsFetch(input, init);
      network.push(url);
      throw new TypeError("network blocked by sweepProviders.test.ts");
    }) as typeof fetch;
    const block = (proto: string) =>
      ((...args: unknown[]) => {
        const o = args[0] as { host?: string; hostname?: string; path?: string; method?: string } | string;
        network.push(`${proto} ${typeof o === "string" ? o : `${o.method ?? "GET"} ${o.hostname ?? o.host}${o.path ?? ""}`}`);
        throw new Error(`${proto} blocked by sweepProviders.test.ts`);
      }) as unknown as typeof https.request;
    const hanging = ((o: { host?: string; hostname?: string; path?: string; method?: string }) => {
      const entry = { target: `${o.method ?? "GET"} ${o.hostname ?? o.host}${o.path ?? ""}`, timeoutMs: null as number | null };
      httpsRequests.push(entry);
      network.push(`https ${entry.target}`);
      const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
      let destroyed = false;
      req.setTimeout = (ms: number, onTimeout: () => void) => {
        entry.timeoutMs = ms;
        setImmediate(() => {
          if (destroyed) return;
          t.mock.timers.setTime(Date.now() + ms);
          onTimeout();
        });
        return req;
      };
      req.write = () => true;
      req.end = () => req;
      req.destroy = (err?: Error) => {
        if (!destroyed) {
          destroyed = true;
          setImmediate(() => req.emit("error", err ?? new Error("destroyed")));
        }
        return req;
      };
      return req;
    }) as unknown as typeof https.request;
    https.request = slow.stripeHttpsHangs ? hanging : block("https");
    http.request = block("http");
    const route = await loadSweepRoute();
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    for (const level of ["info", "warn", "error"] as const) t.mock.method(console, level, (...args: unknown[]) => lines.push(String(args[0])));
    for (const key of Object.keys(rt)) delete rt[key];
    const cb = createFakeCloudbeds({ lenient: true, now: () => Date.now() });
    if (slow.cloudbedsOverFetch) cloudbedsFetch = cb.fetch;
    const kv = recordingKv(createMemoryKv(() => Date.now()));
    const fakeBeam = createFakeBeam({ now: () => Date.now(), merchantId: BEAM_MERCHANT_ID, apiKey: BEAM_API_KEY, hmacKeyB64: BEAM_HMAC_KEY_B64, base: "playground" });
    const fakeStripe = createFakeStripe({ webhookSecret: MOCK_STRIPE_WEBHOOK_SECRET, now: () => Date.now() });
    const stripeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if ((init?.method ?? "GET") === "GET" && url.pathname === "/v1/checkout/sessions") t.mock.timers.setTime(Date.now() + stripeListMs);
      return fakeStripe.fetch(input, init);
    }) as typeof fetch;
    const broken = (name: string): PropertyDescriptor => ({
      configurable: true,
      enumerable: true,
      get(): never {
        throw new Error(`runtime global ${name} unavailable (sweepProviders.test.ts)`);
      },
    });
    if (slow.brokenGlobal === "mock") Object.defineProperty(rt, "mock", broken("mock"));
    else rt.mock = { stripe: { ...fakeStripe, fetch: stripeFetch }, cloudbeds: cb, kv };
    if (slow.brokenGlobal === "memoryKv") Object.defineProperty(rt, "memoryKv", broken("memoryKv"));
    else rt.memoryKv = kv;
    if (slow.redisAsMemory && env.UPSTASH_REDIS_REST_URL) rt.redisKv = { url: env.UPSTASH_REDIS_REST_URL, kv };
    rt.mockWriterCloudbeds = cb;
    rt.beamFetch =
      slow.beamTimeoutMs === undefined
        ? fakeBeam.fetch
        : ((async () => {
            beamAttempts.n++;
            t.mock.timers.setTime(Date.now() + (slow.beamTimeoutMs ?? 0));
            throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
          }) as typeof fetch);
    const stripeOrphan = cb.book("462960", "2027-12-01", "2027-12-02", holdIdentifier(STRIPE_ORPHAN_REF, "stripe-mock"));
    const beamOrphan = cb.book("462961", "2027-12-01", "2027-12-02", holdIdentifier(BEAM_ORPHAN_REF, "beam-playground"));
    for (const id of [stripeOrphan, beamOrphan]) cb.reservations.get(id)!.status = "not_confirmed";
    if (slow.seed) {
      const { POST: checkout } = await import("../../app/api/booking/checkout/route.ts");
      let n = 0;
      const post = (body: unknown) =>
        checkout(
          new Request("http://localhost:3000/api/booking/checkout", {
            method: "POST",
            headers: { host: "localhost:3000", "x-forwarded-for": `198.51.100.${60 + n++}`, "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        );
      await slow.seed({
        cb,
        kv,
        fakeBeam,
        async book(items) {
          const req = { ...demoWindow(items[0].slug, n), items, termsVersion: POLICY_VERSION, guest: GUEST, payMethod: "card_ewallet" };
          const quoted = await post({ ...req, expectedTotalSatang: 1, expectedDueNowSatang: 1 });
          assert.equal(quoted.status, 409);
          const { quote } = (await quoted.json()) as { quote: Quote };
          const res = await post({ ...req, expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang });
          const body = (await res.json()) as CheckoutSuccess;
          assert.equal(res.status, 200, JSON.stringify(body));
          assert.equal(body.provider, "beam");
          return { linkId: new URL(body.redirectUrl).pathname.split("/").pop() ?? "", reservationId: body.holdReservationId ?? "" };
        },
      });
    }
    t.mock.timers.setTime(NOW + ORPHAN_STALE_MS);
    const arrivedAt = Date.now();
    const res = await route.GET(new Request("http://localhost:3000/api/booking/sweep", { headers: { authorization: `Bearer ${SWEEP_SECRET}` } }));
    const elapsedMs = Date.now() - arrivedAt;
    return {
      status: res.status,
      cacheControl: res.headers.get("cache-control"),
      body: (await res.json()) as Record<string, unknown> & { runs?: SweepRunReport[] },
      cb,
      kv,
      fakeBeam,
      network,
      lines,
      beamAttempts: beamAttempts.n,
      stripeOrphan,
      beamOrphan,
      httpsRequests,
      elapsedMs,
    };
  } finally {
    for (const key of Object.keys(rt)) delete rt[key];
    Object.assign(rt, savedGlobals);
    process.env = savedEnv;
    globalThis.fetch = savedFetch;
    https.request = savedHttps;
    http.request = savedHttp;
  }
}

test("the route: a Stripe deployment with a Beam drain sweeps both (Stripe primary), each orphan by its own run", async (t) => {
  const r = await routeSweep(t, { BOOKING_PAYMENT_PROVIDER: "stripe", ...MOCK_STRIPE, ...BEAM_VARS });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.cacheControl, "no-store");
  assert.equal(r.body.ok, true);
  assert.equal(r.body.mode, "stripe-mock");
  assert.deepEqual(
    r.body.runs?.map((x) => [x.provider, x.mode, x.ok, x.released]),
    [
      ["stripe", "stripe-mock", true, 1],
      ["beam", "beam-playground", true, 1],
    ],
  );
  assert.equal(r.body.released, 1, "the primary (Stripe) run's summary");
  assert.equal(r.cb.reservations.get(r.stripeOrphan)?.status, "canceled");
  assert.equal(r.cb.reservations.get(r.beamOrphan)?.status, "canceled");
  assert.equal(r.cb.count("getReservations"), 1);
  assert.ok(r.fakeBeam.calls.some((c) => c.method === "GET" && c.path === "/api/v1/charges"), "Beam's charge scan");
  assert.notEqual(await r.kv.get(keys.lastSweep(keyScope("stripe-mock"))), null);
  assert.notEqual(await r.kv.get(keys.lastSweep(BEAM_SCOPE)), null);
  assert.deepEqual(r.network, []);
});

test("the route: a Beam deployment with a Stripe drain sweeps both (Beam primary); the drain's failing Stripe never stops the Beam run", async (t) => {
  // A Stripe drain needs a Stripe key, so it is stripe-test: its SDK's requests are blocked here, so its step 1 fails.
  const r = await routeSweep(t, { BOOKING_PAYMENT_PROVIDER: "beam", ...MOCK_STRIPE, STRIPE_SECRET_KEY: "sk_test_routetest0123456789", ...BEAM_VARS });
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.equal(r.body.error, "payments_unavailable");
  assert.equal(r.body.mode, "beam-playground", "the active config's provider is primary");
  assert.deepEqual(
    r.body.runs?.map((x) => [x.provider, x.mode, x.ok, x.error ?? null]),
    [
      ["stripe", "stripe-test", false, "payments_unavailable"],
      ["beam", "beam-playground", true, null],
    ],
  );
  assert.equal(r.body.released, 1, "the primary (Beam) run's summary");
  assert.equal(r.cb.reservations.get(r.beamOrphan)?.status, "canceled");
  assert.equal(r.cb.reservations.get(r.stripeOrphan)?.status, "not_confirmed", "no hold side for a provider whose step 1 failed");
  assert.equal(await r.kv.get(keys.lastSweep(keyScope("stripe-test"))), null, "no heartbeat for a Stripe run whose session list failed (round 6)");
  assert.notEqual(await r.kv.get(keys.lastSweep(BEAM_SCOPE)), null, "Beam's heartbeat");
  assert.ok(r.network.length > 0 && r.network.every((n) => n.startsWith("https ") && n.includes("api.stripe.com")), r.network.join(", "));
  assert.ok(r.lines.some((l) => l.includes("sweep_step1_failed")));
});

test("the route's budget is 55 seconds from arrival: a Stripe step 1 taking 31 of them leaves Beam's step 1 (which must end 20 s early) out of time", async (t) => {
  const r = await routeSweep(t, { BOOKING_PAYMENT_PROVIDER: "stripe", ...MOCK_STRIPE, ...BEAM_VARS }, { stripeListMs: 31_000 });
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.equal(r.body.error, "out_of_time");
  assert.deepEqual(r.body.runs?.[1], { provider: "beam", mode: "beam-playground", ok: false, error: "out_of_time", skipped: "out of time" });
  assert.equal(r.body.runs?.[0].ok, true);
  assert.equal(r.fakeBeam.calls.length, 0);
  assert.equal(r.cb.reservations.get(r.stripeOrphan)?.status, "canceled");
  assert.equal(r.cb.reservations.get(r.beamOrphan)?.status, "not_confirmed");
  assert.ok(r.lines.some((l) => l.includes("sweep_run_skipped")));
});

test("the route gives Beam's step 1 the deadline of its slice (55 - 20 s): a timed-out scan attempt is not retried past it", async (t) => {
  // Stripe's list takes 29 s: Beam's step 1 starts with 6 s of its slice left; its first attempt times out after 10 s.
  const r = await routeSweep(t, { BOOKING_PAYMENT_PROVIDER: "stripe", ...MOCK_STRIPE, ...BEAM_VARS }, { stripeListMs: 29_000, beamTimeoutMs: 10_000 });
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.equal(r.beamAttempts, 1, "no retry and no 72-hour pass once the slice is spent");
  assert.deepEqual([r.body.runs?.[1].provider, r.body.runs?.[1].error], ["beam", "payments_unavailable"]);
  assert.equal(r.body.runs?.[0].ok, true);
});

test("the route: without a Beam config (active or drain) it answers the single Stripe sweep, with no runs and no Beam call", async (t) => {
  const r = await routeSweep(t, { BOOKING_PAYMENT_PROVIDER: "stripe", ...MOCK_STRIPE });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, "stripe-mock");
  assert.equal("runs" in r.body, false);
  assert.equal(r.body.released, 1, "its own orphan");
  assert.equal(r.cb.reservations.get(r.beamOrphan)?.status, "not_confirmed", "a Beam hold is never a Stripe run's");
  assert.equal(r.fakeBeam.calls.length, 0);
  assert.deepEqual(Object.keys(r.body), ["ok", "mode", "sessionsChecked", "fulfilled", "released", "holdsChecked", "skippedOpen", "skippedYoung", "skippedOtherMode", "openHolds", "errors", "cloudbedsOk", "undeliveredAlerts", "paidUnconfirmed", "pruned"]);
});

/* ------------------------------------------------ round 6 ------------------------------------------------ */

const STRIPE_TEST_DRAIN_KEY = "sk_test_routetest0123456789";
const SUNRISE: CartItemInput[] = [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];

test("the route: Beam primary with a Stripe drain whose API hangs - Beam confirms, releases and writes its heartbeat; the drain's one request is cut at the step-1 slice's end (no retry); 502", async (t) => {
  let paid: { linkId: string; reservationId: string } | null = null;
  let unpaid: { linkId: string; reservationId: string } | null = null;
  const r = await routeSweep(
    t,
    { BOOKING_PAYMENT_PROVIDER: "beam", ...MOCK_STRIPE, STRIPE_SECRET_KEY: STRIPE_TEST_DRAIN_KEY, ...BEAM_VARS },
    {
      stripeHttpsHangs: true,
      seed: async (w) => {
        paid = await w.book(GARDEN);
        w.fakeBeam.pay(paid.linkId, "CARD"); // its webhook is lost
        unpaid = await w.book(SUNRISE);
      },
    },
  );
  const p = paid as unknown as { linkId: string; reservationId: string };
  const u = unpaid as unknown as { linkId: string; reservationId: string };
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.equal(r.body.error, "payments_unavailable");
  assert.equal(r.body.mode, "beam-playground");
  assert.deepEqual(
    r.body.runs?.map((x) => [x.provider, x.mode, x.ok, x.error ?? null]),
    [
      ["stripe", "stripe-test", false, "payments_unavailable"],
      ["beam", "beam-playground", true, null],
    ],
  );
  assert.equal(r.cb.reservations.get(p.reservationId)?.status, "confirmed", "the paid Beam booking whose webhook was lost");
  assert.equal(r.cb.reservations.get(u.reservationId)?.status, "canceled", "the expired Beam hold");
  assert.equal(r.cb.reservations.get(r.beamOrphan)?.status, "canceled");
  assert.equal(r.cb.reservations.get(r.stripeOrphan)?.status, "not_confirmed", "no hold side for the drain whose step 1 failed");
  assert.notEqual(await r.kv.get(keys.lastSweep(BEAM_SCOPE)), null, "Beam's heartbeat");
  assert.equal(await r.kv.get(keys.lastSweep(keyScope("stripe-test"))), null, "no heartbeat for the drain");
  // One Stripe request (no retry), sent with what was left of the step-1 slice (Beam's step 1 took no mocked time).
  assert.deepEqual(
    r.httpsRequests.map((x) => [x.target.split("?")[0], x.timeoutMs]),
    [["GET api.stripe.com/v1/checkout/sessions", BUDGET_MS - SWEEP_HOLD_SIDE_RESERVE_MS]],
  );
  assert.equal(r.elapsedMs, BUDGET_MS - SWEEP_HOLD_SIDE_RESERVE_MS, "the request took the step-1 slice, not the Stripe client's 3 x 15 s");
  assert.ok(r.lines.includes("[booking] sweep_step1_failed"));
  assert.ok(!r.lines.includes("[booking] sweep_run_skipped"), "Beam is never skipped");
});

test("the route: a Stripe-live deployment with a Beam drain whose Stripe session list fails writes no live heartbeat, so checkout's stale-sweeper warning fires after SWEEP_STALE_ALERT_MS", async (t) => {
  const env: Env = { ...STRIPE_LIVE_ENV, ...BEAM_VARS, BOOKING_SWEEP_SECRET: SWEEP_SECRET };
  // The last good sweep ran 20 minutes before this one.
  const lastGood = NOW + ORPHAN_STALE_MS - 20 * MIN;
  const r = await routeSweep(t, env, {
    cloudbedsOverFetch: true,
    redisAsMemory: true,
    seed: async (w) => void (await w.kv.set(keys.lastSweep("live"), String(lastGood), 7 * 24 * 3600)),
  });
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.equal(r.body.mode, "stripe-live");
  assert.deepEqual(
    r.body.runs?.map((x) => [x.provider, x.mode, x.ok, x.error ?? null, x.cloudbedsOk]),
    [
      ["stripe", "stripe-live", false, "payments_unavailable", true],
      ["beam", "beam-playground", true, null, true],
    ],
  );
  assert.ok(r.network.some((n) => n.startsWith("https ") && n.includes("api.stripe.com")), "the session list was asked (and failed)");
  assert.equal(await r.kv.get(keys.lastSweep("live")), String(lastGood), "the failed Stripe run is no sweep: the heartbeat stays the last good one's");
  assert.notEqual(await r.kv.get(keys.lastSweep(BEAM_SCOPE)), null, "the Beam drain's own heartbeat");
  const alerts: string[][] = [];
  const deps = { config: getFulfilmentConfig(env), kv: r.kv, alert: async (subject: string, lines: string[]) => void alerts.push([subject, ...lines]) };
  await checkSweeperFresh(deps, lastGood + SWEEP_STALE_ALERT_MS - MIN);
  assert.equal(alerts.length, 0, "inside SWEEP_STALE_ALERT_MS of the last good sweep: no warning yet");
  await checkSweeperFresh(deps, lastGood + SWEEP_STALE_ALERT_MS + MIN);
  assert.deepEqual(alerts.map((a) => a.slice(0, 2)), [["The booking sweeper has not run recently", "The last successful sweep was 31 minutes ago."]]);
});

test("the route: the Beam deps can't be built (a Beam config exists) - the Beam run fails sweep_failed, the Stripe run still sweeps; 502", async (t) => {
  const r = await routeSweep(t, { BOOKING_PAYMENT_PROVIDER: "stripe", ...MOCK_STRIPE, ...BEAM_VARS }, { brokenGlobal: "memoryKv" });
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.equal(r.body.error, "sweep_failed");
  assert.equal(r.body.mode, "stripe-mock");
  assert.deepEqual(r.body.runs?.map((x) => [x.provider, x.mode, x.ok, x.error ?? null]), [
    ["stripe", "stripe-mock", true, null],
    ["beam", null, false, "sweep_failed"],
  ]);
  assert.deepEqual(r.body.runs?.[1], { provider: "beam", mode: null, ok: false, error: "sweep_failed" });
  assert.equal(r.cb.reservations.get(r.stripeOrphan)?.status, "canceled", "the Stripe orphan released by the Stripe run");
  assert.equal(r.cb.reservations.get(r.beamOrphan)?.status, "not_confirmed");
  assert.equal(r.fakeBeam.calls.length, 0);
  assert.ok(r.lines.includes("[booking] sweep_failed"));
});

test("the route: the Stripe deps can't be built (a Beam config exists) - the Stripe run fails sweep_failed, the Beam run still sweeps; 502", async (t) => {
  const r = await routeSweep(t, { BOOKING_PAYMENT_PROVIDER: "stripe", ...MOCK_STRIPE, ...BEAM_VARS }, { brokenGlobal: "mock" });
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.equal(r.body.error, "sweep_failed");
  assert.deepEqual(r.body.runs?.[0], { provider: "stripe", mode: null, ok: false, error: "sweep_failed" });
  assert.deepEqual(r.body.runs?.map((x) => [x.provider, x.mode, x.ok]), [
    ["stripe", null, false],
    ["beam", "beam-playground", true],
  ]);
  assert.equal(r.cb.reservations.get(r.beamOrphan)?.status, "canceled", "the Beam orphan released by the Beam run");
  assert.equal(r.cb.reservations.get(r.stripeOrphan)?.status, "not_confirmed");
  assert.ok(r.lines.includes("[booking] sweep_failed"));
});

/** 300 characters naming a guest's email and phone number. */
const PII_ERROR = `Beam said: guest guest@example.com called from +66 81 234 5678 about it ${"x".repeat(300)}`.slice(0, 300);

function assertRedacted(logged: unknown): void {
  const text = String(logged);
  assert.ok(text.includes("[email]") && text.includes("[number]"), text);
  assert.ok(!text.includes("guest@example.com") && !text.includes("234 5678"), text);
  assert.ok(text.length <= 200, `${text.length} characters`);
}

test("sweep_step1_failed and sweep_failed log the error redacted (no email, no phone number) and at most 200 characters long", async () => {
  assert.equal(PII_ERROR.length, 300);
  const a = await scenario();
  const throwingStep1: SweepRun = {
    provider: "beam",
    open: (timing) => {
      const deps = beamDepsFor(a.w, timing);
      return { deps, gw: { ...beamGateway(deps), sweepRecent: () => Promise.reject(new Error(PII_ERROR)) } };
    },
  };
  const log = (message: string, data?: Record<string, unknown>) => a.w.sweeperLogs.push({ message, data });
  await sweepProviders([stripeRun(a.w, true), throwingStep1], { deadlineMs: a.w.wall.ms + BUDGET_MS, clock: () => a.w.wall.ms, log });
  const step1 = sweeperLogged(a.w, "sweep_step1_failed");
  assert.equal(step1.length, 1);
  assertRedacted(step1[0].data?.error);

  const unbuildable: SweepRun = {
    provider: "beam",
    open: () => {
      throw new Error(PII_ERROR);
    },
  };
  await sweepProviders([stripeRun(a.w, true), unbuildable], { deadlineMs: a.w.wall.ms + BUDGET_MS, clock: () => a.w.wall.ms, log });
  const failedLog = sweeperLogged(a.w, "sweep_failed");
  assert.equal(failedLog.length, 1);
  assert.equal(failedLog[0].data?.phase, "step 1");
  assertRedacted(failedLog[0].data?.error);
});

test("the Beam run reports what its tracking read (links) in runs[], and at the top level only as the primary; Stripe's run never carries it (round 6)", async () => {
  for (const primary of ["stripe", "beam"] as const) {
    const a = await scenario();
    const answer = await sweepBoth(a.w, primary);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(runOf(answer, "beam").links, { open: 2, scanned: 1, watched: 0, pendingWatched: 0, watchedRead: 0, watchCovered: 0 }, primary);
    assert.equal("links" in runOf(answer, "stripe"), false, primary);
    assert.equal("links" in answer.body, primary === "beam", `${primary}: the top level is the primary run's summary`);
  }
});

test("one clock per run: each run's hold side and heartbeat keep the time taken before its step 1, as a lone run (round 6)", async () => {
  const a = await scenario();
  const t0 = a.w.now.ms;
  // Beam's first call (in its step 1, after Stripe's step 1) moves the business clock by 30 seconds.
  const fake = a.w.beam.fakeBeam.fetch;
  let moved = false;
  a.w.beamFetch.current = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!moved) {
      moved = true;
      a.w.now.ms += 30_000;
    }
    return fake(input, init);
  }) as typeof fetch;
  const answer = await sweepBoth(a.w, "stripe");
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(a.w.now.ms, t0 + 30_000);
  assert.equal(await a.w.stripeKv.get(keys.lastSweep(STRIPE_SCOPE)), String(t0), "the Stripe run's time: before its step 1");
  assert.equal(await a.w.beamKv.get(keys.lastSweep(BEAM_SCOPE)), String(t0), "the Beam run's time: before its step 1 (before its first Beam call)");
});

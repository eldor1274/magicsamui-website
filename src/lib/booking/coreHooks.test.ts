// The optional hooks of the sweeper, the hold-first checkout core and status (Beam design step S2.6). An
// "Acme" gateway (the Stripe gateway under another provider and brand, as in fulfilHooks.test.ts) sets
// releaseGuard, parseHoldId, isPaymentId and pendingReleasedAlert, and can make a payment read 'refunded',
// carry a mismatch or a pendingReason, which Stripe never reports; an "Acme" checkout adapter sets
// holdNoteDeadline, closedWord and beforeHold. They drive the real code on the in-repo fakes:
// - sweep: a refunded payment goes to fulfil (needs_attention) in step 1 and on the hold side and is never
//   released; every release asks the guard and is followed by afterPaymentReleased; the run owns the
//   orphans its own parser reads when ownsOrphans is set; only the primary run raises the index-size alert;
// - checkout: a beforeHold refusal writes nothing; the hold note and the crash alert use the adapter's words;
// - status: pendingReason on pending answers; 'unconfirmed' -> released, answered pending (never expired or
//   cancelled, so no "Try again"); a mismatch -> the mismatch answer; `s` is read for Stripe only and a
//   link token through gw.isPaymentId.
// The Stripe gateway and adapter set none of the hooks (the adapter only names today's two literals), so
// their calls, texts, KV writes and TTLs are those the golden snapshot (stripeGolden.test.ts) pins.

import { test } from "node:test";
import assert from "node:assert/strict";
import { getCartInventory } from "./availability.ts";
import { PAYMENT_LINK_TTL_MINUTES } from "./config.ts";
import { todayInBangkok } from "./dates.ts";
import { DEFAULT_CLOSED_WORD, DEFAULT_HOLD_NOTE_DEADLINE, startHoldFirstCheckout } from "./holdFirstCheckout.ts";
import type { CheckoutAdapter, HoldFirstCheckoutContext } from "./holdFirstCheckout.ts";
import { createMemoryKv } from "./kv.ts";
import { holdIdentifier, keyScope, keys, parseBeamHoldIdentifier, parseHoldIdentifier, readJson } from "./lock.ts";
import type { FulfilDone } from "./fulfil.ts";
import type { GatewayPayment, GatewayState, PaymentGateway } from "./payments/gateway.ts";
import { stripeGateway } from "./payments/stripeGateway.ts";
import { requestPaymentKey } from "./providerDispatch.ts";
import { canRetryPayment, returnViewKind } from "./returnView.ts";
import { runStatus } from "./status.ts";
import { fail, stripeCheckoutAdapter } from "./stripeCheckout.ts";
import type { StripeCheckoutInput } from "./stripeCheckout.ts";
import type { CoreDeps } from "./stripeDeps.ts";
import { RELEASE_ALERT_AGE_MS, STALE_HOLD_MS, runSweep } from "./sweep.ts";
import type { RecentPayments } from "./sweep.ts";
import { GUEST, HONEYMOON, NOW, ORIGIN, TOKEN_SECRET, checkout, makeKit, recordingKv, request, serverQuote, sessionIdOf } from "./testkit.ts";
import type { Kit } from "./testkit.ts";
import { createBookingToken, verifyBookingToken } from "./token.ts";
import type { BookingSummary, CheckoutSuccess, StatusResponse } from "./types.ts";

/** An orphan is aged by Cloudbeds' own clock, read cautiously (up to 7 h young): past this it is stale. */
const ORPHAN_STALE_MS = STALE_HOLD_MS + 7 * 3600_000 + 60_000;

/* --------------------------------- Acme --------------------------------- */

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
  /** releaseGuard's answer. */
  guard: { answer: boolean };
  /** blind: sweepRecent lists nothing (the sweeper's step 1 never sees the payment). */
  view: { blind: boolean };
}

/** The Stripe gateway as provider "beam" under Acme's brand and words, with the S2.5/S2.6 hooks set. */
function acmeGateway(kit: Kit, extra: Partial<PaymentGateway> = {}): Acme {
  const inner = stripeGateway(kit.deps);
  const calls: string[] = [];
  const override: Override = {};
  const guard = { answer: true };
  const view = { blind: false };
  const adjust = (p: GatewayPayment): GatewayPayment => ({ ...p, receipt: { ...p.receipt, methodType: "QR" }, ...override });
  const gw: PaymentGateway = {
    ...inner,
    provider: "beam",
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
      if (view.blind) return [];
      return (await inner.sweepRecent(sinceMs)).map((listed) => ({ ...listed, read: async () => adjust(await listed.read()) }));
    },
    async releaseGuard(key) {
      calls.push(`guard ${key}`);
      return guard.answer;
    },
    isPaymentId: (id: unknown): id is string => typeof id === "string" && id.startsWith("cs_test_"),
    text: {
      ...inner.text,
      paidVia: (receipt, amount) => `via Acme ${receipt.primaryId ?? "-"} (${amount})`,
      sessionLabel: { long: "payment link", short: "link" },
      refundWhere: "in the Acme dashboard",
      releaseNoteText: (payments) => `Hold released by the sweeper: Acme link ${payments.map((p) => p.state).join(", ") || "never created"}.`,
      pendingReleasedAlert: (payment, reservationId) => ({
        subject: `Acme payment still pending: hold ${reservationId} released (booking ${payment.meta?.ref ?? "-"})`,
        lines: [`A ${payment.receipt.methodType ?? "?"} payment on Acme link ${payment.paymentId} was still waiting for the bank when the hold was released.`],
        key: `acme-pending-released:${payment.paymentId}`,
        severity: "warning",
      }),
    },
    ...extra,
  };
  return { gw, calls, override, guard, view };
}

/** The deps of an Acme run in its own mode (its own key scope) on the same Cloudbeds and Redis. */
const acmeDeps = (kit: Kit): CoreDeps => ({ ...kit.deps, config: { ...kit.config, paymentMode: "beam-playground" } });

async function held(kit: Kit = makeKit()) {
  const res = await checkout(kit);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  const session = kit.fakeStripe.session(sessionIdOf(body))!;
  const t = new URL(session.success_url.replace("{CHECKOUT_SESSION_ID}", "x")).searchParams.get("t")!;
  const v = verifyBookingToken(t, TOKEN_SECRET, kit.now.ms);
  if (!v.ok) throw new Error("bad token");
  return { kit, ...acmeGateway(kit), key: session.id, reservationId: body.holdReservationId as string, ref: body.ref, t, l: body.linkToken!, booking: v.payload.booking };
}

const status = (kit: Kit, reservationId: string) => kit.fakeCb.reservations.get(reservationId)?.status;
const notes = (kit: Kit, reservationId: string) => kit.fakeCb.reservations.get(reservationId)?.notes ?? [];
const cancels = (kit: Kit) => kit.fakeCb.calls.filter((c) => c.method === "putReservation" && c.params.status === "canceled").length;
const urgent = (kit: Kit, from: number) => kit.alerts.slice(from).filter((a) => a.severity === "critical");

async function holdIndexed(kit: Kit, reservationId: string): Promise<boolean> {
  return (await kit.deps.kv.zrangeByScore(keys.holdIndex(), 0, Number.MAX_SAFE_INTEGER, 500)).includes(reservationId);
}

/** A Cloudbeds hold carrying `identifier` that we hold neither a record nor an intent of (Redis lost them). */
async function orphan(kit: Kit, ref: string, identifier: string, state: "not_confirmed" | "confirmed", roomTypeId: string): Promise<string> {
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
  kit.fakeCb.reservations.get(hold.reservationId)!.status = state;
  return hold.reservationId;
}

/* ------------------------------ sweep: refunded ------------------------------ */

test("sweep step 1: a refunded payment goes to fulfil (one CRITICAL needs_attention) and is never released, on this run or later ones", async () => {
  const { kit, gw, override, key, reservationId, ref } = await held();
  kit.fakeStripe.complete(key);
  override.state = "refunded";
  const from = kit.alerts.length;

  const first = await runSweep(kit.deps, gw);
  assert.equal(first.sessionsChecked, 1);
  assert.equal(first.released, 0);
  assert.equal(first.fulfilled, 0);
  assert.deepEqual(
    urgent(kit, from).map((a) => a.subject),
    [`URGENT: paid booking ${ref} needs attention`],
  );
  assert.ok(urgent(kit, from)[0].lines[0].startsWith("REFUNDED at Acme before the booking was confirmed"), urgent(kit, from)[0].lines[0]);
  assert.equal((await readJson<FulfilDone>(kit.deps.kv, keys.fulfilDone(key)))?.state, "needs_attention");
  assert.equal(await holdIndexed(kit, reservationId), false, "fulfil closed the hold");

  // Later runs, past the hold's age: step 1 skips it (done) and the hold side (Cloudbeds' list still shows the
  // reservation, with our record) hands it to fulfil again, which answers from its marker - never a release.
  for (let i = 0; i < 3; i++) {
    kit.now.ms += STALE_HOLD_MS + 5 * 60_000;
    const s = await runSweep(kit.deps, gw);
    assert.equal(s.released, 0);
    assert.equal(s.errors, 0);
  }
  assert.equal(status(kit, reservationId), "not_confirmed", "neither confirmed nor cancelled: the owner settles it");
  assert.equal(cancels(kit), 0);
  assert.equal(kit.fakeCb.count("postPayment"), 0);
  assert.equal(urgent(kit, from).length, 1, "the owner is told once");
});

test("sweep hold side: a refunded payment step 1 never saw (read through the hold record) is handed to fulfil, never released", async () => {
  const { kit, gw, calls, override, view, key, reservationId, ref } = await held();
  kit.fakeStripe.expire(key);
  override.state = "refunded";
  view.blind = true;
  kit.now.ms += STALE_HOLD_MS + 5 * 60_000;
  const from = kit.alerts.length;

  const s = await runSweep(kit.deps, gw);
  assert.equal(s.sessionsChecked, 0, "step 1 saw nothing");
  assert.equal(s.holdsChecked, 1);
  assert.equal(s.released, 0);
  assert.equal(status(kit, reservationId), "not_confirmed");
  assert.equal(cancels(kit), 0);
  assert.equal(calls.some((c) => c.startsWith("guard")), false, "no release was even attempted");
  assert.deepEqual(
    urgent(kit, from).map((a) => a.subject),
    [`URGENT: paid booking ${ref} needs attention`],
  );
  assert.equal((await readJson<FulfilDone>(kit.deps.kv, keys.fulfilDone(key)))?.state, "needs_attention");

  kit.now.ms += STALE_HOLD_MS;
  assert.equal((await runSweep(kit.deps, gw)).released, 0);
  assert.equal(status(kit, reservationId), "not_confirmed");
  assert.equal(urgent(kit, from).length, 1);
});

/* ---------------------------- sweep: release guard ---------------------------- */

test("sweep step 1 and the hold side: every release asks gw.releaseGuard for the payment's key; false keeps the hold, true releases it", async () => {
  const { kit, gw, calls, guard, key, reservationId } = await held();
  kit.fakeStripe.expire(key);
  guard.answer = false;
  kit.now.ms += STALE_HOLD_MS + 5 * 60_000;

  const kept = await runSweep(kit.deps, gw);
  assert.equal(kept.released, 0);
  assert.equal(status(kit, reservationId), "not_confirmed");
  assert.equal(cancels(kit), 0, "no Cloudbeds cancel");
  assert.deepEqual(
    calls.filter((c) => c.startsWith("guard")),
    [`guard ${key}`, `guard ${key}`],
    "asked by step 1, then again by the hold side",
  );
  assert.equal(await kit.deps.kv.get(keys.releaseDone(reservationId)), null);
  assert.equal(await holdIndexed(kit, reservationId), true, "still tracked");
  assert.ok(kept.openHolds >= 1);
  assert.equal(notes(kit, reservationId).some((n) => n.startsWith("Hold released by the sweeper")), false, "no release note");

  guard.answer = true;
  const released = await runSweep(kit.deps, gw);
  assert.equal(released.released, 1);
  assert.equal(status(kit, reservationId), "canceled");
  assert.equal(notes(kit, reservationId).at(-1), "Hold released by the sweeper: Acme link expired.");
  assert.equal(calls.filter((c) => c.startsWith("guard")).length, 3, "asked once more, then released");
});

test("sweep hold side alone (step 1 blind): the release is guarded by the hold record's payment", async () => {
  const { kit, gw, calls, guard, view, key, reservationId } = await held();
  kit.fakeStripe.expire(key);
  view.blind = true;
  guard.answer = false;
  kit.now.ms += STALE_HOLD_MS + 5 * 60_000;

  const kept = await runSweep(kit.deps, gw);
  assert.equal(kept.released, 0);
  assert.equal(status(kit, reservationId), "not_confirmed");
  assert.deepEqual(calls, [`get ${key}`, `guard ${key}`]);

  guard.answer = true;
  assert.equal((await runSweep(kit.deps, gw)).released, 1);
  assert.equal(status(kit, reservationId), "canceled");
  assert.equal(notes(kit, reservationId).at(-1), "Hold released by the sweeper: Acme link expired.");
});

test("sweep: a release of an 'unconfirmed' payment is followed by afterPaymentReleased (the owner warned once), in step 1 and on the hold side", async () => {
  for (const blind of [false, true]) {
    const { kit, gw, override, view, key, reservationId, ref } = await held();
    kit.fakeStripe.expire(key);
    Object.assign(override, { state: "expired", pendingReason: "unconfirmed" });
    view.blind = blind;
    if (blind) kit.now.ms += STALE_HOLD_MS + 5 * 60_000;
    const from = kit.alerts.length;

    const s = await runSweep(kit.deps, gw);
    assert.equal(s.released, 1, `blind ${blind}`);
    assert.equal(status(kit, reservationId), "canceled");
    const warning = { subject: `Acme payment still pending: hold ${reservationId} released (booking ${ref})`, lines: [`A QR payment on Acme link ${key} was still waiting for the bank when the hold was released.`], severity: "warning" };
    assert.deepEqual(kit.alerts.slice(from), [warning], `blind ${blind}`);

    kit.now.ms += STALE_HOLD_MS + 5 * 60_000;
    await runSweep(kit.deps, gw);
    assert.equal(kit.alerts.length, from + 1, "no second warning");
  }
  // A plain expired payment: released without any warning.
  const { kit, gw, key, reservationId } = await held();
  kit.fakeStripe.expire(key);
  const from = kit.alerts.length;
  assert.equal((await runSweep(kit.deps, gw)).released, 1);
  assert.equal(status(kit, reservationId), "canceled");
  assert.deepEqual(kit.alerts.slice(from), []);
});

/* ------------------------------- sweep: orphans ------------------------------- */

test("sweep: with ownsOrphans true a run owns the orphans gw.parseHoldId recognises (released / reported); with false it leaves them alone; never another provider's", async () => {
  const kit = makeKit();
  const beamPending = await orphan(kit, "MSV-20261005-BMPN", holdIdentifier("MSV-20261005-BMPN", "beam-playground"), "not_confirmed", "462958");
  const beamConfirmed = await orphan(kit, "MSV-20261005-BMCF", holdIdentifier("MSV-20261005-BMCF", "beam-playground"), "confirmed", "462961");
  const stripePending = await orphan(kit, "MSV-20261005-STPN", holdIdentifier("MSV-20261005-STPN", kit.config.paymentMode), "not_confirmed", "462960");
  assert.equal(kit.fakeCb.reservations.get(beamPending)?.thirdPartyIdentifier, "MSV-20261005-BMPN-B-TEST");
  kit.now.ms += ORPHAN_STALE_MS;
  const deps = acmeDeps(kit);
  const acme = acmeGateway(kit, { parseHoldId: parseBeamHoldIdentifier });
  acme.view.blind = true;
  const scope = keyScope("beam-playground");
  const noRecord = () => kit.alerts.filter((a) => a.subject.includes("carries an online-booking id we have no record of"));
  const leftToPrimary = () => kit.logs.filter((l) => l.message === "sweep_orphan_left_to_primary").map((l) => l.data?.reservationId);

  // Not owned: the drain default (ownsOrphans = primary = false), and ownsOrphans false on a primary run.
  for (const opts of [{ primary: false }, { primary: true, ownsOrphans: false }]) {
    const s = await runSweep(deps, acme.gw, opts);
    assert.equal(s.released, 0, JSON.stringify(opts));
    assert.equal(s.holdsChecked, 0, JSON.stringify(opts));
  }
  assert.deepEqual(leftToPrimary().sort(), [beamPending, beamConfirmed, beamPending, beamConfirmed].sort(), "only Acme's own tags were looked at");
  assert.equal(status(kit, beamPending), "not_confirmed");
  assert.equal(noRecord().length, 0);
  assert.equal(await kit.deps.kv.get(keys.noRecordReported(scope, beamConfirmed)), null);

  // Owned (as the sweep route will run every provider, S4.8): even as a drain.
  const owned = await runSweep(deps, acme.gw, { primary: false, ownsOrphans: true });
  assert.equal(owned.released, 1);
  assert.equal(status(kit, beamPending), "canceled");
  assert.equal(notes(kit, beamPending).at(-1), "Hold released by the sweeper: Acme link never created.");
  assert.equal(status(kit, beamConfirmed), "confirmed", "a confirmed orphan is never cancelled ...");
  assert.notEqual(await kit.deps.kv.get(keys.noRecordReported(scope, beamConfirmed)), null, "... it is reported");
  assert.equal(noRecord().length, 1);
  assert.equal(status(kit, stripePending), "not_confirmed", "a Stripe-tagged orphan is not Acme's to parse");
  assert.equal(
    kit.logs.some((l) => JSON.stringify(l.data ?? {}).includes(stripePending)),
    false,
    "no Acme log line names the Stripe orphan",
  );

  // The Stripe run (no parseHoldId: parseHoldIdentifier) takes its own and never sees the Beam-tagged ones.
  const stripe = await runSweep(kit.deps);
  assert.equal(stripe.released, 1);
  assert.equal(status(kit, stripePending), "canceled");
  assert.equal(status(kit, beamConfirmed), "confirmed");
  assert.equal(noRecord().length, 1);
});

test("sweep: an orphan whose payment step 1 listed but could not read is kept (no release, no guard bypassed), paid or not; a later readable run decides", async () => {
  const UNREAD = "cs_test_unreadable_link";
  for (const listedPaid of [false, true]) {
    const kit = makeKit();
    const ref = "MSV-20261005-BMRD";
    const reservationId = await orphan(kit, ref, holdIdentifier(ref, "beam-playground"), "not_confirmed", "462958");
    kit.now.ms += ORPHAN_STALE_MS;
    const link = { readable: false };
    const expired: GatewayPayment = { key: UNREAD, paymentId: UNREAD, state: "expired", meta: null, amountSatang: null, currency: null, attempted: false, receipt: { primaryId: null, description: "" } };
    const acme = acmeGateway(kit, {
      parseHoldId: parseBeamHoldIdentifier,
      // The orphan's link, mapped by its signed note (S4.2): listed, but Beam answers 429 to its read.
      async sweepRecent() {
        return [
          {
            key: UNREAD,
            reservationId,
            listedPaid,
            read: async () => {
              if (!link.readable) throw new Error("Acme 429 RATE_LIMIT_ERROR");
              return expired;
            },
          },
        ];
      },
    });
    const deps = acmeDeps(kit);

    for (let run = 0; run < 2; run++) {
      const from = kit.alerts.length;
      const s = await runSweep(deps, acme.gw, { ownsOrphans: true });
      const label = `listedPaid ${listedPaid}, run ${run}`;
      assert.deepEqual([s.released, s.errors, s.holdsChecked, s.skippedOpen], [0, 1, 1, 1], label);
      assert.ok(s.openHolds >= 1, label);
      assert.equal(status(kit, reservationId), "not_confirmed", label);
      assert.equal(cancels(kit), 0, label);
      assert.deepEqual(acme.calls, [], `${label}: no release was attempted, so no guard could be skipped`);
      assert.ok(kit.logs.some((l) => l.message === "sweep_hold_payment_unread" && l.data?.reservationId === reservationId && l.data?.listedPaid === listedPaid), label);
      assert.deepEqual(urgent(kit, from), [], `${label}: no CRITICAL (the unit was never put back on sale)`);
      if (listedPaid && run === 0) {
        // Step 1 says it is paid and must not be cancelled (once per alert window) - and nothing cancels it.
        assert.ok(kit.alerts.slice(from).some((a) => a.subject === "Paid booking not yet confirmed in Cloudbeds (retrying)" && a.lines[1].includes("Do NOT cancel the reservation")), label);
      }
      kit.now.ms += 10 * 60_000;
    }

    if (!listedPaid) {
      // Readable again, and expired: released by step 1 for that payment, guarded.
      link.readable = true;
      const s = await runSweep(deps, acme.gw, { ownsOrphans: true });
      assert.equal(s.released, 1);
      assert.equal(status(kit, reservationId), "canceled");
      assert.deepEqual(acme.calls, [`guard ${UNREAD}`]);
      assert.equal(notes(kit, reservationId).at(-1), "Hold released by the sweeper: Acme link expired.");
    }
  }

  // The control: a provider without a release guard (Stripe) keeps its old behaviour - nothing guards that
  // release, and the hold is released as it was at production main.
  const kit = makeKit();
  const ref = "MSV-20261005-BMRE";
  const reservationId = await orphan(kit, ref, holdIdentifier(ref, "beam-playground"), "not_confirmed", "462958");
  kit.now.ms += ORPHAN_STALE_MS;
  const unguarded = acmeGateway(kit, {
    parseHoldId: parseBeamHoldIdentifier,
    releaseGuard: undefined,
    async sweepRecent() {
      return [{ key: UNREAD, reservationId, listedPaid: false, read: async () => Promise.reject(new Error("Acme 429 RATE_LIMIT_ERROR")) }];
    },
  });
  const s = await runSweep(acmeDeps(kit), unguarded.gw, { ownsOrphans: true });
  assert.deepEqual([s.released, s.errors], [1, 1]);
  assert.equal(status(kit, reservationId), "canceled");
  assert.equal(kit.logs.some((l) => l.message === "sweep_hold_payment_unread"), false);
});

test("sweep: a payment step 1 read but could not release (the Cloudbeds cancel failed) is not 'unread': the hold side retries it the same run, guarded", async () => {
  const { kit, gw, calls, key, reservationId } = await held();
  kit.fakeStripe.expire(key);
  kit.now.ms += STALE_HOLD_MS + 5 * 60_000;
  kit.fakeCb.failNext("putReservation", "http500");
  const s = await runSweep(kit.deps, gw);
  assert.deepEqual([s.errors, s.released], [1, 1], "step 1's release failed; the hold side's went through");
  assert.equal(status(kit, reservationId), "canceled");
  assert.deepEqual(calls.filter((c) => c.startsWith("guard")), [`guard ${key}`, `guard ${key}`]);
  assert.equal(kit.logs.some((l) => l.message === "sweep_hold_payment_unread"), false);
});

test("sweep hold side: with two of the provider's payments for one hold, the guard must agree for each (one refusal keeps the hold)", async () => {
  const { kit, key, reservationId } = await held();
  kit.fakeStripe.expire(key);
  kit.now.ms += STALE_HOLD_MS + 5 * 60_000;
  const asked: string[] = [];
  const refused = new Set([key]);
  const { gw } = acmeGateway(kit, {
    async releaseGuard(k: string) {
      asked.push(k);
      return !refused.has(k);
    },
  });
  // The caller's step 1 (opts.recent) lists one payment for the hold; the hold record names another (its own page).
  const OTHER = "cs_test_second_page";
  const other: GatewayPayment = { ...(await stripeGateway(kit.deps).get(key)), key: OTHER, paymentId: OTHER, state: "expired" };
  const recent: RecentPayments = { text: gw.text, byReservation: new Map([[reservationId, [other]]]), triedPaid: new Set(), counts: { sessionsChecked: 1, fulfilled: 0, released: 0, errors: 0 } };

  const kept = await runSweep(kit.deps, gw, { recent });
  assert.deepEqual(asked, [OTHER, key], "the first payment agrees, the second refuses");
  assert.equal(kept.released, 0);
  assert.equal(status(kit, reservationId), "not_confirmed");
  assert.equal(cancels(kit), 0);
  assert.equal(await holdIndexed(kit, reservationId), true, "still tracked");
  assert.ok(kit.logs.some((l) => l.message === "release_refused_still_payable" && l.data?.reservationId === reservationId));

  // Both agree: released.
  refused.clear();
  asked.length = 0;
  const released = await runSweep(kit.deps, gw, { recent });
  assert.equal(released.released, 1);
  assert.deepEqual(asked, [OTHER, key]);
  assert.equal(status(kit, reservationId), "canceled");
});

test("sweep: an owned orphan whose Cloudbeds cancel fails is alerted with its booking ref, as gw.parseHoldId reads it", async () => {
  const kit = makeKit();
  const ref = "MSV-20261005-BMCX";
  const reservationId = await orphan(kit, ref, holdIdentifier(ref, "beam-playground"), "not_confirmed", "462958");
  assert.equal(parseHoldIdentifier(kit.fakeCb.reservations.get(reservationId)?.thirdPartyIdentifier), null, "Stripe's parser can't read it");
  // Past the alert age by Cloudbeds' own clock, read cautiously (up to 7 h young).
  kit.now.ms += RELEASE_ALERT_AGE_MS + 7 * 3600_000 + 60_000;
  const acme = acmeGateway(kit, { parseHoldId: parseBeamHoldIdentifier });
  acme.view.blind = true;
  kit.fakeCb.failNext("putReservation", "http500");

  const s = await runSweep(acmeDeps(kit), acme.gw, { ownsOrphans: true });
  assert.deepEqual([s.released, s.errors, s.holdsChecked], [0, 1, 1]);
  assert.equal(status(kit, reservationId), "not_confirmed");
  const alert = kit.alerts.find((a) => a.subject === `Hold ${reservationId} could not be released`);
  assert.ok(alert?.lines[0].startsWith(`The sweeper could not release Cloudbeds reservation ${reservationId} (booking ${ref}), created `), alert?.lines[0]);
});

test("sweep: the hold-index-size alert is raised by the primary run only (the index is shared by every run)", async () => {
  const kit = makeKit();
  for (let i = 0; i < 51; i++) await kit.deps.kv.zadd(keys.holdIndex(), kit.now.ms, `9${String(i).padStart(12, "0")}`);
  const growing = () => kit.alerts.filter((a) => a.subject === "The booking sweeper's hold index keeps growing");

  await runSweep(kit.deps, stripeGateway(kit.deps), { primary: false });
  await runSweep(acmeDeps(kit), acmeGateway(kit).gw, { primary: false, ownsOrphans: true });
  assert.equal(growing().length, 0, "a drain run never raises it, even one that owns its orphans");
  await runSweep(kit.deps);
  assert.equal(growing().length, 1);
});

/* ------------------------------ checkout core ------------------------------ */

/** The input runCheckout hands the core: the cart, the test guest, the server's quote and the fresh inventory. */
async function coreInput(kit: Kit): Promise<StripeCheckoutInput> {
  const req = request(HONEYMOON);
  const quote = await serverQuote(kit, req);
  const inv = await getCartInventory(req.checkIn, req.checkOut, req.items, kit.config, { fetchImpl: kit.fakeCb.fetch, allowDemoFallback: false });
  return { checkIn: req.checkIn, checkOut: req.checkOut, items: req.items, guest: GUEST, quote, inventory: inv.inventory, dataSource: inv.dataSource, today: todayInBangkok(new Date(kit.now.ms)) };
}

function coreContext(kit: Kit): HoldFirstCheckoutContext {
  return { deps: kit.deps, origin: ORIGIN, nowMs: kit.now.ms, nonce: () => "nonce", testAccessToken: kit.checkoutDeps().testAccessToken, sleep: async () => undefined };
}

const PREFIX = "acme:";
const ACME_DEADLINE = "after 30 minutes (up to 50 minutes while a QR payment is still being confirmed)";

/** The Stripe adapter under Acme's provider, brand and words (page key "acme:{session id}"), recording its calls. */
function acmeAdapter(kit: Kit, overrides: Partial<CheckoutAdapter<{ kind: string }>> = {}) {
  const inner = stripeCheckoutAdapter(kit.deps, kit.config.stripe!, { origin: ORIGIN, nowMs: kit.now.ms });
  const calls: string[] = [];
  const adapter: CheckoutAdapter<{ kind: string }> = {
    provider: "beam",
    brand: "Acme",
    maxChargeSatang: 50_000_000,
    holdNoteDeadline: ACME_DEADLINE,
    closedWord: "disabled",
    async createPage(input) {
      calls.push(`create ${input.ref}`);
      const page = await inner.createPage(input);
      return { key: `${PREFIX}${page.paymentId}`, paymentId: page.paymentId, redirectUrl: page.redirectUrl };
    },
    isAllowedUrl: (url) => inner.isAllowedUrl(url),
    async cancelPage(key) {
      calls.push(`cancel ${key}`);
      return inner.cancelPage(key.slice(PREFIX.length));
    },
    errorInfo: (e) => ({ kind: e instanceof Error ? e.message : "unknown" }),
    pageFailedAlert: (info, ref) => ({ subject: "Booking stopped: Acme could not create the payment page", lines: [`Booking ${ref}: ${info.kind}.`], key: `acme-page-fail:${info.kind}` }),
    ...overrides,
  };
  return { adapter, calls };
}

/** A kit whose KV records every write. */
function recordedKit() {
  const now = { ms: NOW };
  const kv = recordingKv(createMemoryKv(() => now.ms));
  return { kit: makeKit({ kv, now }), kv };
}

const PAUSED = fail(503, { error: "payment_unavailable", message: "Online payment is briefly unavailable. Nothing has been reserved or charged." });

test("checkout: a beforeHold refusal is answered as it is, before any Redis or Cloudbeds write (no intent, no hold, no page)", async () => {
  const { kit, kv } = recordedKit();
  const input = await coreInput(kit);
  let asked = 0;
  const { adapter, calls } = acmeAdapter(kit, {
    async beforeHold() {
      asked++;
      return PAUSED;
    },
  });
  const at = { kv: kv.writes.length, cb: kit.fakeCb.calls.length, stripe: kit.fakeStripe.calls.length, alerts: kit.alerts.length };

  const res = await startHoldFirstCheckout(input, coreContext(kit), adapter);
  assert.deepEqual(res, PAUSED);
  assert.equal(asked, 1);
  assert.deepEqual(kv.writes.slice(at.kv), [], "no KV write at all");
  assert.deepEqual(await kit.deps.kv.zrangeByScore(keys.intentIndex(), 0, Number.MAX_SAFE_INTEGER, 10), [], "no intent");
  assert.deepEqual(kit.fakeCb.calls.slice(at.cb), [], "no Cloudbeds call");
  assert.equal(kit.fakeCb.reservations.size, 0);
  assert.equal(kit.fakeStripe.calls.length, at.stripe);
  assert.deepEqual(calls, [], "no page");
  assert.equal(kit.alerts.length, at.alerts);
  assert.ok(kit.logs.some((l) => l.message === "checkout_refused_before_hold" && l.data?.provider === "beam" && l.data?.status === 503));
});

test("checkout: beforeHold runs after the test-mode guard and before any write; null goes ahead; a throw refuses with a 503 and nothing held", async () => {
  // The test-mode guard answers first: beforeHold is never asked.
  {
    const kit = makeKit();
    const input = await coreInput(kit);
    let asked = 0;
    const { adapter } = acmeAdapter(kit, {
      async beforeHold() {
        asked++;
        return PAUSED;
      },
    });
    const res = await startHoldFirstCheckout({ ...input, guest: { ...GUEST, email: "someone-else@example.com" } }, coreContext(kit), adapter);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(asked, 0);
  }
  // null: the checkout goes ahead, and nothing had been written when it was asked.
  {
    const { kit, kv } = recordedKit();
    const input = await coreInput(kit);
    const before = { kv: kv.writes.length, cb: kit.fakeCb.calls.length };
    const seen: { kv: number; cb: number }[] = [];
    const { adapter } = acmeAdapter(kit, {
      async beforeHold() {
        seen.push({ kv: kv.writes.length, cb: kit.fakeCb.calls.length });
        return null;
      },
    });
    const res = await startHoldFirstCheckout(input, coreContext(kit), adapter);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(seen, [before]);
    assert.equal(kit.fakeCb.reservations.size, 1);
  }
  // A throw: 503, nothing held, nothing written.
  {
    const { kit, kv } = recordedKit();
    const input = await coreInput(kit);
    const at = { kv: kv.writes.length, cb: kit.fakeCb.calls.length };
    const { adapter, calls } = acmeAdapter(kit, {
      async beforeHold() {
        throw new Error("breaker unreadable");
      },
    });
    const res = await startHoldFirstCheckout(input, coreContext(kit), adapter);
    assert.equal(res.status, 503);
    assert.equal((res.body as { error?: string }).error, "payment_unavailable");
    assert.deepEqual(kv.writes.slice(at.kv), []);
    assert.deepEqual(kit.fakeCb.calls.slice(at.cb), []);
    assert.deepEqual(calls, []);
    assert.ok(kit.logs.some((l) => l.message === "checkout_before_hold_failed" && l.data?.error === "breaker unreadable"));
  }
});

test("checkout: the hold note says the adapter's holdNoteDeadline, the crash alert its closedWord; without them, the Stripe words", async () => {
  const kit = makeKit();
  const input = await coreInput(kit);
  const { adapter } = acmeAdapter(kit);
  const res = await startHoldFirstCheckout(input, coreContext(kit), adapter);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const r = [...kit.fakeCb.reservations.values()][0];
  assert.ok(r.notes[0].includes(`via magicsamui.com (Acme). Awaiting payment - the hold is cancelled automatically if unpaid ${ACME_DEADLINE}.`), r.notes[0]);

  // A crash once the page exists: the alert says what closing it did, in the adapter's word.
  const crash = makeKit();
  const crashInput = await coreInput(crash);
  const { adapter: crashing, calls } = acmeAdapter(crash);
  const log = crash.deps.log;
  crash.deps.log = (message, data) => {
    log(message, data);
    if (message === "beam_session_created") throw new Error("simulated crash after the page");
  };
  assert.equal((await startHoldFirstCheckout(crashInput, coreContext(crash), crashing)).status, 500);
  const key = calls.find((c) => c.startsWith("cancel "))!.slice("cancel ".length);
  const alert = crash.alerts.find((a) => a.subject === "Booking stopped: unexpected error after the hold");
  assert.ok(alert?.lines.includes(`The Acme payment page ${key.slice(PREFIX.length)} was disabled, the hold was cancelled and nothing was charged.`), alert?.lines.join("\n"));

  // No words of its own: the defaults, which are Stripe's literals.
  assert.equal(DEFAULT_HOLD_NOTE_DEADLINE, `after ${PAYMENT_LINK_TTL_MINUTES} minutes`);
  assert.equal(DEFAULT_HOLD_NOTE_DEADLINE, "after 30 minutes");
  assert.equal(DEFAULT_CLOSED_WORD, "expired");
  const plain = makeKit();
  const plainInput = await coreInput(plain);
  const { adapter: wordless } = acmeAdapter(plain, { holdNoteDeadline: undefined, closedWord: undefined });
  assert.equal((await startHoldFirstCheckout(plainInput, coreContext(plain), wordless)).status, 200);
  const p = [...plain.fakeCb.reservations.values()][0];
  assert.ok(p.notes[0].includes("Awaiting payment - the hold is cancelled automatically if unpaid after 30 minutes."), p.notes[0]);
});

test("checkout: the Stripe adapter names today's literals and sets no beforeHold; a Stripe hold's note reads as before", async () => {
  const kit = makeKit();
  const a = stripeCheckoutAdapter(kit.deps, kit.config.stripe!, { origin: ORIGIN, nowMs: kit.now.ms });
  assert.equal(a.holdNoteDeadline, "after 30 minutes");
  assert.equal(a.closedWord, "expired");
  assert.equal("beforeHold" in a, false);
  const { reservationId } = await held(kit);
  assert.ok(
    notes(kit, reservationId)[0].includes("via magicsamui.com (Stripe). Awaiting payment - the hold is cancelled automatically if unpaid after 30 minutes."),
    notes(kit, reservationId)[0],
  );
});

/* --------------------------------- status --------------------------------- */

async function statusOf(kit: Kit, gw: PaymentGateway, params: { t: string; l?: string | null; s?: string | null }): Promise<{ status: number; body: StatusResponse }> {
  const res = await runStatus(
    { t: params.t, p: null, l: params.l ?? null, s: params.s ?? null },
    { config: kit.config, providerDeps: (provider) => (provider === "stripe" ? { deps: kit.deps, gw } : null), nowMs: kit.now.ms, log: kit.deps.log },
  );
  return res as { status: number; body: StatusResponse };
}

test("status: a pending answer carries the payment's pendingReason; a Stripe answer has no such key", async () => {
  const { kit, gw, override, key, t, l } = await held();
  const open = await statusOf(kit, gw, { t, l });
  assert.equal(open.body.status, "pending");
  assert.equal("pendingReason" in open.body, false, "an open payment carries none");

  override.state = "processing";
  override.pendingReason = "processing";
  const processing = await statusOf(kit, gw, { t, l });
  assert.equal(processing.status, 200);
  assert.equal(processing.body.status, "pending");
  assert.equal(processing.body.pendingReason, "processing");
  assert.deepEqual(processing.body.fulfilment, { state: "awaiting_payment", reservationId: null });

  kit.fakeStripe.completeDelayed(key);
  const stripe = await statusOf(kit, stripeGateway(kit.deps), { t, s: key });
  assert.equal(stripe.body.status, "pending");
  assert.equal("pendingReason" in stripe.body, false);
});

test("status: an expired payment still 'unconfirmed' is released (guarded, the owner warned once) and answered pending/unconfirmed - never expired or cancelled, so no Try again", async () => {
  const { kit, gw, calls, override, key, reservationId, ref, t, l } = await held();
  kit.fakeStripe.expire(key);
  Object.assign(override, { state: "expired", pendingReason: "unconfirmed" });
  // The guest pressed Cancel earlier: a plain expired payment would answer "cancelled" (Try again).
  await kit.deps.kv.set(keys.abandoned(key), "1", 3600);
  const from = kit.alerts.length;

  const res = await statusOf(kit, gw, { t, l });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "pending");
  assert.equal(res.body.pendingReason, "unconfirmed");
  assert.equal(res.body.failureCode, null);
  assert.deepEqual(res.body.fulfilment, { state: "released", reservationId: null });
  assert.equal(returnViewKind(res.body), "pending");
  assert.equal(canRetryPayment(res.body), false);
  assert.equal(status(kit, reservationId), "canceled", "the unit is back on sale");
  assert.ok(calls.includes(`guard ${key}`), calls.join(","));
  assert.deepEqual(
    kit.alerts.slice(from).map((a) => a.subject),
    [`Acme payment still pending: hold ${reservationId} released (booking ${ref})`],
  );

  // Asked again (the page polls): the same answer, no second release or warning.
  const again = await statusOf(kit, gw, { t, l });
  assert.deepEqual([again.body.status, again.body.pendingReason], ["pending", "unconfirmed"]);
  assert.equal(kit.alerts.length, from + 1);
  assert.equal(cancels(kit), 1);

  // A guard that keeps the hold changes nothing for the guest: still pending/unconfirmed.
  const kept = await held();
  kept.kit.fakeStripe.expire(kept.key);
  Object.assign(kept.override, { state: "expired", pendingReason: "unconfirmed" });
  kept.guard.answer = false;
  const keptRes = await statusOf(kept.kit, kept.gw, { t: kept.t, l: kept.l });
  assert.deepEqual([keptRes.body.status, keptRes.body.pendingReason], ["pending", "unconfirmed"]);
  assert.equal(status(kept.kit, kept.reservationId), "not_confirmed");

  // The control: a plain expired payment still answers expired / cancelled, as before.
  const plain = await held();
  plain.kit.fakeStripe.expire(plain.key);
  assert.equal((await statusOf(plain.kit, plain.gw, { t: plain.t, l: plain.l })).body.status, "expired");
  await plain.kit.deps.kv.set(keys.abandoned(plain.key), "1", 3600);
  assert.equal((await statusOf(plain.kit, plain.gw, { t: plain.t, l: plain.l })).body.status, "cancelled");
});

test("status: a payment carrying a mismatch gets the mismatch answer (contact us), nothing fulfilled or released", async () => {
  const { kit, gw, override, key, reservationId, t, l } = await held();
  kit.fakeStripe.complete(key);
  override.mismatch = "Acme link was paid to merchant m_other, not to this account: check the payment before settling the booking.";
  const res = await statusOf(kit, gw, { t, l });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.status, res.body.failureCode], ["failed", "AMOUNT_OR_REFERENCE_MISMATCH"]);
  assert.deepEqual(res.body.fulfilment, { state: "not_applicable", reservationId: null });
  assert.equal(returnViewKind(res.body), "mismatch");
  assert.equal(canRetryPayment(res.body), false);
  assert.equal(kit.fakeCb.count("postPayment"), 0);
  assert.equal(await kit.deps.kv.get(keys.reservationPaid(reservationId)), null, "status never fulfils it");
  assert.equal(status(kit, reservationId), "not_confirmed");
  assert.ok(kit.logs.some((l) => l.message === "beam_status_mismatch" && l.data?.providerMismatch === true));
  // Without the mismatch the same paid payment is confirmed (the control).
  delete override.mismatch;
  assert.equal((await statusOf(kit, gw, { t, l })).body.fulfilment.state, "confirmed");
});

/* ---------------------------- requestPaymentKey ---------------------------- */

test("requestPaymentKey: `s` is read for Stripe only; another provider's link token is read through gw.isPaymentId, and gw.keyOf makes the key", async () => {
  const { kit, gw, key, booking, l } = await held();
  const prefixed: PaymentGateway = { ...gw, keyOf: (id) => `${PREFIX}${id}`, idOf: (k) => k.slice(PREFIX.length) };
  const keyFor = (s: unknown, link: unknown, g: PaymentGateway) => requestPaymentKey(s, link, booking, TOKEN_SECRET, g, kit.now.ms);
  const linkWith = (id: string, b: BookingSummary = booking) => createBookingToken(b, id, TOKEN_SECRET, 3600, kit.now.ms);

  assert.equal(keyFor(key, null, prefixed), null, "an id in `s` is never read for another provider");
  assert.equal(keyFor(key, null, gw), null);
  assert.equal(keyFor(null, l, prefixed), `${PREFIX}${key}`, "the token's bare id, made a key by keyOf");
  assert.equal(keyFor(key, l, prefixed), `${PREFIX}${key}`, "the token, whatever `s` says");
  assert.equal(keyFor(null, linkWith("lnk_not_acme_shape"), prefixed), null, "an id gw.isPaymentId refuses");
  assert.equal(keyFor(null, linkWith(key, { ...booking, ref: "MSV-20261005-ZZZZ" }), prefixed), null, "another booking's token");
  const noCheck: PaymentGateway = { ...prefixed, isPaymentId: undefined };
  assert.equal(keyFor(null, l, noCheck), null, "another provider without isPaymentId: no id is read from a request");
  // Stripe, as before: the redirect's id first, else the token's.
  const stripe = stripeGateway(kit.deps);
  assert.equal(keyFor(key, null, stripe), key);
  assert.equal(keyFor(null, l, stripe), key);
  assert.equal(keyFor("not-a-session", null, stripe), null);
});

test("status: `s` is ignored for a non-Stripe gateway (no read without the token or the pointer); the link token is used", async () => {
  const { kit, gw, calls, key, ref, t, l } = await held();
  await kit.deps.kv.del(keys.booking(ref)); // no pointer: only the request can name the payment
  const viaS = await statusOf(kit, gw, { t, s: key });
  assert.equal(viaS.body.status, "pending");
  assert.deepEqual(viaS.body.fulfilment, { state: "awaiting_payment", reservationId: null });
  assert.deepEqual(calls, [], "never read: `s` names nothing for Acme");

  const viaL = await statusOf(kit, gw, { t, l });
  assert.equal(viaL.body.status, "pending");
  assert.deepEqual(calls, [`get ${key}`]);

  // Stripe reads `s` as it always did.
  const stripe = await statusOf(kit, stripeGateway(kit.deps), { t, s: key });
  assert.equal(stripe.body.status, "pending");
  assert.ok(kit.fakeStripe.calls.some((c) => c.method === "GET" && c.path === `/v1/checkout/sessions/${key}`));
});

// The Beam gateway's sweepRecent (design S4.2) through the real sweeper (sweep.ts runSweep and its step 1,
// sweepRecentPayments) on the in-repo fake Beam and the fake Cloudbeds (beamTestkit.ts makeBeamKit). Each hold
// is a real one from the Beam checkout with its links-open entry (startBeamCheckout with
// payments/beamCheckoutAdapter.ts, design S4.3).
//
// Covered: an ACTIVE link past its expiry + skew (fakeBeam expiryLagMs, one clock) disabled and its hold released
// with the note; a PENDING charge kept through the grace, then released with the warning; a late success after
// the release (webhook lost) -> the CRITICAL of owner decision 3, also once the link left links-open and Redis
// lost its record (the charge scan and the signed note); a paid link confirmed by the next run; duplicate
// charges, also after the booking is done; the owner's own Lighthouse links (cached, read once in 8 days) and an
// unknown MSV payment; a refused scan and every other scan failure; the deep-scan cadence; disable failures;
// readings that keep failing; a 404 (tracked or scanned); an orphan whose link Beam rate-limits; two links naming
// one reservation; another mode's record; both refundLinkStatus choices; the housekeeping of links-open and the
// late watch; no card digits anywhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ALERT_WINDOW_SECONDS } from "../alerts.ts";
import { BeamApiError, createPaymentLink } from "../beam.ts";
import type { BeamCreatePaymentLinkRequest } from "../beam.ts";
import { BEAM_MERCHANT_ID, beamHeld, cardDigitsShown, makeBeamKit } from "../beamTestkit.ts";
import type { BeamHeld, BeamKit } from "../beamTestkit.ts";
import { fulfilPayment } from "../fulfil.ts";
import { createMemoryKv } from "../kv.ts";
import { keyScope, keys } from "../lock.ts";
import { createFakeBeam } from "../mock/fakeBeam.ts";
import type { FakeBeamRefundLinkStatus } from "../mock/fakeBeam.ts";
import { STALE_HOLD_MS, runSweep, sweepPaidAndAlerts, sweepRecentPayments } from "../sweep.ts";
import type { SweepSummary } from "../sweep.ts";
import { NOW, TOKEN_SECRET, recordingKv } from "../testkit.ts";
import type { CartItemInput } from "../types.ts";
import {
  BEAM_FAILURE_ALERT_MS,
  BEAM_FOREIGN_CACHE_SECONDS,
  BEAM_PENDING_WATCH_DAYS,
  BEAM_SCAN_MAX_PAGES,
  BEAM_SWEEP_FAILURE_ALERT_RUNS,
  beamGateway,
  trackOpenLink,
} from "./beamGateway.ts";
import type { BeamGateway, BeamGatewayDeps } from "./beamGateway.ts";
import { buildBeamNote, readRecord, writeRecord } from "./beamRecord.ts";
import { BEAM_EXPIRY_SKEW_MS } from "./beamState.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const GRACE_MS = 20 * MIN;
/** Past the alerter's own repeat window: only our set-once markers keep a repeat out. */
const PAST_ALERT_WINDOW_MS = ALERT_WINDOW_SECONDS * 1000 + MIN;
/** An orphan is aged by Cloudbeds' own clock, read cautiously (up to 7 h young): past this it is stale. */
const ORPHAN_STALE_MS = STALE_HOLD_MS + 7 * HOUR + MIN;
const GARDEN: CartItemInput[] = [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
const SCOPE = keyScope("beam-playground");
/** BEAM_MERCHANT_ID after the owner moved the deployment to another Beam merchant. */
const NEW_MERCHANT_ID = "m_NewMerchantAfterSwitch00000";

const sweep = (kit: BeamKit, gw: BeamGateway = kit.gw): Promise<SweepSummary> => runSweep(kit.deps, gw);
const res = (kit: BeamKit, id: string) => {
  const r = kit.fakeCb.reservations.get(id);
  assert.ok(r, `no reservation ${id}`);
  return r;
};
const calls = (kit: BeamKit, method: string) => kit.fakeCb.calls.filter((c) => c.method === method);
const critical = (kit: BeamKit) => kit.alerts.filter((a) => a.severity === "critical");
const withSubject = (kit: BeamKit, re: RegExp) => kit.alerts.filter((a) => re.test(a.subject));
const logged = (kit: BeamKit, message: string) => kit.logs.filter((l) => l.message === message);
const linkGets = (kit: BeamKit, linkId: string) => kit.fakeBeam.count(new RegExp(`^GET /api/v1/payment-links/${linkId}$`));
const disables = (kit: BeamKit, linkId: string) => kit.fakeBeam.count(new RegExp(`^PATCH /api/v1/payment-links/${linkId}/disable$`));
const cbWrites = (kit: BeamKit) => kit.fakeCb.calls.filter((c) => ["postPayment", "postCustomItem", "putReservation", "postReservationNote"].includes(c.method)).length;
const members = (kit: BeamKit, key: string) => kit.deps.kv.zrangeByScore(key, 0, Number.MAX_SAFE_INTEGER, 1000);
const inOpen = async (kit: BeamKit, linkId: string) => (await members(kit, keys.beamLinksOpen(SCOPE))).includes(linkId);
const inWatch = async (kit: BeamKit, linkId: string) => (await members(kit, keys.beamLinksWatch(SCOPE))).includes(linkId);
const inPending = async (kit: BeamKit, linkId: string) => (await members(kit, keys.beamLinksPending(SCOPE))).includes(linkId);
const expiryOf = (kit: BeamKit, linkId: string) => {
  const ms = kit.fakeBeam.link(linkId).expiresAtMs;
  assert.ok(ms !== null);
  return ms;
};
const lateReason = (refund: string) =>
  `The guest PAID but the Cloudbeds hold is CANCELLED. Re-instate or re-book the guest in Cloudbeds (if the unit is still free) or refund ${refund}.`;
const LIGHTHOUSE = (chargeId: string) => `the full amount in Beam Lighthouse (Payments > charge ${chargeId} > Refund). Nothing is refunded automatically`;

/** Redis lost the link's PaymentRecord, its links-open and late-watch entries and the hold record: only Beam and Cloudbeds know it. */
async function loseEverything(kit: BeamKit, h: BeamHeld): Promise<void> {
  await kit.deps.kv.del(keys.beamPayment(h.linkId));
  await kit.deps.kv.zrem(keys.beamLinksOpen(SCOPE), h.linkId);
  await kit.deps.kv.zrem(keys.beamLinksWatch(SCOPE), h.linkId);
  await kit.deps.kv.del(keys.hold(h.reservationId));
  await kit.deps.kv.zrem(keys.holdIndex(), h.reservationId);
}

/** A link body of someone else's making (the owner's own Lighthouse link, or one naming our booking). */
function linkBody(kit: BeamKit, internalNote: string, referenceId: string, netAmount = 150_000): BeamCreatePaymentLinkRequest {
  return {
    order: { currency: "THB", netAmount, description: "Dinner voucher", referenceId, internalNote, orderItems: [] },
    linkSettings: { card: { isEnabled: true } },
    collectPhoneNumber: false,
    collectDeliveryAddress: false,
    redirectUrl: "https://example.com/done",
    cancelUrl: "https://example.com/cancel",
    expiresAt: new Date(kit.now.ms + 30 * MIN).toISOString(),
  };
}

/** The kit's gateway whose fetch answers `status` to the GETs of one link while `gate.on`, after letting `gate.pass` through. */
function flakyLinkReads(kit: BeamKit, linkId: string, status = 429): { gw: BeamGateway; gate: { on: boolean; pass: number } } {
  const gate = { on: true, pass: 0 };
  const path = new RegExp(`/api/v1/payment-links/${linkId}$`);
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (gate.on && (init?.method ?? "GET") === "GET" && path.test(new URL(url).pathname)) {
      if (gate.pass > 0) gate.pass--;
      else {
        const errorCode = status === 429 ? "TOO_MANY_REQUESTS_ERROR" : "INTERNAL_SERVER_ERROR";
        return new Response(JSON.stringify({ code: status, message: "simulated", error: { errorCode, errorMessage: "simulated" } }), { status });
      }
    }
    return kit.fakeBeam.fetch(input, init);
  }) as typeof fetch;
  return { gw: beamGateway({ ...kit.deps, fetchImpl }), gate };
}

/* ------------------------------------ expiry and disable ------------------------------------ */

test("an ACTIVE link past its expiry + skew (Beam lagging, one clock) is disabled and its hold released with the note", async () => {
  const kit = makeBeamKit({ beam: { expiryLagMs: Number.POSITIVE_INFINITY } });
  const h = await beamHeld(kit);
  assert.ok(await inOpen(kit, h.linkId), "the checkout tracks the link in links-open");
  const expiresAt = expiryOf(kit, h.linkId);
  // 31 minutes: past expiresAt but inside the 2-minute skew - Beam may still close it on its own.
  kit.now.ms = expiresAt + MIN;
  let s = await sweep(kit);
  assert.equal(s.sessionsChecked, 1);
  assert.equal(disables(kit, h.linkId), 0);
  assert.equal(kit.fakeBeam.link(h.linkId).status, "ACTIVE");
  assert.equal(res(kit, h.reservationId).status, "not_confirmed");
  // 33 minutes: past the skew, Beam still says ACTIVE -> disabled with a fresh key, read again, released.
  kit.now.ms = expiresAt + BEAM_EXPIRY_SKEW_MS + MIN;
  s = await sweep(kit);
  assert.equal(disables(kit, h.linkId), 1);
  assert.match(kit.fakeBeam.calls.find((c) => c.method === "PATCH")?.idempotencyKey ?? "", new RegExp(`^msv-bd-${h.linkId}-[0-9a-f]{24}$`));
  assert.equal(kit.fakeBeam.link(h.linkId).status, "DISABLED");
  assert.equal(s.released, 1);
  assert.equal(s.errors, 0);
  assert.equal(res(kit, h.reservationId).status, "canceled");
  assert.ok(kit.now.ms - NOW < STALE_HOLD_MS, "step 1 released it before the hold side would have (40 minutes)");
  assert.ok(
    res(kit, h.reservationId).notes.includes("Hold released by the sweeper: the Beam payment link was created but no payment was ever attempted. Nothing was charged."),
    JSON.stringify(res(kit, h.reservationId).notes),
  );
  assert.equal(await kit.deps.kv.get(keys.releaseDone(h.reservationId)), "sweeper: link expired");
  assert.equal(await kit.deps.kv.get(keys.beamDisableFail(SCOPE, h.linkId)), null);
  assert.equal(kit.alerts.length, 0);
  // The next run moves the released link to the late watch; nothing is disabled or released twice.
  kit.now.ms += 10 * MIN;
  s = await sweep(kit);
  assert.equal(await inOpen(kit, h.linkId), false);
  assert.equal(await inWatch(kit, h.linkId), true);
  assert.equal(disables(kit, h.linkId), 1);
  assert.equal(s.released, 0);
});

test("an ACTIVE link with a PENDING charge past its expiry is disabled, kept through the grace, then released with the warning", async () => {
  const kit = makeBeamKit({ beam: { expiryLagMs: Number.POSITIVE_INFINITY } });
  const h = await beamHeld(kit, "promptpay");
  kit.now.ms += 5 * MIN;
  kit.fakeBeam.payPending(h.linkId, "QR_PROMPT_PAY");
  const expiresAt = expiryOf(kit, h.linkId);
  kit.now.ms = expiresAt + BEAM_EXPIRY_SKEW_MS;
  await sweep(kit);
  assert.equal(kit.fakeBeam.link(h.linkId).status, "DISABLED", "disabled at expiry + skew, its QR still pending");
  assert.equal(res(kit, h.reservationId).status, "not_confirmed");
  kit.now.ms = expiresAt + GRACE_MS - MIN;
  await sweep(kit);
  assert.equal(res(kit, h.reservationId).status, "not_confirmed", "inside the grace");
  kit.now.ms = expiresAt + GRACE_MS + MIN;
  const s = await sweep(kit);
  assert.equal(s.released, 1);
  assert.equal(res(kit, h.reservationId).status, "canceled");
  assert.equal(withSubject(kit, /^Beam payment still pending/).length, 1);
  assert.equal(disables(kit, h.linkId), 1);
});

test("a PENDING charge keeps the hold until the grace ends, then release + warning; a late success (webhook lost) -> CRITICAL", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit, "promptpay");
  kit.now.ms += 5 * MIN;
  const qr = kit.fakeBeam.payPending(h.linkId, "QR_PROMPT_PAY");
  const expiresAt = expiryOf(kit, h.linkId);
  for (const at of [expiresAt + MIN, expiresAt + 10 * MIN, expiresAt + GRACE_MS - MIN]) {
    kit.now.ms = at;
    const s = await sweep(kit);
    assert.equal(s.released, 0, `${(at - NOW) / MIN} minutes`);
    assert.equal(res(kit, h.reservationId).status, "not_confirmed", `${(at - NOW) / MIN} minutes`);
  }
  kit.now.ms = expiresAt + GRACE_MS + MIN;
  let s = await sweep(kit);
  assert.equal(s.released, 1);
  assert.equal(res(kit, h.reservationId).status, "canceled");
  assert.ok(res(kit, h.reservationId).notes.some((n) => n.startsWith("Hold released by the sweeper: a payment on the Beam payment link was still pending at the bank")));
  const warned = withSubject(kit, /^Beam payment still pending/);
  assert.equal(warned.length, 1);
  assert.equal(warned[0].subject, `Beam payment still pending: hold ${h.reservationId} released (booking ${h.ref})`);
  assert.equal(critical(kit).length, 0);
  // The next run watches it for a late success.
  kit.now.ms += 10 * MIN;
  await sweep(kit);
  assert.equal(await inWatch(kit, h.linkId), true);
  assert.equal(await inOpen(kit, h.linkId), false);
  // Hours later the bank confirms the QR; Beam's webhook never arrives. The next run finds it.
  kit.now.ms += 3 * HOUR;
  kit.fakeBeam.succeed(qr.chargeId);
  s = await sweep(kit);
  const urgent = critical(kit);
  assert.equal(urgent.length, 1);
  assert.equal(urgent[0].subject, `URGENT: paid booking ${h.ref} needs attention`);
  assert.equal(urgent[0].lines[0], lateReason(LIGHTHOUSE(qr.chargeId)));
  assert.equal(calls(kit, "postPayment").length, 0);
  assert.equal(res(kit, h.reservationId).status, "canceled", "never re-instated automatically");
  // Watched on: later runs never raise it again.
  kit.now.ms += PAST_ALERT_WINDOW_MS;
  await sweep(kit);
  assert.equal(critical(kit).length, 1);
  assert.equal(await inWatch(kit, h.linkId), true);
});

test("a late success after the link left links-open AND Redis lost its record: the charge scan and the signed note find it -> CRITICAL", async () => {
  for (const method of ["CARD", "TRUE_MONEY"] as const) {
    const kit = makeBeamKit();
    const h = await beamHeld(kit);
    kit.now.ms += 31 * MIN;
    assert.equal((await sweep(kit)).released, 1, method);
    kit.now.ms += 10 * MIN;
    await sweep(kit);
    assert.equal(await inWatch(kit, h.linkId), true);
    await loseEverything(kit, h);
    kit.now.ms += 2 * HOUR;
    const late = kit.fakeBeam.payAfterClose(h.linkId, method);
    const s = await sweep(kit);
    assert.equal(s.sessionsChecked, 1, method);
    const urgent = critical(kit);
    assert.equal(urgent.length, 1, method);
    assert.equal(
      urgent[0].lines[0],
      lateReason(method === "CARD" ? LIGHTHOUSE(late.chargeId) : "the full amount by bank transfer: Beam can't refund TrueMoney. Nothing is refunded automatically"),
      method,
    );
    assert.equal(withSubject(kit, /^Beam payment record missing/).length, 1, `${method}: the note stood in for the record`);
    assert.equal(calls(kit, "postPayment").length, 0, method);
  }
});

test("a paid link whose webhook was lost is confirmed by the next run, not 40 minutes later", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.now.ms += 4 * MIN;
  const card = kit.fakeBeam.pay(h.linkId, "CARD");
  kit.now.ms += 6 * MIN;
  let s = await sweep(kit);
  assert.ok(kit.now.ms - NOW < STALE_HOLD_MS, "the hold is still young");
  assert.equal(s.fulfilled, 1);
  assert.equal(res(kit, h.reservationId).status, "confirmed");
  assert.equal(calls(kit, "postPayment").length, 1);
  assert.equal(res(kit, h.reservationId).payments[0].description, `TEST MODE - NOT REAL MONEY. Beam link ${h.linkId} charge ${card.chargeId} (card) ref ${h.ref}`);
  // Done: dropped from links-open; the charge scan still reads it for 72 hours (a second charge would show).
  kit.now.ms += 10 * MIN;
  s = await sweep(kit);
  assert.equal(await inOpen(kit, h.linkId), false);
  assert.equal(await inWatch(kit, h.linkId), false);
  assert.equal(s.sessionsChecked, 1);
  assert.equal(s.fulfilled, 0);
  assert.equal(calls(kit, "postPayment").length, 1);
  assert.equal(kit.alerts.filter((a) => a.severity !== "info").length, 0);
});

/* ------------------------------------------ duplicates ------------------------------------------ */

test("two SUCCEEDED charges -> one 'charged twice' alert, before and after the booking is done (found by the scan)", async () => {
  const kit = makeBeamKit();
  const a = await beamHeld(kit);
  kit.fakeBeam.pay(a.linkId, "CARD");
  kit.now.ms += MIN;
  const extra = kit.fakeBeam.secondCharge(a.linkId, "CARD");
  kit.now.ms += 5 * MIN;
  assert.equal((await sweep(kit)).fulfilled, 1);
  let dup = withSubject(kit, /^URGENT: guest charged twice/);
  assert.equal(dup.length, 1);
  assert.equal(dup[0].subject, `URGENT: guest charged twice for booking ${a.ref}`);
  assert.match(dup[0].lines[0], new RegExp(`${extra.chargeId} \\(card, THB [\\d,.]+\\) is an extra charge`));
  kit.now.ms += PAST_ALERT_WINDOW_MS;
  await sweep(kit);
  assert.equal(withSubject(kit, /^URGENT: guest charged twice/).length, 1, "never repeated");

  // After the booking is done and has left links-open, only the charge scan names the link.
  const b = await beamHeld(kit, "card_ewallet", GARDEN);
  kit.fakeBeam.pay(b.linkId, "CARD");
  await sweep(kit);
  kit.now.ms += 10 * MIN;
  await sweep(kit);
  assert.equal(await inOpen(kit, b.linkId), false);
  const late = kit.fakeBeam.secondCharge(b.linkId, "ALIPAY");
  kit.now.ms += 10 * MIN;
  await sweep(kit);
  dup = withSubject(kit, /^URGENT: guest charged twice for booking/);
  assert.equal(dup.length, 2);
  assert.equal(dup[1].subject, `URGENT: guest charged twice for booking ${b.ref}`);
  assert.match(dup[1].lines[0], new RegExp(`${late.chargeId} \\(Alipay, `));
  assert.equal(calls(kit, "postPayment").length, 2, "the extra charge is never recorded");
});

/* ------------------------------------- links that are not ours ------------------------------------- */

test("the owner's own Lighthouse link is ignored and cached: one GET in 8 days, never disabled, nothing alerted or written", async () => {
  const kit = makeBeamKit();
  const own = await createPaymentLink(kit.beam, linkBody(kit, "Lighthouse link: dinner voucher", "VOUCHER-17"), "own-link-1", kit.fakeBeam.fetch);
  kit.fakeBeam.pay(own.id, "CARD");
  // Another deployment's link (a valid note of the other mode) is not ours either, and not "unknown".
  const record = { mode: "beam-live", ref: "MSV-20261005-ABCD", reservationId: "7000000000009", roomsSatang: 100_000, feeSatang: 0, totalSatang: 100_000 };
  const otherNote = buildBeamNote(
    { ...record, payMethod: "promptpay", checkIn: "2027-11-10", checkOut: "2027-11-13", termsVersion: null, arrivalLate: null, hasRequests: null, noteSaved: null, expiresAt: kit.now.ms + 30 * MIN },
    TOKEN_SECRET,
  );
  const other = await createPaymentLink(kit.beam, linkBody(kit, otherNote, record.ref, 100_000), "own-link-2", kit.fakeBeam.fetch);
  kit.fakeBeam.pay(other.id, "CARD");
  for (let at = 0; at <= 8 * DAY; at += 6 * HOUR) {
    kit.now.ms = NOW + at;
    const s = await sweep(kit);
    assert.equal(s.sessionsChecked, 0, `${at / HOUR} h`);
    if (at === 0) {
      // Cached as foreign for 8 days; the other mode's link is marked as such, so its MSV ref is never "unknown".
      assert.equal(await kit.deps.kv.get(keys.beamReported(SCOPE, "foreign-link", own.id)), "1");
      assert.equal(await kit.deps.kv.get(keys.beamReported(SCOPE, "foreign-link", other.id)), "other-mode");
    }
  }
  assert.equal(linkGets(kit, own.id), 1, "read once for its note, then cached as foreign for 8 days");
  assert.equal(linkGets(kit, other.id), 1);
  assert.equal(kit.fakeBeam.count(/^PATCH /), 0);
  assert.equal(kit.alerts.length, 0);
  assert.equal(cbWrites(kit), 0);
  assert.ok(logged(kit, "beam_payment_other_mode").some((l) => l.data?.linkId === other.id));
  // Past 8 days the charge is older than the 7-day scan: nothing names the link any more.
  kit.now.ms = NOW + 8 * DAY + BEAM_FOREIGN_CACHE_SECONDS * 1000;
  await sweep(kit);
  assert.equal(linkGets(kit, own.id), 1);
});

test("a link that is not ours but whose SUCCEEDED charge names an MSV booking: one CRITICAL (stored until delivered), never handled as ours", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const fake = await createPaymentLink(kit.beam, linkBody(kit, "msv1|forged", h.ref), "forged-1", kit.fakeBeam.fetch);
  const charge = kit.fakeBeam.pay(fake.id, "CARD");
  await sweep(kit);
  kit.now.ms += PAST_ALERT_WINDOW_MS;
  await sweep(kit);
  const warned = withSubject(kit, /^A Beam payment names booking/);
  assert.equal(warned.length, 1);
  assert.equal(warned[0].severity, "critical", "money taken under our ref with no booking: stored and re-sent until delivered (round 5)");
  assert.equal(warned[0].subject, `A Beam payment names booking ${h.ref} but we have no record of it`);
  assert.equal(
    warned[0].lines[0],
    `Charge ${charge.chargeId} (THB 1500.00, card) on payment link ${fake.id} carries our booking reference but neither a record nor a valid signed note. Check it in Lighthouse and Cloudbeds; if it is a real guest payment, book or refund it by hand.`,
  );
  assert.equal(await kit.deps.kv.get(keys.beamReported(SCOPE, "unknown-payment", charge.chargeId)), "1");
  assert.equal(linkGets(kit, fake.id), 1);
  assert.equal(calls(kit, "postPayment").length, 0);
  assert.equal(await kit.deps.kv.get(keys.reservationPaid(h.reservationId)), null, "the booking's own hold is untouched");
  // Only money taken counts: a declined or pending attempt naming a booking on someone else's link is no warning.
  const tried = await createPaymentLink(kit.beam, linkBody(kit, "msv1|forged-too", h.ref), "forged-2", kit.fakeBeam.fetch);
  kit.fakeBeam.decline(tried.id, "CARD");
  kit.fakeBeam.payPending(tried.id, "CARD");
  kit.now.ms += 10 * MIN;
  await sweep(kit);
  assert.equal(withSubject(kit, /^A Beam payment names booking/).length, 1);
  assert.equal(await kit.deps.kv.get(keys.beamReported(SCOPE, "foreign-link", tried.id)), "1");
});

test("a scanned link Beam answers 404 for, without a record, is cached as not ours (never an error); charges of other sources are ignored", async () => {
  const kit = makeBeamKit();
  const gone = await createPaymentLink(kit.beam, linkBody(kit, "voucher", "VOUCHER-18"), "gone-1", kit.fakeBeam.fetch);
  kit.fakeBeam.pay(gone.id, "CARD");
  kit.fakeBeam.links.delete(gone.id);
  // Beam's list is asked for PAYMENT_LINK charges only; a charge of another source that slips in is never read as a link.
  const withApiCharge = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await kit.fakeBeam.fetch(input, init);
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname !== "/api/v1/charges" || url.searchParams.has("sourceId")) return response;
    const body = (await response.json()) as { data: Record<string, unknown>[]; totalCount: number };
    const api = { ...body.data[0], chargeId: "ch_ApiSourceCharge0000000000000", source: "API", sourceId: "ApiSrc0001" };
    return new Response(JSON.stringify({ data: [api, ...body.data], totalCount: body.totalCount + 1 }), { status: 200 });
  }) as typeof fetch;
  const gw = beamGateway({ ...kit.deps, fetchImpl: withApiCharge });
  const s = await sweep(kit, gw);
  assert.equal(s.errors, 0);
  assert.equal(s.sessionsChecked, 0);
  assert.equal(linkGets(kit, gone.id), 1);
  assert.equal(linkGets(kit, "ApiSrc0001"), 0);
  assert.equal(await kit.deps.kv.get(keys.beamReported(SCOPE, "foreign-link", gone.id)), "1");
  kit.now.ms += 10 * MIN;
  await sweep(kit, gw);
  assert.equal(linkGets(kit, gone.id), 1, "cached");
  assert.equal(kit.alerts.length, 0);
});

/* ---------------------------------------- the charge scan ---------------------------------------- */

test("a refused scan (Beam won't list charges without a link id) is told once; the tracked links are still handled", async () => {
  const kit = makeBeamKit();
  kit.fakeBeam.unfilteredListUnsupported();
  const paid = await beamHeld(kit);
  const idle = await beamHeld(kit, "card_ewallet", GARDEN);
  kit.fakeBeam.pay(paid.linkId, "CARD");
  kit.now.ms += 31 * MIN;
  let s = await sweep(kit);
  assert.equal(s.fulfilled, 1);
  assert.equal(s.released, 1);
  assert.equal(s.errors, 0);
  assert.equal(res(kit, paid.reservationId).status, "confirmed");
  assert.equal(res(kit, idle.reservationId).status, "canceled");
  const refused = withSubject(kit, /^Beam refused the sweeper's payment scan$/);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].severity, "warning");
  assert.match(refused[0].lines[0], /with API_VALIDATION_ERROR, HTTP 400, so the sweeper only checks the payment links the booking engine tracks: the open ones, and released ones for 7 days\.$/);
  assert.ok(logged(kit, "beam_scan_refused").length >= 1);
  kit.now.ms += PAST_ALERT_WINDOW_MS;
  s = await sweep(kit);
  assert.equal(s.errors, 0);
  assert.equal(withSubject(kit, /^Beam refused the sweeper's payment scan$/).length, 1, "told once");
  assert.equal(logged(kit, "beam_scan_refused").length, 2, "logged on every run");
  assert.equal(await kit.deps.kv.get(keys.beamDeepScan(SCOPE)), null, "no deep pass was completed");
});

test("any other scan failure fails the run (every hold kept): a 5xx, a later page that fails, a spent budget", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.now.ms += 31 * MIN;
  // Each pass is retried once by beam.ts; the failed deep pass is followed by the 72-hour pass (round 5): 4 failures.
  for (let i = 0; i < 4; i++) kit.fakeBeam.failNext(/^GET \/api\/v1\/charges$/, 503);
  await assert.rejects(sweep(kit), (e: unknown) => e instanceof BeamApiError && e.status === 503);
  assert.equal(res(kit, h.reservationId).status, "not_confirmed");
  // A 429 is Beam asking us to slow down, not a refusal of the list.
  kit.fakeBeam.rateLimitNext(4, /^GET \/api\/v1\/charges$/);
  await assert.rejects(sweep(kit), (e: unknown) => e instanceof BeamApiError && e.status === 429);
  assert.equal(res(kit, h.reservationId).status, "not_confirmed");
  // More than a page of charges (another guest's declined attempts), and the second page fails.
  const busy = await beamHeld(kit, "card_ewallet", GARDEN);
  for (let i = 0; i < 101; i++) kit.fakeBeam.decline(busy.linkId, "CARD");
  const secondPageFails = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === "/api/v1/charges" && url.searchParams.get("offset") === "100" && !url.searchParams.has("sourceId")) {
      return new Response(JSON.stringify({ code: 503, message: "busy", error: { errorCode: "SERVICE_UNAVAILABLE", errorMessage: "busy" } }), { status: 503 });
    }
    return kit.fakeBeam.fetch(input, init);
  }) as typeof fetch;
  await assert.rejects(sweep(kit, beamGateway({ ...kit.deps, fetchImpl: secondPageFails })), (e: unknown) => e instanceof BeamApiError && e.status === 503);
  assert.ok(logged(kit, "beam_sweep_scan").some((l) => l.data?.complete === false && l.data?.status === 503));
  const late = beamGateway({ ...kit.deps, deadlineMs: 1_000, clock: () => 2_000 });
  await assert.rejects(sweep(kit, late), (e: unknown) => e instanceof BeamApiError && e.errorCode === "SCAN_INCOMPLETE");
  assert.equal(res(kit, h.reservationId).status, "not_confirmed");
  assert.equal(await kit.deps.kv.get(keys.beamDeepScan(SCOPE)), null, "no deep pass completed");
  assert.equal(withSubject(kit, /refused the sweeper's payment scan/).length, 0);
  assert.equal((await sweep(kit)).released, 1, "the next good run releases it");
});

test("the scan looks back 72 hours, and 7 days once the last complete deep pass is 6 hours old", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.fakeBeam.pay(h.linkId, "CARD");
  await sweep(kit);
  assert.equal(await kit.deps.kv.get(keys.beamDeepScan(SCOPE)), String(NOW), "the first run is a deep pass");
  kit.now.ms += 10 * MIN;
  await sweep(kit);
  assert.equal(await inOpen(kit, h.linkId), false, "done: only the scan names it now");
  const reads = () => linkGets(kit, h.linkId);
  // 5 days later the charge is older than 72 hours: only a deep pass names the link.
  kit.now.ms = NOW + 5 * DAY;
  let before = reads();
  await sweep(kit);
  assert.equal(reads() - before, 1, "deep pass (the last one is 5 days old)");
  assert.equal(await kit.deps.kv.get(keys.beamDeepScan(SCOPE)), String(NOW + 5 * DAY));
  kit.now.ms += HOUR;
  before = reads();
  await sweep(kit);
  assert.equal(reads() - before, 0, "a 72-hour pass");
  kit.now.ms = NOW + 5 * DAY + 6 * HOUR;
  before = reads();
  await sweep(kit);
  assert.equal(reads() - before, 1, "6 hours after the last deep pass");
  kit.now.ms = NOW + 8 * DAY;
  before = reads();
  await sweep(kit);
  assert.equal(reads() - before, 0, "older than 7 days: no pass names it");
});

/* ------------------------------------------- failures ------------------------------------------- */

for (const c of [
  {
    name: "a disable that throws (403 NO_PERMISSION_ERROR)",
    fail: (kit: BeamKit) => kit.fakeBeam.failNext(/^PATCH \/api\/v1\/payment-links\/.+\/disable$/, 403, "NO_PERMISSION_ERROR"),
    problem: "NO_PERMISSION_ERROR, HTTP 403",
  },
  {
    name: "a disable answered 'not open' while the link still reads ACTIVE",
    fail: (kit: BeamKit) => kit.fakeBeam.failNext(/^PATCH \/api\/v1\/payment-links\/.+\/disable$/, 409, "REQUEST_CONFLICT_ERROR"),
    problem: "Beam answered that the link is no longer open, but it still reads ACTIVE",
  },
]) {
  test(`disable failures - ${c.name}: the hold stays, the owner is told after 60 minutes, a good disable releases it`, async () => {
    const kit = makeBeamKit({ beam: { expiryLagMs: Number.POSITIVE_INFINITY } });
    const h = await beamHeld(kit);
    const first = expiryOf(kit, h.linkId) + BEAM_EXPIRY_SKEW_MS;
    for (const after of [0, 20, 40, 59]) {
      kit.now.ms = first + after * MIN;
      c.fail(kit);
      const s = await sweep(kit);
      assert.equal(s.released, 0, `${after} min`);
      assert.equal(s.errors, 0, `${after} min: a failed disable is no error, the link is still open`);
      assert.equal(kit.fakeBeam.link(h.linkId).status, "ACTIVE");
      assert.equal(res(kit, h.reservationId).status, "not_confirmed");
    }
    assert.equal(withSubject(kit, /could not be disabled/).length, 0, "not before 60 minutes");
    assert.equal(await kit.deps.kv.get(keys.beamDisableFail(SCOPE, h.linkId)), String(first));
    kit.now.ms = first + BEAM_FAILURE_ALERT_MS;
    c.fail(kit);
    await sweep(kit);
    const told = withSubject(kit, /could not be disabled/);
    assert.equal(told.length, 1);
    assert.equal(told[0].subject, `Beam link ${h.linkId} could not be disabled for 60 minutes`);
    assert.notEqual(await kit.deps.kv.get(keys.alerted(SCOPE, `beam-disable-fail:${h.linkId}`)), null, "keyed per link");
    assert.equal(
      told[0].lines[0],
      `The sweeper keeps failing to disable an expired Beam payment link (booking ${h.ref}): ${c.problem}. Disable it in Lighthouse; its hold is released only once Beam reports no payable charge.`,
    );
    assert.ok(logged(kit, "beam_disable_failed").length >= 5);
    // Beam works again: disabled, released, the marker gone.
    kit.now.ms += 10 * MIN;
    const s = await sweep(kit);
    assert.equal(s.released, 1);
    assert.equal(kit.fakeBeam.link(h.linkId).status, "DISABLED");
    assert.equal(res(kit, h.reservationId).status, "canceled");
    assert.equal(await kit.deps.kv.get(keys.beamDisableFail(SCOPE, h.linkId)), null);
  });
}

test("a link whose reading keeps failing keeps its hold, is told to the owner after 60 minutes, and is cleared by a good reading", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const { gw, gate } = flakyLinkReads(kit, h.linkId, 500);
  const start = NOW + 45 * MIN;
  for (const after of [0, 30, 59]) {
    kit.now.ms = start + after * MIN;
    const s = await sweep(kit, gw);
    // Step 1's reading, and the hold side's own reading of the hold record's link (it throws: kept, sweep_hold_error).
    assert.equal(s.errors, 2, `${after} min`);
    assert.equal(s.released, 0, `${after} min`);
    assert.equal(res(kit, h.reservationId).status, "not_confirmed", `${after} min: the expired link could not be read, so its hold stays`);
  }
  assert.ok(logged(kit, "sweep_session_error").some((l) => l.data?.sessionId === h.key));
  assert.ok(logged(kit, "sweep_hold_error").some((l) => l.data?.reservationId === h.reservationId));
  assert.equal(withSubject(kit, /could not be read/).length, 0);
  kit.now.ms = start + BEAM_FAILURE_ALERT_MS;
  await sweep(kit, gw);
  const told = withSubject(kit, /could not be read/);
  assert.equal(told.length, 1);
  assert.equal(told[0].subject, `Beam link ${h.linkId} could not be read for 60 minutes`);
  assert.notEqual(await kit.deps.kv.get(keys.alerted(SCOPE, `beam-read-fail:${h.linkId}`)), null, "keyed per link");
  assert.ok(
    told[0].lines[0].startsWith(
      `The sweeper keeps failing to read Beam payment link ${h.linkId} (booking ${h.ref}, Cloudbeds reservation ${h.reservationId}): INTERNAL_SERVER_ERROR, HTTP 500.`,
    ),
    told[0].lines[0],
  );
  assert.deepEqual(await members(kit, keys.beamReadFailures(SCOPE)), [h.linkId]);
  gate.on = false;
  kit.now.ms += 10 * MIN;
  const s = await sweep(kit, gw);
  assert.equal(s.errors, 0);
  assert.equal(s.released, 1);
  assert.equal(res(kit, h.reservationId).status, "canceled");
  assert.deepEqual(await members(kit, keys.beamReadFailures(SCOPE)), [], "a good reading clears the record");

  // A failing link the sweeper stops listing (here: it left links-open) has its failure record dropped too.
  const kit2 = makeBeamKit();
  const g = await beamHeld(kit2);
  const flaky = flakyLinkReads(kit2, g.linkId, 500);
  kit2.now.ms += 10 * MIN;
  await sweep(kit2, flaky.gw);
  assert.deepEqual(await members(kit2, keys.beamReadFailures(SCOPE)), [g.linkId]);
  await kit2.deps.kv.zrem(keys.beamLinksOpen(SCOPE), g.linkId);
  kit2.now.ms += 10 * MIN;
  await sweep(kit2, flaky.gw);
  assert.deepEqual(await members(kit2, keys.beamReadFailures(SCOPE)), []);
});

test("a record of another payment mode is never listed (that mode's sweeper owns it), nor its link ever disabled", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const record = await readRecord(kit.deps.kv, h.linkId);
  assert.ok(record);
  await writeRecord(kit.deps.kv, { ...record, mode: "beam-live" });
  kit.fakeBeam.pay(h.linkId, "CARD");
  assert.deepEqual(await kit.gw.sweepRecent(NOW), []);
  assert.ok(logged(kit, "beam_payment_other_mode").some((l) => l.data?.linkId === h.linkId && l.data?.source === "record"));
  kit.now.ms += 5 * MIN;
  const s = await sweep(kit);
  assert.equal(s.sessionsChecked, 0);
  assert.equal(calls(kit, "postPayment").length, 0);
  assert.equal(kit.alerts.length, 0);

  // Listed as ours, then (before step 1 reads it) its record turns out to be another mode's: read, never disabled.
  const kit2 = makeBeamKit({ beam: { expiryLagMs: Number.POSITIVE_INFINITY } });
  const g = await beamHeld(kit2);
  kit2.now.ms = expiryOf(kit2, g.linkId) + BEAM_EXPIRY_SKEW_MS;
  const [listed] = await kit2.gw.sweepRecent(kit2.now.ms);
  const other = await readRecord(kit2.deps.kv, g.linkId);
  assert.ok(other);
  await writeRecord(kit2.deps.kv, { ...other, mode: "beam-live" });
  const p = await listed.read();
  assert.equal(p.meta, null);
  assert.equal(disables(kit2, g.linkId), 0);
  assert.equal(kit2.fakeBeam.link(g.linkId).status, "ACTIVE");
});

test("a link of this merchant Beam answers 404 for: kept until its expiry plus the grace (a failed reading), then read as expired and released (the guard agrees)", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const expiresAt = expiryOf(kit, h.linkId);
  kit.fakeBeam.links.delete(h.linkId);
  // A 404 before the expiry plus the pending grace may pass (the guest may still be on Beam's page): never final.
  assert.equal(await kit.gw.releaseGuard?.(h.key), false, "before the expiry plus the grace the guard keeps the hold");
  assert.equal(await kit.gw.releaseGuard?.("cs_test_a1b2c3"), false, "a key that is not a Beam key is never released by the Beam guard");
  let [listed] = await kit.gw.sweepRecent(NOW);
  await assert.rejects(listed.read(), (e: unknown) => e instanceof BeamApiError && e.errorCode === "NOT_FOUND_BEFORE_EXPIRY" && !kit.gw.isMissing(e));
  kit.now.ms = expiresAt + GRACE_MS - MIN;
  let s = await sweep(kit);
  assert.equal(s.released, 0);
  assert.ok(s.errors >= 1);
  assert.equal(res(kit, h.reservationId).status, "not_confirmed", "kept: the link may still be paid");
  assert.ok(logged(kit, "beam_link_missing_early").length >= 2);
  assert.equal(logged(kit, "beam_link_missing").length, 0);
  // From the expiry plus the grace, a link of this merchant that Beam does not know can never be paid.
  kit.now.ms = expiresAt + GRACE_MS;
  assert.equal(await kit.gw.releaseGuard?.(h.key), true);
  [listed] = await kit.gw.sweepRecent(kit.now.ms);
  const p = await listed.read();
  assert.equal(p.state, "expired");
  assert.equal(p.meta?.reservationId, h.reservationId);
  assert.equal(p.attempted, false);
  s = await sweep(kit);
  assert.equal(s.errors, 0);
  assert.equal(s.released, 1);
  assert.equal(res(kit, h.reservationId).status, "canceled");
  assert.ok(logged(kit, "beam_link_missing").length >= 1);
  assert.equal(kit.alerts.length, 0);
  assert.deepEqual(await members(kit, keys.beamReadFailures(SCOPE)), [], "the final reading ended the failure record");
  // Without its record nothing says whose link it was or when it expired: the guard keeps the hold.
  const kit2 = makeBeamKit();
  const g = await beamHeld(kit2);
  kit2.fakeBeam.links.delete(g.linkId);
  await kit2.deps.kv.del(keys.beamPayment(g.linkId));
  kit2.now.ms += DAY;
  assert.equal(await kit2.gw.releaseGuard?.(g.key), false);
});

/** The same deployment after the owner switched BEAM_MERCHANT_ID (and its API key): Beam knows none of the older links. */
function switchedMerchant(kit: BeamKit): { deps: BeamGatewayDeps; gw: BeamGateway } {
  const merchantId = NEW_MERCHANT_ID;
  const fake = createFakeBeam({ now: () => kit.now.ms, merchantId, apiKey: kit.beam.apiKey, base: "playground" });
  const beam = { ...kit.beam, merchantId };
  const deps: BeamGatewayDeps = { ...kit.deps, beam, config: { ...kit.config, beam }, fetchImpl: fake.fetch };
  return { deps, gw: beamGateway(deps) };
}

test("a merchant switch while links are open: a paid link (webhook lost) and a payable one keep their holds, one CRITICAL per link", async () => {
  for (const paid of [true, false]) {
    const label = paid ? "paid before the switch, webhook lost" : "paid on the old merchant's page after the switch";
    const kit = makeBeamKit();
    const h = await beamHeld(kit);
    if (paid) kit.fakeBeam.pay(h.linkId, "CARD");
    const after = switchedMerchant(kit);
    kit.now.ms += 5 * MIN;
    await runSweep(after.deps, after.gw);
    assert.equal(res(kit, h.reservationId).status, "not_confirmed", `${label}: kept at once`);
    assert.notEqual(await kit.deps.kv.get(keys.alerted(SCOPE, `beam-merchant-switch:${h.linkId}`)), null, `${label}: alert key beam-merchant-switch:{linkId}`);
    kit.now.ms += 5 * MIN;
    if (!paid) kit.fakeBeam.pay(h.linkId, "CARD");
    // Hours of sweeps on the new merchant: Beam answers 404 for the old link every time.
    for (let i = 0; i < 12; i++) {
      kit.now.ms += 30 * MIN;
      const s = await runSweep(after.deps, after.gw);
      assert.equal(s.released, 0, `${label}: run ${i}`);
    }
    assert.equal(res(kit, h.reservationId).status, "not_confirmed", `${label}: never released`);
    assert.equal(calls(kit, "putReservation").filter((x) => x.params.status === "canceled").length, 0, label);
    assert.equal(calls(kit, "postPayment").length, 0, label);
    const urgent = withSubject(kit, /belongs to another Beam merchant$/);
    assert.equal(urgent.length, 1, `${label}: one CRITICAL for the link`);
    assert.equal(urgent[0].severity, "critical");
    assert.equal(urgent[0].subject, `URGENT: Beam payment link ${h.linkId} for booking ${h.ref} belongs to another Beam merchant`);
    assert.deepEqual(urgent[0].lines, [
      `Beam payment link ${h.linkId} (booking ${h.ref}, Cloudbeds reservation ${h.reservationId}) was created under Beam merchant ${BEAM_MERCHANT_ID}, but this deployment's BEAM_MERCHANT_ID is ${NEW_MERCHANT_ID}, so Beam answers that the link does not exist. The sweeper can't tell whether the guest paid: the hold is kept and nothing was confirmed, cancelled or refunded.`,
      `Check the link in the Beam Lighthouse of merchant ${BEAM_MERCHANT_ID}: if the guest paid, confirm reservation ${h.reservationId} by hand (or refund the full amount there); if nobody paid, disable the link there and cancel reservation ${h.reservationId} in Cloudbeds. Never change BEAM_MERCHANT_ID while payment links are still open.`,
    ]);
    assert.equal(await kit.deps.kv.get(keys.beamReported(SCOPE, "merchant-switch", h.linkId)), "1");
    assert.equal(withSubject(kit, /could not be read for 60 minutes$/).length, 1, `${label}: the failing reading is told too`);
    assert.ok(logged(kit, "sweep_session_error").some((l) => l.data?.sessionId === h.key), label);
    assert.equal(await after.gw.releaseGuard?.(h.key), false, `${label}: the guard never releases a link of another merchant`);
  }
});

test("a merchant switch with a released link still watched: one CRITICAL saying a late payment on it can't be seen any more", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit, "promptpay");
  kit.now.ms += 5 * MIN;
  kit.fakeBeam.payPending(h.linkId, "QR_PROMPT_PAY");
  kit.now.ms = expiryOf(kit, h.linkId) + GRACE_MS + MIN;
  assert.equal((await sweep(kit)).released, 1);
  kit.now.ms += 10 * MIN;
  await sweep(kit);
  assert.equal(await inWatch(kit, h.linkId), true);
  const after = switchedMerchant(kit);
  kit.now.ms += 10 * MIN;
  await runSweep(after.deps, after.gw);
  kit.now.ms += PAST_ALERT_WINDOW_MS;
  await runSweep(after.deps, after.gw);
  const urgent = withSubject(kit, /belongs to another Beam merchant$/);
  assert.equal(urgent.length, 1, "once per link");
  assert.equal(urgent[0].severity, "critical");
  assert.deepEqual(urgent[0].lines, [
    `Beam payment link ${h.linkId} (booking ${h.ref}, Cloudbeds reservation ${h.reservationId}) was created under Beam merchant ${BEAM_MERCHANT_ID}, but this deployment's BEAM_MERCHANT_ID is ${NEW_MERCHANT_ID}, so Beam answers that the link does not exist. Its hold was already released (no payment had succeeded when its time ran out), but the sweeper can no longer see a late payment on it.`,
    `Check the link in the Beam Lighthouse of merchant ${BEAM_MERCHANT_ID} until it has no pending payment: if the guest paid late, re-book the guest if the unit is still free, otherwise refund the full amount there. Never change BEAM_MERCHANT_ID while payment links are still open or watched.`,
  ]);
  assert.ok(logged(kit, "beam_link_other_merchant").some((l) => l.data?.linkId === h.linkId && l.data?.released === true));
  assert.equal(res(kit, h.reservationId).status, "canceled");
});

/** The kit's gateway whose fetch answers Beam's unfiltered charge list (the scan) with `gate.status` while `gate.on`; link reads work. */
function failingScan(kit: BeamKit, status = 503, errorCode = "INTERNAL_SERVER_ERROR"): { deps: BeamGatewayDeps; gw: BeamGateway; gate: { on: boolean; status: number; errorCode: string } } {
  const gate = { on: true, status, errorCode };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (gate.on && url.pathname === "/api/v1/charges" && !url.searchParams.has("sourceId")) {
      const body = { code: gate.status, message: "simulated", error: { errorCode: gate.errorCode, errorMessage: "simulated" } };
      return new Response(JSON.stringify(body), { status: gate.status });
    }
    return kit.fakeBeam.fetch(input, init);
  }) as typeof fetch;
  const deps: BeamGatewayDeps = { ...kit.deps, fetchImpl };
  return { deps, gw: beamGateway(deps), gate };
}

test("a Beam step 1 that throws: sweepPaidAndAlerts still confirms a paid booking and re-sends a stored CRITICAL, releases nothing, writes the heartbeat", async () => {
  const kit = makeBeamKit();
  // A paid booking whose first confirmation failed (Cloudbeds down): on the unconfirmed-paid index.
  const paid = await beamHeld(kit);
  kit.fakeBeam.pay(paid.linkId, "CARD");
  kit.fakeCb.failNext("postReservationNote", "http500");
  kit.fakeCb.failNext("getReservation", "http500");
  await assert.rejects(fulfilPayment(paid.key, kit.deps, kit.gw));
  assert.deepEqual(await members(kit, keys.paidIndex(SCOPE)), [paid.key]);
  // An unpaid hold whose link expires, and a CRITICAL whose mail failed (stored for re-sending).
  const idle = await beamHeld(kit, "card_ewallet", GARDEN);
  kit.mail.ok = false;
  await kit.deps.alert("URGENT: stored test alert", ["Raised while the mail relay was down."], { key: "stored-test-alert", severity: "critical" });
  kit.mail.ok = true;
  assert.equal(withSubject(kit, /stored test alert/).length, 0);
  kit.now.ms += 41 * MIN;
  const { deps, gw } = failingScan(kit);
  await assert.rejects(sweepRecentPayments(deps, gw), (e: unknown) => e instanceof BeamApiError && e.status === 503);
  const s = await sweepPaidAndAlerts(deps, gw, { cloudbedsOk: true });
  assert.equal(s.fulfilled, 1);
  assert.equal(s.errors, 1, "the failed step 1");
  assert.equal(s.released, 0);
  assert.equal(s.undeliveredAlerts, 1);
  assert.equal(res(kit, paid.reservationId).status, "confirmed");
  assert.deepEqual(await members(kit, keys.paidIndex(SCOPE)), []);
  assert.equal(withSubject(kit, /stored test alert/).length, 1, "the stored CRITICAL is re-sent");
  assert.equal(res(kit, idle.reservationId).status, "not_confirmed", "no hold side: nothing released");
  assert.equal(await kit.deps.kv.get(keys.lastSweep(SCOPE)), String(kit.now.ms), "the Beam heartbeat");
  assert.ok(logged(kit, "sweep_done").some((l) => l.data?.step1Failed === true && l.data?.fulfilled === 1));

  // One stuck for 2 hours (Cloudbeds still failing for it): the CRITICAL 'still not confirmed'; no heartbeat without Cloudbeds.
  const kit2 = makeBeamKit();
  const stuck = await beamHeld(kit2);
  kit2.fakeBeam.pay(stuck.linkId, "CARD");
  kit2.fakeCb.failNext("postReservationNote", "http500");
  kit2.fakeCb.failNext("getReservation", "http500");
  await assert.rejects(fulfilPayment(stuck.key, kit2.deps, kit2.gw));
  kit2.now.ms += 2 * HOUR + MIN;
  kit2.fakeCb.failNext("postReservationNote", "http500");
  kit2.fakeCb.failNext("getReservation", "http500");
  const late = failingScan(kit2);
  await assert.rejects(sweepRecentPayments(late.deps, late.gw));
  const s2 = await sweepPaidAndAlerts(late.deps, late.gw, { cloudbedsOk: false });
  assert.equal(s2.paidUnconfirmed, 1);
  assert.equal(s2.errors, 2);
  const urgent = critical(kit2);
  assert.equal(urgent.length, 1);
  assert.equal(urgent[0].subject, `URGENT: paid booking ${stuck.ref} still not confirmed in Cloudbeds`);
  assert.equal(await kit2.deps.kv.get(keys.lastSweep(SCOPE)), null);
});

test("failed Beam step-1 runs are counted: the 3rd in a row tells the owner once; a good run ends the count", async () => {
  const kit = makeBeamKit();
  await beamHeld(kit);
  const { gw, gate } = failingScan(kit);
  for (let i = 1; i <= BEAM_SWEEP_FAILURE_ALERT_RUNS + 1; i++) {
    await assert.rejects(sweep(kit, gw), (e: unknown) => e instanceof BeamApiError && e.status === 503);
    assert.equal(await kit.deps.kv.get(keys.beamSweepFailures(SCOPE)), String(i));
    assert.equal(withSubject(kit, /^The booking sweeper cannot check Beam payments$/).length, i >= BEAM_SWEEP_FAILURE_ALERT_RUNS ? 1 : 0, `run ${i}`);
    kit.now.ms += 10 * MIN;
  }
  const [told] = withSubject(kit, /^The booking sweeper cannot check Beam payments$/);
  assert.equal(told.severity, "warning");
  assert.equal(
    told.lines[0],
    "3 sweeper runs in a row could not finish Beam's payment check (the charge scan, or the reading of a payment link whose record is gone): INTERNAL_SERVER_ERROR, HTTP 503.",
  );
  assert.notEqual(await kit.deps.kv.get(keys.alerted(SCOPE, "beam-sweep-failing")), null);
  assert.equal(logged(kit, "beam_deep_scan_failed").length, BEAM_SWEEP_FAILURE_ALERT_RUNS + 1, "each run tried the deep pass, then the 72-hour pass");
  assert.equal(logged(kit, "beam_sweep_failed").length, BEAM_SWEEP_FAILURE_ALERT_RUNS + 1);
  gate.on = false;
  await sweep(kit, gw);
  assert.equal(await kit.deps.kv.get(keys.beamSweepFailures(SCOPE)), null, "a good run ends the count");
  gate.on = true;
  await assert.rejects(sweep(kit, gw));
  assert.equal(await kit.deps.kv.get(keys.beamSweepFailures(SCOPE)), "1");
});

test("a deep pass that fails is followed by the 72-hour pass in the same run; the next run tries the deep pass again", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.now.ms += 31 * MIN;
  // The deep pass's first page fails twice (beam.ts retries once); the 72-hour pass works.
  kit.fakeBeam.failNext(/^GET \/api\/v1\/charges$/, 503);
  kit.fakeBeam.failNext(/^GET \/api\/v1\/charges$/, 503);
  const s = await sweep(kit);
  assert.equal(s.errors, 0);
  assert.equal(s.released, 1, "the run went on: the expired hold is released");
  assert.equal(res(kit, h.reservationId).status, "canceled");
  assert.equal(logged(kit, "beam_deep_scan_failed").length, 1);
  assert.deepEqual(logged(kit, "beam_sweep_scan").map((l) => l.data?.deep), [false]);
  assert.equal(await kit.deps.kv.get(keys.beamDeepScan(SCOPE)), null, "no deep pass completed");
  kit.now.ms += 10 * MIN;
  await sweep(kit);
  assert.deepEqual(logged(kit, "beam_sweep_scan").map((l) => l.data?.deep), [false, true], "the next run tries the deep pass again");
  assert.equal(await kit.deps.kv.get(keys.beamDeepScan(SCOPE)), String(kit.now.ms));
});

test("a refused scan is told once per HTTP status a day: a 400 and a 403 both, a repeated 400 not, the next day's 400 again", async () => {
  const kit = makeBeamKit();
  const { gw, gate } = failingScan(kit, 400, "API_VALIDATION_ERROR");
  const refused = () => withSubject(kit, /^Beam refused the sweeper's payment scan$/);
  assert.equal((await sweep(kit, gw)).errors, 0);
  assert.equal(refused().length, 1);
  kit.now.ms += 10 * MIN;
  await sweep(kit, gw);
  assert.equal(refused().length, 1, "the same status the same day: not again");
  kit.now.ms += 10 * MIN;
  Object.assign(gate, { status: 403, errorCode: "NO_PERMISSION_ERROR" });
  assert.equal((await sweep(kit, gw)).errors, 0);
  assert.equal(refused().length, 2, "another status: told");
  assert.match(refused()[1].lines[0], /with NO_PERMISSION_ERROR, HTTP 403, so the sweeper only checks/);
  assert.equal(await kit.deps.kv.get(keys.beamReported(SCOPE, "scan-refused", "400:2026-10-05")), "1");
  assert.equal(await kit.deps.kv.get(keys.beamReported(SCOPE, "scan-refused", "403:2026-10-05")), "1");
  assert.notEqual(await kit.deps.kv.get(keys.alerted(SCOPE, "beam-scan-refused:403")), null, "keyed per status");
  // The next day (UTC) a refusal that lasts is told again: one lost mail never hides it for good.
  kit.now.ms = NOW + DAY;
  Object.assign(gate, { status: 400, errorCode: "API_VALIDATION_ERROR" });
  await sweep(kit, gw);
  assert.equal(refused().length, 3);
  assert.equal(logged(kit, "beam_scan_refused").length, 4, "logged on every run");
});

test("a released link whose PENDING charge outlives the late watch stays watched until it settles: a success on day 9 (webhook lost) -> CRITICAL", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit, "promptpay");
  kit.now.ms += 5 * MIN;
  const qr = kit.fakeBeam.payPending(h.linkId, "QR_PROMPT_PAY");
  kit.now.ms = expiryOf(kit, h.linkId) + GRACE_MS + MIN;
  assert.equal((await sweep(kit)).released, 1);
  kit.now.ms += 10 * MIN;
  await sweep(kit);
  const releasedAt = kit.now.ms;
  assert.equal(await inWatch(kit, h.linkId), true);
  assert.equal(await inPending(kit, h.linkId), true, "its reading showed the PENDING charge");
  // Day 8: the late-watch entry is gone; the PENDING charge keeps the link read on every run.
  kit.now.ms = releasedAt + 8 * DAY;
  let before = linkGets(kit, h.linkId);
  await sweep(kit);
  assert.equal(await inWatch(kit, h.linkId), false);
  assert.equal(linkGets(kit, h.linkId) - before, 1);
  // Day 9: the bank confirms the QR; Beam's webhook never arrives. The next run finds it.
  kit.now.ms = releasedAt + 9 * DAY;
  kit.fakeBeam.succeed(qr.chargeId);
  await sweep(kit);
  const urgent = critical(kit);
  assert.equal(urgent.length, 1);
  assert.equal(urgent[0].subject, `URGENT: paid booking ${h.ref} needs attention`);
  assert.equal(urgent[0].lines[0], lateReason(LIGHTHOUSE(qr.chargeId)));
  assert.equal(await inPending(kit, h.linkId), false, "settled: no longer watched");
  kit.now.ms += DAY;
  before = linkGets(kit, h.linkId);
  await sweep(kit);
  assert.equal(linkGets(kit, h.linkId) - before, 0);

  // A charge that fails ends the watch; one that stays PENDING is watched BEAM_PENDING_WATCH_DAYS at most.
  // (A charge that fails on day 1 is seen while the charge scan still names the link: the flag is kept up to date however
  // the run lists a released link.)
  for (const ending of ["failed on day 1", "failed", "never settles"] as const) {
    const kit2 = makeBeamKit();
    const g = await beamHeld(kit2, "promptpay");
    kit2.now.ms += 5 * MIN;
    const pending = kit2.fakeBeam.payPending(g.linkId, "QR_PROMPT_PAY");
    kit2.now.ms = expiryOf(kit2, g.linkId) + GRACE_MS + MIN;
    await sweep(kit2);
    kit2.now.ms += 10 * MIN;
    await sweep(kit2);
    const flagged = kit2.now.ms;
    assert.equal(await inPending(kit2, g.linkId), true, ending);
    if (ending !== "never settles") {
      kit2.now.ms += ending === "failed" ? 10 * DAY : DAY;
      kit2.fakeBeam.failCharge(pending.chargeId);
      await sweep(kit2);
      assert.equal(await inPending(kit2, g.linkId), false, ending);
    } else {
      kit2.now.ms = flagged + BEAM_PENDING_WATCH_DAYS * DAY - MIN;
      before = linkGets(kit2, g.linkId);
      await sweep(kit2);
      assert.equal(linkGets(kit2, g.linkId) - before, 1, `${ending}: still read on day 29`);
      kit2.now.ms = flagged + BEAM_PENDING_WATCH_DAYS * DAY + MIN;
      before = linkGets(kit2, g.linkId);
      await sweep(kit2);
      assert.equal(linkGets(kit2, g.linkId) - before, 0, `${ending}: dropped after 30 days`);
      assert.equal(await inPending(kit2, g.linkId), false, ending);
    }
    // Past the late watch, a link with no pending charge is not read any more (inside it the late watch still reads it).
    kit2.now.ms = Math.max(kit2.now.ms, flagged + 8 * DAY) + DAY;
    before = linkGets(kit2, g.linkId);
    await sweep(kit2);
    assert.equal(linkGets(kit2, g.linkId) - before, 0, `${ending}: no longer read`);
    assert.equal(critical(kit2).length, 0, ending);
  }
});

test("an orphan's link (record and hold record lost) that Beam rate-limits keeps its hold until a readable run - SUCCEEDED and non-paid", async () => {
  for (const kind of ["paid", "declined"] as const) {
    for (const where of ["note", "read"] as const) {
      const label = `${kind}, 429 at the ${where === "note" ? "reading for the signed note" : "step-1 reading"}`;
      const kit = makeBeamKit();
      const h = await beamHeld(kit);
      kit.now.ms += 5 * MIN;
      const charge = kind === "paid" ? kit.fakeBeam.pay(h.linkId, "CARD") : kit.fakeBeam.decline(h.linkId, "CARD");
      await loseEverything(kit, h);
      kit.now.ms = NOW + ORPHAN_STALE_MS;
      // The orphan is found only by the charge scan (and its signed note) and by Cloudbeds' list.
      const { gw, gate } = flakyLinkReads(kit, h.linkId, 429);
      gate.pass = where === "note" ? 0 : 1;
      if (where === "note") {
        await assert.rejects(sweep(kit, gw), (e: unknown) => e instanceof BeamApiError && e.status === 429, label);
      } else {
        const s = await sweep(kit, gw);
        assert.equal(s.errors, 1, label);
        assert.ok(logged(kit, "sweep_hold_payment_unread").some((l) => l.data?.reservationId === h.reservationId && l.data?.listedPaid === (kind === "paid")), label);
        if (kind === "paid") assert.equal(withSubject(kit, /not yet confirmed in Cloudbeds \(retrying\)$/).length, 1, label);
      }
      assert.equal(res(kit, h.reservationId).status, "not_confirmed", `${label}: kept`);
      assert.equal(critical(kit).length, 0, label);
      assert.equal(calls(kit, "postPayment").length, 0, label);
      // Beam answers again: paid -> confirmed (the hold was kept), declined -> released with the note.
      gate.on = false;
      kit.now.ms += 10 * MIN;
      const s = await sweep(kit, gw);
      assert.equal(s.errors, 0, label);
      if (kind === "paid") {
        assert.equal(res(kit, h.reservationId).status, "confirmed", label);
        assert.equal(res(kit, h.reservationId).payments[0].description, `TEST MODE - NOT REAL MONEY. Beam link ${h.linkId} charge ${charge.chargeId} (card) ref ${h.ref}`);
      } else {
        assert.equal(res(kit, h.reservationId).status, "canceled", label);
        assert.ok(res(kit, h.reservationId).notes.includes("Hold released by the sweeper: a payment was attempted on the Beam payment link but not completed. Nothing was charged."), label);
      }
      assert.equal(critical(kit).length, 0, label);
      assert.equal(withSubject(kit, /^Beam payment record missing/).length, 1, label);
    }
  }
});

/* --------------------------------------- one entry per hold --------------------------------------- */

test("two links naming one reservation share one step-1 entry, which answers the one that was paid", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const record = await readRecord(kit.deps.kv, h.linkId);
  assert.ok(record);
  const second = await createPaymentLink(kit.beam, linkBody(kit, buildBeamNote(record, TOKEN_SECRET), h.ref, record.totalSatang), "second-link", kit.fakeBeam.fetch);
  await writeRecord(kit.deps.kv, { ...record, linkId: second.id });
  await trackOpenLink(kit.deps.kv, kit.config.paymentMode, second.id, record.expiresAt);
  const listed = await kit.gw.sweepRecent(NOW);
  assert.equal(listed.length, 1, "at most one payment per reservation");
  assert.equal(listed[0].reservationId, h.reservationId);
  assert.ok(logged(kit, "beam_sweep_links_share_reservation").length >= 1);
  const charge = kit.fakeBeam.pay(second.id, "CARD");
  kit.now.ms += 5 * MIN;
  const s = await sweep(kit);
  assert.equal(s.sessionsChecked, 1);
  assert.equal(s.fulfilled, 1);
  assert.equal(res(kit, h.reservationId).status, "confirmed");
  assert.equal(res(kit, h.reservationId).payments[0].description, `TEST MODE - NOT REAL MONEY. Beam link ${second.id} charge ${charge.chargeId} (card) ref ${h.ref}`);
  assert.notEqual(await kit.deps.kv.get(keys.fulfilDone(`beam:${second.id}`)), null);
  assert.equal(await kit.deps.kv.get(keys.fulfilDone(h.key)), null);
});

/* -------------------------------------- refunds in Lighthouse -------------------------------------- */

for (const refundLinkStatus of ["any_refund", "all_charges_fully_refunded"] as FakeBeamRefundLinkStatus[]) {
  test(`refunds before confirmation (webhook lost), refundLinkStatus ${refundLinkStatus}: never released, refunded or confirmed as Beam says`, async () => {
    // A 50% card refund in Lighthouse before the booking was confirmed.
    const kit = makeBeamKit({ beam: { refundLinkStatus } });
    const h = await beamHeld(kit);
    const card = kit.fakeBeam.pay(h.linkId, "CARD");
    kit.fakeBeam.refund(card.chargeId, Math.round(card.amount / 2));
    kit.now.ms += 5 * MIN;
    await sweep(kit);
    kit.now.ms += 2 * HOUR;
    await sweep(kit);
    if (refundLinkStatus === "any_refund") {
      assert.equal(kit.fakeBeam.link(h.linkId).status, "REFUNDED");
      const urgent = critical(kit);
      assert.equal(urgent.length, 1);
      assert.ok(urgent[0].lines[0].startsWith("REFUNDED at Beam before the booking was confirmed"), urgent[0].lines[0]);
      assert.equal(res(kit, h.reservationId).status, "not_confirmed", "left for a person, never released");
      assert.equal(calls(kit, "postPayment").length, 0);
    } else {
      assert.equal(kit.fakeBeam.link(h.linkId).status, "PAID");
      assert.equal(res(kit, h.reservationId).status, "confirmed", "the link still says PAID: the booking stands");
      assert.equal(critical(kit).length, 0);
    }
    assert.equal(calls(kit, "putReservation").filter((x) => x.params.status === "canceled").length, 0);

    // Two successes, the extra one refunded in full.
    const kit2 = makeBeamKit({ beam: { refundLinkStatus } });
    const g = await beamHeld(kit2);
    kit2.fakeBeam.pay(g.linkId, "CARD");
    kit2.now.ms += MIN;
    const extra = kit2.fakeBeam.secondCharge(g.linkId, "CARD");
    kit2.fakeBeam.refund(extra.chargeId);
    kit2.now.ms += 5 * MIN;
    await sweep(kit2);
    kit2.now.ms += 2 * HOUR;
    await sweep(kit2);
    assert.equal(withSubject(kit2, /^URGENT: guest charged twice/).length, 1);
    const ambiguous = withSubject(kit2, /check in Lighthouse which charges were refunded$/);
    if (refundLinkStatus === "any_refund") {
      assert.equal(kit2.fakeBeam.link(g.linkId).status, "REFUNDED");
      assert.equal(ambiguous.length, 1);
      assert.equal(res(kit2, g.reservationId).status, "not_confirmed", "nothing confirmed or released automatically");
    } else {
      assert.equal(kit2.fakeBeam.link(g.linkId).status, "PAID");
      assert.equal(ambiguous.length, 0);
      assert.equal(res(kit2, g.reservationId).status, "confirmed");
    }
    assert.equal(calls(kit2, "putReservation").filter((x) => x.params.status === "canceled").length, 0);
  });
}

/* ------------------------------------------ housekeeping ------------------------------------------ */

test("housekeeping: done links leave links-open, released ones are watched for BEAM_LATE_WATCH_DAYS, long-closed ones are dropped", async () => {
  const kit = makeBeamKit();
  const done = await beamHeld(kit);
  const released = await beamHeld(kit, "card_ewallet", GARDEN);
  const refused = await beamHeld(kit, "card_ewallet", [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }]);
  kit.fakeBeam.pay(done.linkId, "CARD");
  // Staff confirm the third hold by hand: its release is refused on every run.
  res(kit, refused.reservationId).status = "confirmed";
  kit.now.ms += 31 * MIN;
  await sweep(kit);
  assert.equal(res(kit, released.reservationId).status, "canceled");
  assert.equal(res(kit, refused.reservationId).status, "confirmed");
  const releasedAt = kit.now.ms + 10 * MIN;
  kit.now.ms = releasedAt;
  await sweep(kit);
  assert.equal(await inOpen(kit, done.linkId), false);
  assert.equal(await inWatch(kit, done.linkId), false);
  assert.equal(await inOpen(kit, released.linkId), false);
  assert.equal(await inWatch(kit, released.linkId), true);
  assert.equal(await inOpen(kit, refused.linkId), true, "neither done nor released: still tracked");
  const watchedReads = () => linkGets(kit, released.linkId);
  // Inside the window the released link is read on every run; past it, it is dropped and no longer read.
  kit.now.ms = releasedAt + 7 * DAY - MIN;
  let before = watchedReads();
  await sweep(kit);
  assert.equal(watchedReads() - before, 1);
  kit.now.ms = releasedAt + 7 * DAY + MIN;
  before = watchedReads();
  await sweep(kit);
  assert.equal(watchedReads() - before, 0);
  assert.equal(await inWatch(kit, released.linkId), false);
  // The refused one: dropped once its link closed more than 7 days ago.
  assert.equal(await inOpen(kit, refused.linkId), false);
  assert.ok(logged(kit, "beam_link_untracked").some((l) => l.data?.linkId === refused.linkId));
  assert.equal(res(kit, refused.reservationId).status, "confirmed", "never cancelled");
});

/* -------------------------------------------- privacy -------------------------------------------- */

test("the card's last digits never reach a log, an alert or Redis through the sweep", async () => {
  const now = { ms: NOW };
  const kv = recordingKv(createMemoryKv(() => now.ms));
  const kit = makeBeamKit({ kv, now });
  const h = await beamHeld(kit);
  kit.fakeBeam.pay(h.linkId, "CARD", { card: { brand: "VISA", last4: "4729", countryAlpha2: "TH" } });
  kit.fakeBeam.secondCharge(h.linkId, "CARD", { card: { brand: "MASTERCARD", last4: "5831", countryAlpha2: "GB" } });
  const own = await createPaymentLink(kit.beam, linkBody(kit, "voucher", h.ref), "own-1", kit.fakeBeam.fetch);
  kit.fakeBeam.pay(own.id, "CARD", { card: { brand: "VISA", last4: "6612", countryAlpha2: "TH" } });
  kit.now.ms += 5 * MIN;
  await sweep(kit);
  assert.ok(kit.alerts.length >= 2);
  const everything = JSON.stringify([kit.logs, kit.alerts, kv.writes]);
  // The digits standing alone, as a leak would show them (random ids can carry them by chance), and no last4 field.
  for (const digits of ["4729", "5831", "6612"]) assert.equal(cardDigitsShown(everything, digits), false, digits);
  assert.doesNotMatch(everything, /"last4"/);
});

/* ------------------------- round 5: readings the round-4 tests left open ------------------------- */

test("a 500 on the scan's first page fails the run (it is no refusal): every hold kept, nothing told as refused", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.now.ms += 31 * MIN;
  const { gw } = failingScan(kit, 500);
  await assert.rejects(sweep(kit, gw), (e: unknown) => e instanceof BeamApiError && e.status === 500);
  assert.equal(res(kit, h.reservationId).status, "not_confirmed");
  assert.equal(withSubject(kit, /refused the sweeper's payment scan/).length, 0);
  assert.equal(logged(kit, "beam_scan_refused").length, 0);
});

test("a scan pass reads at most BEAM_SCAN_MAX_PAGES = 50 pages of 100; one that needs more fails the run", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.fakeBeam.decline(h.linkId, "CARD");
  // The last deep pass is fresh: this run is one 72-hour pass.
  await kit.deps.kv.set(keys.beamDeepScan(SCOPE), String(kit.now.ms), 3600);
  let template: Record<string, unknown> | null = null;
  const offsets: number[] = [];
  const endless = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === "/api/v1/charges" && !url.searchParams.has("sourceId")) {
      const offset = Number(url.searchParams.get("offset") ?? "0");
      offsets.push(offset);
      if (template === null) template = ((await (await kit.fakeBeam.fetch(input, init)).json()) as { data: Record<string, unknown>[] }).data[0];
      // A full page of recent charges every time, as an endless list would answer.
      const data = Array.from({ length: 100 }, (_, i) => ({ ...template, chargeId: `ch_Endless${String(offset + i).padStart(20, "0")}` }));
      return new Response(JSON.stringify({ data, totalCount: 1_000_000 }), { status: 200 });
    }
    return kit.fakeBeam.fetch(input, init);
  }) as typeof fetch;
  await assert.rejects(sweep(kit, beamGateway({ ...kit.deps, fetchImpl: endless })), (e: unknown) => e instanceof BeamApiError && e.errorCode === "SCAN_INCOMPLETE");
  assert.equal(BEAM_SCAN_MAX_PAGES, 50);
  assert.equal(offsets.length, 50);
  assert.equal(offsets.at(-1), 4_900);
  assert.equal(res(kit, h.reservationId).status, "not_confirmed");
});

test("Beam not copying the link's referenceId onto its charges: the unknown-MSV CRITICAL still names the booking (the link's referenceId)", async () => {
  const kit = makeBeamKit({ beam: { copyReferenceIdToCharges: false } });
  const h = await beamHeld(kit);
  const fake = await createPaymentLink(kit.beam, linkBody(kit, "msv1|forged", h.ref), "forged-3", kit.fakeBeam.fetch);
  const charge = kit.fakeBeam.pay(fake.id, "CARD");
  assert.notEqual(kit.fakeBeam.charge(charge.chargeId).referenceId, h.ref, "the charge itself does not name the booking");
  await sweep(kit);
  const warned = withSubject(kit, /^A Beam payment names booking/);
  assert.equal(warned.length, 1);
  assert.equal(warned[0].severity, "critical");
  assert.equal(warned[0].subject, `A Beam payment names booking ${h.ref} but we have no record of it`);
  assert.notEqual(await kit.deps.kv.get(keys.alerted(SCOPE, `beam-unknown-msv:${charge.chargeId}`)), null, "keyed per charge");
  kit.now.ms += PAST_ALERT_WINDOW_MS;
  await sweep(kit);
  assert.equal(withSubject(kit, /^A Beam payment names booking/).length, 1, "once per charge");
});

test("a cached foreign link whose PENDING charge naming an MSV booking succeeds later: one CRITICAL from the scan alone, no new GET", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const fake = await createPaymentLink(kit.beam, linkBody(kit, "msv1|forged", h.ref), "forged-4", kit.fakeBeam.fetch);
  const pending = kit.fakeBeam.payPending(fake.id, "CARD");
  await sweep(kit);
  assert.equal(await kit.deps.kv.get(keys.beamReported(SCOPE, "foreign-link", fake.id)), "1", "read once and cached as not ours");
  assert.equal(withSubject(kit, /^A Beam payment names booking/).length, 0, "pending: no money taken yet");
  const reads = linkGets(kit, fake.id);
  kit.now.ms += 10 * MIN;
  kit.fakeBeam.succeed(pending.chargeId);
  await sweep(kit);
  const warned = withSubject(kit, /^A Beam payment names booking/);
  assert.equal(warned.length, 1);
  assert.equal(warned[0].subject, `A Beam payment names booking ${h.ref} but we have no record of it`);
  assert.equal(linkGets(kit, fake.id), reads, "the cached link is not read again: the scan alone tells");
});

test("a disable Beam answers 404 for is no failed disable (no beamDisableFail marker): the reading fails until the expiry plus the grace", async () => {
  const kit = makeBeamKit({ beam: { expiryLagMs: Number.POSITIVE_INFINITY } });
  const h = await beamHeld(kit);
  kit.now.ms = expiryOf(kit, h.linkId) + BEAM_EXPIRY_SKEW_MS + MIN;
  kit.fakeBeam.failNext(new RegExp(`^PATCH /api/v1/payment-links/${h.linkId}/disable$`), 404, "NOT_FOUND_ERROR");
  const s = await sweep(kit);
  assert.equal(disables(kit, h.linkId), 1);
  assert.equal(await kit.deps.kv.get(keys.beamDisableFail(SCOPE, h.linkId)), null);
  assert.equal(logged(kit, "beam_disable_failed").length, 0);
  assert.ok(logged(kit, "beam_link_missing_early").some((l) => l.data?.linkId === h.linkId));
  assert.deepEqual(await members(kit, keys.beamReadFailures(SCOPE)), [h.linkId]);
  assert.equal(s.released, 0);
  assert.equal(res(kit, h.reservationId).status, "not_confirmed");
});

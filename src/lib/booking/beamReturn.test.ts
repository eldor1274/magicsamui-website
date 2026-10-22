// The return page and abandon for hold-first Beam bookings (design S4.6). runStatus and runAbandon answer Beam
// bookings made through the checkout route's own path (beamTestkit.ts beamRunCheckout), through the real Beam gateway
// on the in-repo fake Beam and the fake Cloudbeds, with the real fulfil and release. Then the checkout, status and
// abandon ROUTES run on the real runtime deps (runtime.ts: the mock writer, the in-memory store and Beam's fetch on
// the fake through the beamFetch test hook), as the golden snapshot runs Stripe's. Nothing leaves the process.
//
// Covered: status per state - open; processing with its pendingReason; paid -> confirmed, confirming or
// needs_attention; unconfirmed with no "Try again"; expired; cancelled after abandon; refunded; mismatch - the pointer
// path without a link token (and with another booking's); a PENDING charge inside the grace never answers "expired";
// the GA4 purchase only in beam-live on the production deployment, once confirmed; the done shortcut answers a
// finished booking with no Beam call, only when the marker is this booking's; the reads stay inside the deadline.
// Abandon: ACTIVE -> disabled and released; PAID -> fulfilled; PENDING -> 'pending', the hold kept; unconfirmed ->
// 'pending'; booking A's token can't cancel booking B.

import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";
import { runAbandon } from "./abandon.ts";
import { buildOffers } from "./availability.ts";
import { BEAM_API_KEY, BEAM_LIVE_ENV, BEAM_MERCHANT_ID, beamRunCheckout, makeBeamKit } from "./beamTestkit.ts";
import type { BeamKit } from "./beamTestkit.ts";
import { POLICY_VERSION } from "./catalogue.ts";
import { BEAM_PLAYGROUND_BASE, getBookingConfig } from "./config.ts";
import type { Env } from "./config.ts";
import { addDays } from "./dates.ts";
import { demoInventory } from "./demoProvider.ts";
import { createMemoryKv } from "./kv.ts";
import type { KvStore } from "./kv.ts";
import { beamKeyOf, keys } from "./lock.ts";
import { createFakeBeam } from "./mock/fakeBeam.ts";
import { createFakeCloudbeds } from "./mock/fakeCloudbeds.ts";
import type { FakeCloudbeds } from "./mock/fakeCloudbeds.ts";
import { satangToBaht } from "./quote.ts";
import { canRetryPayment } from "./returnView.ts";
import { purchaseFor, runStatus } from "./status.ts";
import type { StatusParams, StatusResult } from "./status.ts";
import type { ProviderDepsFn } from "./stripeDeps.ts";
import { GUEST, HONEYMOON, NOW, TOKEN_SECRET } from "./testkit.ts";
import { createBookingToken, verifyBookingToken } from "./token.ts";
import type { BookingSummary, CartItemInput, CheckoutSuccess, PayMethod, Quote, StatusResponse } from "./types.ts";

const MIN = 60_000;
/** BEAM_PENDING_GRACE_MINUTES' default. */
const GRACE_MS = 20 * MIN;
const GARDEN: CartItemInput[] = [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
const SUNRISE: CartItemInput[] = [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
const COULD_NOT_CHECK = { status: 502, body: { ok: false, error: "upstream_error", message: "We couldn't check the payment just now." } };

/** A Beam booking awaiting payment, made through runCheckout. */
interface Booked {
  ref: string;
  /** The page's booking token (no payment id), as on Beam's return URL. */
  t: string;
  /** The link token (the bare link id). */
  l: string;
  linkId: string;
  key: string;
  reservationId: string;
  quote: Quote;
  booking: BookingSummary;
  expiresAt: number;
}

async function booked(kit: BeamKit, payMethod: PayMethod = "card_ewallet", items: CartItemInput[] = HONEYMOON): Promise<Booked> {
  const res = await beamRunCheckout(kit, items, { payMethod });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  const linkId = new URL(body.redirectUrl).pathname.split("/").pop() ?? "";
  const link = kit.fakeBeam.link(linkId);
  const t = new URL(link.redirectUrl ?? "").searchParams.get("t") ?? "";
  const v = verifyBookingToken(t, TOKEN_SECRET, kit.now.ms);
  if (!v.ok) throw new Error("the return URL's token does not verify");
  assert.ok(body.linkToken && body.holdReservationId && link.expiresAtMs !== null);
  return { ref: body.ref, t, l: body.linkToken, linkId, key: beamKeyOf(linkId), reservationId: body.holdReservationId, quote: body.quote, booking: v.payload.booking, expiresAt: link.expiresAtMs };
}

/** The routes' providerDeps for the kit: Beam's deps and gateway, nothing for any other provider. */
const providerDepsOfKit = (kit: BeamKit): ProviderDepsFn => (provider) => (provider === "beam" ? { deps: kit.deps, gw: kit.gw } : null);

function statusOf(kit: BeamKit, b: Pick<Booked, "t" | "l">, params: Partial<StatusParams> = {}): Promise<StatusResult> {
  return runStatus({ t: b.t, p: null, l: b.l, ...params }, { config: kit.config, providerDeps: providerDepsOfKit(kit), nowMs: kit.now.ms, log: kit.deps.log });
}

/** A 200 status answer. */
function answer(r: StatusResult): StatusResponse {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as StatusResponse;
}

function abandon(kit: BeamKit, body: Record<string, unknown>) {
  return runAbandon(body, { config: kit.config, providerDeps: providerDepsOfKit(kit), nowMs: kit.now.ms, log: kit.deps.log });
}

const reservation = (kit: BeamKit, id: string) => {
  const r = kit.fakeCb.reservations.get(id);
  assert.ok(r, `no reservation ${id}`);
  return r;
};
const beamCallsSince = (kit: BeamKit, at: number) => kit.fakeBeam.calls.slice(at).map((c) => `${c.method} ${c.path}`);
const logged = (kit: BeamKit, message: string) => kit.logs.filter((l) => l.message === message);

/* ------------------------------------------- status per state ------------------------------------------- */

test("open: pending / awaiting_payment from Beam's own reading (the link and its charges), by the link token, by the pointer without it, and by the pointer when the token is another booking's", async () => {
  const kit = makeBeamKit();
  const a = await booked(kit);
  const b = await booked(kit, "card_ewallet", GARDEN);
  for (const [label, params] of [
    ["the link token", {}],
    ["no link token: the pointer", { l: null }],
    ["another booking's link token: the pointer", { l: b.l }],
    ["a Stripe session id is never read for Beam", { l: null, s: "cs_test_a1b2c3d4e5f6g7h8i9j0" }],
  ] as const) {
    const at = kit.fakeBeam.calls.length;
    const body = answer(await statusOf(kit, a, params));
    assert.equal(body.status, "pending", label);
    assert.equal(body.provider, "beam");
    assert.equal(body.paymentMode, "beam-playground");
    assert.equal(body.ref, a.ref, label);
    assert.deepEqual(body.fulfilment, { state: "awaiting_payment", reservationId: null }, label);
    assert.equal("pendingReason" in body, false, `${label}: no pendingReason on an open link`);
    assert.equal(body.purchase, null);
    assert.equal(body.booking.payMethod, "card_ewallet");
    assert.deepEqual(beamCallsSince(kit, at), [`GET /api/v1/payment-links/${a.linkId}`, "GET /api/v1/charges"], label);
  }
  assert.equal(kit.fakeBeam.link(b.linkId).status, "ACTIVE");
  assert.equal(reservation(kit, a.reservationId).status, "not_confirmed");
});

test("processing: a PENDING PromptPay charge -> pending with pendingReason 'processing'; after the link expired, inside the grace, still never 'expired'", async () => {
  const kit = makeBeamKit();
  const b = await booked(kit, "promptpay");
  kit.fakeBeam.payPending(b.linkId, "QR_PROMPT_PAY");
  let body = answer(await statusOf(kit, b));
  assert.equal(body.status, "pending");
  assert.equal(body.pendingReason, "processing");
  assert.deepEqual(body.fulfilment, { state: "awaiting_payment", reservationId: null });
  kit.now.ms = b.expiresAt + GRACE_MS - MIN;
  assert.equal(kit.fakeBeam.link(b.linkId).status, "EXPIRED");
  body = answer(await statusOf(kit, b));
  assert.equal(body.status, "pending", "a PENDING charge inside the grace is never 'expired'");
  assert.equal(body.pendingReason, "processing");
  assert.equal(reservation(kit, b.reservationId).status, "not_confirmed", "the hold is kept");
});

test("unconfirmed: still PENDING past the grace -> the hold released, but pending/unconfirmed with no 'Try again'", async () => {
  const kit = makeBeamKit();
  const b = await booked(kit, "promptpay");
  kit.fakeBeam.payPending(b.linkId, "QR_PROMPT_PAY");
  kit.now.ms = b.expiresAt + GRACE_MS + MIN;
  const body = answer(await statusOf(kit, b));
  assert.equal(body.status, "pending");
  assert.equal(body.pendingReason, "unconfirmed");
  assert.deepEqual(body.fulfilment, { state: "released", reservationId: null });
  assert.equal(canRetryPayment(body), false, "never invited to pay again");
  assert.equal(reservation(kit, b.reservationId).status, "canceled");
});

test("expired: no payment by the link's expiry -> expired, the hold released ('Try again' offered)", async () => {
  const kit = makeBeamKit();
  const b = await booked(kit);
  kit.now.ms = b.expiresAt + 1;
  const body = answer(await statusOf(kit, b));
  assert.equal(body.status, "expired");
  assert.deepEqual(body.fulfilment, { state: "released", reservationId: null });
  assert.equal(canRetryPayment(body), true);
  assert.equal(reservation(kit, b.reservationId).status, "canceled");
});

test("cancelled after abandon: the link disabled, the hold released, then the return page says cancelled", async () => {
  const kit = makeBeamKit();
  const b = await booked(kit);
  assert.deepEqual((await abandon(kit, { t: b.t, l: b.l })).body, { ok: true, state: "released" });
  const body = answer(await statusOf(kit, b));
  assert.equal(body.status, "cancelled");
  assert.deepEqual(body.fulfilment, { state: "released", reservationId: null });
  assert.equal(canRetryPayment(body), true);
});

test("paid -> confirmed: fulfilled from the status (the Cloudbeds reservation confirmed, the payment posted); beam-playground carries no purchase", async () => {
  const kit = makeBeamKit();
  const b = await booked(kit);
  kit.fakeBeam.pay(b.linkId, "CARD");
  const body = answer(await statusOf(kit, b, { l: null }));
  assert.equal(body.status, "paid");
  assert.deepEqual(body.fulfilment, { state: "confirmed", reservationId: b.reservationId });
  assert.equal(body.purchase, null, "a purchase only in beam-live on the production deployment");
  const r = reservation(kit, b.reservationId);
  assert.equal(r.status, "confirmed");
  assert.deepEqual(r.payments.map((p) => p.amount), [b.quote.totalSatang / 100]);
  assert.ok(logged(kit, "beam_status_mismatch").length === 0);
});

test("paid -> confirming: the confirmation still running elsewhere (fulfil's lock) -> confirming, no purchase; then confirmed", async () => {
  const kit = makeBeamKit({ env: BEAM_LIVE_ENV });
  const b = await booked(kit);
  kit.fakeBeam.pay(b.linkId, "CARD");
  await kit.deps.kv.set(keys.fulfilLock(b.key), "another-instance", 120);
  let body = answer(await statusOf(kit, b));
  assert.equal(body.status, "paid");
  assert.deepEqual(body.fulfilment, { state: "confirming", reservationId: null });
  assert.equal(body.purchase, null, "never before the reservation is confirmed");
  assert.equal(canRetryPayment(body), false);
  await kit.deps.kv.del(keys.fulfilLock(b.key));
  body = answer(await statusOf(kit, b));
  assert.deepEqual(body.fulfilment, { state: "confirmed", reservationId: b.reservationId });
  assert.deepEqual(body.purchase, { transactionId: b.reservationId, valueBaht: satangToBaht(b.quote.dueNowSatang), currency: "THB" });
});

test("paid -> needs_attention: the hold was cancelled in Cloudbeds before the payment -> paid/needs_attention ('we'll contact you'), the CRITICAL alert, no purchase", async () => {
  const kit = makeBeamKit({ env: BEAM_LIVE_ENV });
  const b = await booked(kit);
  reservation(kit, b.reservationId).status = "canceled";
  kit.fakeBeam.pay(b.linkId, "CARD");
  const body = answer(await statusOf(kit, b));
  assert.equal(body.status, "paid");
  assert.deepEqual(body.fulfilment, { state: "needs_attention", reservationId: b.reservationId });
  assert.equal(body.purchase, null);
  assert.equal(canRetryPayment(body), false);
  assert.ok(kit.alerts.some((a) => a.severity === "critical"), JSON.stringify(kit.alerts.map((a) => a.subject)));
});

test("refunded before anything confirmed it: 'refunded', nothing confirmed or released, no 'Try again'", async () => {
  const kit = makeBeamKit();
  const b = await booked(kit);
  const charge = kit.fakeBeam.pay(b.linkId, "CARD");
  kit.fakeBeam.refund(charge.chargeId);
  const body = answer(await statusOf(kit, b));
  assert.equal(body.status, "refunded");
  assert.deepEqual(body.fulfilment, { state: "not_applicable", reservationId: null });
  assert.equal(canRetryPayment(body), false);
  assert.equal(reservation(kit, b.reservationId).status, "not_confirmed", "never confirmed, never cancelled from here");
  assert.equal(reservation(kit, b.reservationId).payments.length, 0);
});

test("mismatch: a token whose amount is not the payment's -> failed AMOUNT_OR_REFERENCE_MISMATCH (contact us, never 'Try again'), nothing written; a done marker for another amount is never the answer", async () => {
  const kit = makeBeamKit();
  const b = await booked(kit);
  const other = { ...b.booking, totalSatang: b.booking.totalSatang - 100, dueNowSatang: b.booking.dueNowSatang - 100 };
  const forged = {
    t: createBookingToken(other, null, TOKEN_SECRET, 3600, kit.now.ms),
    l: createBookingToken(other, b.linkId, TOKEN_SECRET, 3600, kit.now.ms),
  };
  const cbAt = kit.fakeCb.calls.length;
  let body = answer(await statusOf(kit, forged));
  assert.equal(body.status, "failed");
  assert.equal(body.failureCode, "AMOUNT_OR_REFERENCE_MISMATCH");
  assert.deepEqual(body.fulfilment, { state: "not_applicable", reservationId: null });
  assert.equal(canRetryPayment(body), false);
  assert.deepEqual(kit.fakeCb.calls.slice(cbAt), [], "nothing written to Cloudbeds");
  assert.ok(logged(kit, "beam_status_mismatch").some((l) => l.data?.ref === b.ref && l.data?.sessionId === b.key));

  // Once the real booking is confirmed (its done marker), the forged amount still reaches Beam and is refused.
  kit.fakeBeam.pay(b.linkId, "CARD");
  assert.deepEqual(answer(await statusOf(kit, b)).fulfilment, { state: "confirmed", reservationId: b.reservationId });
  const at = kit.fakeBeam.calls.length;
  body = answer(await statusOf(kit, forged));
  assert.equal(body.status, "failed");
  assert.equal(body.failureCode, "AMOUNT_OR_REFERENCE_MISMATCH");
  assert.ok(kit.fakeBeam.calls.length > at, "a marker for another amount is not this booking's: Beam is asked");
});

/* ------------------------------------------- the done shortcut ------------------------------------------- */

test("the done shortcut: a finished booking (confirmed or needs_attention) is answered from its done marker with no Beam call, with the purchase", async () => {
  const kit = makeBeamKit({ env: BEAM_LIVE_ENV });
  const b = await booked(kit);
  kit.fakeBeam.pay(b.linkId, "CARD");
  const first = answer(await statusOf(kit, b));
  assert.deepEqual(first.fulfilment, { state: "confirmed", reservationId: b.reservationId });
  const at = kit.fakeBeam.calls.length;
  const cbAt = kit.fakeCb.calls.length;
  for (const l of [b.l, null]) {
    const body = answer(await statusOf(kit, b, { l }));
    assert.equal(body.status, "paid");
    assert.deepEqual(body.fulfilment, { state: "confirmed", reservationId: b.reservationId });
    assert.deepEqual(body.purchase, { transactionId: b.reservationId, valueBaht: satangToBaht(b.quote.dueNowSatang), currency: "THB" });
  }
  assert.deepEqual(beamCallsSince(kit, at), [], "no Beam call");
  assert.deepEqual(kit.fakeCb.calls.slice(cbAt), [], "no Cloudbeds call");

  // needs_attention is final too: answered from the marker.
  const c = await booked(kit, "card_ewallet", GARDEN);
  reservation(kit, c.reservationId).status = "canceled";
  kit.fakeBeam.pay(c.linkId, "CARD");
  assert.equal(answer(await statusOf(kit, c)).fulfilment.state, "needs_attention");
  const at2 = kit.fakeBeam.calls.length;
  const again = answer(await statusOf(kit, c));
  assert.equal(again.status, "paid");
  assert.deepEqual(again.fulfilment, { state: "needs_attention", reservationId: c.reservationId });
  assert.equal(again.purchase, null);
  assert.deepEqual(beamCallsSince(kit, at2), []);
});

test("purchase: only beam-live on the production deployment, once confirmed (purchaseFor)", () => {
  const live = getBookingConfig(BEAM_LIVE_ENV, { liveFulfilmentReady: true });
  const booking = { dueNowSatang: 2_781_000 } as BookingSummary;
  const confirmed = { state: "confirmed" as const, reservationId: "7000000123456" };
  assert.deepEqual(purchaseFor(live, booking, confirmed), { transactionId: "7000000123456", valueBaht: 27_810, currency: "THB" });
  assert.equal(purchaseFor({ ...live, production: false }, booking, confirmed), null);
  assert.equal(purchaseFor(makeBeamKit().config, booking, confirmed), null, "beam-playground");
  for (const state of ["confirming", "needs_attention", "awaiting_payment", "released", "not_applicable"] as const) {
    assert.equal(purchaseFor(live, booking, { state, reservationId: "7000000123456" }), null, state);
  }
});

/* --------------------------------------------- the deadline --------------------------------------------- */

test("the status reads stay inside the route's deadline: a Beam that answers the link at the deadline gets the guest 502 'couldn't check', the charges never asked", async () => {
  const clock = { ms: 0 };
  const kit = makeBeamKit({ gateway: { deadlineMs: 25_000, clock: () => clock.ms } });
  const b = await booked(kit);
  const inner = kit.deps.fetchImpl as typeof fetch;
  kit.deps.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await inner(input, init);
    if (String(input).includes("/payment-links/")) clock.ms += 25_000;
    return res;
  }) as typeof fetch;
  const at = kit.fakeBeam.calls.length;
  assert.deepEqual(await statusOf(kit, b), COULD_NOT_CHECK);
  assert.deepEqual(beamCallsSince(kit, at), [`GET /api/v1/payment-links/${b.linkId}`], "no time left for the charge read");
  assert.ok(logged(kit, "beam_status_failed").some((l) => l.data?.ref === b.ref));
  assert.equal(reservation(kit, b.reservationId).status, "not_confirmed", "nothing released on a failed reading");
});

/* ------------------------------------------------ abandon ------------------------------------------------ */

test("abandon: an ACTIVE link -> disabled and the hold released", async () => {
  const kit = makeBeamKit();
  const b = await booked(kit);
  assert.deepEqual(await abandon(kit, { t: b.t, l: b.l }), { status: 200, body: { ok: true, state: "released" } });
  assert.equal(kit.fakeBeam.link(b.linkId).status, "DISABLED");
  assert.equal(reservation(kit, b.reservationId).status, "canceled");
  assert.equal(await kit.deps.kv.get(keys.abandoned(b.key)), "1");
  assert.ok(logged(kit, "booking_abandoned").some((l) => l.data?.ref === b.ref && l.data?.state === "released"));
});

test("abandon: a PAID link is fulfilled, never cancelled ('paid'); found by the pointer without a link token", async () => {
  const kit = makeBeamKit();
  const b = await booked(kit);
  kit.fakeBeam.pay(b.linkId, "CARD");
  assert.deepEqual((await abandon(kit, { t: b.t })).body, { ok: true, state: "paid" });
  assert.equal(kit.fakeBeam.link(b.linkId).status, "PAID");
  assert.equal(reservation(kit, b.reservationId).status, "confirmed");
});

test("abandon: a PENDING charge -> 'pending', the link disabled, the hold kept; still PENDING past the grace -> 'pending' (released, never 'Try again')", async () => {
  const kit = makeBeamKit();
  const b = await booked(kit, "promptpay");
  kit.fakeBeam.payPending(b.linkId, "QR_PROMPT_PAY");
  assert.deepEqual((await abandon(kit, { t: b.t, l: b.l })).body, { ok: true, state: "pending" });
  assert.equal(kit.fakeBeam.link(b.linkId).status, "DISABLED");
  assert.equal(reservation(kit, b.reservationId).status, "not_confirmed", "the QR may still be paid: the hold stays");

  const c = await booked(kit, "promptpay", GARDEN);
  kit.fakeBeam.payPending(c.linkId, "QR_PROMPT_PAY");
  kit.now.ms = c.expiresAt + GRACE_MS + MIN;
  assert.deepEqual((await abandon(kit, { t: c.t, l: c.l })).body, { ok: true, state: "pending" });
  assert.equal(reservation(kit, c.reservationId).status, "canceled");
});

test("abandon: booking A's token can't cancel booking B (B's link token and B's link id are never read for A)", async () => {
  const kit = makeBeamKit();
  const a = await booked(kit);
  const b = await booked(kit, "card_ewallet", GARDEN);
  assert.deepEqual((await abandon(kit, { t: a.t, l: b.l, s: b.linkId })).body, { ok: true, state: "released" });
  assert.equal(kit.fakeBeam.link(a.linkId).status, "DISABLED");
  assert.equal(reservation(kit, a.reservationId).status, "canceled");
  assert.equal(kit.fakeBeam.link(b.linkId).status, "ACTIVE", "B's link is untouched");
  assert.equal(reservation(kit, b.reservationId).status, "not_confirmed", "B's hold is kept");
  assert.equal(await kit.deps.kv.get(keys.abandoned(b.key)), null);
});

/* ------------------------------------------------- routes ------------------------------------------------- */

// The route handlers import "@/..." paths and runtime.ts imports "next/server", which plain Node can't resolve: a
// resolve hook maps them to the same module URLs the relative imports use (as stripeGolden.test.ts does), so every
// module is loaded once.
type ResolveHook = (specifier: string, context: unknown, nextResolve: (specifier: string, context?: unknown) => { url: string }) => { url: string; shortCircuit?: boolean };
let hooked = false;

async function loadRoutes() {
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
  return {
    checkout: await import("../../app/api/booking/checkout/route.ts"),
    status: await import("../../app/api/booking/status/route.ts"),
    abandon: await import("../../app/api/booking/abandon/route.ts"),
    NextRequest: (await import("next/server")).NextRequest,
  };
}

/** runtime.ts's process-wide state (globalThis.__msvBookingRuntime). */
interface RuntimeGlobals {
  memoryKv?: KvStore;
  mockWriterCloudbeds?: FakeCloudbeds;
  beamFetch?: typeof fetch;
  [other: string]: unknown;
}

function runtimeGlobals(): RuntimeGlobals {
  const g = globalThis as typeof globalThis & { __msvBookingRuntime?: RuntimeGlobals };
  return (g.__msvBookingRuntime ??= {});
}

/** beam-playground with the MOCK writer and demo availability (a local run): the in-memory store, nothing leaves. */
const ROUTE_ENV: Env = {
  BOOKING_PAYMENT_PROVIDER: "beam",
  BEAM_API_BASE: BEAM_PLAYGROUND_BASE,
  BEAM_MERCHANT_ID,
  BEAM_API_KEY,
  BOOKING_TOKEN_SECRET: TOKEN_SECRET,
};

/** The first 3-night window from Jan 2027 where the demo calendar has `slug` free. */
function demoWindow(slug: string): { checkIn: string; checkOut: string } {
  for (let i = 0; i < 300; i++) {
    const checkIn = addDays("2027-01-04", i);
    const checkOut = addDays(checkIn, 3);
    if (buildOffers(demoInventory(checkIn, checkOut), 2).find((o) => o.slug === slug)?.available) return { checkIn, checkOut };
  }
  throw new Error(`no demo window for ${slug}`);
}

test("routes: checkout, status and abandon on Beam through the real handlers and runtime deps - hold-first, the done shortcut, the status and abandon routes' deadline", async (t: TestContext) => {
  const savedEnv = process.env;
  const savedFetch = globalThis.fetch;
  const rt = runtimeGlobals();
  const savedGlobals = { ...rt };
  const network: string[] = [];
  const lines: string[] = [];
  try {
    process.env = { ...ROUTE_ENV } as NodeJS.ProcessEnv;
    globalThis.fetch = (async (input: string | URL | Request) => {
      network.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      throw new TypeError("network blocked by beamReturn.test.ts");
    }) as typeof fetch;
    const routes = await loadRoutes();
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    for (const level of ["info", "warn", "error"] as const) {
      t.mock.method(console, level, (...args: unknown[]) => void lines.push(typeof args[0] === "string" ? args[0] : JSON.stringify(args[0])));
    }
    for (const key of Object.keys(rt)) delete rt[key];
    const config = getBookingConfig(ROUTE_ENV);
    assert.equal(config.paymentMode, "beam-playground");
    assert.deepEqual(config.cloudbedsWrite, { mode: "mock" });
    const fakeBeam = createFakeBeam({ now: () => Date.now(), merchantId: BEAM_MERCHANT_ID, apiKey: BEAM_API_KEY, base: "playground" });
    const cloudbeds = createFakeCloudbeds({ lenient: true, now: () => Date.now() });
    const memory = createMemoryKv(() => Date.now());
    let slowLinkReads = false;
    let slowCreateNoRecord = false;
    // The store, failing the payment record's write while slowCreateNoRecord is set (afterCreate then closes the page).
    const kv: KvStore = {
      ...memory,
      kind: memory.kind,
      set: (key, value, ttl) => (slowCreateNoRecord && key.startsWith("msv:beam:pay:") ? Promise.reject(new Error("simulated Redis failure")) : memory.set(key, value, ttl)),
    };
    rt.memoryKv = kv;
    rt.mockWriterCloudbeds = cloudbeds;
    rt.beamFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await fakeBeam.fetch(input, init);
      // A Beam that answers a link read only after the status route's 25-second budget.
      if (slowLinkReads && String(input).includes("/payment-links/")) t.mock.timers.setTime(Date.now() + 26_000);
      // A create answered only after the checkout route's 25-second budget.
      if (slowCreateNoRecord && (init?.method ?? "GET") === "POST") t.mock.timers.setTime(Date.now() + 26_000);
      return res;
    }) as typeof fetch;

    const headers = { host: "localhost:3000", "x-forwarded-for": "198.51.100.46", "content-type": "application/json" };
    const post = (path: string, body: unknown) => new Request(`http://localhost:3000${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const getStatus = async (q: Record<string, string>) => {
      const res = await routes.status.GET(new routes.NextRequest(`http://localhost:3000/api/booking/status?${new URLSearchParams(q).toString()}`, { headers }));
      return { status: res.status, body: (await res.json()) as StatusResponse };
    };
    const book = async (items: CartItemInput[]) => {
      const req = { ...demoWindow(items[0].slug), items, termsVersion: POLICY_VERSION, guest: GUEST, payMethod: "card_ewallet" };
      const quoted = await routes.checkout.POST(post("/api/booking/checkout", { ...req, expectedTotalSatang: 1, expectedDueNowSatang: 1 }));
      assert.equal(quoted.status, 409);
      const { quote } = (await quoted.json()) as { quote: Quote };
      const res = await routes.checkout.POST(post("/api/booking/checkout", { ...req, expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang }));
      const body = (await res.json()) as CheckoutSuccess;
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.provider, "beam");
      assert.equal(new URL(body.redirectUrl).host, "playground-pay.beamcheckout.com");
      const linkId = new URL(body.redirectUrl).pathname.split("/").pop() ?? "";
      const tok = new URL(fakeBeam.link(linkId).redirectUrl ?? "").searchParams.get("t") ?? "";
      return { linkId, t: tok, l: body.linkToken ?? "", reservationId: body.holdReservationId ?? "" };
    };

    // 1. Held, then abandoned on the payment page: disabled, released, "cancelled".
    const a = await book(HONEYMOON);
    assert.equal(cloudbeds.reservations.get(a.reservationId)?.status, "not_confirmed");
    assert.equal((await getStatus({ t: a.t, l: a.l })).body.status, "pending");
    const ab = await routes.abandon.POST(post("/api/booking/abandon", { t: a.t, l: a.l }));
    assert.deepEqual(await ab.json(), { ok: true, state: "released" });
    assert.equal(fakeBeam.link(a.linkId).status, "DISABLED");
    assert.equal(cloudbeds.reservations.get(a.reservationId)?.status, "canceled");
    assert.equal((await getStatus({ t: a.t, l: a.l })).body.status, "cancelled");

    // 2. Paid: the return page (the pointer, no link token) confirms it; the next reading comes from the done marker.
    const b = await book(GARDEN);
    fakeBeam.pay(b.linkId, "CARD");
    const paid = await getStatus({ t: b.t });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.status, "paid");
    assert.deepEqual(paid.body.fulfilment, { state: "confirmed", reservationId: b.reservationId });
    assert.equal(cloudbeds.reservations.get(b.reservationId)?.status, "confirmed");
    const calls = fakeBeam.calls.length;
    const again = await getStatus({ t: b.t, l: b.l });
    assert.deepEqual(again.body.fulfilment, { state: "confirmed", reservationId: b.reservationId });
    assert.equal(fakeBeam.calls.length, calls, "no Beam call for a finished booking");

    // 3. The status route's deadline reaches every Beam call: the charges are never read after a 26-second link read.
    const c = await book(SUNRISE);
    slowLinkReads = true;
    const before = fakeBeam.calls.length;
    const slow = await getStatus({ t: c.t, l: c.l });
    assert.deepEqual(slow, COULD_NOT_CHECK);
    assert.deepEqual(fakeBeam.calls.slice(before).map((x) => `${x.method} ${x.path}`), [`GET /api/v1/payment-links/${c.linkId}`]);
    // The abandon route's deadline too: no time is left to disable the link after a 26-second link read.
    const abandonAt = fakeBeam.calls.length;
    const late = await routes.abandon.POST(post("/api/booking/abandon", { t: c.t, l: c.l }));
    assert.equal(late.status, 502);
    assert.deepEqual(fakeBeam.calls.slice(abandonAt).map((x) => `${x.method} ${x.path}`), [`GET /api/v1/payment-links/${c.linkId}`]);
    assert.equal(fakeBeam.link(c.linkId).status, "ACTIVE");
    slowLinkReads = false;

    // The checkout route's deadline reaches the Beam deps too: a page whose record could not be written once the deadline
    // has passed is not disabled in the route's time (the link was never handed out and lapses at its own expiry; its
    // signed note still names the booking to the charge scan), and the guest gets the 502.
    slowCreateNoRecord = true;
    const createdBefore = fakeBeam.links.size;
    const disablesBefore = fakeBeam.calls.filter((x) => x.method === "PATCH").length;
    const window = demoWindow("seaview-2br");
    const tooLateReq = { ...window, items: [{ slug: "seaview-2br", ratePlanId: "standard", adults: 2, addonIds: [] }], termsVersion: POLICY_VERSION, guest: GUEST, payMethod: "card_ewallet" };
    const priced = (await (await routes.checkout.POST(post("/api/booking/checkout", { ...tooLateReq, expectedTotalSatang: 1, expectedDueNowSatang: 1 }))).json()) as { quote: Quote };
    const tooLate = await routes.checkout.POST(
      post("/api/booking/checkout", { ...tooLateReq, expectedTotalSatang: priced.quote.totalSatang, expectedDueNowSatang: priced.quote.dueNowSatang }),
    );
    assert.equal(tooLate.status, 502);
    assert.equal(fakeBeam.links.size, createdBefore + 1, "the link was created");
    assert.equal(fakeBeam.calls.filter((x) => x.method === "PATCH").length, disablesBefore, "no disable after the route's deadline");
    assert.ok(lines.includes("[booking] beam_session_expire_failed"), "the skipped disable is logged");
    slowCreateNoRecord = false;

    assert.deepEqual(network, [], "nothing left the process");
    for (const event of ["hold_created", "beam_session_created", "booking_abandoned", "beam_status_failed"]) {
      assert.ok(lines.includes(`[booking] ${event}`), `${event} logged: ${lines.join(" | ")}`);
    }
  } finally {
    for (const key of Object.keys(rt)) delete rt[key];
    Object.assign(rt, savedGlobals);
    process.env = savedEnv;
    globalThis.fetch = savedFetch;
  }
});

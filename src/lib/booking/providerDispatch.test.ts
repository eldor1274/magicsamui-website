// Status and abandon dispatch by the booking's provider (Beam design step S1.5). runStatus and runAbandon
// finish a hold-first booking through the deps and PaymentGateway that deps.providerDeps(provider) hands
// out for the BOOKING's provider - the active config's for its own provider, else that provider's drain -
// and through nothing else:
// - the drain is asked only for a booking of another mode, and used only when it is of the booking's mode;
// - no deps for the active hold-first provider -> 503, as before; demo and the Beam preview never ask;
// - the payment key comes from the request (Stripe ids only), else the booking pointer;
// - every read, cancel, Redis key, release reason and log name follows the gateway handed in;
// - the Stripe shorthand (deps.stripe, deps.stripeDrain) maps onto the same dispatch;
// - runtime.ts providerDepsFor builds the active deps at once and a drain only when a booking asks.
// Only Stripe has a gateway so far: the other provider here is "Acme" (the Stripe gateway under another
// provider, brand and wording), as in sweepOwnership.test.ts. Live Stripe answers are pinned by the golden
// snapshot (stripeGolden.test.ts), which runs both the shorthand and the routes' providerDepsFor.

import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { runAbandon } from "./abandon.ts";
import { BEAM_PLAYGROUND_BASE, getBookingConfig, getFulfilmentConfig } from "./config.ts";
import type { Env } from "./config.ts";
import { keys } from "./lock.ts";
import type { PaymentGateway } from "./payments/gateway.ts";
import { stripeGateway } from "./payments/stripeGateway.ts";
import { holdFirstProvider, providerDepsOf, requestPaymentKey, runStatus } from "./status.ts";
import type { ProviderDeps, ProviderDepsFn } from "./stripeDeps.ts";
import { HONEYMOON, NOW, STRIPE_LIVE_ENV, STRIPE_TEST_ENV, TOKEN_SECRET, checkout, makeKit, sessionIdOf } from "./testkit.ts";
import type { Kit } from "./testkit.ts";
import { createBookingToken, verifyBookingToken } from "./token.ts";
import type { BookingSummary, CheckoutSuccess, PaymentMode, StatusResponse } from "./types.ts";

const DEMO_ENV: Env = { ...STRIPE_TEST_ENV, BOOKING_PAYMENT_PROVIDER: "demo" };
const BEAM_ENV: Env = { BEAM_API_BASE: BEAM_PLAYGROUND_BASE, BEAM_MERCHANT_ID: "m1", BEAM_API_KEY: "k1", BOOKING_TOKEN_SECRET: TOKEN_SECRET };

async function opened(kit: Kit) {
  const res = await checkout(kit, HONEYMOON);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  const session = kit.fakeStripe.session(sessionIdOf(body))!;
  const t = new URL(session.success_url.replace("{CHECKOUT_SESSION_ID}", "x")).searchParams.get("t")!;
  const v = verifyBookingToken(t, TOKEN_SECRET, NOW);
  if (!v.ok) throw new Error("bad token");
  return { booking: v.payload.booking, sessionId: session.id, reservationId: body.holdReservationId!, t, l: body.linkToken! };
}

/** A booking's token, signed in a payment mode (same secret) with a link id. */
function tokenIn(booking: BookingSummary, paymentMode: PaymentMode, paymentLinkId: string | null = null): string {
  return createBookingToken({ ...booking, paymentMode }, paymentLinkId, TOKEN_SECRET, 48 * 3600, NOW);
}

/** providerDeps that hands out `pd` for Stripe and records every provider asked for. */
function recording(pd: ProviderDeps | null): { fn: ProviderDepsFn; asked: string[] } {
  const asked: string[] = [];
  return { asked, fn: (provider) => (asked.push(provider), provider === "stripe" ? pd : null) };
}

const stripeOf = (kit: Kit): ProviderDeps => ({ deps: kit.deps, gw: stripeGateway(kit.deps) });

/** The Stripe gateway under another provider, brand and wording, recording every read and cancel. */
function acmeGateway(kit: Kit, calls: string[]): PaymentGateway {
  const inner = stripeGateway(kit.deps);
  return {
    ...inner,
    provider: "beam",
    brand: "Acme",
    get: (key) => (calls.push(`get ${key}`), inner.get(key)),
    cancel: (key) => (calls.push(`cancel ${key}`), inner.cancel(key)),
    text: { ...inner.text, paidVia: (receipt, amount) => `via Acme ${receipt.primaryId ?? "-"} (${amount})`, sessionLabel: { long: "payment link", short: "link" } },
  };
}

test("holdFirstProvider: only the hold-first modes (Stripe so far) have a gateway provider", () => {
  for (const mode of ["stripe-test", "stripe-live", "stripe-mock"] as const) assert.equal(holdFirstProvider(mode), "stripe", mode);
  for (const mode of ["demo", "beam-playground", "beam-live"] as const) assert.equal(holdFirstProvider(mode), null, mode);
});

test("requestPaymentKey: the redirect's id, else this booking's link token; Stripe ids only", async () => {
  const kit = makeKit();
  const a = await opened(kit);
  const gw = stripeGateway(kit.deps);
  const key = (s: unknown, l: unknown, g: PaymentGateway = gw) => requestPaymentKey(s, l, a.booking, TOKEN_SECRET, g, NOW);
  assert.equal(key(a.sessionId, null), a.sessionId);
  assert.equal(key(a.sessionId, tokenIn(a.booking, "stripe-test", "cs_test_other0000000000")), a.sessionId, "the redirect's id comes first");
  assert.equal(key(null, a.l), a.sessionId, "the link token carries the session id");
  assert.equal(key("not-a-session", a.l), a.sessionId, "a malformed s is ignored");
  assert.equal(key(null, ""), null);
  assert.equal(key(null, 42), null);
  assert.equal(key(null, "garbage"), null);
  assert.equal(key(null, tokenIn(a.booking, "stripe-test", "plink_123")), null, "a link id that is not a Stripe session id");
  const otherBooking = createBookingToken({ ...a.booking, ref: "MSV-20261005-ZZZZ" }, a.sessionId, TOKEN_SECRET, 3600, NOW);
  assert.equal(key(null, otherBooking), null, "another booking's link token never names this booking's payment");
  const acme = acmeGateway(kit, []);
  assert.equal(key(a.sessionId, a.l, acme), null, "no other provider's id is read from a request yet: the pointer is used");
});

test("providerDepsOf: providerDeps wins; else stripe for an active Stripe config, stripeDrain otherwise, nothing for Beam", async () => {
  const kit = makeKit();
  const demo = getBookingConfig(DEMO_ENV);
  const handed: ProviderDepsFn = () => null;
  assert.equal(providerDepsOf({ config: kit.config, providerDeps: handed, stripe: kit.deps }), handed);

  let drains = 0;
  const drain = () => (drains++, kit.deps);
  const active = providerDepsOf({ config: kit.config, stripe: kit.deps, stripeDrain: drain });
  assert.equal(active("stripe")?.deps, kit.deps);
  assert.equal(active("stripe")?.gw.provider, "stripe");
  assert.equal(active("stripe")?.gw.brand, "Stripe");
  assert.equal(active("beam"), null);
  assert.equal(drains, 0, "the active Stripe config never asks the drain");

  const drained = providerDepsOf({ config: demo, stripe: null, stripeDrain: drain });
  assert.equal(drained("stripe")?.deps, kit.deps);
  assert.equal(drains, 1);
  assert.equal(drained("beam"), null);
  assert.equal(drains, 1, "the Stripe drain is never asked for another provider");
  assert.equal(providerDepsOf({ config: demo, stripe: kit.deps })("stripe"), null, "without a drain a Stripe booking has no deps under demo");
  assert.equal(providerDepsOf({ config: kit.config })("stripe"), null);
});

test("status: the active hold-first config asks for its own provider once; without deps -> 503; demo and the Beam preview never ask", async () => {
  const kit = makeKit();
  const a = await opened(kit);
  const r = recording(stripeOf(kit));
  const res = await runStatus({ t: a.t, p: null, l: null, s: a.sessionId }, { config: kit.config, providerDeps: r.fn, nowMs: NOW });
  assert.equal((res.body as StatusResponse).status, "pending");
  assert.deepEqual(r.asked, ["stripe"]);

  const none = recording(null);
  const un = await runStatus({ t: a.t, p: null, l: null, s: a.sessionId }, { config: kit.config, providerDeps: none.fn, nowMs: NOW });
  assert.deepEqual(un, { status: 503, body: { ok: false, error: "payment_unavailable", message: "Payment status is unavailable." } });
  const ab = await runAbandon({ t: a.t, s: a.sessionId }, { config: kit.config, providerDeps: none.fn, nowMs: NOW });
  assert.deepEqual(ab, { status: 503, body: { ok: false, error: "payment_unavailable", message: "Please try again in a moment." } });
  assert.deepEqual(none.asked, ["stripe", "stripe"]);
  assert.notEqual(kit.fakeCb.reservations.get(a.reservationId)?.status, "canceled", "nothing was released");
  assert.equal(kit.fakeStripe.session(a.sessionId)?.status, "open", "nothing was cancelled");

  const demo = getBookingConfig(DEMO_ENV);
  const d = recording(stripeOf(kit));
  const demoToken = tokenIn(a.booking, "demo");
  assert.equal(((await runStatus({ t: demoToken, p: null, l: null }, { config: demo, providerDeps: d.fn, nowMs: NOW })).body as StatusResponse).status, "pending");
  assert.deepEqual((await runAbandon({ t: demoToken }, { config: demo, providerDeps: d.fn, nowMs: NOW })).body, { ok: true, state: "not_applicable" });

  const beam = getBookingConfig(BEAM_ENV);
  const beamToken = tokenIn(a.booking, "beam-playground");
  const nothing = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
  const pb = await runStatus({ t: beamToken, p: null, l: null }, { config: beam, providerDeps: d.fn, nowMs: NOW, fetchImpl: nothing });
  assert.equal((pb.body as StatusResponse).status, "pending", "the Beam preview answers as before");
  assert.deepEqual((await runAbandon({ t: beamToken }, { config: beam, providerDeps: d.fn, nowMs: NOW })).body, { ok: true, state: "not_applicable" });
  assert.deepEqual(d.asked, [], "demo and the Beam preview never ask for provider deps");
});

test("drain: a booking of another mode is finished with its provider's deps, only when they are of its mode", async () => {
  const kit = makeKit();
  const a = await opened(kit);
  const demo = getBookingConfig(DEMO_ENV);
  kit.fakeStripe.complete(a.sessionId);

  const wrongMode = recording(stripeOf(makeKit({ env: STRIPE_LIVE_ENV })));
  const refused = await runStatus({ t: a.t, p: null, l: null, s: a.sessionId }, { config: demo, providerDeps: wrongMode.fn, nowMs: NOW });
  assert.equal(refused.status, 409, "a drain of another mode is not this booking's");
  assert.deepEqual((await runAbandon({ t: a.t, s: a.sessionId }, { config: demo, providerDeps: wrongMode.fn, nowMs: NOW })).body, { ok: true, state: "not_applicable" });
  assert.equal((await runStatus({ t: a.t, p: null, l: null, s: a.sessionId }, { config: demo, providerDeps: recording(null).fn, nowMs: NOW })).status, 409);
  assert.equal(kit.fakeStripe.session(a.sessionId)?.status, "complete", "nothing was read or cancelled through the wrong deps");

  const r = recording(stripeOf(kit));
  const res = (await runStatus({ t: a.t, p: null, l: null, s: a.sessionId }, { config: demo, providerDeps: r.fn, nowMs: NOW })).body as StatusResponse;
  assert.equal(res.status, "paid");
  assert.equal(res.paymentMode, "stripe-test");
  assert.deepEqual(res.fulfilment, { state: "confirmed", reservationId: a.reservationId });
  assert.deepEqual(r.asked, ["stripe"]);
  assert.equal(kit.fakeCb.reservations.get(a.reservationId)?.status, "confirmed");

  // Abandon drains the same way.
  const kit2 = makeKit();
  const b = await opened(kit2);
  const r2 = recording(stripeOf(kit2));
  assert.deepEqual((await runAbandon({ t: b.t, l: b.l }, { config: demo, providerDeps: r2.fn, nowMs: NOW })).body, { ok: true, state: "released" });
  assert.deepEqual(r2.asked, ["stripe"]);
  assert.equal(kit2.fakeStripe.session(b.sessionId)?.status, "expired");
});

test("status and abandon reach the payment only through the gateway handed in: its reads, cancel, keys and words", async (t: TestContext) => {
  await t.test("open, then expired: read through the gateway, released with its wording", async () => {
    const kit = makeKit();
    const a = await opened(kit);
    const calls: string[] = [];
    const pd: ProviderDeps = { deps: kit.deps, gw: acmeGateway(kit, calls) };
    const status = async () => (await runStatus({ t: a.t, p: null, l: a.l, s: a.sessionId }, { config: kit.config, providerDeps: () => pd, nowMs: NOW, log: kit.deps.log })).body as StatusResponse;
    assert.equal((await status()).status, "pending");
    assert.deepEqual(calls, [`get ${a.sessionId}`], "found by the pointer (Acme ids are not read from the request)");
    kit.fakeStripe.expire(a.sessionId);
    const e = await status();
    assert.equal(e.status, "expired");
    assert.deepEqual(e.fulfilment, { state: "released", reservationId: null });
    assert.equal(kit.fakeCb.reservations.get(a.reservationId)?.status, "canceled");
    assert.equal(await kit.deps.kv.get(keys.releaseDone(a.reservationId)), "link expired", "the release reason follows the gateway's wording");
    assert.ok(calls.every((c) => c.startsWith("get ")));
  });

  await t.test("a payment for another amount: refused, logged under the gateway's provider", async () => {
    const kit = makeKit();
    const a = await opened(kit);
    kit.fakeStripe.session(a.sessionId)!.amount_total = 1;
    const pd: ProviderDeps = { deps: kit.deps, gw: acmeGateway(kit, []) };
    const r = (await runStatus({ t: a.t, p: null, l: null }, { config: kit.config, providerDeps: () => pd, nowMs: NOW, log: kit.deps.log })).body as StatusResponse;
    assert.equal(r.status, "failed");
    assert.equal(r.failureCode, "AMOUNT_OR_REFERENCE_MISMATCH");
    assert.deepEqual(kit.logs.filter((l) => l.message.endsWith("_status_mismatch")).map((l) => l.message), ["beam_status_mismatch"]);
  });

  await t.test("paid: fulfilled through the gateway", async () => {
    const kit = makeKit();
    const a = await opened(kit);
    kit.fakeStripe.complete(a.sessionId);
    const calls: string[] = [];
    const pd: ProviderDeps = { deps: kit.deps, gw: acmeGateway(kit, calls) };
    const r = (await runStatus({ t: a.t, p: null, l: null }, { config: kit.config, providerDeps: () => pd, nowMs: NOW })).body as StatusResponse;
    assert.equal(r.status, "paid");
    assert.deepEqual(r.fulfilment, { state: "confirmed", reservationId: a.reservationId });
    assert.ok(calls.length >= 2 && calls.every((c) => c === `get ${a.sessionId}`), calls.join(", "));
    assert.ok(kit.fakeCb.reservations.get(a.reservationId)?.notes.some((n) => n.includes("PAID via Acme")), "the paid note is in the gateway's words");
  });

  await t.test("abandon: cancelled through the gateway, its key marked abandoned, the hold released", async () => {
    const kit = makeKit();
    const a = await opened(kit);
    const calls: string[] = [];
    const pd: ProviderDeps = { deps: kit.deps, gw: acmeGateway(kit, calls) };
    const ab = await runAbandon({ t: a.t, s: a.sessionId, l: a.l }, { config: kit.config, providerDeps: () => pd, nowMs: NOW });
    assert.deepEqual(ab.body, { ok: true, state: "released" });
    assert.deepEqual(calls, [`get ${a.sessionId}`, `cancel ${a.sessionId}`, `get ${a.sessionId}`]);
    assert.equal(await kit.deps.kv.get(keys.abandoned(a.sessionId)), "1");
    const r = (await runStatus({ t: a.t, p: null, l: null }, { config: kit.config, providerDeps: () => pd, nowMs: NOW })).body as StatusResponse;
    assert.equal(r.status, "cancelled");
  });
});

/* ------------------------------ runtime.ts ------------------------------ */

type ResolveHook = (specifier: string, context: unknown, nextResolve: (specifier: string, context?: unknown) => { url: string }) => { url: string };

/** runtime.ts imports next/server, whose package has no exports map for Node's ESM resolver. */
async function loadRuntime() {
  const { registerHooks } = nodeModule as unknown as { registerHooks?: (hooks: { resolve: ResolveHook }) => void };
  if (!registerHooks) throw new Error("module.registerHooks is required (Node 22.15+ / 23.5+)");
  registerHooks({ resolve: (specifier, context, nextResolve) => nextResolve(specifier === "next/server" ? "next/server.js" : specifier, context) });
  return import("./runtime.ts");
}

test("runtime: providerDepsFor builds the active deps at once and another provider's drain only when a booking asks", async (t) => {
  t.mock.method(console, "info", () => undefined);
  t.mock.method(console, "warn", () => undefined);
  const runtime = await loadRuntime();
  const globals = (globalThis as typeof globalThis & { __msvBookingRuntime?: { warnedDrain?: boolean } }).__msvBookingRuntime ?? {};

  const mockEnv: Env = { BOOKING_PAYMENT_PROVIDER: "stripe", BOOKING_STRIPE_MOCK: "true" };
  const mock = getFulfilmentConfig(mockEnv);
  const fn = runtime.providerDepsFor(mock, mockEnv);
  const active = fn("stripe");
  assert.equal(active?.deps.config, mock);
  assert.equal(active?.gw.provider, "stripe");
  assert.equal(fn("stripe"), active, "the same active deps for every ask");
  assert.equal(fn("beam"), null, "no Beam gateway yet");
  assert.equal(runtime.getProviderDeps(mock)?.deps.config.paymentMode, "stripe-mock");

  const demo = getFulfilmentConfig(DEMO_ENV);
  assert.equal(runtime.getProviderDeps(demo), null);
  delete globals.warnedDrain;
  const drained = runtime.providerDepsFor(demo, DEMO_ENV);
  assert.equal(globals.warnedDrain, undefined, "no drain is built before a booking asks");
  const d = drained("stripe");
  assert.equal(d?.deps.config.paymentMode, "stripe-test");
  assert.equal(d?.gw.provider, "stripe");
  assert.equal(globals.warnedDrain, true, "the Stripe drain was built on demand");
  assert.equal(drained("beam"), null);
  assert.equal(runtime.getFulfilmentProviderDeps(DEMO_ENV, "beam"), null);
  assert.equal(runtime.getFulfilmentProviderDeps({ BOOKING_PAYMENT_PROVIDER: "demo" }, "stripe"), null, "no Stripe credentials: nothing to finish");
});

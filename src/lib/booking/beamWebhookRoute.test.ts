// The Beam webhook ROUTE (design S4.7): app/api/beam/webhook/route.ts through the real handler (beamWebhook.ts) and
// the real runtime deps (runtime.ts getBeamFulfilmentDeps: the active Beam config's, else the Beam drain's), as the
// golden snapshot runs Stripe's routes: the MOCK writer on a fake Cloudbeds, the in-memory store (a Beam mode with the
// mock writer always uses it) and Beam's fetch on the in-repo fake Beam through the beamFetch test hook. The global
// fetch is blocked: nothing leaves the process.
//
// Covered: unconfigured -> 503 before the body is read (no Beam config and no drain, a Stripe deployment carrying
// only BEAM_WEBHOOK_HMAC_KEY, Beam deps without the key); an unsigned, wrongly signed or tampered POST -> 401 with the
// active Beam config and with the Beam drain, the 3rd in an hour alerting once; oversized -> 413 (declared, lied
// about or streamed), a body of exactly 64 KB read and judged; a signed paid event on a fake world -> 200 and
// confirmed (one postPayment; a replay and the charge event change nothing), also through the Beam drain after the
// switch back to Stripe; the route's 25-second deadline bounds every Beam call (503, nothing recorded, then confirmed
// on Beam's retry). Every answer is text with Cache-Control no-store.

import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";
import { buildOffers } from "./availability.ts";
import { BEAM_API_KEY, BEAM_HMAC_KEY_B64, BEAM_MERCHANT_ID } from "./beamTestkit.ts";
import { POLICY_VERSION } from "./catalogue.ts";
import { BEAM_PLAYGROUND_BASE } from "./config.ts";
import type { Env } from "./config.ts";
import { addDays } from "./dates.ts";
import { demoInventory } from "./demoProvider.ts";
import { createMemoryKv } from "./kv.ts";
import type { KvStore } from "./kv.ts";
import { beamKeyOf, keyScope, keys } from "./lock.ts";
import { beamSignature, createFakeBeam } from "./mock/fakeBeam.ts";
import type { FakeBeam, FakeBeamSignedEvent } from "./mock/fakeBeam.ts";
import { createFakeCloudbeds } from "./mock/fakeCloudbeds.ts";
import type { FakeCloudbeds } from "./mock/fakeCloudbeds.ts";
import { GUEST, NOW, STRIPE_LIVE_ENV, STRIPE_TEST_ENV, TOKEN_SECRET, WEBHOOK_SECRET, recordingKv } from "./testkit.ts";
import type { KvWrite } from "./testkit.ts";
import type { CartItemInput, CheckoutSuccess, Quote } from "./types.ts";

/** The route's capped read. */
const MAX_BODY_BYTES = 64 * 1024;
const SCOPE = keyScope("beam-playground");
const TEXT = "text/plain;charset=UTF-8";
const OTHER_HMAC_KEY_B64 = Buffer.from("another-environment-hmac-key-012").toString("base64");
const GARDEN: CartItemInput[] = [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];

const BEAM_VARS: Env = { BEAM_API_BASE: BEAM_PLAYGROUND_BASE, BEAM_MERCHANT_ID, BEAM_API_KEY, BEAM_WEBHOOK_HMAC_KEY: BEAM_HMAC_KEY_B64 };
/** beam-playground with the MOCK writer and demo availability (a local run): the in-memory store, nothing leaves. */
const BEAM_ENV: Env = { BOOKING_PAYMENT_PROVIDER: "beam", ...BEAM_VARS, BOOKING_TOKEN_SECRET: TOKEN_SECRET };
/** The same without BEAM_WEBHOOK_HMAC_KEY: Beam deps exist, the key does not. */
const BEAM_NO_KEY_ENV: Env = { BOOKING_PAYMENT_PROVIDER: "beam", BEAM_API_BASE: BEAM_PLAYGROUND_BASE, BEAM_MERCHANT_ID, BEAM_API_KEY, BOOKING_TOKEN_SECRET: TOKEN_SECRET };
/** The instant fallback (owner decision 5): provider stripe (test keys), the Beam variables kept -> the Beam drain. */
const DRAIN_ENV: Env = {
  BOOKING_PAYMENT_PROVIDER: "stripe",
  STRIPE_SECRET_KEY: STRIPE_TEST_ENV.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  BOOKING_TOKEN_SECRET: TOKEN_SECRET,
  ...BEAM_VARS,
};

/* ------------------------------------------------ module hooks ------------------------------------------------ */

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
    webhook: await import("../../app/api/beam/webhook/route.ts"),
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

/* --------------------------------------------------- world --------------------------------------------------- */

/** A route answer as Beam sees it, and whether the route read the request body. */
interface Answer {
  status: number;
  body: string;
  cacheControl: string | null;
  contentType: string | null;
  bodyUsed: boolean;
}

interface World {
  fakeBeam: FakeBeam;
  cloudbeds: FakeCloudbeds;
  kv: KvStore & { writes: KvWrite[] };
  /** Console lines: logEvent's as {message, data} (data: the JSON, or "" without data); others as {message: line}. */
  lines: { message: string; data?: string }[];
  network: string[];
  /** The routes read process.env per request: later requests run under `env`. */
  useEnv(env: Env): void;
  /** Set: every Beam link read is answered only after the route's 25-second budget (the mocked clock moves 26 s). */
  slow: { linkReads: boolean };
  /** One POST to the webhook route. */
  webhook(body: BodyInit, headers?: Record<string, string>): Promise<Answer>;
  /** A signed delivery, as Beam POSTs it. */
  deliver(ev: FakeBeamSignedEvent): Promise<Answer>;
  /** A Beam hold made through the checkout route (card / e-wallet), awaiting payment. */
  book(items: CartItemInput[]): Promise<{ linkId: string; reservationId: string }>;
}

/** The first 3-night window from Jan 2027 where the demo calendar has `slug` free. */
function demoWindow(slug: string): { checkIn: string; checkOut: string } {
  for (let i = 0; i < 300; i++) {
    const checkIn = addDays("2027-01-04", i);
    const checkOut = addDays(checkIn, 3);
    if (buildOffers(demoInventory(checkIn, checkOut), 2).find((o) => o.slug === slug)?.available) return { checkIn, checkOut };
  }
  throw new Error(`no demo window for ${slug}`);
}

/**
 * Runs `fn` with process.env = `env`, Date frozen at NOW, the global fetch blocked and recorded, console lines
 * recorded, and runtime.ts's globals seeded: the in-memory store (recording its writes), the mock writer's fake
 * Cloudbeds and Beam's fetch on a fake Beam that signs with BEAM_HMAC_KEY_B64.
 */
async function withWorld(t: TestContext, env: Env, fn: (w: World) => Promise<void>): Promise<void> {
  const savedEnv = process.env;
  const savedFetch = globalThis.fetch;
  const rt = runtimeGlobals();
  const savedGlobals = { ...rt };
  const network: string[] = [];
  const lines: World["lines"] = [];
  try {
    process.env = { ...env } as NodeJS.ProcessEnv;
    globalThis.fetch = (async (input: string | URL | Request) => {
      network.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      throw new TypeError("network blocked by beamWebhookRoute.test.ts");
    }) as typeof fetch;
    const routes = await loadRoutes();
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    for (const level of ["info", "warn", "error"] as const) {
      t.mock.method(console, level, (...args: unknown[]) => {
        const first = typeof args[0] === "string" ? args[0] : JSON.stringify(args[0]);
        const m = /^\[booking\] (\S+)$/.exec(first);
        lines.push(m ? { message: m[1], data: typeof args[1] === "string" ? args[1] : JSON.stringify(args[1]) } : { message: first });
      });
    }
    for (const key of Object.keys(rt)) delete rt[key];
    const fakeBeam = createFakeBeam({ now: () => Date.now(), merchantId: BEAM_MERCHANT_ID, apiKey: BEAM_API_KEY, hmacKeyB64: BEAM_HMAC_KEY_B64, base: "playground" });
    const cloudbeds = createFakeCloudbeds({ lenient: true, now: () => Date.now() });
    const kv = recordingKv(createMemoryKv(() => Date.now()));
    const slow = { linkReads: false };
    rt.memoryKv = kv;
    rt.mockWriterCloudbeds = cloudbeds;
    rt.beamFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await fakeBeam.fetch(input, init);
      if (slow.linkReads && (init?.method ?? "GET") === "GET" && String(input).includes("/payment-links/")) t.mock.timers.setTime(Date.now() + 26_000);
      return res;
    }) as typeof fetch;

    const webhook = async (body: BodyInit, headers: Record<string, string> = {}): Promise<Answer> => {
      const request = new Request("https://magicsamui.com/api/beam/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", ...headers },
        body,
        ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
      } as RequestInit);
      const res = await routes.webhook.POST(request);
      return { status: res.status, body: await res.text(), cacheControl: res.headers.get("cache-control"), contentType: res.headers.get("content-type"), bodyUsed: request.bodyUsed };
    };
    const post = (path: string, body: unknown) =>
      new Request(`http://localhost:3000${path}`, { method: "POST", headers: { host: "localhost:3000", "x-forwarded-for": "198.51.100.47", "content-type": "application/json" }, body: JSON.stringify(body) });
    const book = async (items: CartItemInput[]) => {
      const req = { ...demoWindow(items[0].slug), items, termsVersion: POLICY_VERSION, guest: GUEST, payMethod: "card_ewallet" };
      const quoted = await routes.checkout.POST(post("/api/booking/checkout", { ...req, expectedTotalSatang: 1, expectedDueNowSatang: 1 }));
      assert.equal(quoted.status, 409);
      const { quote } = (await quoted.json()) as { quote: Quote };
      const res = await routes.checkout.POST(post("/api/booking/checkout", { ...req, expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang }));
      const body = (await res.json()) as CheckoutSuccess;
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.provider, "beam");
      const linkId = new URL(body.redirectUrl).pathname.split("/").pop() ?? "";
      assert.equal(fakeBeam.link(linkId).status, "ACTIVE");
      return { linkId, reservationId: body.holdReservationId ?? "" };
    };

    await fn({
      fakeBeam,
      cloudbeds,
      kv,
      lines,
      network,
      useEnv: (next) => void (process.env = { ...next } as NodeJS.ProcessEnv),
      slow,
      webhook,
      deliver: (ev) => webhook(ev.raw, ev.headers),
      book,
    });
    assert.deepEqual(network, [], "nothing left the process");
  } finally {
    for (const key of Object.keys(rt)) delete rt[key];
    Object.assign(rt, savedGlobals);
    process.env = savedEnv;
    globalThis.fetch = savedFetch;
  }
}

const cbWrites = (w: World) => w.cloudbeds.calls.filter((c) => ["postPayment", "postCustomItem", "putReservation", "postReservationNote"].includes(c.method));
const beamCallsSince = (w: World, at: number) => w.fakeBeam.calls.slice(at).map((c) => `${c.method} ${c.path}`);
const messages = (w: World, from = 0) => w.lines.slice(from).map((l) => l.message);

/* --------------------------------------------------- tests --------------------------------------------------- */

test("route config: Node runtime, maxDuration 30, POST only (Next answers 405 for any other method)", async () => {
  const route = (await loadRoutes()).webhook as Record<string, unknown>;
  assert.equal(route.runtime, "nodejs");
  assert.equal(route.maxDuration, 30);
  assert.deepEqual(Object.keys(route).filter((k) => /^[A-Z]+$/.test(k)), ["POST"]);
});

test("unconfigured -> 503 'webhook not configured' before the body is read: no Beam config and no drain (the demo, stripe-test, stripe-live, a Stripe deployment carrying only BEAM_WEBHOOK_HMAC_KEY), or Beam deps without the key; nothing written, no Beam call", async (t) => {
  const NOT_CONFIGURED: Answer = { status: 503, body: "webhook not configured", cacheControl: "no-store", contentType: TEXT, bodyUsed: false };
  const cases: [string, Env, { message: string; data: string }][] = [
    ["the demo", {}, { message: "beam_webhook_unconfigured", data: "" }],
    ["stripe-test", STRIPE_TEST_ENV, { message: "beam_webhook_unconfigured", data: "" }],
    ["stripe-live", STRIPE_LIVE_ENV, { message: "beam_webhook_unconfigured", data: "" }],
    // The pre-S4.7 route acknowledged every event signed with this key; with no Beam config to finish it, Beam must retry.
    ["stripe-live carrying only BEAM_WEBHOOK_HMAC_KEY", { ...STRIPE_LIVE_ENV, BEAM_WEBHOOK_HMAC_KEY: BEAM_HMAC_KEY_B64 }, { message: "beam_webhook_unconfigured", data: "" }],
    // Beam deps, no key: the handler's own line.
    ["beam-playground without BEAM_WEBHOOK_HMAC_KEY", BEAM_NO_KEY_ENV, { message: "beam_webhook_unconfigured", data: JSON.stringify({ hmacKey: false }) }],
  ];
  await withWorld(t, BEAM_ENV, async (w) => {
    const raw = JSON.stringify({ paymentLinkId: "AbCdEfGh12", order: { netAmount: 100, currency: "THB", referenceId: "MSV-20261005-GQ7K" } });
    const bodies: [string, string, Record<string, string>][] = [
      ["signed", raw, { "x-beam-signature": beamSignature(raw, BEAM_HMAC_KEY_B64), "x-beam-event": "payment_link.paid" }],
      ["unsigned", raw, {}],
      ["oversized", "x".repeat(MAX_BODY_BYTES + 1), { "content-length": String(MAX_BODY_BYTES + 1) }],
    ];
    for (const [name, env, line] of cases) {
      w.useEnv(env);
      const from = w.lines.length;
      for (const [label, body, headers] of bodies) assert.deepEqual(await w.webhook(body, headers), NOT_CONFIGURED, `${name}: ${label}`);
      assert.deepEqual(w.lines.slice(from), [line, line, line], name);
    }
    assert.deepEqual(w.kv.writes, [], "nothing written");
    assert.equal(w.fakeBeam.calls.length, 0, "no Beam call");
    assert.equal(w.cloudbeds.calls.length, 0, "no Cloudbeds call");
  });
});

for (const [where, env] of [
  ["the active Beam config", BEAM_ENV],
  ["the Beam drain (BOOKING_PAYMENT_PROVIDER switched to stripe, the Beam variables kept)", DRAIN_ENV],
] as const) {
  test(`unsigned POST -> 401 'invalid signature' with ${where}; another environment's key or a tampered body too; the 3rd in an hour alerts the owner once`, async (t) => {
    await withWorld(t, env, async (w) => {
      const raw = JSON.stringify({ paymentLinkId: "AbCdEfGh12", order: { netAmount: 100, currency: "THB" } });
      const INVALID: Answer = { status: 401, body: "invalid signature", cacheControl: "no-store", contentType: TEXT, bodyUsed: true };
      assert.deepEqual(await w.webhook(raw, { "x-beam-event": "payment_link.paid" }), INVALID, "unsigned");
      assert.deepEqual(await w.webhook(raw, { "x-beam-signature": beamSignature(raw, OTHER_HMAC_KEY_B64) }), INVALID, "another key");
      assert.deepEqual(await w.webhook(`${raw} `, { "x-beam-signature": beamSignature(raw, BEAM_HMAC_KEY_B64) }), INVALID, "tampered");
      const rejected = w.lines.filter((l) => l.message === "beam_webhook_bad_signature").map((l) => l.data);
      assert.deepEqual(rejected, [false, true, true].map((hasHeader) => JSON.stringify({ mode: "beam-playground", hasHeader })));
      assert.deepEqual(
        w.lines.filter((l) => l.message.startsWith("alert_")),
        [{ message: "alert_warning", data: JSON.stringify({ subject: "Beam webhook: signatures are being rejected" }) }],
      );
      assert.deepEqual(
        w.kv.writes.map((x) => `${x.op} ${x.key}`),
        Array(3).fill(`incr ${keys.beamBadSignatures(SCOPE)}`),
      );
      assert.equal(w.lines.filter((l) => l.message === "beam_drain_mode").length, env === DRAIN_ENV ? 1 : 0, "the drain says so once");
      assert.equal(w.fakeBeam.calls.length, 0, "no Beam call");
      assert.equal(w.cloudbeds.calls.length, 0, "no Cloudbeds call");
    });
  });
}

test("oversized -> 413 'payload too large': a declared Content-Length over 64 KB, one that lies, or a stream past 64 KB without one; a body of exactly 64 KB is read and judged (401)", async (t) => {
  await withWorld(t, BEAM_ENV, async (w) => {
    const TOO_LARGE = { status: 413, body: "payload too large", cacheControl: "no-store", contentType: TEXT };
    const over = "x".repeat(MAX_BODY_BYTES + 1);
    const signedOver = { "x-beam-signature": beamSignature(over, BEAM_HMAC_KEY_B64) };
    const declared = await w.webhook(over, { ...signedOver, "content-length": String(MAX_BODY_BYTES + 1) });
    assert.deepEqual({ ...declared, bodyUsed: undefined }, { ...TOO_LARGE, bodyUsed: undefined }, "declared");
    assert.equal(declared.bodyUsed, false, "refused from the header alone");
    const lying = await w.webhook(over, { ...signedOver, "content-length": "2" });
    assert.deepEqual({ ...lying, bodyUsed: undefined }, { ...TOO_LARGE, bodyUsed: undefined }, "a Content-Length that lies");
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(40_000));
        c.enqueue(new Uint8Array(40_000));
        c.close();
      },
    });
    const streamed = await w.webhook(stream, signedOver);
    assert.deepEqual({ ...streamed, bodyUsed: undefined }, { ...TOO_LARGE, bodyUsed: undefined }, "streamed past the cap");
    assert.equal(w.lines.filter((l) => l.message.startsWith("beam_webhook")).length, 0, "a refused body is not judged");

    const exact = "x".repeat(MAX_BODY_BYTES);
    assert.deepEqual(await w.webhook(exact), { status: 401, body: "invalid signature", cacheControl: "no-store", contentType: TEXT, bodyUsed: true }, "64 KB exactly");
    assert.equal(w.fakeBeam.calls.length, 0, "no Beam call");
  });
});

test("a signed paid event on a fake world -> 200 'confirmed': the hold the checkout route made is confirmed in Cloudbeds with one postPayment; a replay and the payment's charge.succeeded change nothing", async (t) => {
  await withWorld(t, BEAM_ENV, async (w) => {
    const b = await w.book(GARDEN);
    assert.equal(w.cloudbeds.reservations.get(b.reservationId)?.status, "not_confirmed");
    const charge = w.fakeBeam.pay(b.linkId, "CARD");
    const from = w.lines.length;
    const CONFIRMED: Answer = { status: 200, body: "confirmed", cacheControl: "no-store", contentType: TEXT, bodyUsed: true };
    assert.deepEqual(await w.deliver(w.fakeBeam.signedEvent("payment_link.paid", b.linkId)), CONFIRMED);
    assert.equal(w.cloudbeds.reservations.get(b.reservationId)?.status, "confirmed");
    assert.equal(w.cloudbeds.calls.filter((c) => c.method === "postPayment").length, 1, "one payment posted");
    assert.ok(await w.kv.get(keys.fulfilDone(beamKeyOf(b.linkId))), "the done marker");
    assert.equal(await w.kv.get(keys.reservationPaid(b.reservationId)), beamKeyOf(b.linkId), "the paid marker came first");
    assert.ok(messages(w, from).includes("beam_webhook"), messages(w, from).join(" | "));
    assert.ok(
      w.lines.slice(from).some((l) => l.message === "beam_webhook_payment" && l.data !== undefined && JSON.parse(l.data).outcome === "confirmed"),
      "the outcome is logged",
    );

    const writes = cbWrites(w).length;
    const kvWrites = w.kv.writes.length;
    assert.deepEqual(await w.deliver(w.fakeBeam.signedEvent("payment_link.paid", b.linkId)), CONFIRMED, "a replay");
    assert.deepEqual(await w.deliver(w.fakeBeam.signedEvent("charge.succeeded", charge.chargeId)), CONFIRMED, "the charge event");
    assert.equal(cbWrites(w).length, writes, "no new Cloudbeds write");
    assert.equal(w.cloudbeds.calls.filter((c) => c.method === "postPayment").length, 1, "still one payment");
    assert.deepEqual(w.kv.writes.slice(kvWrites).filter((x) => x.key === keys.reservationPaid(b.reservationId) || x.key === keys.fulfilDone(beamKeyOf(b.linkId))), [], "no paid or done marker rewritten");
  });
});

test("through the Beam drain: a link handed out before BOOKING_PAYMENT_PROVIDER went back to stripe (owner decision 5) is still confirmed by its paid event", async (t) => {
  await withWorld(t, BEAM_ENV, async (w) => {
    const b = await w.book(GARDEN);
    w.fakeBeam.pay(b.linkId, "CARD");
    w.useEnv(DRAIN_ENV);
    const from = w.lines.length;
    assert.deepEqual(await w.deliver(w.fakeBeam.signedEvent("payment_link.paid", b.linkId)), { status: 200, body: "confirmed", cacheControl: "no-store", contentType: TEXT, bodyUsed: true });
    assert.equal(w.cloudbeds.reservations.get(b.reservationId)?.status, "confirmed");
    assert.equal(w.cloudbeds.calls.filter((c) => c.method === "postPayment").length, 1);
    assert.deepEqual(
      w.lines.slice(from).filter((l) => l.message === "beam_drain_mode"),
      [{ message: "beam_drain_mode", data: JSON.stringify({ mode: "beam-playground" }) }],
    );
  });
});

test("the route's 25-second deadline bounds every Beam call: a link read answered after it leaves no time for the charges -> 503 'payment could not be read - retry', nothing recorded; Beam's retry confirms it", async (t) => {
  await withWorld(t, BEAM_ENV, async (w) => {
    const b = await w.book(GARDEN);
    w.fakeBeam.pay(b.linkId, "CARD");
    const ev = w.fakeBeam.signedEvent("payment_link.paid", b.linkId);
    w.slow.linkReads = true;
    const at = w.fakeBeam.calls.length;
    const kvWrites = w.kv.writes.length;
    assert.deepEqual(await w.deliver(ev), { status: 503, body: "payment could not be read - retry", cacheControl: "no-store", contentType: TEXT, bodyUsed: true });
    assert.deepEqual(beamCallsSince(w, at), [`GET /api/v1/payment-links/${b.linkId}`], "the charges are never asked");
    assert.deepEqual(w.kv.writes.slice(kvWrites), [], "nothing recorded");
    assert.equal(w.cloudbeds.reservations.get(b.reservationId)?.status, "not_confirmed");
    assert.ok(messages(w).includes("beam_webhook_read_failed"));

    w.slow.linkReads = false;
    assert.deepEqual(await w.deliver(ev), { status: 200, body: "confirmed", cacheControl: "no-store", contentType: TEXT, bodyUsed: true }, "Beam's retry");
    assert.equal(w.cloudbeds.reservations.get(b.reservationId)?.status, "confirmed");
  });
});

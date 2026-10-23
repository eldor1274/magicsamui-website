// The payment lookup ROUTE (app/api/support/payment-lookup/route.ts): its config, process.env and the real runtime
// deps (runtime.ts getBeamFulfilmentDeps), end to end with the checkout route on one local world - beam-playground
// with the MOCK writer on a fake Cloudbeds, the in-memory store and Beam's fetch on the in-repo fake Beam (the
// beamFetch test hook). The global fetch is blocked: nothing leaves the process. The lookup itself is covered by
// supportLookup.test.ts.

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
import { createFakeBeam } from "./mock/fakeBeam.ts";
import type { FakeBeam } from "./mock/fakeBeam.ts";
import { createFakeCloudbeds } from "./mock/fakeCloudbeds.ts";
import type { FakeCloudbeds } from "./mock/fakeCloudbeds.ts";
import { GUEST, NOW, STRIPE_TEST_ENV, TEST_EMAIL, TOKEN_SECRET } from "./testkit.ts";
import type { CartItemInput, CheckoutSuccess, Quote } from "./types.ts";

const SECRET = "route-test-bot-lookup-secret-0123456789abc";
const GARDEN: CartItemInput[] = [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
/** beam-playground with the MOCK writer and demo availability (a local run): the in-memory store, nothing leaves. */
const BEAM_ENV: Env = {
  BOOKING_PAYMENT_PROVIDER: "beam",
  BEAM_API_BASE: BEAM_PLAYGROUND_BASE,
  BEAM_MERCHANT_ID,
  BEAM_API_KEY,
  BEAM_WEBHOOK_HMAC_KEY: BEAM_HMAC_KEY_B64,
  BOOKING_TOKEN_SECRET: TOKEN_SECRET,
  BOT_LOOKUP_SECRET: SECRET,
};

type ResolveHook = (specifier: string, context: unknown, nextResolve: (specifier: string, context?: unknown) => { url: string }) => { url: string; shortCircuit?: boolean };
let hooked = false;

/** The routes, with "@/..." and "next/server" resolved for plain Node (as the other route tests do). */
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
    lookup: await import("../../app/api/support/payment-lookup/route.ts"),
  };
}

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

/** The first 3-night window from Jan 2027 where the demo calendar has `slug` free. */
function demoWindow(slug: string): { checkIn: string; checkOut: string } {
  for (let i = 0; i < 300; i++) {
    const checkIn = addDays("2027-01-04", i);
    const checkOut = addDays(checkIn, 3);
    if (buildOffers(demoInventory(checkIn, checkOut), 2).find((o) => o.slug === slug)?.available) return { checkIn, checkOut };
  }
  throw new Error(`no demo window for ${slug}`);
}

interface World {
  fakeBeam: FakeBeam;
  lines: { message: string; data?: string }[];
  useEnv(env: Env): void;
  lookup(body: unknown, auth?: string | null): Promise<{ status: number; body: Record<string, unknown>; cacheControl: string | null; text: string }>;
  book(items: CartItemInput[]): Promise<{ ref: string; linkId: string }>;
}

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
      throw new TypeError("network blocked by supportLookupRoute.test.ts");
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
    rt.memoryKv = createMemoryKv(() => Date.now());
    rt.mockWriterCloudbeds = createFakeCloudbeds({ lenient: true, now: () => Date.now() });
    rt.beamFetch = fakeBeam.fetch;

    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      new Request(`http://localhost:3000${path}`, {
        method: "POST",
        headers: { host: "localhost:3000", "x-forwarded-for": "198.51.100.47", "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const lookup: World["lookup"] = async (body, auth = `Bearer ${SECRET}`) => {
      const res = await routes.lookup.POST(post("/api/support/payment-lookup", body, auth === null ? {} : { authorization: auth }));
      const text = await res.text();
      return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, cacheControl: res.headers.get("cache-control"), text };
    };
    const book: World["book"] = async (items) => {
      const req = { ...demoWindow(items[0].slug), items, termsVersion: POLICY_VERSION, guest: GUEST, payMethod: "card_ewallet" };
      const quoted = await routes.checkout.POST(post("/api/booking/checkout", { ...req, expectedTotalSatang: 1, expectedDueNowSatang: 1 }));
      assert.equal(quoted.status, 409);
      const { quote } = (await quoted.json()) as { quote: Quote };
      const res = await routes.checkout.POST(post("/api/booking/checkout", { ...req, expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang }));
      const body = (await res.json()) as CheckoutSuccess;
      assert.equal(res.status, 200, JSON.stringify(body));
      return { ref: body.ref, linkId: new URL(body.redirectUrl).pathname.split("/").pop() ?? "" };
    };
    await fn({ fakeBeam, lines, useEnv: (next) => void (process.env = { ...next } as NodeJS.ProcessEnv), lookup, book });
    assert.deepEqual(network, [], "nothing left the process");
  } finally {
    for (const key of Object.keys(rt)) delete rt[key];
    Object.assign(rt, savedGlobals);
    process.env = savedEnv;
    globalThis.fetch = savedFetch;
  }
}

test("route config: Node runtime, maxDuration 15, POST only (Next answers 405 for any other method)", async () => {
  const route = (await loadRoutes()).lookup as Record<string, unknown>;
  assert.equal(route.runtime, "nodejs");
  assert.equal(route.maxDuration, 15);
  assert.equal(typeof route.POST, "function");
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) assert.equal(route[method], undefined, method);
  // No caching options: a POST route handler is never cached.
  for (const option of ["dynamic", "revalidate", "fetchCache"]) assert.equal(route[option], undefined, option);
});

test("the route reads BOT_LOOKUP_SECRET from process.env: unset 503, wrong 401, no Beam config 503 - all no-store", async (t) => {
  const { BOT_LOOKUP_SECRET: _unset, ...withoutSecret } = BEAM_ENV;
  void _unset;
  await withWorld(t, withoutSecret, async (w) => {
    const res = await w.lookup({ email: TEST_EMAIL });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, "not_configured");
    assert.equal(res.cacheControl, "no-store");
    assert.ok(w.lines.some((l) => l.message === "support_lookup_unconfigured"));
    w.useEnv({ ...BEAM_ENV, BOT_LOOKUP_SECRET: "too-short-secret" });
    assert.equal((await w.lookup({ email: TEST_EMAIL }, "Bearer too-short-secret")).status, 503);
    w.useEnv(BEAM_ENV);
    const wrong = await w.lookup({ email: TEST_EMAIL }, `Bearer ${SECRET.slice(1)}`);
    assert.equal(wrong.status, 401);
    assert.equal(wrong.cacheControl, "no-store");
    // A Stripe deployment without any Beam variable: the lookup has nothing to read.
    w.useEnv({ ...STRIPE_TEST_ENV, BOT_LOOKUP_SECRET: SECRET });
    const stripeOnly = await w.lookup({ email: TEST_EMAIL });
    assert.equal(stripeOnly.status, 503);
    assert.equal(stripeOnly.body.error, "beam_unavailable");
    assert.equal(w.fakeBeam.calls.length, 0);
  });
});

test("a Beam booking made through the checkout route is found through the lookup route by email and phone, nothing personal in it", async (t) => {
  await withWorld(t, BEAM_ENV, async (w) => {
    assert.deepEqual((await w.lookup({ email: TEST_EMAIL })).body.found, 0);
    const b = await w.book(GARDEN);
    for (const q of [{ email: TEST_EMAIL }, { phone: "+66 95 246 6011" }, { ref: b.ref }]) {
      const res = await w.lookup(q);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.cacheControl, "no-store");
      const matches = res.body.matches as Array<Record<string, unknown>>;
      assert.equal(matches.length, 1);
      assert.equal(matches[0].ref, b.ref);
      assert.equal(matches[0].state, "open");
      assert.equal(matches[0].retrySafe, true);
      for (const pii of [TEST_EMAIL, "952466011", GUEST.lastName, GUEST.specialRequests]) assert.ok(!res.text.includes(pii), pii);
    }
    w.fakeBeam.decline(b.linkId, "CARD", "CH_CARD_DECLINED");
    const failed = await w.lookup({ phone: "0952466011" });
    const m = (failed.body.matches as Array<Record<string, unknown>>)[0];
    assert.deepEqual([m.state, m.failureCode, m.reason], ["failed", "CH_CARD_DECLINED", "Your bank declined the card."]);
    const logs = JSON.stringify(w.lines);
    for (const pii of [TEST_EMAIL, "952466011", GUEST.lastName, SECRET]) assert.ok(!logs.includes(pii), pii);
    assert.ok(w.lines.some((l) => l.message === "support_lookup" && (l.data ?? "").includes('"states":["failed"]')));
  });
});

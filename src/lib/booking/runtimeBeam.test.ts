// runtime.ts's Beam deps (design S4.5): getBeamDeps, the Beam drain (getBeamFulfilmentDeps), the provider deps
// (getProviderDeps, getFulfilmentProviderDeps, providerDepsFor) with the Beam gateway, the mock writer's
// in-memory store and the 429 counter. runtime.ts is loaded with the next/server resolve hook (as
// providerDispatch.test.ts does); every test runs with process.env set to its environment, Date frozen at NOW,
// the global fetch blocked and recorded, console lines recorded and runtime.ts's globals seeded and restored.
// Beam calls go to the in-repo fake Beam through the beamFetch test hook. Nothing leaves the process.

import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { beamHeld, BEAM_API_KEY, BEAM_HMAC_KEY_B64, BEAM_LIVE_ENV, BEAM_MERCHANT_ID, BEAM_TEST_ENV, makeBeamKit } from "./beamTestkit.ts";
import { BEAM_LIVE_BASE, BEAM_PLAYGROUND_BASE, getBookingConfig, getFulfilmentConfig } from "./config.ts";
import type { Env } from "./config.ts";
import { createMemoryKv } from "./kv.ts";
import type { KvStore } from "./kv.ts";
import { beamKeyOf, keyScope, keys } from "./lock.ts";
import { beamGateway } from "./payments/beamGateway.ts";
import type { BeamGateway, BeamGatewayDeps } from "./payments/beamGateway.ts";
import type { GatewayPayment, GatewayReceipt } from "./payments/gateway.ts";
import { NOW, STRIPE_LIVE_ENV, STRIPE_TEST_ENV } from "./testkit.ts";

type ResolveHook = (specifier: string, context: unknown, nextResolve: (specifier: string, context?: unknown) => { url: string }) => { url: string };

/** runtime.ts imports next/server, whose package has no exports map for Node's ESM resolver. */
async function loadRuntime() {
  const { registerHooks } = nodeModule as unknown as { registerHooks?: (hooks: { resolve: ResolveHook }) => void };
  if (!registerHooks) throw new Error("module.registerHooks is required (Node 22.15+ / 23.5+)");
  registerHooks({ resolve: (specifier, context, nextResolve) => nextResolve(specifier === "next/server" ? "next/server.js" : specifier, context) });
  return import("./runtime.ts");
}

/** runtime.ts's process-wide state (globalThis.__msvBookingRuntime). */
interface RuntimeGlobals {
  memoryKv?: KvStore;
  redisKv?: { url: string; kv: KvStore };
  warnedMemory?: boolean;
  warnedDrain?: boolean;
  warnedBeamDrain?: boolean;
  beamFetch?: typeof fetch;
  [other: string]: unknown;
}

function runtimeGlobals(): RuntimeGlobals {
  const g = globalThis as typeof globalThis & { __msvBookingRuntime?: RuntimeGlobals };
  return (g.__msvBookingRuntime ??= {});
}

type KvWrite = [string, ...unknown[]];

/** A memory store (on the frozen clock) that records every write. */
function recordingKv(): KvStore & { writes: KvWrite[] } {
  const kv = createMemoryKv(() => Date.now());
  const writes: KvWrite[] = [];
  return {
    kind: "redis",
    writes,
    setNx: (key, value, ttl) => (writes.push(["setNx", key, value, ttl]), kv.setNx(key, value, ttl)),
    set: (key, value, ttl) => (writes.push(["set", key, value, ttl]), kv.set(key, value, ttl)),
    get: (key) => kv.get(key),
    del: (key) => (writes.push(["del", key]), kv.del(key)),
    delIfEquals: (key, value) => (writes.push(["delIfEquals", key, value]), kv.delIfEquals(key, value)),
    zadd: (key, score, member) => (writes.push(["zadd", key, score, member]), kv.zadd(key, score, member)),
    zrangeByScore: (key, min, max, limit) => kv.zrangeByScore(key, min, max, limit),
    zrem: (key, member) => (writes.push(["zrem", key, member]), kv.zrem(key, member)),
    incr: (key, ttl) => (writes.push(["incr", key, ttl]), kv.incr(key, ttl)),
  };
}

interface World {
  runtime: Awaited<ReturnType<typeof loadRuntime>>;
  rt: RuntimeGlobals;
  /** "info [booking] beam_drain_mode {...}", one per console line. */
  lines: string[];
  network: string[];
  /** The store runtime.ts uses for the env's Redis URL (seeded), when the env has one. */
  redis: (KvStore & { writes: KvWrite[] }) | null;
}

/**
 * Runs `fn` with process.env = `env`, Date frozen at NOW, the global fetch blocked and recorded, console lines
 * recorded, and runtime.ts's globals emptied, with a recording store for the env's Redis URL; restores it all.
 */
async function withRuntime(t: TestContext, env: Env, fn: (w: World) => Promise<void>): Promise<void> {
  const savedEnv = process.env;
  const savedFetch = globalThis.fetch;
  const rt = runtimeGlobals();
  const savedGlobals = { ...rt };
  const lines: string[] = [];
  const network: string[] = [];
  const restore: (() => void)[] = [];
  try {
    process.env = { ...env } as NodeJS.ProcessEnv;
    globalThis.fetch = (async (input: string | URL | Request) => {
      network.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      throw new TypeError("network blocked by runtimeBeam.test.ts");
    }) as typeof fetch;
    const runtime = await loadRuntime();
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    restore.push(() => t.mock.timers.reset());
    for (const level of ["info", "warn", "error"] as const) {
      const m = t.mock.method(console, level, (...args: unknown[]) => void lines.push([level, ...args.map((a) => (typeof a === "string" ? a : JSON.stringify(a)))].join(" ").trim()));
      restore.push(() => m.mock.restore());
    }
    for (const key of Object.keys(rt)) delete rt[key];
    const url = env.UPSTASH_REDIS_REST_URL;
    const redis = url ? recordingKv() : null;
    if (url && redis) rt.redisKv = { url, kv: redis };
    await fn({ runtime, rt, lines, network, redis });
  } finally {
    for (const undo of restore.reverse()) undo();
    for (const key of Object.keys(rt)) delete rt[key];
    Object.assign(rt, savedGlobals);
    process.env = savedEnv;
    globalThis.fetch = savedFetch;
  }
}

/** Lets every pending count (memory store, no timers) finish. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const BEAM_VARS: Env = { BEAM_MERCHANT_ID, BEAM_API_KEY, BEAM_WEBHOOK_HMAC_KEY: BEAM_HMAC_KEY_B64 };
/** A Stripe deployment that kept the Beam playground variables: the Beam drain. */
const STRIPE_WITH_BEAM_DRAIN: Env = { ...STRIPE_TEST_ENV, ...BEAM_VARS, BEAM_API_BASE: BEAM_PLAYGROUND_BASE, CLOUDBEDS_BEAM_PAYMENT_METHOD: "Beam(website)" };
/** The golden route env 'drain: provider beam (playground), Stripe live credentials kept' (the active config is Beam's). */
const GOLDEN_BEAM_ENV: Env = {
  ...STRIPE_LIVE_ENV,
  BEAM_API_BASE: BEAM_PLAYGROUND_BASE,
  BEAM_MERCHANT_ID: "golden-merchant",
  BEAM_API_KEY: "golden-beam-key-0123456789",
  BEAM_WEBHOOK_HMAC_KEY: Buffer.from("golden-beam-hmac-key-0123456789!").toString("base64"),
  BOOKING_PAYMENT_PROVIDER: "beam",
};
/** beam-playground with the MOCK Cloudbeds writer (no booking key; local only) and Redis set. */
const BEAM_MOCK_WRITER_ENV: Env = { ...BEAM_TEST_ENV, CLOUDBEDS_API_KEY_BOOKING: undefined };

test("getBeamDeps: the Beam modes only; the store, writer, alerter and restrictions as for Stripe, plus config.beam, the fetch hook, the 429 counter and the caller's deadline", async (t) => {
  await withRuntime(t, BEAM_TEST_ENV, async ({ runtime, rt, redis }) => {
    const config = getBookingConfig(BEAM_TEST_ENV);
    assert.equal(config.paymentMode, "beam-playground");
    const deps = runtime.getBeamDeps(config);
    assert.ok(deps);
    assert.deepEqual(Object.keys(deps), ["config", "beam", "writer", "kv", "alert", "log", "restrictions", "onRateLimited"]);
    assert.equal(deps.config, config);
    assert.equal(deps.beam, config.beam);
    assert.equal(deps.kv, redis, "the live writer's store is the shared Redis, as Stripe's");
    assert.equal(deps.writer.mode, "live");
    assert.equal(typeof deps.alert, "function");
    assert.equal(typeof deps.restrictions, "function", "availability is Cloudbeds': the live restriction check");
    assert.equal(typeof deps.onRateLimited, "function");
    assert.equal(runtime.getStripeDeps(config), null);

    const fake = makeBeamKit().fakeBeam;
    rt.beamFetch = fake.fetch;
    assert.equal(runtime.getBeamDeps(config)?.fetchImpl, fake.fetch, "Beam's fetch comes from the test hook");
    const clock = () => 1_000;
    const timed = runtime.getBeamDeps(config, { deadlineMs: 26_000, clock });
    assert.equal(timed?.deadlineMs, 26_000);
    assert.equal(timed?.clock, clock);
    assert.equal(runtime.getBeamDeps(config, {})?.deadlineMs, undefined);
    for (const name of ["nonce", "sleep", "now"]) assert.ok(!(name in (timed ?? {})), `${name} stays at its default`);
  });

  for (const env of [STRIPE_TEST_ENV, STRIPE_LIVE_ENV, { BOOKING_PAYMENT_PROVIDER: "stripe", BOOKING_STRIPE_MOCK: "true" }, { ...STRIPE_TEST_ENV, BOOKING_PAYMENT_PROVIDER: "demo" }, STRIPE_WITH_BEAM_DRAIN] as Env[]) {
    await withRuntime(t, env, async ({ runtime, rt, redis }) => {
      const config = getBookingConfig(env);
      assert.equal(runtime.getBeamDeps(config), null, config.paymentMode);
      assert.deepEqual(Object.keys(rt).filter((k) => k !== "redisKv"), [], `${config.paymentMode}: nothing was built`);
      assert.deepEqual(redis?.writes ?? [], []);
    });
  }
});

test("getProviderDeps and providerDepsFor: an active Beam config gets its deps with the Beam gateway, the same as payments/beamGateway.ts", async (t) => {
  await withRuntime(t, BEAM_TEST_ENV, async ({ runtime, rt, redis }) => {
    const config = getBookingConfig(BEAM_TEST_ENV);
    const pd = runtime.getProviderDeps(config);
    assert.ok(pd && redis);
    assert.equal(pd.gw.provider, "beam");
    assert.equal(pd.gw.brand, "Beam");
    assert.equal(pd.deps.config, config);
    const deps = pd.deps as BeamGatewayDeps;
    assert.equal(deps.beam, config.beam);

    const fn = runtime.providerDepsFor(config, BEAM_TEST_ENV);
    const active = fn("beam");
    assert.equal(active?.gw.provider, "beam");
    assert.equal(fn("beam"), active, "the same active deps for every ask");
    assert.equal(fn("stripe"), null, "no Stripe credentials: nothing to finish");
    const clock = () => 7;
    const timed = runtime.providerDepsFor(config, BEAM_TEST_ENV, { deadlineMs: 30_000, clock })("beam")?.deps as BeamGatewayDeps;
    assert.deepEqual([timed.deadlineMs, timed.clock], [30_000, clock], "the route's deadline reaches the Beam deps");
    const timedActive = runtime.getProviderDeps(config, { deadlineMs: 31_000, clock })?.deps as BeamGatewayDeps;
    assert.deepEqual([timedActive.deadlineMs, timedActive.clock], [31_000, clock]);

    // The members read without a Beam call are the real gateway's.
    const lazy = pd.gw as BeamGateway;
    const real = beamGateway(deps);
    assert.deepEqual(Object.keys(lazy).sort(), Object.keys(real).sort());
    assert.deepEqual(Object.keys(lazy.text).sort(), Object.keys(real.text).sort());
    assert.equal(lazy.doneTtlSeconds, real.doneTtlSeconds);
    for (const id of ["Lnk_0123", "a-b_c", "", "x/y", "cs_test_abc", "A".repeat(65)]) {
      assert.equal(lazy.keyOf(id), real.keyOf(id), id);
      assert.equal(lazy.isPaymentId?.(id), real.isPaymentId?.(id), id);
    }
    for (const id of ["MSV-20261005-GQ7K-B", "MSV-20261005-GQ7K-B-TEST", "MSV-20261005-GQ7K", "MSV-20261005-GQ7K-TEST", " MSV-20261005-GQ7K-B ", null, undefined, "nope"]) {
      assert.deepEqual(lazy.parseHoldId?.(id), real.parseHoldId?.(id), String(id));
    }
    assert.equal(lazy.idOf("beam:Lnk_0123"), real.idOf("beam:Lnk_0123"));
    for (const key of ["cs_test_abc", "Lnk_0123", "beam:", "beam:x/y"]) {
      const err = (g: BeamGateway) => {
        try {
          g.idOf(key);
        } catch (e) {
          return e;
        }
        return null;
      };
      const [a, b] = [err(lazy), err(real)];
      assert.ok(a !== null && b !== null, key);
      assert.ok(lazy.isMissing(a) && real.isMissing(b), `${key}: not a Beam key reads as missing`);
    }
    assert.equal(lazy.isMissing(new Error("x")), false);
    const receipt: GatewayReceipt = { primaryId: "chrg_1", description: "Beam link Lnk_1 charge chrg_1 (card)", methodType: "CARD", refundable: true, partialRefundable: true };
    const wallet: GatewayReceipt = { primaryId: "chrg_2", description: "Beam link Lnk_2 charge chrg_2 (PromptPay)", methodType: "QR_PROMPT_PAY", refundable: false, partialRefundable: false };
    const payment: GatewayPayment = { key: "beam:Lnk_1", paymentId: "Lnk_1", state: "expired", meta: null, amountSatang: 100, currency: "THB", attempted: true, receipt, pendingReason: "unconfirmed" };
    for (const r of [receipt, wallet, { primaryId: null, description: "Beam link Lnk_3 charge pending (unknown)" }]) {
      assert.equal(lazy.text.paidVia(r, "THB 1.00"), real.text.paidVia(r, "THB 1.00"));
      assert.equal(lazy.text.paymentDescription(r, "MSV-20261005-GQ7K"), real.text.paymentDescription(r, "MSV-20261005-GQ7K"));
      assert.equal(lazy.text.refundHow?.(r), real.text.refundHow?.(r));
      assert.equal(lazy.text.bookedExtra?.(r), real.text.bookedExtra?.(r));
    }
    for (const name of ["sessionLabel", "refundWhere", "methodEnvVar", "testMethodEnvVar", "feeItemName", "webhookRetryHint", "mockMethod"] as const) {
      assert.deepEqual(lazy.text[name], real.text[name], name);
    }
    for (const mode of ["beam-playground", "beam-live"]) assert.deepEqual(lazy.text.feeItem(mode), real.text.feeItem(mode), mode);
    const pages = [[{ state: "expired", attempted: false }], [{ state: "expired", attempted: true, pendingReason: "unconfirmed" }], [{ state: "failed", attempted: true }]] as const;
    for (const p of pages) assert.equal(lazy.text.releaseNoteText([...p]), real.text.releaseNoteText([...p]));
    assert.deepEqual(lazy.text.pendingReleasedAlert?.(payment, "7000000001"), real.text.pendingReleasedAlert?.(payment, "7000000001"));

    // Every member that calls Beam runs the real gateway's: one hold on the fake Beam, read both ways.
    const kit = makeBeamKit({ kv: redis });
    rt.beamFetch = kit.fakeBeam.fetch;
    const h = await beamHeld(kit);
    const gw = runtime.getProviderDeps(config)?.gw as BeamGateway;
    assert.deepEqual(await gw.get(h.key), await kit.gw.get(h.key));
    assert.deepEqual((await gw.readLink(h.key)).state, (await kit.gw.readLink(h.key)).state);
    assert.equal(await gw.releaseGuard?.(h.key), false, "an open link is never released");
    // Round 6: abandon's 404 judgement, the real gateway's too.
    assert.deepEqual([await gw.isGone?.(h.key), await gw.isGone?.("cs_test_notbeam")], [await kit.gw.isGone?.(h.key), await kit.gw.isGone?.("cs_test_notbeam")]);
    assert.deepEqual([await gw.isGone?.(h.key), await gw.isGone?.("cs_test_notbeam")], [false, true]);
    const listed = await gw.sweepRecent(NOW - 3_600_000);
    assert.deepEqual(listed.map((p) => [p.key, p.reservationId, p.listedPaid]), [[h.key, h.reservationId, false]]);
    await assert.rejects(gw.get(beamKeyOf("NoSuchLnk1")), (e: unknown) => gw.isMissing(e), "a link Beam does not know reads as missing");
    await assert.rejects(gw.get("cs_test_notbeam"), (e: unknown) => gw.isMissing(e), "a key that is not a Beam key reads as missing");
    assert.equal(await gw.cancel(h.key), "cancelled");
    assert.equal(kit.fakeBeam.links.get(h.linkId)?.status, "DISABLED");
    assert.equal(await gw.cancel(h.key), "not_open");
  });
});

test("getBeamFulfilmentDeps and getFulfilmentProviderDeps(env, 'beam'): the active Beam config's deps, else a Beam drain only when one is configured", async (t) => {
  // Active Beam config: its own deps, no drain line.
  await withRuntime(t, BEAM_TEST_ENV, async ({ runtime, rt, lines }) => {
    const deps = runtime.getBeamFulfilmentDeps(BEAM_TEST_ENV);
    assert.equal(deps?.config.paymentMode, "beam-playground");
    assert.equal(runtime.getFulfilmentProviderDeps(BEAM_TEST_ENV, "beam")?.gw.provider, "beam");
    assert.deepEqual(lines.filter((l) => l.includes("beam_drain_mode")), []);
    assert.equal(rt.warnedBeamDrain, undefined);
    const clock = () => 5;
    const timed = runtime.getFulfilmentProviderDeps(BEAM_TEST_ENV, "beam", { deadlineMs: 50, clock })?.deps as BeamGatewayDeps;
    assert.deepEqual([timed.deadlineMs, timed.clock], [50, clock]);
  });

  // beam-live stays locked in code (LIVE_FULFILMENT_READY.beam is false): no active Beam deps, and the provider is beam, so no drain.
  await withRuntime(t, BEAM_LIVE_ENV, async ({ runtime }) => {
    assert.equal(runtime.getBeamFulfilmentDeps(BEAM_LIVE_ENV), null);
    assert.equal(runtime.getFulfilmentProviderDeps(BEAM_LIVE_ENV, "beam"), null);
  });

  // A Stripe deployment that kept the Beam playground variables: the drain, built when a Beam booking asks, logged once.
  await withRuntime(t, STRIPE_WITH_BEAM_DRAIN, async ({ runtime, rt, lines }) => {
    const stripeConfig = getFulfilmentConfig(STRIPE_WITH_BEAM_DRAIN);
    assert.equal(stripeConfig.paymentMode, "stripe-test");
    const fn = runtime.providerDepsFor(stripeConfig, STRIPE_WITH_BEAM_DRAIN);
    assert.equal(fn("stripe")?.gw.provider, "stripe");
    assert.equal(rt.warnedBeamDrain, undefined, "no Beam drain is built before a Beam booking asks");
    const clock = () => 9;
    const timedDrain = runtime.providerDepsFor(stripeConfig, STRIPE_WITH_BEAM_DRAIN, { deadlineMs: 40_000, clock })("beam")?.deps as BeamGatewayDeps;
    assert.deepEqual([timedDrain.deadlineMs, timedDrain.clock], [40_000, clock], "the route's deadline reaches the drain's deps");
    const drained = fn("beam");
    assert.equal(drained?.gw.provider, "beam");
    assert.equal(drained?.deps.config.paymentMode, "beam-playground");
    assert.equal(drained?.deps.config.provider, "beam");
    assert.equal((drained?.deps as BeamGatewayDeps).beam.merchantId, BEAM_MERCHANT_ID);
    assert.equal(runtime.getBeamFulfilmentDeps(STRIPE_WITH_BEAM_DRAIN)?.config.paymentMode, "beam-playground");
    assert.equal(runtime.getFulfilmentProviderDeps(STRIPE_WITH_BEAM_DRAIN, "beam")?.gw.provider, "beam");
    assert.deepEqual(lines.filter((l) => l.includes("beam_drain_mode")), ['info [booking] beam_drain_mode {"mode":"beam-playground"}'], "logged once");
  });

  // Switched to the demo with the Beam playground variables kept: still drained.
  const demoDrain: Env = { ...STRIPE_WITH_BEAM_DRAIN, BOOKING_PAYMENT_PROVIDER: "demo" };
  await withRuntime(t, demoDrain, async ({ runtime }) => {
    assert.equal(runtime.getBeamFulfilmentDeps(demoDrain)?.config.paymentMode, "beam-playground");
  });

  // Not configured: no Beam variables, no HMAC key, the live Beam variables on a Stripe deployment (code switch off), the demo.
  for (const env of [
    STRIPE_TEST_ENV,
    { ...STRIPE_WITH_BEAM_DRAIN, BEAM_WEBHOOK_HMAC_KEY: undefined },
    { ...STRIPE_WITH_BEAM_DRAIN, BEAM_API_KEY: " " },
    { ...STRIPE_LIVE_ENV, ...BEAM_VARS, BEAM_API_BASE: BEAM_LIVE_BASE },
    { ...STRIPE_TEST_ENV, BOOKING_PAYMENT_PROVIDER: "demo" },
    { BOOKING_PAYMENT_PROVIDER: "demo" },
  ] as Env[]) {
    await withRuntime(t, env, async ({ runtime, rt, lines }) => {
      assert.equal(runtime.getBeamFulfilmentDeps(env), null);
      assert.equal(runtime.getFulfilmentProviderDeps(env, "beam"), null);
      let config: ReturnType<typeof getFulfilmentConfig> | null = null;
      try {
        config = getFulfilmentConfig(env);
      } catch {
        config = null;
      }
      if (config) assert.equal(runtime.providerDepsFor(config, env)("beam"), null);
      assert.equal(rt.warnedBeamDrain, undefined);
      assert.deepEqual(lines.filter((l) => l.includes("beam_drain_mode")), []);
    });
  }
});

test("kvFor: a Beam mode with the mock writer uses the in-memory store even with Redis set (money review 10); the live writer uses Redis", async (t) => {
  const config = getBookingConfig(BEAM_MOCK_WRITER_ENV);
  await withRuntime(t, BEAM_MOCK_WRITER_ENV, async ({ runtime, rt, lines, redis }) => {
    assert.equal(config.paymentMode, "beam-playground");
    assert.equal(config.cloudbedsWrite?.mode, "mock");
    assert.ok(config.redis, "Redis is configured");
    delete rt.redisKv;
    const deps = runtime.getBeamDeps(config);
    assert.equal(deps?.kv.kind, "memory");
    assert.equal(deps?.kv, rt.memoryKv);
    assert.equal(deps?.writer.mode, "mock");
    assert.equal(rt.redisKv, undefined, "no Redis store is made");
    assert.equal(runtime.getProviderDeps(config)?.deps.kv, rt.memoryKv);
    assert.equal(rt.warnedMemory, undefined);
    assert.deepEqual(lines, [], "no warning: memory is what a local mock-writer run is meant to use");
    assert.deepEqual(redis?.writes, []);
  });

  // A Stripe deployment with the mock writer and Redis: Stripe keeps Redis; its Beam drain (mock writer too) uses memory.
  const stripeMockWriter: Env = { ...STRIPE_WITH_BEAM_DRAIN, CLOUDBEDS_API_KEY_BOOKING: undefined };
  await withRuntime(t, stripeMockWriter, async ({ runtime, rt, redis }) => {
    const stripe = runtime.getStripeDeps(getFulfilmentConfig(stripeMockWriter));
    assert.equal(stripe?.writer.mode, "mock");
    assert.equal(stripe?.kv, redis, "Stripe's store is unchanged: Redis");
    const drain = runtime.getBeamFulfilmentDeps(stripeMockWriter);
    assert.equal(drain?.config.cloudbedsWrite?.mode, "mock");
    assert.equal(drain?.kv.kind, "memory");
    assert.equal(drain?.kv, rt.memoryKv);
  });

  await withRuntime(t, BEAM_TEST_ENV, async ({ runtime, rt, redis }) => {
    const deps = runtime.getBeamDeps(getBookingConfig(BEAM_TEST_ENV));
    assert.equal(deps?.writer.mode, "live");
    assert.equal(deps?.kv, redis);
    assert.equal(rt.memoryKv, undefined);
  });
});

test("building the Beam deps writes no KV and logs nothing (the golden route env 'drain: provider beam (playground), Stripe live credentials kept' builds them eagerly)", async (t) => {
  for (const env of [GOLDEN_BEAM_ENV, BEAM_TEST_ENV, BEAM_MOCK_WRITER_ENV]) {
    // The routes resolve their config first (it may warn once per process); the deps are built after it.
    const fulfilment = getFulfilmentConfig(env);
    const booking = getBookingConfig(env);
    await withRuntime(t, env, async ({ runtime, rt, lines, network, redis }) => {
      assert.equal(fulfilment.paymentMode, "beam-playground");
      const deps = runtime.getBeamDeps(fulfilment);
      const pd = runtime.getProviderDeps(fulfilment);
      // The status and abandon routes and the return page: the active deps at once.
      runtime.providerDepsFor(fulfilment, env)("beam");
      // The availability route's no-base-rate alerter (S3.1 amendment f).
      const alerter = runtime.getProviderDeps(booking)?.deps;
      runtime.getBeamFulfilmentDeps(env);
      runtime.getFulfilmentProviderDeps(env, "beam", { deadlineMs: NOW + 25_000 });
      assert.ok(deps && pd && alerter);
      // The gateway's members read without a call make none.
      pd.gw.keyOf("Lnk_1");
      pd.gw.text.feeItem(fulfilment.paymentMode);
      pd.gw.parseHoldId?.("MSV-20261005-GQ7K-B-TEST");
      assert.deepEqual(lines, []);
      assert.deepEqual(network, []);
      assert.deepEqual(redis?.writes ?? [], []);
      assert.deepEqual(Object.keys(rt).filter((k) => k !== "redisKv" && k !== "memoryKv" && k !== "mockWriterCloudbeds"), [], "no warning flag was set");
    });
  }
});

test("onRateLimited counts every Beam 429 per mode and tells the owner once, at the 20th in an hour; a failed count never breaks the call", async (t) => {
  await withRuntime(t, BEAM_TEST_ENV, async ({ runtime, rt, lines, redis }) => {
    assert.ok(redis);
    const config = getBookingConfig(BEAM_TEST_ENV);
    const deps = runtime.getBeamDeps(config);
    assert.ok(deps?.onRateLimited);
    const key = keys.beamRateLimited(keyScope(config.paymentMode));
    assert.equal(key, "msv:beam-playground:beam:ratelimited");
    const alertLines = () => lines.filter((l) => l.startsWith("info [booking] alert_"));
    for (let i = 0; i < runtime.BEAM_RATE_LIMIT_ALERT_COUNT - 1; i++) deps.onRateLimited();
    await settle();
    assert.equal(await redis.get(key), "19");
    assert.deepEqual(alertLines(), []);
    assert.deepEqual(redis.writes[0], ["incr", key, 3600], "a one-hour window");
    deps.onRateLimited();
    await settle();
    assert.equal(await redis.get(key), "20");
    assert.deepEqual(alertLines(), ['info [booking] alert_warning {"subject":"Beam is rate-limiting the booking engine"}']);
    for (let i = 0; i < 5; i++) deps.onRateLimited();
    await settle();
    assert.equal(await redis.get(key), "25");
    assert.equal(alertLines().length, 1, "once per window");

    // The window is an hour: the count starts again.
    t.mock.timers.setTime(NOW + 3_601_000);
    runtime.getBeamDeps(config)?.onRateLimited?.();
    await settle();
    assert.equal(await redis.get(key), "1");

    // Wired into the gateway: a 429 answered to a read is counted (beam.ts retries a GET once).
    const kit = makeBeamKit({ kv: redis, now: { ms: NOW + 3_601_000 } });
    rt.beamFetch = kit.fakeBeam.fetch;
    const h = await beamHeld(kit);
    kit.fakeBeam.rateLimitNext(1);
    const gw = runtime.getProviderDeps(config)?.gw;
    assert.equal((await gw?.get(h.key))?.state, "open", "the retry answered");
    await settle();
    assert.equal(await redis.get(key), "2");

    // A store that fails: the count is dropped, nothing throws, no rejection is left unhandled.
    rt.redisKv = { url: BEAM_TEST_ENV.UPSTASH_REDIS_REST_URL ?? "", kv: { ...redis, incr: async () => Promise.reject(new Error("redis down")) } };
    const failing = runtime.getBeamDeps(config);
    assert.doesNotThrow(() => failing?.onRateLimited?.());
    await settle();
  });

  // The alert's words (the alerter only logs the subject outside live mode).
  const source = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");
  assert.ok(
    source.includes(
      "`${n} requests were answered 429 in the last hour. Return pages may show 'couldn't check the payment just now'; webhooks and the sweeper still confirm bookings. Ask Beam for the limits if this repeats.`",
    ),
  );
  assert.ok(source.includes('{ key: "beam-rate-limited", severity: "warning" }'));
});

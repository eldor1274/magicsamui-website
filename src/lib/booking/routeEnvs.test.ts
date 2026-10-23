// Route resilience across deployment variants (Beam design S4.9, money review 11). The status, abandon and sweep
// routes, both webhooks and the return page's status check run through the real handlers and the real runtime deps
// (runtime.ts) on one fake world per deployment: a fake Cloudbeds behind the MOCK writer, one in-memory store, a fake
// Stripe that the real Stripe SDK reaches over node:https (stripe-test) and a fake Beam (the beamFetch test hook).
// Everything else that would leave the process (the global fetch, node:http, any other https host) is blocked.
//
// Covered:
// - A Stripe-primary deployment with (a) no Beam variables, (b) valid Beam playground drain variables and (c) invalid
//   Beam variables (an unknown base with short keys; the playground keys without BEAM_WEBHOOK_HMAC_KEY; the live
//   base while LIVE_FULFILMENT_READY.beam is false): every Stripe answer - checkout, status, abandon, the Stripe
//   webhook, the sweep - and every Stripe and Cloudbeds call, Stripe store write and log line is the same in all of
//   them, apart from the sweep's runs field (and the Beam run's own lines and writes in (b)); no Beam config error
//   ever reaches a Stripe answer. The Beam webhook answers (a) and (c) 503 before the body is read, (b) 401 unsigned;
//   the sweep is the single-run answer without a Beam config and adds runs[] with one; a failing Stripe session list
//   answers 500 sweep_failed alone and 502 payments_unavailable next to a Beam config; a failed Beam run makes it
//   502. (b) finishes Beam bookings started before the switch (status, abandon, the return page, the Beam webhook,
//   the sweep) and releases Beam-mode holds, so the Stripe runs count fewer skippedOtherMode.
// - A Beam-primary deployment with a Stripe drain: Stripe bookings made before the switch get the very answers they
//   got on the Stripe deployment; the sweep sweeps Beam first while the answer lists Stripe first; a drain whose
//   session list fails writes no Stripe heartbeat.
// - The fallback (routeFallback.ts): after a BOOKING_PAYMENT_PROVIDER typo a Beam booking still gets its status,
//   its abandon and its return page from the Beam drain (the config error still logged, the routes' 25-second
//   deadline and per-client limits kept), while a Stripe booking keeps the config error exactly as with no Beam
//   variables (nothing Beam built, no Beam call); a lock, a missing or weak token secret, invalid_beam_base and a
//   typo without Beam deps keep the config error for Beam bookings too, and without Beam variables abandon reads no
//   body (today's code path).
// - stripe-live with the same Beam variants, on every path that needs no Cloudbeds call: the same answers.

import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import * as nodeModule from "node:module";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { buildOffers } from "./availability.ts";
import { BEAM_API_KEY, BEAM_HMAC_KEY_B64, BEAM_MERCHANT_ID } from "./beamTestkit.ts";
import { POLICY_VERSION } from "./catalogue.ts";
import { BEAM_LIVE_BASE, BEAM_PLAYGROUND_BASE, BookingConfigError, LIVE_FULFILMENT_READY, getBeamDrainConfig, getFulfilmentConfig } from "./config.ts";
import type { Env } from "./config.ts";
import { addDays } from "./dates.ts";
import { demoInventory } from "./demoProvider.ts";
import { createMemoryKv } from "./kv.ts";
import type { KvStore } from "./kv.ts";
import { holdIdentifier, keyScope, keys } from "./lock.ts";
import { beamSignature, createFakeBeam } from "./mock/fakeBeam.ts";
import type { FakeBeam } from "./mock/fakeBeam.ts";
import { createFakeCloudbeds } from "./mock/fakeCloudbeds.ts";
import type { FakeCloudbeds } from "./mock/fakeCloudbeds.ts";
import { createFakeStripe } from "./mock/fakeStripe.ts";
import type { FakeStripe } from "./mock/fakeStripe.ts";
import { STALE_HOLD_MS } from "./sweep.ts";
import { GUEST, NOW, STRIPE_LIVE_ENV, TOKEN_SECRET, WEBHOOK_SECRET, recordingKv } from "./testkit.ts";
import type { KvWrite } from "./testkit.ts";
import { createBookingToken } from "./token.ts";
import type { BookingSummary, CartItemInput, CheckoutSuccess, PayMethod, Quote } from "./types.ts";

const MIN = 60_000;
/** Past this a hold is stale for the sweeper, its Cloudbeds age read cautiously (up to 7 h young). */
const ORPHAN_STALE_MS = STALE_HOLD_MS + 7 * 3600_000 + MIN;
const SWEEP_SECRET = "sweep-secret-routeenvs-0123456789";
const STRIPE_TEST_KEY = "sk_test_routeenvs0123456789";
const HONEYMOON: CartItemInput[] = [{ slug: "honeymoon-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
const GARDEN: CartItemInput[] = [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
const SUNRISE: CartItemInput[] = [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
const TEXT = "text/plain;charset=UTF-8";
const JSON_TYPE = "application/json";

const BEAM_VARS: Env = { BEAM_API_BASE: BEAM_PLAYGROUND_BASE, BEAM_MERCHANT_ID, BEAM_API_KEY, BEAM_WEBHOOK_HMAC_KEY: BEAM_HMAC_KEY_B64 };
/** A Stripe-primary deployment: stripe-test (the real SDK over node:https), the MOCK writer, no Redis, demo availability. */
const STRIPE_PRIMARY: Env = {
  BOOKING_PAYMENT_PROVIDER: "stripe",
  STRIPE_SECRET_KEY: STRIPE_TEST_KEY,
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  BOOKING_TOKEN_SECRET: TOKEN_SECRET,
  CLOUDBEDS_STRIPE_PAYMENT_METHOD: "Stripe(website)",
  BOOKING_SWEEP_SECRET: SWEEP_SECRET,
};
/** A Beam-primary deployment (beam-playground, the MOCK writer) with the Stripe variables kept: the Stripe drain. */
const BEAM_PRIMARY: Env = { ...STRIPE_PRIMARY, BOOKING_PAYMENT_PROVIDER: "beam", ...BEAM_VARS };

type Variant = "none" | "drain";
/** The Stripe-primary variants: (a), (b) and (c); "drain" = a Beam config (the Beam drain) exists. */
const STRIPE_VARIANTS: [string, Env, Variant][] = [
  ["(a) no Beam variables", STRIPE_PRIMARY, "none"],
  ["(b) valid Beam playground drain variables", { ...STRIPE_PRIMARY, ...BEAM_VARS }, "drain"],
  ["(c) invalid Beam variables: an unknown base, short keys", { ...STRIPE_PRIMARY, BEAM_API_BASE: "https://beam.invalid", BEAM_MERCHANT_ID: "x", BEAM_API_KEY: "y", BEAM_WEBHOOK_HMAC_KEY: "short" }, "none"],
  ["(c) invalid Beam variables: the playground keys without BEAM_WEBHOOK_HMAC_KEY", { ...STRIPE_PRIMARY, ...BEAM_VARS, BEAM_WEBHOOK_HMAC_KEY: undefined }, "none"],
  ["(c) invalid Beam variables: the live base while the code switch is off", { ...STRIPE_PRIMARY, ...BEAM_VARS, BEAM_API_BASE: BEAM_LIVE_BASE }, "none"],
];
const [ENV_A, ENV_B] = [STRIPE_VARIANTS[0][1], STRIPE_VARIANTS[1][1]];

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
    status: await import("../../app/api/booking/status/route.ts"),
    abandon: await import("../../app/api/booking/abandon/route.ts"),
    sweep: await import("../../app/api/booking/sweep/route.ts"),
    stripeWebhook: await import("../../app/api/stripe/webhook/route.ts"),
    beamWebhook: await import("../../app/api/beam/webhook/route.ts"),
    returnPage: await import("./returnPageStatus.ts"),
    NextRequest: (await import("next/server")).NextRequest,
  };
}

/** runtime.ts's process-wide state (globalThis.__msvBookingRuntime). */
interface RuntimeGlobals {
  [key: string]: unknown;
}

function runtimeGlobals(): RuntimeGlobals {
  const g = globalThis as typeof globalThis & { __msvBookingRuntime?: RuntimeGlobals };
  return (g.__msvBookingRuntime ??= {});
}

/* ----------------------------------------------- Stripe over https ----------------------------------------------- */

/**
 * node:https as the Stripe SDK uses it, answered by `fake()` for api.stripe.com (each request passed to `onRequest`);
 * any other host, and every request while `fake()` is null, is blocked (and passed to `onBlocked`).
 */
function stripeOverHttps(fake: () => FakeStripe | null, onBlocked: (line: string) => void, onRequest: (line: string) => void): typeof https.request {
  return ((...args: unknown[]) => {
    const o = args[0] as { host?: string; hostname?: string; path?: string; method?: string; headers?: Record<string, unknown> } | string;
    const host = typeof o === "string" ? new URL(o).host : (o.hostname ?? o.host ?? "");
    const stripe = fake();
    if (!stripe || typeof o === "string" || host !== "api.stripe.com") {
      onBlocked(`https ${typeof o === "string" ? o : `${o.method ?? "GET"} ${host}${o.path ?? ""}`}`);
      throw new Error("https blocked by routeEnvs.test.ts");
    }
    const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
    let body = "";
    req.setTimeout = () => req;
    req.destroy = (e?: Error) => {
      if (e) req.emit("error", e);
      return req;
    };
    req.write = (chunk: unknown) => {
      if (chunk !== undefined && chunk !== null) body += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
      return true;
    };
    req.end = () => {
      const method = (o.method ?? "GET").toUpperCase();
      onRequest(`stripe ${method} ${(o.path ?? "/").split("?")[0]}`);
      void (async () => {
        const headers = Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k, String(v)]));
        const res = await stripe.fetch(`https://api.stripe.com${o.path ?? "/"}`, { method, headers, ...(method !== "GET" && body !== "" ? { body } : {}) });
        const text = await res.text();
        const msg = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string>; complete: boolean };
        msg.statusCode = res.status;
        msg.headers = Object.fromEntries(res.headers.entries());
        msg.complete = true;
        req.emit("response", msg);
        msg.end(text);
      })().catch((e: unknown) => req.emit("error", e));
      return req;
    };
    return req;
  }) as unknown as typeof https.request;
}

/* --------------------------------------------------- the world --------------------------------------------------- */

/** A route answer: status, the cache and type headers, and the body (parsed when JSON). */
interface Answer {
  status: number;
  cacheControl: string | null;
  contentType: string | null;
  body: unknown;
}

async function answerOf(res: Response): Promise<Answer> {
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // a plain text answer (the webhooks)
  }
  return { status: res.status, cacheControl: res.headers.get("cache-control"), contentType: res.headers.get("content-type"), body };
}

/** A console line: logEvent's event name and data ("" without data), or the whole line (config errors, warnings). */
interface Line {
  level: string;
  message: string;
  data?: string;
}

const lineText = (l: Line) => `${l.level} ${l.message}`;

interface Booked {
  provider: "stripe" | "beam";
  ref: string;
  /** The booking token (the return URL's t) and the link token (l). */
  t: string;
  l: string;
  /** The Checkout Session id (Stripe) or the payment link id (Beam). */
  id: string;
  reservationId: string;
  quote: Answer;
  answer: Answer;
}

interface World {
  cb: FakeCloudbeds;
  kv: KvStore & { writes: KvWrite[] };
  stripe: FakeStripe;
  beam: FakeBeam;
  lines: Line[];
  network: string[];
  /** Every Stripe and Beam API request, in order ("stripe GET /v1/...", "beam GET /api/v1/..."). */
  order: string[];
  /** beamCharges: Beam answers every charge list (its charge scan) 503. slowLinkReads: every link read is answered only after the routes' 25-second budget (the mocked clock moves 26 s). */
  faults: { beamCharges: boolean; slowLinkReads: boolean };
  /** The routes read process.env per request: later requests run under `env`. */
  useEnv(env: Env): void;
  setTime(ms: number): void;
  checkout(items: CartItemInput[], payMethod?: PayMethod): Promise<Booked>;
  /** `ip`: the client address (default: a fresh one). */
  status(q: Record<string, string>, ip?: string): Promise<Answer>;
  /** bodyUsed: whether the route read the request body. */
  abandon(body: unknown, contentType?: string, ip?: string): Promise<Answer & { bodyUsed: boolean }>;
  stripeWebhook(payload: string, signature: string | null): Promise<Answer>;
  beamWebhook(raw: string, headers?: Record<string, string>): Promise<Answer & { bodyUsed: boolean }>;
  sweep(auth?: string | null): Promise<Answer>;
  returnPage(t: string, s?: string | null): Promise<unknown>;
}

/** The first 3-night window from Jan 2027 (after `skip` others) where the demo calendar has `slug` free. */
function demoWindow(slug: string, skip: number): { checkIn: string; checkOut: string } {
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

let ipCounter = 0;
/** A fresh client address per request: the routes' per-IP limits live as long as the process. */
const nextIp = () => `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`;

/**
 * Runs `fn` with Date frozen (each world starts at NOW), the console recorded, the global fetch, node:http and every
 * https host but the world's fake Stripe blocked, and `open(env)` making a fresh world: runtime.ts's globals cleared
 * and seeded (the in-memory store, also for the env's Upstash URL; the MOCK writer's fake Cloudbeds; Beam's fetch on a
 * fake Beam), process.env = env.
 */
async function withWorlds(t: TestContext, fn: (open: (env: Env) => World) => Promise<void>): Promise<void> {
  const savedEnv = process.env;
  const savedFetch = globalThis.fetch;
  const savedHttps = https.request;
  const savedHttp = http.request;
  const rt = runtimeGlobals();
  const savedGlobals = { ...rt };
  let current: World | null = null;
  const opened: World[] = [];
  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      current?.network.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      throw new TypeError("network blocked by routeEnvs.test.ts");
    }) as typeof fetch;
    https.request = stripeOverHttps(
      () => current?.stripe ?? null,
      (line) => void current?.network.push(line),
      (line) => void current?.order.push(line),
    );
    http.request = ((...args: unknown[]) => {
      current?.network.push(`http ${JSON.stringify(args[0])}`);
      throw new Error("http blocked by routeEnvs.test.ts");
    }) as unknown as typeof http.request;
    const routes = await loadRoutes();
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    for (const level of ["info", "warn", "error"] as const) {
      t.mock.method(console, level, (...args: unknown[]) => {
        const first = typeof args[0] === "string" ? args[0] : JSON.stringify(args[0]);
        const m = /^\[booking\] (\S+)$/.exec(first);
        current?.lines.push(m ? { level, message: m[1], data: typeof args[1] === "string" ? args[1] : JSON.stringify(args[1]) } : { level, message: first });
      });
    }

    const open = (env: Env): World => {
      for (const key of Object.keys(rt)) delete rt[key];
      t.mock.timers.setTime(NOW);
      process.env = { ...env } as NodeJS.ProcessEnv;
      const cb = createFakeCloudbeds({ lenient: true, now: () => Date.now() });
      const kv = recordingKv(createMemoryKv(() => Date.now()));
      const stripe = createFakeStripe({ webhookSecret: WEBHOOK_SECRET, now: () => Date.now(), checkoutUrl: (x) => `https://checkout.stripe.com/c/pay/${x.id}` });
      const beam = createFakeBeam({ now: () => Date.now(), merchantId: BEAM_MERCHANT_ID, apiKey: BEAM_API_KEY, hmacKeyB64: BEAM_HMAC_KEY_B64, base: "playground" });
      const order: string[] = [];
      const faults = { beamCharges: false, slowLinkReads: false };
      rt.memoryKv = kv;
      // A config with Redis (the live ones) gets the same in-memory store for its Upstash URL.
      if (env.UPSTASH_REDIS_REST_URL) rt.redisKv = { url: env.UPSTASH_REDIS_REST_URL, kv };
      rt.mockWriterCloudbeds = cb;
      rt.beamFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
        order.push(`beam ${(init?.method ?? "GET").toUpperCase()} ${path}`);
        if (faults.beamCharges && path === "/api/v1/charges") {
          return new Response(JSON.stringify({ code: 503, message: "simulated", error: { errorCode: "INTERNAL_SERVER_ERROR", errorMessage: "simulated" } }), { status: 503 });
        }
        const res = await beam.fetch(input, init);
        if (faults.slowLinkReads && (init?.method ?? "GET") === "GET" && path.startsWith("/api/v1/payment-links/")) t.mock.timers.setTime(Date.now() + 26_000);
        return res;
      }) as typeof fetch;
      const windows = new Map<string, number>();
      const post = (path: string, body: string, contentType = JSON_TYPE, ip = nextIp()) =>
        new Request(`http://localhost:3000${path}`, { method: "POST", headers: { host: "localhost:3000", "x-forwarded-for": ip, "content-type": contentType }, body });
      const world: World = {
        cb,
        kv,
        stripe,
        beam,
        lines: [],
        network: [],
        order,
        faults,
        useEnv: (next) => void (process.env = { ...next } as NodeJS.ProcessEnv),
        setTime: (ms) => t.mock.timers.setTime(ms),
        async checkout(items, payMethod) {
          const skip = windows.get(items[0].slug) ?? 0;
          windows.set(items[0].slug, skip + 1);
          const req = { ...demoWindow(items[0].slug, skip), items, termsVersion: POLICY_VERSION, guest: GUEST, ...(payMethod ? { payMethod } : {}) };
          const quote = await answerOf(await routes.checkout.POST(post("/api/booking/checkout", JSON.stringify({ ...req, expectedTotalSatang: 1, expectedDueNowSatang: 1 }))));
          assert.equal(quote.status, 409, JSON.stringify(quote.body));
          const q = (quote.body as { quote: Quote }).quote;
          const answer = await answerOf(
            await routes.checkout.POST(post("/api/booking/checkout", JSON.stringify({ ...req, expectedTotalSatang: q.totalSatang, expectedDueNowSatang: q.dueNowSatang }))),
          );
          assert.equal(answer.status, 200, `${JSON.stringify(answer.body)} ${JSON.stringify(world.lines.slice(-6))} ${world.network.join(", ")}`);
          const body = answer.body as CheckoutSuccess;
          const redirect = new URL(body.redirectUrl);
          if (body.provider === "beam") {
            const id = redirect.pathname.split("/").pop() ?? "";
            const t = new URL(beam.link(id).redirectUrl ?? "").searchParams.get("t") ?? "";
            return { provider: "beam", ref: body.ref, t, l: body.linkToken ?? "", id, reservationId: body.holdReservationId ?? "", quote, answer };
          }
          assert.equal(body.provider, "stripe");
          const id = redirect.pathname.split("/").pop() ?? "";
          const t = new URL((stripe.session(id)?.success_url ?? "").replace("{CHECKOUT_SESSION_ID}", "x")).searchParams.get("t") ?? "";
          return { provider: "stripe", ref: body.ref, t, l: body.linkToken ?? "", id, reservationId: body.holdReservationId ?? "", quote, answer };
        },
        async status(q, ip = nextIp()) {
          const req = new routes.NextRequest(`http://localhost:3000/api/booking/status?${new URLSearchParams(q).toString()}`, { headers: { host: "localhost:3000", "x-forwarded-for": ip } });
          return answerOf(await routes.status.GET(req));
        },
        async abandon(body, contentType = JSON_TYPE, ip = nextIp()) {
          const request = post("/api/booking/abandon", typeof body === "string" ? body : JSON.stringify(body), contentType, ip);
          const res = await routes.abandon.POST(request);
          return { ...(await answerOf(res)), bodyUsed: request.bodyUsed };
        },
        stripeWebhook: async (payload, signature) =>
          answerOf(await routes.stripeWebhook.POST(new Request("https://magicsamui.com/api/stripe/webhook", { method: "POST", headers: signature ? { "stripe-signature": signature } : {}, body: payload }))),
        async beamWebhook(raw, headers = {}) {
          const request = new Request("https://magicsamui.com/api/beam/webhook", { method: "POST", headers: { "content-type": JSON_TYPE, "x-forwarded-for": nextIp(), ...headers }, body: raw });
          const res = await routes.beamWebhook.POST(request);
          return { ...(await answerOf(res)), bodyUsed: request.bodyUsed };
        },
        sweep: async (auth = `Bearer ${SWEEP_SECRET}`) =>
          answerOf(await routes.sweep.GET(new Request("https://magicsamui.com/api/booking/sweep", { headers: auth ? { authorization: auth } : {} }))),
        returnPage: (tok, s = null) => routes.returnPage.returnPageStatus(tok, null, s),
      };
      current = world;
      opened.push(world);
      return world;
    };
    await fn(open);
    for (const w of opened) assert.deepEqual(w.network, [], "nothing left the process");
  } finally {
    current = null;
    for (const key of Object.keys(rt)) delete rt[key];
    Object.assign(rt, savedGlobals);
    process.env = savedEnv;
    globalThis.fetch = savedFetch;
    https.request = savedHttps;
    http.request = savedHttp;
  }
}

/* ---------------------------------------------------- tapes ---------------------------------------------------- */

const TOKEN_RE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

/** Replaces what differs between worlds (random ids, refs, tokens) by placeholders numbered in order of first appearance. */
class Normaliser {
  private readonly seen = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  readonly tokens: Record<string, unknown> = {};

  private id(raw: string, kind: string): string {
    let placeholder = this.seen.get(raw);
    if (placeholder === undefined) {
      const n = (this.counters.get(kind) ?? 0) + 1;
      this.counters.set(kind, n);
      placeholder = `${kind}_${n}`;
      this.seen.set(raw, placeholder);
    }
    return placeholder;
  }

  private token(raw: string): string {
    const known = this.seen.get(raw);
    if (known !== undefined) return known;
    const placeholder = this.id(raw, "tok");
    let payload: unknown = "(not JSON)";
    try {
      payload = JSON.parse(Buffer.from(raw.split(".")[0], "base64url").toString("utf8"));
    } catch {
      // keep the marker
    }
    this.tokens[placeholder] = this.value(payload);
    return placeholder;
  }

  text(s: string): string {
    if (/^[0-9a-f]{24}$/.test(s)) return this.id(s, "lock");
    return s
      .replace(TOKEN_RE, (m) => this.token(m))
      .replace(/cs_(test|live)_fake_[0-9a-f]+/g, (m) => this.id(m, "cs"))
      .replace(/\b(pi|ch|evt|req)_fake_[0-9a-f]+/g, (m, kind: string) => this.id(m, kind))
      .replace(/(?<!\d)70000\d{8}(?!\d)/g, (m) => this.id(m, "res"))
      .replace(/(?<![\w-])fake-\d+(?!\d)/g, (m) => this.id(m, "cbreq"))
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (m) => this.id(m, "uuid"))
      .replace(/MSV-(\d{8})-[A-HJ-NP-Z2-9]{4}/g, (m, day: string) => `MSV-${day}-${this.id(m, "ref")}`)
      .replace(/msv-cs-[0-9a-f]{40}/g, (m) => this.id(m, "idem"))
      // Per-client hold counters: the hashed client address (every request has an address of its own).
      .replace(/(?<=msv:holds:client:)[0-9a-f]{32}/g, (m) => this.id(m, "client"));
  }

  value(v: unknown): unknown {
    if (typeof v === "string") return this.text(v);
    if (Array.isArray(v)) return v.map((x) => this.value(x));
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [this.text(k), this.value(x)]));
    return v;
  }
}

/** Beam's own store keys ("msv:beam:..." and the beam-* scopes): never a Stripe write. */
const isBeamKey = (key: string) => key.startsWith("msv:beam");

/**
 * Step by step: the answer and what the step did on the Stripe side - the fake Stripe's requests, the Cloudbeds
 * calls, the store writes (Beam's own keys left out) and the log lines - normalised. A sweep step drops the answer's
 * runs field and keeps its lines apart (sweepLines): the Beam run of a drain adds lines of its own.
 */
class Tape {
  private readonly norm = new Normaliser();
  private at = { stripe: 0, cb: 0, kv: 0, lines: 0 };
  readonly steps: unknown[] = [];
  readonly sweepLines: string[][] = [];
  readonly sweeps: Record<string, unknown>[] = [];

  private readonly w: World;

  constructor(w: World) {
    this.w = w;
  }

  /** Skips whatever happened since the last step (a setup the tape leaves out). */
  mark(): void {
    this.at = { stripe: this.w.stripe.calls.length, cb: this.w.cb.calls.length, kv: this.w.kv.writes.length, lines: this.w.lines.length };
  }

  step(label: string, answer: Answer | unknown, opts: { sweep?: boolean } = {}): void {
    const w = this.w;
    // Whether a route read the body is no answer (the tests that care assert it apart).
    let shown = answer !== null && typeof answer === "object" && "bodyUsed" in answer ? { ...(answer as Answer & { bodyUsed?: boolean }), bodyUsed: undefined } : answer;
    const lines = w.lines.slice(this.at.lines).map(lineText);
    if (opts.sweep) {
      const a = answer as Answer;
      const { runs: _runs, ...rest } = a.body as Record<string, unknown>;
      void _runs;
      this.sweeps.push(a.body as Record<string, unknown>);
      shown = { ...a, body: rest };
      this.sweepLines.push(lines);
    }
    this.steps.push({
      step: label,
      answer: this.norm.value(shown),
      stripe: this.norm.value(w.stripe.calls.slice(this.at.stripe)),
      cloudbeds: this.norm.value(w.cb.calls.slice(this.at.cb)),
      kv: this.norm.value(w.kv.writes.slice(this.at.kv).filter((x) => !isBeamKey(x.key))),
      ...(opts.sweep ? {} : { logs: lines }),
    });
    this.mark();
  }

  close(): unknown {
    return { steps: this.steps, tokens: this.norm.tokens };
  }
}

/** `sub` appears in `full` in order (other lines may come between). */
function isSubsequence(sub: string[], full: string[]): boolean {
  let i = 0;
  for (const x of full) if (i < sub.length && x === sub[i]) i++;
  return i === sub.length;
}

const statusOf = (a: Answer) => (a.body as { status?: string }).status;
const unsignedBeam = JSON.stringify({ paymentLinkId: "AbCdEfGh12", order: { netAmount: 100, currency: "THB" } });

/**
 * The Stripe flows on a Stripe-primary deployment, recorded: a booking abandoned on the payment page, one paid and
 * confirmed by the webhook, one expired and released by the sweeper, and the error paths of every route.
 */
async function stripeScript(w: World): Promise<Tape> {
  const tape = new Tape(w);
  const a = await w.checkout(HONEYMOON);
  tape.step("checkout 1: quote", a.quote);
  tape.step("checkout 1", a.answer);
  tape.step("status 1 (open)", await w.status({ t: a.t, session_id: a.id }));
  tape.step("abandon 1", await w.abandon({ t: a.t, l: a.l }));
  tape.step("status 1 (cancelled)", await w.status({ t: a.t, session_id: a.id }));
  tape.step("return page 1", await w.returnPage(a.t, a.id));

  w.setTime(NOW + MIN);
  const b = await w.checkout(GARDEN);
  tape.step("checkout 2", b.answer);
  w.stripe.complete(b.id);
  const paid = w.stripe.signedEvent("checkout.session.completed", b.id);
  tape.step("stripe webhook 2 (completed)", await w.stripeWebhook(paid.payload, paid.header));
  tape.step("stripe webhook: a bad signature", await w.stripeWebhook(paid.payload, "t=1,v1=bad"));
  tape.step("stripe webhook: no signature", await w.stripeWebhook(paid.payload, null));
  tape.step("status 2 (session id)", await w.status({ t: b.t, session_id: b.id }));
  tape.step("status 2 (link token)", await w.status({ t: b.t, l: b.l }));
  tape.step("status 2 (pointer)", await w.status({ t: b.t }));
  tape.step("return page 2", await w.returnPage(b.t, null));
  tape.step("abandon 2 (paid)", await w.abandon({ t: b.t, l: b.l }));

  w.setTime(NOW + 2 * MIN);
  const c = await w.checkout(SUNRISE);
  tape.step("checkout 3", c.answer);
  w.stripe.expire(c.id);
  w.setTime(NOW + 2 * MIN + ORPHAN_STALE_MS);
  tape.step("sweep: no secret", await w.sweep(null));
  tape.step("sweep: a wrong secret", await w.sweep("Bearer wrong-secret-0123456789abcdef"));
  tape.step("sweep", await w.sweep(), { sweep: true });
  tape.step("status 3 (expired)", await w.status({ t: c.t, session_id: c.id }));
  tape.step("sweep again", await w.sweep(), { sweep: true });

  tape.step("status: a bad token", await w.status({ t: "garbage" }));
  tape.step("status: no token", await w.status({}));
  tape.step("abandon: a bad token", await w.abandon({ t: "garbage" }));
  tape.step("abandon: not JSON", await w.abandon("t=1", "text/plain"));
  tape.step("abandon: not an object", await w.abandon([a.t]));
  tape.step("return page: a bad token", await w.returnPage("garbage"));
  return tape;
}

/** A booking summary of `paymentMode` for a hand-made token (no record of it anywhere). */
function bookingFor(paymentMode: string, ref = "MSV-20261005-GQ7K"): BookingSummary {
  return {
    ref,
    paymentMode,
    checkIn: "2027-11-10",
    checkOut: "2027-11-13",
    nights: 3,
    items: HONEYMOON,
    itemRoomSatang: [2_700_000],
    promoCode: null,
    totalSatang: 2_781_000,
    cardFeeSatang: 81_000,
    dueNowSatang: 2_781_000,
    createdAt: new Date(NOW).toISOString(),
    linkExpiresAt: new Date(NOW + 30 * MIN).toISOString(),
  } as BookingSummary;
}

const handMadeToken = (paymentMode: string, ref?: string) => createBookingToken(bookingFor(paymentMode, ref), null, TOKEN_SECRET, 48 * 3600, NOW);

/* ---------------------------------------------- Stripe-primary ---------------------------------------------- */

test("Stripe-primary: every Stripe answer, call, store write and log line is the same with no Beam variables (a), a valid Beam playground drain (b) and invalid Beam variables (c), apart from the sweep's runs field", async (t) => {
  await withWorlds(t, async (open) => {
    const tapes: { label: string; variant: Variant; tape: Tape; world: World }[] = [];
    for (const [label, env, variant] of STRIPE_VARIANTS) {
      const world = open(env);
      tapes.push({ label, variant, tape: await stripeScript(world), world });
    }
    const [base, ...others] = tapes;
    // The baseline itself: the flows did what they say.
    const answers = Object.fromEntries((base.tape.steps as { step: string; answer: Answer }[]).map((s) => [s.step, s.answer]));
    assert.equal(statusOf(answers["status 1 (open)"]), "pending");
    assert.deepEqual(answers["abandon 1"].body, { ok: true, state: "released" });
    assert.equal(statusOf(answers["status 1 (cancelled)"]), "cancelled");
    assert.equal(answers["stripe webhook 2 (completed)"].status, 200);
    assert.equal(statusOf(answers["status 2 (pointer)"]), "paid");
    assert.equal(statusOf(answers["status 3 (expired)"]), "expired");
    assert.equal(answers["sweep"].status, 200);
    assert.equal(answers["abandon: not JSON"].status, 415);
    for (const o of others) {
      assert.deepEqual(o.tape.close(), base.tape.close(), `${o.label}: the Stripe tape is (a)'s`);
      // The sweep's own lines: every line (a) logs is there in order; only a Beam drain adds lines of its own.
      o.tape.sweepLines.forEach((lines, i) => {
        if (o.variant === "none") assert.deepEqual(lines, base.tape.sweepLines[i], `${o.label}: sweep ${i + 1} lines`);
        else assert.ok(isSubsequence(base.tape.sweepLines[i], lines), `${o.label}: sweep ${i + 1} lines ${lines.join(" | ")}`);
      });
    }
    for (const { label, variant, tape, world } of tapes) {
      for (const sweep of tape.sweeps) {
        if (variant === "none") assert.equal("runs" in sweep, false, `${label}: the single-run answer`);
        else {
          const runs = sweep.runs as { provider: string; mode: string | null; ok: boolean }[];
          assert.deepEqual(runs.map((r) => [r.provider, r.mode, r.ok]), [["stripe", "stripe-test", true], ["beam", "beam-playground", true]], label);
        }
      }
      // No Beam call without a Beam config; with the drain only its sweep runs ask Beam (its charge scan).
      const beamCalls = world.order.filter((x) => x.startsWith("beam "));
      if (variant === "none") assert.deepEqual(beamCalls, [], label);
      else assert.ok(beamCalls.length > 0 && beamCalls.every((x) => x.startsWith("beam GET /api/v1/charges")), beamCalls.join(", "));
      // No Beam config error, and no Beam line at all outside a drain's sweep, reaches a Stripe deployment's logs.
      const text = world.lines.map((l) => `${l.message} ${l.data ?? ""}`).join("\n");
      assert.doesNotMatch(text, /config error|invalid_beam_base|payment_misconfigured|live_payments_locked/, label);
      if (variant === "none") assert.doesNotMatch(text, /beam/i, label);
      else assert.equal(world.lines.filter((l) => l.message === "beam_drain_mode").length, 1, `${label}: the drain says so once`);
    }
  });
});

/** stripe-live (real Cloudbeds writes, Redis, production) with the same Beam variants: (a), (b) and (c). */
const LIVE = { ...STRIPE_LIVE_ENV, BOOKING_SWEEP_SECRET: SWEEP_SECRET };
const LIVE_VARIANTS: [string, Env][] = [
  ["stripe-live, (a) no Beam variables", LIVE],
  ["stripe-live, (b) valid Beam playground drain variables", { ...LIVE, ...BEAM_VARS }],
  ["stripe-live, (c) an unknown Beam base, short keys", { ...LIVE, BEAM_API_BASE: "https://beam.invalid", BEAM_MERCHANT_ID: "x", BEAM_API_KEY: "y", BEAM_WEBHOOK_HMAC_KEY: "short" }],
  ["stripe-live, (c) the playground keys without BEAM_WEBHOOK_HMAC_KEY", { ...LIVE, ...BEAM_VARS, BEAM_WEBHOOK_HMAC_KEY: undefined }],
  ["stripe-live, (c) the live Beam base while the code switch is off", { ...LIVE, ...BEAM_VARS, BEAM_API_BASE: BEAM_LIVE_BASE }],
];

test("stripe-live: on every path that needs no Cloudbeds call (Cloudbeds is blocked here) the answers, Stripe calls, store writes and log lines are the same with no Beam variables (a), a valid Beam playground drain (b) and invalid Beam variables (c)", async (t) => {
  await withWorlds(t, async (open) => {
    const tapes: [string, unknown][] = [];
    for (const [label, env] of LIVE_VARIANTS) {
      const w = open(env);
      const tape = new Tape(w);
      const liveToken = handMadeToken("stripe-live", "MSV-20261005-GQ7K");
      const testToken = handMadeToken("stripe-test", "MSV-20261005-GQ7M");
      const event = (type: string, object: Record<string, unknown>) =>
        JSON.stringify({ id: "evt_routeenvs_0001", object: "event", api_version: "2026-09-30.endive", created: Math.floor(NOW / 1000), type, livemode: true, pending_webhooks: 1, request: { id: null, idempotency_key: null }, data: { object } });
      tape.step("status: a bad token", await w.status({ t: "garbage" }));
      tape.step("status: a stripe-live booking with no session recorded yet", await w.status({ t: liveToken }));
      tape.step("status: a stripe-test booking", await w.status({ t: testToken }));
      tape.step("abandon: a stripe-live booking with no session recorded yet", await w.abandon({ t: liveToken }));
      tape.step("abandon: not JSON", await w.abandon("t=1", "text/plain"));
      tape.step("return page: a stripe-live booking with no session recorded yet", await w.returnPage(liveToken));
      tape.step("stripe webhook: no signature", await w.stripeWebhook(event("checkout.session.completed", {}), null));
      tape.step("stripe webhook: a bad signature", await w.stripeWebhook(event("checkout.session.completed", {}), "t=1,v1=bad"));
      tape.step("sweep: no secret", await w.sweep(null));
      tape.step("sweep: a wrong secret", await w.sweep("Bearer wrong-secret-0123456789abcdef"));
      tapes.push([label, tape.close()]);
      assert.deepEqual(w.order, [], `${label}: no Stripe or Beam call`);
    }
    const [[, base], ...others] = tapes;
    const steps = (base as { steps: { step: string; answer: Answer }[] }).steps;
    assert.equal(statusOf(steps[1].answer), "pending");
    assert.equal(steps[2].answer.status, 409);
    assert.deepEqual(steps[3].answer.body, { ok: true, state: "closed" });
    assert.equal(steps[6].answer.status, 400);
    for (const [label, tape] of others) assert.deepEqual(tape, base, label);
    // (b) is a working Beam drain on that deployment: a Beam token is answered by it (and only by it).
    const w = open(LIVE_VARIANTS[1][1]);
    const beam = await w.status({ t: handMadeToken("beam-playground") });
    assert.deepEqual([beam.status, statusOf(beam), (beam.body as { provider?: string }).provider], [200, "pending", "beam"]);
    assert.equal(w.lines.filter((l) => l.message === "beam_drain_mode").length, 1);
  });
});

test("the Beam webhook on a Stripe-primary deployment: (a) and (c) answer 503 'webhook not configured' to every POST, signed or not, before the body is read, logging beam_webhook_unconfigured with no data; (b) 401 to an unsigned POST; Cache-Control no-store on every answer; a Beam token gets the Stripe config's answer without a Beam config", async (t) => {
  await withWorlds(t, async (open) => {
    for (const [label, env, variant] of STRIPE_VARIANTS) {
      const w = open(env);
      const signed = { "x-beam-signature": beamSignature(unsignedBeam, BEAM_HMAC_KEY_B64), "x-beam-event": "payment_link.paid" };
      const answers = [await w.beamWebhook(unsignedBeam, signed), await w.beamWebhook(unsignedBeam), await w.beamWebhook("x".repeat(70_000))];
      if (variant === "none") {
        for (const a of answers) assert.deepEqual(a, { status: 503, cacheControl: "no-store", contentType: TEXT, body: "webhook not configured", bodyUsed: false }, label);
        assert.deepEqual(w.lines, Array(3).fill({ level: "info", message: "beam_webhook_unconfigured", data: "" }), label);
      } else {
        // A signed event for a link Beam doesn't know: read from Beam (404) and acknowledged, nothing to finish.
        assert.deepEqual(answers[0], { status: 200, cacheControl: "no-store", contentType: TEXT, body: "not ours", bodyUsed: true }, label);
        assert.deepEqual(w.order, ["beam GET /api/v1/payment-links/AbCdEfGh12"], label);
        assert.deepEqual(answers[1], { status: 401, cacheControl: "no-store", contentType: TEXT, body: "invalid signature", bodyUsed: true }, label);
        assert.deepEqual([answers[2].status, answers[2].body], [413, "payload too large"], label);
        assert.equal(w.lines.filter((l) => l.message === "beam_drain_mode").length, 1, `${label}: once per process`);
      }
      for (const a of answers) assert.equal(a.cacheControl, "no-store");

      // A Beam token on the Stripe deployment: the drain's answer in (b); without a Beam config, the Stripe config's.
      const beamToken = handMadeToken("beam-playground");
      const status = await w.status({ t: beamToken });
      const abandon = await w.abandon({ t: beamToken });
      if (variant === "none") {
        assert.deepEqual(status.body, { ok: false, error: "invalid_token", message: "This booking was made in a different payment mode." }, label);
        assert.equal(status.status, 409);
        assert.deepEqual([abandon.status, abandon.body], [200, { ok: true, state: "not_applicable" }], label);
        assert.equal(w.order.filter((x) => x.startsWith("beam ")).length, 0, label);
      } else {
        assert.deepEqual([status.status, statusOf(status), (status.body as { provider?: string }).provider], [200, "pending", "beam"], label);
        assert.deepEqual([abandon.status, abandon.body], [200, { ok: true, state: "closed" }], label);
      }
    }
  });
});

test("(b) a valid Beam playground drain finishes the Beam bookings started before the switch to stripe: status, abandon, the return page, the Beam webhook and the sweep, beam_drain_mode logged once", async (t) => {
  await withWorlds(t, async (open) => {
    const w = open(BEAM_PRIMARY);
    const a = await w.checkout(HONEYMOON, "card_ewallet");
    const b = await w.checkout(GARDEN, "card_ewallet");
    const c = await w.checkout(SUNRISE, "promptpay");
    assert.deepEqual([a.provider, b.provider, c.provider], ["beam", "beam", "beam"]);
    w.useEnv(ENV_B);

    const pending = await w.status({ t: a.t, l: a.l });
    assert.deepEqual([pending.status, statusOf(pending), (pending.body as { provider: string }).provider], [200, "pending", "beam"]);
    assert.deepEqual((await w.abandon({ t: a.t, l: a.l })).body, { ok: true, state: "released" });
    assert.equal(w.beam.link(a.id).status, "DISABLED");
    assert.equal(w.cb.reservations.get(a.reservationId)?.status, "canceled");
    assert.equal(statusOf(await w.status({ t: a.t, l: a.l })), "cancelled");

    w.beam.pay(b.id, "CARD");
    assert.equal((await w.beamWebhook(unsignedBeam)).status, 401, "unsigned");
    const event = w.beam.signedEvent("payment_link.paid", b.id);
    assert.deepEqual(await w.beamWebhook(event.raw, event.headers), { status: 200, cacheControl: "no-store", contentType: TEXT, body: "confirmed", bodyUsed: true });
    assert.equal(w.cb.reservations.get(b.reservationId)?.status, "confirmed");
    const paid = await w.status({ t: b.t });
    assert.deepEqual([statusOf(paid), (paid.body as { fulfilment: unknown }).fulfilment], ["paid", { state: "confirmed", reservationId: b.reservationId }]);
    assert.deepEqual(await w.returnPage(b.t), paid.body, "the return page answers as the status API");

    // C's link lapses unpaid: the drain's sweep run releases its hold.
    w.setTime(NOW + ORPHAN_STALE_MS);
    const sweep = await w.sweep();
    assert.equal(sweep.status, 200, JSON.stringify(sweep.body));
    const runs = (sweep.body as { runs: { provider: string; mode: string; ok: boolean; released: number }[] }).runs;
    assert.deepEqual(runs.map((r) => [r.provider, r.mode, r.ok]), [["stripe", "stripe-test", true], ["beam", "beam-playground", true]]);
    assert.equal(runs[1].released, 1);
    assert.equal(w.cb.reservations.get(c.reservationId)?.status, "canceled");
    assert.equal(statusOf(await w.status({ t: c.t, l: c.l })), "expired");
    assert.equal(w.lines.filter((l) => l.message === "beam_drain_mode").length, 1, "once per process");
  });
});

test("(b) the sweep: the Beam drain releases the Beam-mode holds (a lapsed beam-playground hold, a -B-TEST orphan), so the Stripe runs count fewer skippedOtherMode than with no Beam variables (a), where they stay", async (t) => {
  await withWorlds(t, async (open) => {
    const counts: Record<string, number[]> = {};
    for (const [label, env] of [["(a)", ENV_A], ["(b)", ENV_B]] as const) {
      const w = open(BEAM_PRIMARY);
      const held = await w.checkout(HONEYMOON, "card_ewallet");
      const orphan = w.cb.book("462961", "2027-12-01", "2027-12-02", holdIdentifier("MSV-20261005-BEAM", "beam-playground"));
      w.cb.reservations.get(orphan)!.status = "not_confirmed";
      w.useEnv(env);
      w.setTime(NOW + ORPHAN_STALE_MS);
      const first = await w.sweep();
      w.setTime(NOW + ORPHAN_STALE_MS + 10 * MIN);
      const second = await w.sweep();
      assert.equal(first.status, 200, `${label}: ${JSON.stringify(first.body)}`);
      assert.equal(second.status, 200, `${label}: ${JSON.stringify(second.body)}`);
      counts[label] = [first, second].map((s) => (s.body as { skippedOtherMode: number }).skippedOtherMode);
      const released = label === "(b)" ? "canceled" : "not_confirmed";
      assert.equal(w.cb.reservations.get(held.reservationId)?.status, released, `${label}: the Beam hold`);
      assert.equal(w.cb.reservations.get(orphan)?.status, released, `${label}: the Beam orphan`);
    }
    // (a): the stale beam-playground record is another mode's on every run. (b): every step 1 runs before the hold
    // sides, so the drain's step 1 has released the lapsed link's hold before Stripe's hold side reads the index.
    assert.deepEqual(counts, { "(a)": [1, 1], "(b)": [0, 0] });
  });
});

test("the sweep's failures: a failing Stripe session list answers 500 sweep_failed without a Beam config and 502 payments_unavailable (sweepPaidAndAlerts) next to one; a failed Beam run makes the answer 502", async (t) => {
  await withWorlds(t, async (open) => {
    for (const [label, env, variant] of STRIPE_VARIANTS) {
      const w = open(env);
      w.stripe.failNext(/^GET \/v1\/checkout\/sessions$/, 400, "Simulated list failure");
      const failed = await w.sweep();
      if (variant === "none") {
        assert.deepEqual([failed.status, failed.body], [500, { ok: false, error: "sweep_failed" }], label);
      } else {
        assert.equal(failed.status, 502, label);
        const body = failed.body as { error: string; runs: { provider: string; ok: boolean; error?: string }[] };
        assert.equal(body.error, "payments_unavailable");
        assert.deepEqual(body.runs.map((r) => [r.provider, r.ok, r.error ?? null]), [["stripe", false, "payments_unavailable"], ["beam", true, null]]);
        assert.equal(w.kv.writes.filter((x) => x.key === keys.lastSweep(keyScope("stripe-test"))).length, 0, "no Stripe heartbeat for a failed session list");
        // A failed Beam run: 502, the Stripe run's own summary as without Beam.
        w.setTime(NOW + 10 * MIN);
        w.faults.beamCharges = true;
        const beamFailed = await w.sweep();
        const b2 = beamFailed.body as { ok: boolean; error: string; mode: string; runs: { provider: string; ok: boolean; error?: string }[] };
        assert.equal(beamFailed.status, 502, JSON.stringify(b2));
        assert.deepEqual([b2.ok, b2.mode], [false, "stripe-test"]);
        assert.deepEqual(b2.runs.map((r) => [r.provider, r.ok]), [["stripe", true], ["beam", false]]);
      }
    }
  });
});

/* ------------------------------------------- Beam-primary, Stripe drain ------------------------------------------- */

test("Beam-primary with a Stripe drain: Stripe bookings made before the switch get exactly the answers the Stripe deployment gives them (status, abandon, the Stripe webhook, the return page)", async (t) => {
  await withWorlds(t, async (open) => {
    const run = async (after: Env) => {
      const w = open(ENV_A);
      const a = await w.checkout(HONEYMOON);
      const b = await w.checkout(GARDEN);
      w.useEnv(after);
      const tape = new Tape(w);
      tape.mark();
      tape.step("status 1 (open)", await w.status({ t: a.t, session_id: a.id }));
      tape.step("abandon 1", await w.abandon({ t: a.t, l: a.l }));
      tape.step("status 1 (cancelled)", await w.status({ t: a.t, session_id: a.id }));
      w.stripe.complete(b.id);
      const paid = w.stripe.signedEvent("checkout.session.completed", b.id);
      tape.step("stripe webhook 2 (completed)", await w.stripeWebhook(paid.payload, paid.header));
      tape.step("status 2 (pointer)", await w.status({ t: b.t }));
      tape.step("status 2 (link token)", await w.status({ t: b.t, l: b.l }));
      tape.step("return page 2", await w.returnPage(b.t, b.id));
      tape.step("abandon 2 (paid)", await w.abandon({ t: b.t, l: b.l }));
      return { w, tape };
    };
    const stripe = await run(ENV_A);
    const drained = await run(BEAM_PRIMARY);
    // The drain says once that it is draining (its first use); every other line, answer, call and write is the same.
    const steps = (drained.tape.close() as { steps: { logs?: string[] }[] }).steps;
    const drainLines = steps.flatMap((s) => s.logs ?? []).filter((l) => l === "info stripe_drain_mode");
    assert.deepEqual(drainLines, ["info stripe_drain_mode"]);
    for (const s of steps) if (s.logs) s.logs = s.logs.filter((l) => l !== "info stripe_drain_mode");
    assert.deepEqual(drained.tape.close(), stripe.tape.close());
    assert.equal(drained.w.order.filter((x) => x.startsWith("beam ")).length, 0, "no Beam call for a Stripe booking");
  });
});

test("Beam-primary with a Stripe drain: the sweep sweeps Beam first while the answer lists Stripe first; a drain whose session list fails writes no Stripe heartbeat (Beam's is written), 502", async (t) => {
  await withWorlds(t, async (open) => {
    const w = open(ENV_A);
    const s = await w.checkout(HONEYMOON);
    w.stripe.expire(s.id);
    w.useEnv(BEAM_PRIMARY);
    const beamHold = await w.checkout(GARDEN, "card_ewallet");
    w.setTime(NOW + ORPHAN_STALE_MS);
    const from = w.order.length;
    const sweep = await w.sweep();
    assert.equal(sweep.status, 200, JSON.stringify(sweep.body));
    const body = sweep.body as { mode: string; released: number; runs: { provider: string; mode: string; ok: boolean; released: number }[] };
    assert.equal(body.mode, "beam-playground", "the top-level counts are the active provider's (Beam's)");
    assert.deepEqual(body.runs.map((r) => [r.provider, r.mode, r.ok, r.released]), [["stripe", "stripe-test", true, 1], ["beam", "beam-playground", true, 1]]);
    const calls = w.order.slice(from);
    const firstBeam = calls.findIndex((x) => x.startsWith("beam "));
    const firstStripe = calls.findIndex((x) => x.startsWith("stripe "));
    assert.ok(firstBeam >= 0 && firstStripe > firstBeam, `Beam's step 1 first: ${calls.join(", ")}`);
    assert.equal(w.cb.reservations.get(s.reservationId)?.status, "canceled", "the Stripe drain released its expired hold");
    assert.equal(w.cb.reservations.get(beamHold.reservationId)?.status, "canceled", "Beam released its lapsed hold");

    w.setTime(NOW + ORPHAN_STALE_MS + 10 * MIN);
    w.stripe.failNext(/^GET \/v1\/checkout\/sessions$/, 400, "Simulated list failure");
    const writesFrom = w.kv.writes.length;
    const failed = await w.sweep();
    assert.equal(failed.status, 502, JSON.stringify(failed.body));
    const f = failed.body as { error: string; mode: string; runs: { provider: string; ok: boolean; error?: string }[] };
    assert.deepEqual([f.error, f.mode], ["payments_unavailable", "beam-playground"]);
    assert.deepEqual(f.runs.map((r) => [r.provider, r.ok, r.error ?? null]), [["stripe", false, "payments_unavailable"], ["beam", true, null]]);
    const writes = w.kv.writes.slice(writesFrom).map((x) => x.key);
    assert.ok(!writes.includes(keys.lastSweep(keyScope("stripe-test"))), "no Stripe heartbeat");
    assert.ok(writes.includes(keys.lastSweep(keyScope("beam-playground"))), "Beam's heartbeat");
  });
});

/* --------------------------------------------------- the fallback --------------------------------------------------- */

const TYPO = "bean";
/** BOOKING_PAYMENT_PROVIDER misspelt, every other variable as the Beam deployment's: the Beam (and Stripe) drain. */
const TYPO_ENV: Env = { ...BEAM_PRIMARY, BOOKING_PAYMENT_PROVIDER: TYPO };
/** The same typo without any Beam variable: today's answers, for comparison. */
const TYPO_NO_BEAM_ENV: Env = { ...STRIPE_PRIMARY, BOOKING_PAYMENT_PROVIDER: TYPO };
/** Real Cloudbeds writes next to the typo (round 8): the booking key, the property id and Upstash (the worlds' store). */
const TYPO_WRITES_ENV: Env = {
  ...TYPO_ENV,
  CLOUDBEDS_API_KEY_BOOKING: "cbat_write_routeenvs",
  CLOUDBEDS_PROPERTY_ID: "235064",
  UPSTASH_REDIS_REST_URL: "https://routeenvs-redis.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "routeenvs-redis-token",
};
const NOT_CONFIGURED = { ok: false, error: "payment_unavailable", message: "Online payment is not configured right now. No payment was taken." };
const LOCKED = { ok: false, error: "live_payments_locked", message: "Online payment on this page is paused right now. No payment was taken." };
const COULD_NOT_CHECK = { ok: false, error: "payment_unavailable", message: "We couldn't check this payment right now. Please refresh in a moment." };
/** A Beam reading that failed (here: past the deadline). */
const COULD_NOT_CHECK_NOW = { ok: false, error: "upstream_error", message: "We couldn't check the payment just now." };

test("a Beam booking still gets its status, its abandon and its return page after a BOOKING_PAYMENT_PROVIDER typo (the Beam drain); a Stripe booking, and anything else, keeps the config error exactly as with no Beam variables", async (t) => {
  await withWorlds(t, async (open) => {
    const w = open(BEAM_PRIMARY);
    const b1 = await w.checkout(HONEYMOON, "card_ewallet");
    const b2 = await w.checkout(GARDEN, "promptpay");
    const b3 = await w.checkout(SUNRISE, "card_ewallet");
    w.useEnv(STRIPE_PRIMARY);
    const s1 = await w.checkout(SUNRISE);
    const linesFrom = w.lines.length;
    const orderFrom = w.order.length;

    // Stripe (and bad) requests: the same answers, lines, calls and writes with and without the Beam variables.
    const stripeRequests = async (env: Env) => {
      w.useEnv(env);
      const tape = new Tape(w);
      tape.mark();
      tape.step("status: the Stripe booking", await w.status({ t: s1.t, session_id: s1.id }));
      tape.step("status: the Stripe booking (link token)", await w.status({ t: s1.t, l: s1.l }));
      tape.step("abandon: the Stripe booking", await w.abandon({ t: s1.t, l: s1.l }));
      tape.step("status: a bad token", await w.status({ t: "garbage" }));
      tape.step("status: no token", await w.status({}));
      tape.step("status: a token signed with another secret", await w.status({ t: createBookingToken(bookingFor("beam-playground"), null, "another-secret-0123456789abcdefghij", 3600, NOW) }));
      tape.step("abandon: a bad token", await w.abandon({ t: "garbage" }));
      tape.step("abandon: not JSON", await w.abandon("t=1", "text/plain"));
      tape.step("abandon: too large", await w.abandon(JSON.stringify({ t: b1.t, pad: "x".repeat(9_000) })));
      tape.step("abandon: not an object", await w.abandon([b1.t]));
      tape.step("return page: the Stripe booking", await w.returnPage(s1.t, s1.id));
      tape.step("return page: a bad token", await w.returnPage("garbage"));
      return tape.close();
    };
    const today = await stripeRequests(TYPO_NO_BEAM_ENV);
    const typo = await stripeRequests(TYPO_ENV);
    assert.deepEqual(typo, today);
    const steps = (today as { steps: { step: string; answer: Answer; logs: string[] }[] }).steps;
    for (const s of steps.filter((x) => !x.step.startsWith("return page"))) {
      assert.deepEqual([s.answer.status, s.answer.body], [503, NOT_CONFIGURED], s.step);
      assert.deepEqual(s.logs, ["error [booking] config error: payment_misconfigured - missing: BOOKING_PAYMENT_PROVIDER"], s.step);
    }
    for (const s of steps.filter((x) => x.step.startsWith("return page"))) assert.deepEqual(s.answer, COULD_NOT_CHECK, s.step);
    assert.equal(w.lines.slice(linesFrom).filter((l) => l.message === "beam_drain_mode").length, 0, "nothing Beam was built for them");
    assert.deepEqual(w.order.slice(orderFrom), [], "no Beam or Stripe call for them");

    // Without the Beam variables a Beam booking gets the config error too (no Beam deps), and abandon reads no body:
    // today's code path. With them it reads the body to find the token, and answers as before when it is not Beam's.
    w.useEnv(TYPO_NO_BEAM_ENV);
    assert.deepEqual((await w.status({ t: b1.t, l: b1.l })).body, NOT_CONFIGURED);
    const noBeam = await w.abandon({ t: b1.t, l: b1.l });
    assert.deepEqual([noBeam.status, noBeam.body, noBeam.bodyUsed], [503, NOT_CONFIGURED, false]);
    w.useEnv(TYPO_ENV);
    const stripeInTypo = await w.abandon({ t: s1.t, l: s1.l });
    assert.deepEqual([stripeInTypo.status, stripeInTypo.body, stripeInTypo.bodyUsed], [503, NOT_CONFIGURED, true]);

    // With them: the Beam drain answers, as the Beam deployment itself would; the config error is still logged.
    w.useEnv(TYPO_ENV);
    let at = w.lines.length;
    const pending = await w.status({ t: b1.t, l: b1.l });
    assert.deepEqual([pending.status, pending.cacheControl, statusOf(pending), (pending.body as { provider: string }).provider], [200, "no-store", "pending", "beam"]);
    assert.deepEqual(
      w.lines.slice(at).map(lineText),
      ["info beam_drain_mode", "error [booking] config error: payment_misconfigured - missing: BOOKING_PAYMENT_PROVIDER"],
    );
    w.beam.pay(b1.id, "CARD");
    const paid = await w.status({ t: b1.t, l: b1.l });
    assert.deepEqual([statusOf(paid), (paid.body as { fulfilment: unknown }).fulfilment], ["paid", { state: "confirmed", reservationId: b1.reservationId }]);
    assert.equal(w.cb.reservations.get(b1.reservationId)?.status, "confirmed", "confirmed in Cloudbeds through the drain");
    assert.deepEqual(await w.returnPage(b1.t), paid.body, "the return page");
    w.useEnv(BEAM_PRIMARY);
    assert.deepEqual(await w.status({ t: b1.t }), paid, "the Beam deployment's own answer");
    w.useEnv(TYPO_ENV);

    at = w.lines.length;
    const abandoned = await w.abandon({ t: b2.t, l: b2.l });
    assert.deepEqual([abandoned.status, abandoned.body], [200, { ok: true, state: "released" }]);
    assert.ok(w.lines.slice(at).some((l) => l.message === "[booking] config error: payment_misconfigured - missing: BOOKING_PAYMENT_PROVIDER"));
    assert.equal(w.beam.link(b2.id).status, "DISABLED");
    assert.equal(w.cb.reservations.get(b2.reservationId)?.status, "canceled");
    assert.equal(statusOf(await w.status({ t: b2.t, l: b2.l })), "cancelled");
    assert.equal(w.lines.filter((l) => l.message === "beam_drain_mode").length, 1, "once per process");

    // A Beam token of another Beam mode than the drain's: the config error.
    assert.deepEqual((await w.status({ t: handMadeToken("beam-live") })).body, NOT_CONFIGURED);
    assert.deepEqual((await w.abandon({ t: handMadeToken("beam-live") })).body, NOT_CONFIGURED);

    // The fallback gives every Beam call the route's (or the page's) 25-second deadline, as the normal path does: a
    // link read answered after it leaves no time for the charges, nor for the disable.
    w.faults.slowLinkReads = true;
    const linkRead = [`beam GET /api/v1/payment-links/${b3.id}`];
    let calls = w.order.length;
    assert.deepEqual(await w.status({ t: b3.t, l: b3.l }), { status: 502, cacheControl: "no-store", contentType: JSON_TYPE, body: COULD_NOT_CHECK_NOW });
    assert.deepEqual(w.order.slice(calls), linkRead, "the status route: the charges are never asked");
    calls = w.order.length;
    assert.deepEqual(await w.returnPage(b3.t), COULD_NOT_CHECK_NOW);
    assert.deepEqual(w.order.slice(calls), linkRead, "the return page");
    calls = w.order.length;
    const late = await w.abandon({ t: b3.t, l: b3.l });
    assert.deepEqual([late.status, (late.body as { error?: string }).error], [502, "upstream_error"]);
    assert.deepEqual(w.order.slice(calls), linkRead, "the abandon route: no disable after the deadline");
    assert.equal(w.beam.link(b3.id).status, "ACTIVE");
    w.faults.slowLinkReads = false;

    // The fallback keeps the routes' per-client limits (status 120 a minute, abandon 20 in 10 minutes).
    const statusIp = "192.0.2.10";
    for (let i = 0; i < 120; i++) assert.equal((await w.status({ t: b1.t }, statusIp)).status, 200, `status ${i + 1}`);
    assert.deepEqual(await w.status({ t: b1.t }, statusIp), { status: 429, cacheControl: "no-store", contentType: JSON_TYPE, body: { ok: false, error: "rate_limited", message: "Checking too often - please wait a moment." } });
    const abandonIp = "192.0.2.11";
    for (let i = 0; i < 20; i++) assert.equal((await w.abandon({ t: b2.t, l: b2.l }, JSON_TYPE, abandonIp)).status, 200, `abandon ${i + 1}`);
    const limited = await w.abandon({ t: b2.t, l: b2.l }, JSON_TYPE, abandonIp);
    assert.deepEqual([limited.status, limited.body], [429, { ok: false, error: "rate_limited", message: "Too many attempts - please wait a moment." }]);

    // The webhooks and the sweeper never depend on the active config: through the drains they still finish both
    // providers' payments after the typo (the Stripe booking is confirmed by its webhook, B3's lapsed hold released).
    w.stripe.complete(s1.id);
    const paidEvent = w.stripe.signedEvent("checkout.session.completed", s1.id);
    assert.deepEqual([(await w.stripeWebhook(paidEvent.payload, paidEvent.header)).status, w.cb.reservations.get(s1.reservationId)?.status], [200, "confirmed"]);
    w.setTime(NOW + ORPHAN_STALE_MS);
    const sweep = await w.sweep();
    assert.equal(sweep.status, 200, JSON.stringify(sweep.body));
    const runs = (sweep.body as { runs: { provider: string; mode: string; ok: boolean }[] }).runs;
    assert.deepEqual(runs.map((r) => [r.provider, r.mode, r.ok]), [["stripe", "stripe-test", true], ["beam", "beam-playground", true]]);
    assert.equal(w.cb.reservations.get(b3.reservationId)?.status, "canceled");
  });
});

test("the fallback is for typos only: a lock (live_payments_locked), a missing token secret, invalid_beam_base and a typo without Beam deps (a Beam-primary typo; Beam on Vercel without real writes) keep the config error for Beam bookings too, with nothing built", async (t) => {
  const cases: [string, Env, unknown, string][] = [
    [
      "a live Stripe key without the live conditions (locked), the Beam playground variables kept",
      { ...STRIPE_PRIMARY, ...BEAM_VARS, STRIPE_SECRET_KEY: "sk_live_routeenvs0123456789" },
      LOCKED,
      "live_payments_locked",
    ],
    ["no BOOKING_TOKEN_SECRET, the Beam playground variables kept", { ...STRIPE_PRIMARY, ...BEAM_VARS, BOOKING_TOKEN_SECRET: undefined }, NOT_CONFIGURED, "token_secret_missing"],
    ["invalid_beam_base (the legacy rule: no provider variable, an unknown base)", { ...BEAM_VARS, BEAM_API_BASE: "https://beam.invalid", BOOKING_TOKEN_SECRET: TOKEN_SECRET }, NOT_CONFIGURED, "invalid_beam_base"],
    [
      "a Beam-primary typo elsewhere (CLOUDBEDS_PROPERTY_ID not numeric): no Beam drain, the provider is beam",
      { ...BEAM_PRIMARY, CLOUDBEDS_API_KEY_BOOKING: "cbat_write_routeenvs", CLOUDBEDS_PROPERTY_ID: "not-a-number" },
      NOT_CONFIGURED,
      "payment_misconfigured",
    ],
    ["a provider typo on a Vercel preview: the Beam drain can't run there without real writes", { ...TYPO_ENV, VERCEL_ENV: "preview" }, NOT_CONFIGURED, "payment_misconfigured"],
    ["a provider typo with a weak BOOKING_TOKEN_SECRET: no Beam config can sign with it", { ...TYPO_ENV, BOOKING_TOKEN_SECRET: "short-secret" }, NOT_CONFIGURED, "payment_misconfigured"],
    ["a provider typo with the Beam base but neither Beam key", { ...TYPO_ENV, BEAM_MERCHANT_ID: undefined, BEAM_API_KEY: undefined }, NOT_CONFIGURED, "payment_misconfigured"],
    // Round 7: what getBeamDrainConfig also requires - BEAM_WEBHOOK_HMAC_KEY, and the live base only once LIVE_FULFILMENT_READY.beam is true.
    ["a provider typo with the Beam playground keys but no BEAM_WEBHOOK_HMAC_KEY (no Beam drain)", { ...TYPO_ENV, BEAM_WEBHOOK_HMAC_KEY: undefined }, NOT_CONFIGURED, "payment_misconfigured"],
    ["a provider typo with the live Beam base while LIVE_FULFILMENT_READY.beam is false (no Beam drain)", { ...TYPO_ENV, BEAM_API_BASE: BEAM_LIVE_BASE }, NOT_CONFIGURED, "payment_misconfigured"],
    ["a provider typo with the live Beam base and no BEAM_WEBHOOK_HMAC_KEY", { ...TYPO_ENV, BEAM_API_BASE: BEAM_LIVE_BASE, BEAM_WEBHOOK_HMAC_KEY: undefined }, NOT_CONFIGURED, "payment_misconfigured"],
    // Round 8: what the Beam-mode branch of the config requires of the Cloudbeds writes (no Beam drain without them).
    ["a provider typo with the booking key but no Redis", { ...TYPO_WRITES_ENV, UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined }, NOT_CONFIGURED, "payment_misconfigured"],
    ["a provider typo with the booking key and a CLOUDBEDS_PROPERTY_ID that is not numeric", { ...TYPO_WRITES_ENV, CLOUDBEDS_PROPERTY_ID: "23506x" }, NOT_CONFIGURED, "payment_misconfigured"],
    ["a provider typo with the booking key and BOOKING_DATA_SOURCE=demo", { ...TYPO_WRITES_ENV, BOOKING_DATA_SOURCE: "demo" }, NOT_CONFIGURED, "payment_misconfigured"],
    ["a provider typo on the production deployment without the booking key", { ...TYPO_ENV, VERCEL_ENV: "production" }, NOT_CONFIGURED, "payment_misconfigured"],
  ];
  await withWorlds(t, async (open) => {
    for (const [label, env, body, code] of cases) {
      const w = open(env);
      const beamToken = handMadeToken("beam-playground");
      const status = await w.status({ t: beamToken });
      const abandon = await w.abandon({ t: beamToken });
      for (const a of [status, abandon]) assert.deepEqual([a.status, a.cacheControl, a.body], [503, "no-store", body], label);
      // No Beam config could answer (a lock, no or a weak secret, no recognised base, no keys, no writes the Beam config
      // accepts): abandon keeps today's path and reads no body (round 8: also on a Vercel deployment without real writes).
      assert.equal(abandon.bodyUsed, false, label);
      assert.deepEqual(await w.returnPage(beamToken), COULD_NOT_CHECK, label);
      const lines = w.lines.map(lineText);
      assert.equal(lines.length, 2, `${label}: ${lines.join(" | ")}`);
      for (const l of lines) assert.match(l, new RegExp(`^error \\[booking\\] config error: ${code}`), label);
      assert.deepEqual(w.order, [], `${label}: no Beam or Stripe call`);
      assert.deepEqual(w.kv.writes, [], `${label}: nothing written`);
      // Round 7: with provider beam the Beam config is the one that threw (no Beam drain): no body read either (above).
      if (label.startsWith("a Beam-primary typo")) {
        const hook = await w.beamWebhook(unsignedBeam);
        assert.deepEqual([hook.status, hook.body, hook.bodyUsed], [503, "webhook not configured", false], `${label}: the Beam webhook (Beam retries)`);
      }
    }
  });
});

test("beamFallbackPossible asks what getBeamDrainConfig asks, from the variables alone (rounds 7 and 8): a typo error, a provider other than beam, a recognised base (the live one only with LIVE_FULFILMENT_READY.beam), both keys, BEAM_WEBHOOK_HMAC_KEY, a strong secret and the Cloudbeds writes the Beam config accepts", async () => {
  // routeFallback.ts imports runtime.ts (next/server): loaded once the resolve hook is in place.
  await loadRoutes();
  const { beamFallbackPossible } = await import("./routeFallback.ts");
  const errorOf = (env: Env): unknown => {
    try {
      getFulfilmentConfig(env);
    } catch (e) {
      return e;
    }
    return null;
  };
  assert.equal(LIVE_FULFILMENT_READY.beam, false);
  const cases: [string, Env, boolean][] = [
    ["the Beam playground drain variables", TYPO_ENV, true],
    ["no BEAM_WEBHOOK_HMAC_KEY", { ...TYPO_ENV, BEAM_WEBHOOK_HMAC_KEY: undefined }, false],
    ["a blank BEAM_WEBHOOK_HMAC_KEY", { ...TYPO_ENV, BEAM_WEBHOOK_HMAC_KEY: "  " }, false],
    ["the live base (the code switch is off)", { ...TYPO_ENV, BEAM_API_BASE: BEAM_LIVE_BASE }, false],
    ["no BEAM_MERCHANT_ID", { ...TYPO_ENV, BEAM_MERCHANT_ID: undefined }, false],
    ["no BEAM_API_KEY", { ...TYPO_ENV, BEAM_API_KEY: undefined }, false],
    ["an unknown base", { ...TYPO_ENV, BEAM_API_BASE: "https://beam.invalid" }, false],
    ["a weak BOOKING_TOKEN_SECRET", { ...TYPO_ENV, BOOKING_TOKEN_SECRET: "short-secret" }, false],
    ["provider beam with a typo elsewhere", { ...BEAM_PRIMARY, CLOUDBEDS_API_KEY_BOOKING: "cbat_write_routeenvs", CLOUDBEDS_PROPERTY_ID: "not-a-number" }, false],
    // Round 8: the Beam-mode branch's Cloudbeds writes.
    ["real writes: the booking key, a numeric property id, Redis, live Cloudbeds data", TYPO_WRITES_ENV, true],
    ["real writes on a Vercel preview", { ...TYPO_WRITES_ENV, VERCEL_ENV: "preview" }, true],
    ["the booking key without Redis", { ...TYPO_WRITES_ENV, UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined }, false],
    ["the booking key with Redis by its KV_REST_API names", { ...TYPO_WRITES_ENV, UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined, KV_REST_API_URL: "https://routeenvs-kv.upstash.io", KV_REST_API_TOKEN: "routeenvs-kv-token" }, true],
    ["the booking key with a CLOUDBEDS_PROPERTY_ID that is not numeric", { ...TYPO_WRITES_ENV, CLOUDBEDS_PROPERTY_ID: "23506x" }, false],
    ["the booking key without CLOUDBEDS_PROPERTY_ID", { ...TYPO_WRITES_ENV, CLOUDBEDS_PROPERTY_ID: undefined }, false],
    ["the booking key with BOOKING_DATA_SOURCE=demo", { ...TYPO_WRITES_ENV, BOOKING_DATA_SOURCE: "demo" }, false],
    ["no booking key on a Vercel preview", { ...TYPO_ENV, VERCEL_ENV: "preview" }, false],
    ["no booking key on the production deployment", { ...TYPO_ENV, VERCEL_ENV: "production" }, false],
    ["a blank booking key, locally (the simulated writer)", { ...TYPO_ENV, CLOUDBEDS_API_KEY_BOOKING: "  " }, true],
  ];
  for (const [label, env, possible] of cases) {
    const e = errorOf(env);
    assert.ok(e instanceof BookingConfigError && e.code === "payment_misconfigured", label);
    assert.equal(beamFallbackPossible(e, env), possible, label);
    // Round 8: exactly when the Beam drain builds a config (the live base aside: no beam-live drain before S7.1).
    assert.equal(getBeamDrainConfig(env) !== null, possible, `${label}: getBeamDrainConfig`);
  }
  // Never for an error that is not a typo, nor without one.
  assert.equal(beamFallbackPossible(new BookingConfigError("live_payments_locked", "locked"), TYPO_ENV), false);
  assert.equal(beamFallbackPossible(new Error("x"), TYPO_ENV), false);
  assert.equal(beamFallbackPossible(null, TYPO_ENV), false);
});

test("Beam deps that can't be built after a typo (a runtime store that throws): the config error, as before - the routes and the return page never throw", async (t) => {
  await withWorlds(t, async (open) => {
    const w = open(TYPO_ENV);
    Object.defineProperty(runtimeGlobals(), "memoryKv", {
      configurable: true,
      enumerable: true,
      get(): never {
        throw new Error("runtime global memoryKv unavailable (routeEnvs.test.ts)");
      },
    });
    const beamToken = handMadeToken("beam-playground");
    const status = await w.status({ t: beamToken });
    const abandon = await w.abandon({ t: beamToken });
    for (const a of [status, abandon]) assert.deepEqual([a.status, a.cacheControl, a.body], [503, "no-store", NOT_CONFIGURED]);
    assert.deepEqual(await w.returnPage(beamToken), COULD_NOT_CHECK);
    assert.deepEqual(w.order, [], "no Beam call");
    assert.deepEqual(
      w.lines.map(lineText).filter((l) => l !== "info beam_drain_mode"),
      Array(2).fill("error [booking] config error: payment_misconfigured - missing: BOOKING_PAYMENT_PROVIDER"),
    );
  });
});

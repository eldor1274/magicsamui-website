// Golden characterisation of the LIVE Stripe money path (Beam design step S0.1): the safety net every
// later refactor of checkout, fulfil, release, abandon, status and the sweeper must pass unchanged.
//
// About twenty deterministic scenarios run on kits built from STRIPE_TEST_ENV and STRIPE_LIVE_ENV (real
// SDK, real Cloudbeds writer, the in-repo fakes), and the real route handlers (checkout, status, abandon,
// sweep, Stripe webhook) run on the real runtime deps (runtime.ts): stripe-mock end to end, and the live
// environments - with and without Beam variables, drained, locked - on every path that needs no network.
// Each scenario is recorded step by step:
// - the answer (status and body);
// - the fake Cloudbeds calls with every param (note texts, payment descriptions, fee item ids and names);
// - the fake Stripe requests (params, metadata, line items, expires_at, the idempotency key);
// - the delivered alerts (subject, lines, severity), every KV write with its TTL, the log event names;
// - the fake Cloudbeds reservations as they end up.
// getBookingConfig / toPublicConfig of the Stripe environments are recorded too.
//
// Volatile ids are numbered in the order they first appear in a record (cs_test_1, res_1, pi_1, lock_1,
// ...); booking tokens become tok_N, with their decoded payload listed under "tokens".
//
// The snapshot (__golden__/stripe.json) must stay identical, byte for byte, through every refactor: a
// difference IS a change in how live money is handled. Normal runs only compare.
// UPDATE_GOLDEN=1 node --test src/lib/booking/stripeGolden.test.ts rewrites it - never to make a change pass.

import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";
import { runAbandon } from "./abandon.ts";
import { buildOffers } from "./availability.ts";
import { runCheckout } from "./checkout.ts";
import { MOCK_STRIPE_WEBHOOK_SECRET, getBookingConfig, getFulfilmentConfig, getStripeDrainConfig, toPublicConfig } from "./config.ts";
import type { Env } from "./config.ts";
import { addDays } from "./dates.ts";
import { demoInventory } from "./demoProvider.ts";
import { PAYMENT_DOUBT_COOLDOWN_MS, fulfilSession } from "./fulfil.ts";
import { createMemoryKv } from "./kv.ts";
import type { KvStore } from "./kv.ts";
import { keys, recordHold, recordIntent } from "./lock.ts";
import { createFakeCloudbeds } from "./mock/fakeCloudbeds.ts";
import type { FakeCloudbeds, FakeCloudbedsOptions } from "./mock/fakeCloudbeds.ts";
import { createFakeStripe, parseStripeForm, stripeSignatureHeader } from "./mock/fakeStripe.ts";
import type { FakeStripe } from "./mock/fakeStripe.ts";
import { runStatus } from "./status.ts";
import type { StripeDeps } from "./stripeDeps.ts";
import { handleStripeWebhook } from "./stripeWebhook.ts";
import { STALE_HOLD_MS, runSweep } from "./sweep.ts";
import { createBookingToken } from "./token.ts";
import { HONEYMOON, NOW, STRIPE_LIVE_ENV, STRIPE_TEST_ENV, TOKEN_SECRET, WEBHOOK_SECRET, makeKit, recordingKv, refCharSequence, request, sessionIdOf } from "./testkit.ts";
import type { Kit, KvWrite } from "./testkit.ts";
import type { BookingSummary, CartItemInput, CheckoutRequest, CheckoutSuccess } from "./types.ts";

const UPDATE = process.env.UPDATE_GOLDEN === "1";
const GOLDEN_URL = new URL("./__golden__/stripe.json", import.meta.url);

type Section = "configs" | "scenarios" | "routes";
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type GoldenFile = { [S in Section]: Record<string, Json> };

const GOLDEN: GoldenFile | null = existsSync(GOLDEN_URL) ? (JSON.parse(readFileSync(GOLDEN_URL, "utf8")) as GoldenFile) : null;
const registered: { section: Section; name: string }[] = [];
const produced: GoldenFile = { configs: {}, scenarios: {}, routes: {} };

/* ----------------------------- normalising ----------------------------- */

/**
 * Replaces what differs between runs with stable placeholders, numbered per record in the order of first
 * appearance. `refs`: booking refs and the Stripe idempotency keys derived from them too (the route
 * scenarios, where checkout draws refs and salts at random).
 */
class Normaliser {
  private readonly seen = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  readonly tokens: Record<string, Json> = {};
  private readonly refs: boolean;

  constructor(refs: boolean) {
    this.refs = refs;
  }

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

  /** A booking token: tok_N, its payload decoded (and normalised) under `tokens`. */
  private token(raw: string): string {
    const known = this.seen.get(raw);
    if (known !== undefined) return known;
    const placeholder = this.id(raw, "tok");
    let payload: unknown = null;
    try {
      payload = JSON.parse(Buffer.from(raw.split(".")[0], "base64url").toString("utf8"));
    } catch {
      payload = "(not JSON)";
    }
    this.tokens[placeholder] = this.value(payload);
    return placeholder;
  }

  text(s: string): string {
    if (/^[0-9a-f]{24}$/.test(s)) return this.id(s, "lock"); // lock owner tokens (lock.ts acquireLock)
    let out = s
      .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, (m) => this.token(m))
      .replace(/cs_(test|live)_fake_[0-9a-f]+/g, (m, mode: string) => this.id(m, `cs_${mode}`))
      .replace(/\b(pi|ch|evt|req)_fake_[0-9a-f]+/g, (m, kind: string) => this.id(m, kind))
      // The fake Cloudbeds numbers reservations from a random base (7000000000000 + randomInt(1e6)).
      .replace(/(?<!\d)70000\d{8}(?!\d)/g, (m) => this.id(m, "res"))
      .replace(/(?<![\w-])fake-\d+(?!\d)/g, (m) => this.id(m, "cbreq"))
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (m) => this.id(m, "uuid"));
    if (this.refs) {
      out = out
        .replace(/MSV-(\d{8})-[A-HJ-NP-Z2-9]{4}/g, (m, day: string) => `MSV-${day}-${this.id(m, "ref")}`)
        .replace(/msv-cs-[0-9a-f]{40}/g, (m) => this.id(m, "idem"));
    }
    return out;
  }

  value(v: unknown): Json {
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
    if (typeof v === "string") return this.text(v);
    if (Array.isArray(v)) return v.map((x) => (x === undefined || typeof x === "function" ? null : this.value(x)));
    if (v instanceof Map) return this.value(Object.fromEntries(v));
    if (v instanceof Error) return { error: v.name, message: this.text(v.message) };
    if (typeof v === "object") {
      const out: { [key: string]: Json } = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (x === undefined || typeof x === "function") continue;
        out[this.text(k)] = this.value(x);
      }
      return out;
    }
    return null;
  }
}

function normalise(record: unknown, refs: boolean): Json {
  const n = new Normaliser(refs);
  const body = n.value(record);
  const out = Object.keys(n.tokens).length > 0 && body !== null && typeof body === "object" && !Array.isArray(body) ? { ...body, tokens: n.tokens } : body;
  return JSON.parse(JSON.stringify(out)) as Json;
}

/** Registers one golden record: compared with the snapshot (or collected for it with UPDATE_GOLDEN=1). */
function golden(section: Section, name: string, run: (t: TestContext) => Promise<unknown>, options: { refs?: boolean } = {}): void {
  registered.push({ section, name });
  test(`golden ${section}: ${name}`, async (t) => {
    const record = normalise(await run(t), options.refs === true);
    if (UPDATE) {
      produced[section][name] = record;
      return;
    }
    const expected = GOLDEN?.[section]?.[name];
    assert.ok(expected !== undefined, `no golden record for ${section} "${name}" - run UPDATE_GOLDEN=1 node --test src/lib/booking/stripeGolden.test.ts once`);
    assert.deepStrictEqual(record, expected);
    // Same content is not enough: the snapshot is compared byte for byte (key order included).
    assert.equal(JSON.stringify(record), JSON.stringify(expected), "same content, different key order");
  });
}

/* ------------------------------- the tape ------------------------------- */

/** Splits what the sources recorded into steps: each step lists what its action did. */
class Tape {
  readonly steps: Record<string, unknown>[] = [];
  private readonly marks = new Map<string, number>();
  private readonly sources: Record<string, () => readonly unknown[]>;

  constructor(sources: Record<string, () => readonly unknown[]>) {
    this.sources = sources;
  }

  step(label: string, answer?: unknown): void {
    const entry: Record<string, unknown> = { step: label };
    if (answer !== undefined) entry.answer = answer;
    for (const [name, list] of Object.entries(this.sources)) {
      const all = list();
      const from = this.marks.get(name) ?? 0;
      if (all.length > from) entry[name] = all.slice(from);
      this.marks.set(name, all.length);
    }
    this.steps.push(entry);
  }

  /** Anything recorded after the last step (nothing, normally). */
  close(): Record<string, unknown>[] {
    const left = Object.entries(this.sources).some(([name, list]) => list().length > (this.marks.get(name) ?? 0));
    if (left) this.step("(after the last step)");
    return this.steps;
  }
}

/** One Stripe API request as the SDK sent it. */
interface StripeRequest {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  idempotencyKey: string | null;
  status: number;
}

/** Records every request the SDK sends to the fake (params and the Idempotency-Key header) and its HTTP status. */
function recordStripe(inner: typeof fetch, out: StripeRequest[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const entry: StripeRequest = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      ...(url.search ? { query: parseStripeForm(url.search.slice(1)) } : {}),
      ...(typeof init?.body === "string" && init.body !== "" ? { body: parseStripeForm(init.body) } : {}),
      idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
      status: 0,
    };
    out.push(entry);
    const res = await inner(input, init);
    entry.status = res.status;
    return res;
  }) as typeof fetch;
}

/* ------------------------------ kit scenarios ------------------------------ */

interface GoldenKit {
  kit: Kit;
  tape: Tape;
}

function goldenKit(env: Env = STRIPE_TEST_ENV, cb: FakeCloudbedsOptions = {}): GoldenKit {
  const now = { ms: NOW };
  const kv = recordingKv(createMemoryKv(() => now.ms));
  const stripe: StripeRequest[] = [];
  const kit = makeKit({ env, cb, kv, now, pickRefChar: refCharSequence(), stripeFetch: (inner) => recordStripe(inner, stripe) });
  const tape = new Tape({
    stripe: () => stripe,
    cloudbeds: () => kit.fakeCb.calls,
    kv: () => kv.writes,
    alerts: () => kit.alerts,
    logs: () => kit.logs.map((l) => l.message),
  });
  return { kit, tape };
}

function finish(g: GoldenKit): unknown {
  return { steps: g.tape.close(), reservations: [...g.kit.fakeCb.reservations.values()] };
}

interface Opened {
  sessionId: string;
  reservationId: string;
  ref: string;
  /** The booking token of the success_url. */
  t: string;
  linkToken: string | null;
}

/** The server's quote (asked with a wrong total), then the checkout at that price: two steps. */
async function quoteAndCheckout(g: GoldenKit, items: CartItemInput[] = HONEYMOON, extra: Partial<CheckoutRequest> = {}, label = "checkout") {
  const req = request(items, extra);
  const quoted = await runCheckout({ ...req, expectedTotalSatang: 1, expectedDueNowSatang: 1 }, g.kit.checkoutDeps());
  g.tape.step(`${label}: quote (a wrong total is sent)`, quoted);
  if (quoted.body.ok || quoted.body.error !== "price_changed" || !quoted.body.quote) throw new Error(`no quote: ${JSON.stringify(quoted.body)}`);
  const res = await runCheckout({ ...req, expectedTotalSatang: quoted.body.quote.totalSatang, expectedDueNowSatang: quoted.body.quote.dueNowSatang }, g.kit.checkoutDeps());
  g.tape.step(label, res);
  return res;
}

async function opened(g: GoldenKit, items: CartItemInput[] = HONEYMOON, extra: Partial<CheckoutRequest> = {}, label = "checkout"): Promise<Opened> {
  const res = await quoteAndCheckout(g, items, extra, label);
  const body = res.body as CheckoutSuccess;
  const sessionId = sessionIdOf(body);
  const session = g.kit.fakeStripe.session(sessionId);
  if (!session) throw new Error("no session");
  const t = new URL(session.success_url.replace("{CHECKOUT_SESSION_ID}", "x")).searchParams.get("t") ?? "";
  return { sessionId, reservationId: body.holdReservationId ?? "", ref: body.ref, t, linkToken: body.linkToken };
}

async function webhook(g: GoldenKit, type: string, sessionId: string, label = `webhook ${type}`): Promise<void> {
  const { payload, header } = g.kit.fakeStripe.signedEvent(type, sessionId);
  g.tape.step(label, await handleStripeWebhook(payload, header, g.kit.deps, { nowMs: g.kit.now.ms }));
}

async function status(g: GoldenKit, o: Opened, which: { s?: boolean; l?: boolean }, label: string): Promise<void> {
  const res = await runStatus(
    { t: o.t, p: null, l: which.l ? o.linkToken : null, s: which.s ? o.sessionId : null },
    { config: g.kit.config, stripe: g.kit.deps, nowMs: g.kit.now.ms, log: g.kit.deps.log },
  );
  g.tape.step(label, res);
}

async function abandon(g: GoldenKit, body: Record<string, unknown>, label: string): Promise<void> {
  g.tape.step(label, await runAbandon(body, { config: g.kit.config, stripe: g.kit.deps, nowMs: g.kit.now.ms, log: g.kit.deps.log }));
}

async function sweep(g: GoldenKit, label = "sweep"): Promise<void> {
  g.tape.step(label, await runSweep(g.kit.deps));
}

const GARDEN: CartItemInput[] = [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
const SUNRISE: CartItemInput[] = [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
/** A second Honeymoon stay (the unit is free on these dates too). */
const DECEMBER = { checkIn: "2027-12-10", checkOut: "2027-12-13" };

golden("scenarios", "checkout success (stripe-test): hold, price check, pending, note, session", async () => {
  const g = goldenKit();
  await quoteAndCheckout(g);
  return finish(g);
});

golden("scenarios", "stripe-live: checkout (sweeper-stale alert), webhook completed, status paid with the purchase", async () => {
  const g = goldenKit(STRIPE_LIVE_ENV);
  const o = await opened(g);
  g.kit.fakeStripe.complete(o.sessionId);
  await webhook(g, "checkout.session.completed", o.sessionId);
  await status(g, o, { s: true }, "status (session id)");
  return finish(g);
});

golden("scenarios", "price mismatch: Cloudbeds prices the hold above the quote", async () => {
  // 273 THB per night more than the quote's rooms: 409 price_changed, the hold cancelled with a note.
  const g = goldenKit(STRIPE_TEST_ENV, { pricer: ({ rooms, startDate }) => (rooms.length && startDate ? 27_300 : 0) });
  await quoteAndCheckout(g);
  return finish(g);
});

golden("scenarios", "ambiguous hold: postReservation's answer lost after Cloudbeds created it; the sweeper releases it by its intent", async () => {
  const g = goldenKit();
  g.kit.fakeCb.failNext("postReservation", "network_after");
  await quoteAndCheckout(g);
  g.kit.now.ms += STALE_HOLD_MS + 5 * 60_000;
  await sweep(g);
  return finish(g);
});

golden("scenarios", "hold refused: a non-availability refusal while the room is still free", async () => {
  const g = goldenKit();
  g.kit.fakeCb.failNext("postReservation", "rejected", "Invalid rate plan");
  await quoteAndCheckout(g);
  return finish(g);
});

golden("scenarios", "Stripe Session create fails: hold cancelled, owner alerted", async () => {
  const g = goldenKit();
  g.kit.fakeStripe.failNext(/^POST \/v1\/checkout\/sessions$/, 500, "Simulated Stripe outage");
  await quoteAndCheckout(g);
  return finish(g);
});

golden("scenarios", "crash after the hold, before the payment page", async () => {
  const g = goldenKit();
  // Any unexpected throw after the hold takes the crash path; a log call is the simplest place to throw it.
  const log = g.kit.deps.log;
  g.kit.deps.log = (message, data) => {
    log(message, data);
    if (message === "hold_created") throw new Error("simulated crash after the hold");
  };
  await quoteAndCheckout(g);
  return finish(g);
});

golden("scenarios", "crash after the payment page was created: session expired, hold cancelled", async () => {
  const g = goldenKit();
  const log = g.kit.deps.log;
  g.kit.deps.log = (message, data) => {
    log(message, data);
    if (message === "stripe_session_created") throw new Error("simulated crash after the session");
  };
  await quoteAndCheckout(g);
  return finish(g);
});

golden("scenarios", "checkout refusals before any hold: terms changed, test guard, open-holds brake", async () => {
  const g = goldenKit();
  const req = request(HONEYMOON);
  g.tape.step("terms version from an old page", await runCheckout({ ...req, termsVersion: "2020-01-01" }, g.kit.checkoutDeps()));
  g.tape.step(
    "test guard: not the test guest's email",
    await runCheckout({ ...req, guest: { ...req.guest, email: "someone@example.com" }, expectedTotalSatang: 2_835_000, expectedDueNowSatang: 2_835_000 }, g.kit.checkoutDeps()),
  );
  for (let i = 0; i < 8; i++) await g.kit.deps.kv.zadd(keys.holdIndex(), NOW - i * 60_000, `brake-${i}`);
  g.tape.step("8 open holds", await runCheckout({ ...req, expectedTotalSatang: 2_835_000, expectedDueNowSatang: 2_835_000 }, g.kit.checkoutDeps()));
  return finish(g);
});

golden("scenarios", "checkout refused: real Cloudbeds writes without a payment method", async () => {
  const g = goldenKit({ ...STRIPE_TEST_ENV, CLOUDBEDS_STRIPE_PAYMENT_METHOD: undefined });
  await quoteAndCheckout(g);
  return finish(g);
});

golden("scenarios", "webhook completed -> confirmed; replay changes nothing", async () => {
  const g = goldenKit();
  const o = await opened(g);
  g.kit.fakeStripe.complete(o.sessionId);
  const { payload, header } = g.kit.fakeStripe.signedEvent("checkout.session.completed", o.sessionId);
  g.tape.step("webhook checkout.session.completed", await handleStripeWebhook(payload, header, g.kit.deps, { nowMs: g.kit.now.ms }));
  g.tape.step("the same delivery again", await handleStripeWebhook(payload, header, g.kit.deps, { nowMs: g.kit.now.ms }));
  g.tape.step("fulfilSession once more", await fulfilSession(o.sessionId, g.kit.deps));
  return finish(g);
});

golden("scenarios", "webhook expired -> released", async () => {
  const g = goldenKit();
  const o = await opened(g);
  g.kit.now.ms += 31 * 60_000;
  g.kit.fakeStripe.expire(o.sessionId);
  await webhook(g, "checkout.session.expired", o.sessionId);
  return finish(g);
});

golden("scenarios", "delayed payment succeeds: completed unpaid, then async_payment_succeeded", async () => {
  const g = goldenKit();
  const o = await opened(g);
  g.kit.fakeStripe.completeDelayed(o.sessionId);
  await webhook(g, "checkout.session.completed", o.sessionId);
  await status(g, o, { s: true }, "status while processing");
  g.kit.now.ms += 60_000;
  g.kit.fakeStripe.asyncSucceed(o.sessionId);
  await webhook(g, "checkout.session.async_payment_succeeded", o.sessionId);
  return finish(g);
});

golden("scenarios", "delayed payment fails: async_payment_failed releases the hold", async () => {
  const g = goldenKit();
  const o = await opened(g);
  g.kit.fakeStripe.completeDelayed(o.sessionId);
  g.kit.fakeStripe.asyncFail(o.sessionId);
  await webhook(g, "checkout.session.async_payment_failed", o.sessionId);
  await status(g, o, { s: true }, "status after the failure");
  return finish(g);
});

golden("scenarios", "fulfil with the fee line failing every time: confirmed, owner told to check the fee", async () => {
  const g = goldenKit();
  const o = await opened(g);
  g.kit.fakeStripe.complete(o.sessionId);
  g.kit.fakeCb.failNext("postCustomItem", "http500");
  g.kit.fakeCb.failNext("postCustomItem", "http500");
  await webhook(g, "checkout.session.completed", o.sessionId);
  return finish(g);
});

golden("scenarios", "postPayment refused: webhook 500 with a CRITICAL alert, the retry confirms", async () => {
  const g = goldenKit();
  const o = await opened(g);
  g.kit.fakeStripe.complete(o.sessionId);
  g.kit.fakeCb.failNext("postPayment", "rejected", "Payment type not found");
  await webhook(g, "checkout.session.completed", o.sessionId);
  g.kit.now.ms += 60_000;
  await webhook(g, "checkout.session.completed", o.sessionId, "webhook retry");
  return finish(g);
});

golden("scenarios", "postPayment answer lost: the retry waits for the folio, never pays twice", async () => {
  const g = goldenKit();
  const o = await opened(g);
  g.kit.fakeStripe.complete(o.sessionId);
  g.kit.fakeCb.failNext("postPayment", "network_late");
  await webhook(g, "checkout.session.completed", o.sessionId);
  g.kit.now.ms += 3_000;
  await status(g, o, { s: true }, "return page 3 s later (payment in doubt)");
  g.tape.step("Cloudbeds commits the payment late", await g.kit.fakeCb.commitLate());
  g.kit.now.ms += PAYMENT_DOUBT_COOLDOWN_MS;
  await webhook(g, "checkout.session.completed", o.sessionId, "webhook retry after the cool-down");
  return finish(g);
});

golden("scenarios", "needs attention: the guest paid but the hold was cancelled in Cloudbeds", async () => {
  const g = goldenKit();
  const o = await opened(g);
  const r = g.kit.fakeCb.reservations.get(o.reservationId);
  if (r) r.status = "canceled"; // staff cancelled the unpaid hold by hand
  g.kit.fakeStripe.complete(o.sessionId);
  await webhook(g, "checkout.session.completed", o.sessionId);
  await status(g, o, { s: true }, "status");
  return finish(g);
});

golden("scenarios", "abandon: expire + release, status cancelled, repeat closed, a paid session is fulfilled instead", async () => {
  const g = goldenKit();
  const o = await opened(g);
  await abandon(g, { t: o.t, l: o.linkToken }, "abandon (link token)");
  await status(g, o, { s: true }, "status");
  await abandon(g, { t: o.t }, "abandon again (pointer)");
  await abandon(g, { t: "garbage" }, "abandon with a bad token");
  g.kit.now.ms += 60_000;
  const paid = await opened(g, HONEYMOON, DECEMBER, "second checkout");
  g.kit.fakeStripe.complete(paid.sessionId);
  await abandon(g, { t: paid.t, s: paid.sessionId }, "abandon a paid session");
  return finish(g);
});

golden("scenarios", "status: pending, paid (session id, link token, pointer), expired", async () => {
  const g = goldenKit();
  const o = await opened(g);
  await status(g, o, { s: true }, "status while open");
  g.kit.fakeStripe.complete(o.sessionId);
  await status(g, o, { s: true }, "status paid (session id)");
  await status(g, o, { l: true }, "status paid (link token)");
  await status(g, o, {}, "status paid (pointer)");
  g.kit.now.ms += 60_000;
  const late = await opened(g, GARDEN, {}, "second checkout");
  g.kit.now.ms += 31 * 60_000;
  await status(g, late, { s: true }, "status after the session expired");
  return finish(g);
});

golden("scenarios", "sweep: dropped paid webhook, expired, open, the paid index, an orphan by its intent, stale index entries", async () => {
  const g = goldenKit();
  // Created a minute apart: Stripe lists sessions newest first by creation time.
  const paid = await opened(g, HONEYMOON, {}, "checkout 1 (paid, its webhook never arrives)");
  g.kit.fakeStripe.complete(paid.sessionId);
  g.kit.now.ms += 60_000;
  await opened(g, GARDEN, {}, "checkout 2 (its session expires without a webhook)");
  g.kit.now.ms += 60_000;
  const open = await opened(g, SUNRISE, {}, "checkout 3 (still paying)");
  g.kit.now.ms += 60_000;
  const refused = await opened(g, HONEYMOON, DECEMBER, "checkout 4 (paid, Cloudbeds refuses the payment once)");
  g.kit.fakeStripe.complete(refused.sessionId);
  g.kit.fakeCb.failNext("postPayment", "rejected", "Payment type not found");
  await webhook(g, "checkout.session.completed", refused.sessionId);

  // An orphan: postReservation landed but nothing came back - only the intent written before it exists.
  await recordIntent(g.kit.deps.kv, { ref: "MSV-20261005-ABCD", identifier: "MSV-20261005-ABCD-TEST", mode: g.kit.config.paymentMode, createdAt: g.kit.now.ms, reservationId: null });
  const orphanGuest = { firstName: "A", lastName: "B", email: "a@b.co", phone: "+1 5555555", country: "US", zip: "1" };
  await g.kit.deps.writer.createHold({
    ref: "MSV-20261005-ABCD",
    identifier: "MSV-20261005-ABCD-TEST",
    checkIn: "2027-12-01",
    checkOut: "2027-12-02",
    rooms: [{ roomTypeId: "462961", rateId: null, adults: 2 }],
    guest: orphanGuest,
    estimatedArrivalTime: null,
    paymentMethod: "credit",
    expectedRoomsSatang: 0,
  });
  // A live deployment's hold on the same property (no -TEST tag): never touched by this test-mode sweeper.
  await g.kit.deps.writer.createHold({
    ref: "MSV-20261005-HQ2L",
    identifier: "MSV-20261005-HQ2L",
    checkIn: "2027-12-20",
    checkOut: "2027-12-21",
    rooms: [{ roomTypeId: "462960", rateId: null, adults: 2 }],
    guest: orphanGuest,
    estimatedArrivalTime: null,
    paymentMethod: "credit",
    expectedRoomsSatang: 0,
  });
  // Index entries it can't vouch for: a record that expired, and an old leftover of another mode.
  await g.kit.deps.kv.zadd(keys.holdIndex(), NOW - 31 * 24 * 3600_000, "expired-record");
  await recordHold(g.kit.deps.kv, { ref: "MSV-20260901-HQ3L", reservationId: "live-leftover", sessionId: null, createdAt: NOW - 8 * 24 * 3600_000, mode: "stripe-live" });
  g.tape.step("setup: orphan, live hold, stale index entries");

  const s = g.kit.fakeStripe.session(open.sessionId);
  if (s) s.expires_at += 3600; // checkout 3 stays open; checkout 2's session lapses by itself (31 minutes)
  g.kit.now.ms += STALE_HOLD_MS + 5 * 60_000;
  await sweep(g, "sweep");
  await sweep(g, "sweep again (nothing left to do)");
  return finish(g);
});

golden("scenarios", "webhook: bad signatures (alert on the third), ignored event, not ours, other mode", async () => {
  const g = goldenKit();
  const o = await opened(g);
  const { payload } = g.kit.fakeStripe.signedEvent("checkout.session.completed", o.sessionId);
  for (const [i, header] of [null, "t=1,v1=bad", `t=${Math.floor(NOW / 1000)},v1=${"0".repeat(64)}`].entries()) {
    g.tape.step(`bad signature ${i + 1}`, await handleStripeWebhook(payload, header, g.kit.deps, { nowMs: g.kit.now.ms }));
  }
  const nowS = Math.floor(g.kit.now.ms / 1000);
  const event = (type: string, object: Record<string, unknown>, livemode = false) =>
    JSON.stringify({ id: "evt_golden_0001", object: "event", api_version: "2026-09-30.endive", created: nowS, type, livemode, pending_webhooks: 1, request: { id: null, idempotency_key: null }, data: { object } });
  const send = async (label: string, body: string) => g.tape.step(label, await handleStripeWebhook(body, stripeSignatureHeader(body, WEBHOOK_SECRET, nowS), g.kit.deps, { nowMs: g.kit.now.ms }));
  await send("an event type we don't handle", event("payment_intent.succeeded", { id: "pi_golden", object: "payment_intent" }));
  await send("a session that is not ours (no metadata)", event("checkout.session.completed", { id: "cs_test_golden0000000000", object: "checkout.session", metadata: {}, client_reference_id: null, payment_status: "paid", status: "complete" }));
  const ours = g.kit.fakeStripe.session(o.sessionId);
  await send("our session, but a live-mode event", event("checkout.session.completed", { ...ours, line_items_input: undefined, payment_intent_metadata: undefined }, true));
  return finish(g);
});

/* -------------------------------- configs -------------------------------- */

const MOCK_ENV: Env = { BOOKING_PAYMENT_PROVIDER: "stripe", BOOKING_STRIPE_MOCK: "true" };
const SWEEP_SECRET = "sweep-secret-testkit-0123456789";
/** Beam variables a Stripe deployment may carry once the Beam work lands (none is a real credential). */
const BEAM_LIVE_VARS: Env = {
  BEAM_API_BASE: "https://api.beamcheckout.com",
  BEAM_MERCHANT_ID: "golden-merchant",
  BEAM_API_KEY: "golden-beam-key-0123456789",
  BEAM_WEBHOOK_HMAC_KEY: Buffer.from("golden-beam-hmac-key-0123456789!").toString("base64"),
};
const BEAM_PLAYGROUND_VARS: Env = { ...BEAM_LIVE_VARS, BEAM_API_BASE: "https://playground.api.beamcheckout.com" };

/** The value, or what was thrown (a locked or invalid config is part of the record). */
function attempt(fn: () => unknown): unknown {
  try {
    return fn();
  } catch (e) {
    const err = e as { name?: string; code?: string; message?: string; missing?: string[] };
    return { thrown: { name: err.name ?? null, code: err.code ?? null, message: err.message ?? String(e), missing: err.missing ?? null } };
  }
}

for (const [name, env] of [
  ["stripe-test", STRIPE_TEST_ENV],
  ["stripe-live", STRIPE_LIVE_ENV],
  ["stripe-mock", MOCK_ENV],
] as const) {
  golden("configs", name, async () => {
    const config = getBookingConfig(env);
    return { bookingConfig: config, publicConfig: toPublicConfig(config, env) };
  });
}

golden("configs", "stripe-live emergency stop (BOOKING_ALLOW_LIVE_PAYMENTS=false): checkout locked, fulfilment unlocked", async () => {
  const env = { ...STRIPE_LIVE_ENV, BOOKING_ALLOW_LIVE_PAYMENTS: "false" };
  return { bookingConfig: attempt(() => getBookingConfig(env)), fulfilmentConfig: attempt(() => getFulfilmentConfig(env)) };
});

golden("configs", "drain: provider beam (playground) with the Stripe live credentials kept", async () => {
  const env = { ...STRIPE_LIVE_ENV, ...BEAM_PLAYGROUND_VARS, BOOKING_PAYMENT_PROVIDER: "beam" };
  return { fulfilmentMode: attempt(() => getFulfilmentConfig(env).paymentMode), drainConfig: attempt(() => getStripeDrainConfig(env)) };
});

/* --------------------------------- routes --------------------------------- */

// The route handlers import "@/..." paths and runtime.ts imports "next/server", which plain Node can't
// resolve: a resolve hook maps them (to the same module URLs the relative imports use, so every module
// is loaded once). The routes then run on the real runtime deps, with runtime.ts's process globals
// seeded (stripe-mock world, Redis store) and global fetch blocked, so nothing leaves the process.

type ResolveHook = (
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context?: unknown) => { url: string },
) => { url: string; shortCircuit?: boolean };

let hooked = false;

function hookModules(): void {
  if (hooked) return;
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

async function loadRoutes() {
  hookModules();
  return {
    checkout: await import("../../app/api/booking/checkout/route.ts"),
    status: await import("../../app/api/booking/status/route.ts"),
    abandon: await import("../../app/api/booking/abandon/route.ts"),
    sweep: await import("../../app/api/booking/sweep/route.ts"),
    webhook: await import("../../app/api/stripe/webhook/route.ts"),
    runtime: await import("./runtime.ts"),
    NextRequest: (await import("next/server")).NextRequest,
  };
}

/** runtime.ts's process-wide state (globalThis.__msvBookingRuntime), seeded per route scenario. */
interface RuntimeGlobals {
  mock?: { stripe: FakeStripe; cloudbeds: FakeCloudbeds; kv: KvStore };
  memoryKv?: KvStore;
  mockWriterCloudbeds?: FakeCloudbeds;
  redisKv?: { url: string; kv: KvStore };
  warnedMemory?: boolean;
  warnedDrain?: boolean;
}

function runtimeGlobals(): RuntimeGlobals {
  const g = globalThis as typeof globalThis & { __msvBookingRuntime?: RuntimeGlobals };
  return (g.__msvBookingRuntime ??= {});
}

interface RouteWorld {
  routes: Awaited<ReturnType<typeof loadRoutes>>;
  tape: Tape;
  /** The stripe-mock world's fakes (null outside stripe-mock). */
  stripe: FakeStripe | null;
  kv: (KvStore & { writes: KvWrite[] }) | null;
}

/** A route answer: status, the cache and type headers, and the body (parsed when JSON). */
async function answer(res: Response): Promise<unknown> {
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // plain text answer (the webhook)
  }
  return { status: res.status, cacheControl: res.headers.get("cache-control"), contentType: res.headers.get("content-type"), body };
}

/** "info hold_created", "info alert_warning: <subject>", or the line itself (config errors and warnings). */
function consoleLine(level: string, args: unknown[]): string {
  const first = typeof args[0] === "string" ? args[0] : JSON.stringify(args[0]);
  const m = /^\[booking\] (\S+)$/.exec(first);
  if (!m) return `${level} ${first}`;
  let subject = "";
  if (m[1].startsWith("alert_") && typeof args[1] === "string") {
    try {
      subject = `: ${(JSON.parse(args[1]) as { subject?: string }).subject ?? ""}`;
    } catch {
      // no data
    }
  }
  return `${level} ${m[1]}${subject}`;
}

/**
 * Runs `fn` with process.env = `env`, Date frozen at NOW (moved with t.mock.timers.setTime), global fetch
 * blocked and recorded, console lines recorded, and runtime.ts's globals seeded: the stripe-mock world
 * (`mock`), or an in-memory store for the env's Redis URL and the memory store.
 */
async function routeScenario(t: TestContext, env: Env, fn: (w: RouteWorld) => Promise<void>): Promise<unknown> {
  const savedEnv = process.env;
  const savedFetch = globalThis.fetch;
  const lines: string[] = [];
  const network: { method: string; url: string }[] = [];
  const rt = runtimeGlobals();
  const savedGlobals = { ...rt };
  try {
    process.env = { ...env } as NodeJS.ProcessEnv;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      network.push({ method: (init?.method ?? "GET").toUpperCase(), url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url });
      throw new TypeError("network blocked by stripeGolden.test.ts");
    }) as typeof fetch;
    // Loaded (once) under the test env, before the console is captured: module loading may warn once per process.
    const routes = await loadRoutes();
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    for (const level of ["info", "warn", "error"] as const) t.mock.method(console, level, (...args: unknown[]) => void lines.push(consoleLine(level, args)));
    for (const key of Object.keys(rt) as (keyof RuntimeGlobals)[]) delete rt[key];

    const stripeLog: StripeRequest[] = [];
    let cloudbeds: FakeCloudbeds | null = null;
    const world: RouteWorld = {
      routes,
      tape: new Tape({
        stripe: () => stripeLog,
        cloudbeds: () => cloudbeds?.calls ?? [],
        kv: () => world.kv?.writes ?? [],
        logs: () => lines,
        network: () => network,
      }),
      stripe: null,
      kv: null,
    };
    if (env.BOOKING_STRIPE_MOCK === "true") {
      // Like runtime.ts mockWorld, on the frozen clock: the routes' own Stripe client, writer and store use these.
      const fake = createFakeStripe({ webhookSecret: MOCK_STRIPE_WEBHOOK_SECRET, now: () => Date.now() });
      cloudbeds = createFakeCloudbeds({ lenient: true, now: () => Date.now() });
      world.stripe = fake;
      world.kv = recordingKv(createMemoryKv(() => Date.now()));
      rt.mock = { stripe: { ...fake, fetch: recordStripe(fake.fetch, stripeLog) }, cloudbeds, kv: world.kv };
    }
    await fn(world);
    return { steps: world.tape.close(), reservations: cloudbeds ? [...cloudbeds.reservations.values()] : [] };
  } finally {
    for (const key of Object.keys(rt) as (keyof RuntimeGlobals)[]) delete rt[key];
    Object.assign(rt, savedGlobals);
    process.env = savedEnv;
    globalThis.fetch = savedFetch;
  }
}

/** What the routes' runtime deps are made of (no secrets): the mode, the store, the writer, the Stripe client. */
function describeDeps(d: StripeDeps | null): unknown {
  if (!d) return null;
  return {
    paymentMode: d.config.paymentMode,
    kv: d.kv.kind,
    writer: d.writer.mode,
    restrictions: d.restrictions !== undefined,
    stripe: { livemode: d.config.stripe?.livemode ?? null, mock: d.config.stripe?.mock ?? null, webhookSecretSet: Boolean(d.config.stripe?.webhookSecret) },
  };
}

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
    totalSatang: 2_835_000,
    cardFeeSatang: 135_000,
    dueNowSatang: 2_835_000,
    createdAt: new Date(NOW).toISOString(),
    linkExpiresAt: new Date(NOW + 30 * 60_000).toISOString(),
  } as BookingSummary;
}

/** The first 3-night window from Jan 2027 where the demo calendar (stripe-mock data) has `slug` free. */
function demoWindow(slug: string, from = "2027-01-04"): { checkIn: string; checkOut: string } {
  for (let i = 0; i < 300; i++) {
    const checkIn = addDays(from, i);
    const checkOut = addDays(checkIn, 3);
    if (buildOffers(demoInventory(checkIn, checkOut), 2).find((o) => o.slug === slug)?.available) return { checkIn, checkOut };
  }
  throw new Error(`no demo window for ${slug}`);
}

golden(
  "routes",
  "stripe-mock end to end: checkout, status, abandon, webhook, sweep (real runtime deps)",
  (t) =>
    routeScenario(t, { ...MOCK_ENV, BOOKING_TOKEN_SECRET: TOKEN_SECRET, BOOKING_SWEEP_SECRET: SWEEP_SECRET }, async (w) => {
      const { routes, tape } = w;
      const fake = w.stripe;
      if (!fake) throw new Error("no mock world");
      const ip = "203.0.113.10";
      const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
        new Request(`http://localhost:3000${path}`, {
          method: "POST",
          headers: { host: "localhost:3000", "x-forwarded-for": ip, "content-type": "application/json", ...headers },
          body: typeof body === "string" ? body : JSON.stringify(body),
        });
      const get = (path: string, headers: Record<string, string> = {}) =>
        new routes.NextRequest(`http://localhost:3000${path}`, { headers: { host: "localhost:3000", "x-forwarded-for": ip, ...headers } });

      const book = async (items: CartItemInput[], label: string) => {
        const req = request(items, demoWindow(items[0].slug));
        const quoted = await routes.checkout.POST(post("/api/booking/checkout", { ...req, expectedTotalSatang: 1, expectedDueNowSatang: 1 }));
        const q = (await answer(quoted)) as { body: { quote: { totalSatang: number; dueNowSatang: number } } };
        tape.step(`${label}: quote (a wrong total is sent)`, q);
        const res = await answer(await routes.checkout.POST(post("/api/booking/checkout", { ...req, expectedTotalSatang: q.body.quote.totalSatang, expectedDueNowSatang: q.body.quote.dueNowSatang })));
        tape.step(label, res);
        const body = (res as { body: CheckoutSuccess }).body;
        const sessionId = new URL(body.redirectUrl).searchParams.get("session_id") ?? "";
        const session = fake.session(sessionId);
        const tok = new URL((session?.success_url ?? "").replace("{CHECKOUT_SESSION_ID}", "x")).searchParams.get("t") ?? "";
        return { sessionId, t: tok, l: body.linkToken ?? "" };
      };
      const statusOf = async (label: string, q: Record<string, string>) =>
        tape.step(label, await answer(await routes.status.GET(get(`/api/booking/status?${new URLSearchParams(q).toString()}`))));
      const sweepWith = async (label: string, auth: string | null) =>
        tape.step(label, await answer(await routes.sweep.GET(new Request("http://localhost:3000/api/booking/sweep", { headers: auth ? { authorization: auth } : {} }))));

      // 1. Abandoned on the payment page.
      const a = await book(HONEYMOON, "checkout 1");
      await statusOf("status 1 (open)", { t: a.t, session_id: a.sessionId });
      tape.step("abandon 1", await answer(await routes.abandon.POST(post("/api/booking/abandon", { t: a.t, l: a.l }))));
      await statusOf("status 1 (cancelled)", { t: a.t, session_id: a.sessionId });

      // 2. Paid: the webhook confirms it; the return page finds it by session id, link token or pointer.
      t.mock.timers.setTime(NOW + 60_000);
      const b = await book(GARDEN, "checkout 2");
      fake.complete(b.sessionId);
      const event = fake.signedEvent("checkout.session.completed", b.sessionId);
      tape.step("webhook 2 (completed)", await answer(await routes.webhook.POST(post("/api/stripe/webhook", event.payload, { "stripe-signature": event.header }))));
      tape.step("webhook with a bad signature", await answer(await routes.webhook.POST(post("/api/stripe/webhook", event.payload, { "stripe-signature": "t=1,v1=bad" }))));
      await statusOf("status 2 (session id)", { t: b.t, session_id: b.sessionId });
      await statusOf("status 2 (link token)", { t: b.t, l: b.l });
      await statusOf("status 2 (pointer)", { t: b.t });

      // 3. Its session expires without a webhook: the sweeper releases it.
      t.mock.timers.setTime(NOW + 2 * 60_000);
      const c = await book(SUNRISE, "checkout 3");
      fake.expire(c.sessionId);
      t.mock.timers.setTime(NOW + 2 * 60_000 + STALE_HOLD_MS + 5 * 60_000);
      await sweepWith("sweep without the secret", null);
      await sweepWith("sweep with a wrong secret", "Bearer wrong-secret-0123456789abcdef");
      await sweepWith("sweep", `Bearer ${SWEEP_SECRET}`);
      await statusOf("status 3 (expired)", { t: c.t, session_id: c.sessionId });
    }),
  { refs: true },
);

/**
 * Live environments on every route path that needs no network (the live Stripe SDK talks over node:https,
 * and Cloudbeds and Upstash are blocked here): config errors, bad tokens, a booking with no session yet,
 * the webhook's signature check and its "ignored"/"not ours" answers, the sweeper's auth. With and without
 * Beam variables, emergency-stopped, drained to Beam, locked, misconfigured.
 */
const LIVE_ROUTE_ENVS: [string, Env][] = [
  ["stripe-live", STRIPE_LIVE_ENV],
  ["stripe-live with valid Beam live variables", { ...STRIPE_LIVE_ENV, ...BEAM_LIVE_VARS }],
  ["stripe-live with invalid Beam variables", { ...STRIPE_LIVE_ENV, BEAM_API_BASE: "https://beam.invalid", BEAM_MERCHANT_ID: "x", BEAM_API_KEY: "y", BEAM_WEBHOOK_HMAC_KEY: "short" }],
  ["stripe-live emergency stop", { ...STRIPE_LIVE_ENV, BOOKING_ALLOW_LIVE_PAYMENTS: "false" }],
  ["drain: provider beam (playground), Stripe live credentials kept", { ...STRIPE_LIVE_ENV, ...BEAM_PLAYGROUND_VARS, BOOKING_PAYMENT_PROVIDER: "beam" }],
  ["provider beam live (locked in code), Stripe live credentials kept", { ...STRIPE_LIVE_ENV, ...BEAM_LIVE_VARS, BOOKING_PAYMENT_PROVIDER: "beam" }],
  ["stripe-live without a sweep secret (locked)", { ...STRIPE_LIVE_ENV, BOOKING_SWEEP_SECRET: undefined }],
  ["stripe-test, mock writer, no Redis", { BOOKING_PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: STRIPE_TEST_ENV.STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, BOOKING_TOKEN_SECRET: TOKEN_SECRET, CLOUDBEDS_STRIPE_PAYMENT_METHOD: "Stripe(website)", BOOKING_SWEEP_SECRET: SWEEP_SECRET }],
];

for (const [index, [name, env]] of LIVE_ROUTE_ENVS.entries()) {
  golden("routes", name, (t) =>
    routeScenario(t, env, async (w) => {
      const { routes, tape } = w;
      const rt = runtimeGlobals();
      // The deps the routes build (status and abandon; the webhook and the sweeper), before the stores are
      // swapped for a recorded in-memory one. Building them sends nothing.
      let statusDeps: unknown;
      try {
        statusDeps = describeDeps(routes.runtime.getStripeDeps(getFulfilmentConfig(env)));
      } catch (e) {
        statusDeps = { thrown: (e as { code?: string }).code ?? String(e) };
      }
      tape.step("runtime deps", { "getStripeDeps(getFulfilmentConfig())": statusDeps, "getStripeFulfilmentDeps()": describeDeps(routes.runtime.getStripeFulfilmentDeps(env)) });
      for (const key of ["redisKv", "memoryKv", "warnedMemory", "warnedDrain"] as const) delete rt[key];
      const kv = recordingKv(createMemoryKv(() => Date.now()));
      if (env.UPSTASH_REDIS_REST_URL) rt.redisKv = { url: env.UPSTASH_REDIS_REST_URL, kv };
      else rt.memoryKv = kv;
      w.kv = kv;

      const headers = { "x-forwarded-for": `203.0.113.${100 + index}` };
      const liveToken = createBookingToken(bookingFor("stripe-live"), null, TOKEN_SECRET, 48 * 3600, NOW);
      const testToken = createBookingToken(bookingFor("stripe-test", "MSV-20261005-GQ7M"), null, TOKEN_SECRET, 48 * 3600, NOW);
      const statusCall = async (label: string, token: string) =>
        tape.step(label, await answer(await routes.status.GET(new routes.NextRequest(`http://localhost:3000/api/booking/status?t=${encodeURIComponent(token)}`, { headers }))));
      const abandonCall = async (label: string, body: string, type = "application/json") =>
        tape.step(label, await answer(await routes.abandon.POST(new Request("http://localhost:3000/api/booking/abandon", { method: "POST", headers: { ...headers, "content-type": type }, body }))));
      const nowS = Math.floor(NOW / 1000);
      const hook = async (label: string, body: string, signature: string | null) =>
        tape.step(label, await answer(await routes.webhook.POST(new Request("http://localhost:3000/api/stripe/webhook", { method: "POST", headers: signature ? { "stripe-signature": signature } : {}, body }))));
      const event = (type: string, object: Record<string, unknown>) =>
        JSON.stringify({ id: "evt_golden_0002", object: "event", api_version: "2026-09-30.endive", created: nowS, type, livemode: true, pending_webhooks: 1, request: { id: null, idempotency_key: null }, data: { object } });
      const signed = (body: string) => stripeSignatureHeader(body, env.STRIPE_WEBHOOK_SECRET ?? WEBHOOK_SECRET, nowS);

      await statusCall("status: bad token", "garbage");
      await statusCall("status: a stripe-live booking with no session recorded yet", liveToken);
      await statusCall("status: a stripe-test booking", testToken);
      await abandonCall("abandon: a stripe-live booking with no session recorded yet", JSON.stringify({ t: liveToken }));
      await abandonCall("abandon: not JSON", "t=1", "text/plain");
      await hook("webhook: no signature", event("checkout.session.completed", {}), null);
      const ignored = event("payment_intent.succeeded", { id: "pi_golden", object: "payment_intent" });
      await hook("webhook: an event type we don't handle", ignored, signed(ignored));
      const notOurs = event("checkout.session.completed", { id: "cs_live_golden0000000000", object: "checkout.session", metadata: {}, client_reference_id: null, payment_status: "paid", status: "complete", livemode: true });
      await hook("webhook: a session that is not ours", notOurs, signed(notOurs));
      for (const [label, auth] of [["sweep: no secret sent", null], ["sweep: a wrong secret", "Bearer wrong-secret-0123456789abcdef"]] as const) {
        tape.step(label, await answer(await routes.sweep.GET(new Request("http://localhost:3000/api/booking/sweep", { headers: auth ? { authorization: auth } : {} }))));
      }
    }),
  );
}

/* ------------------------------ the snapshot ------------------------------ */

/** The snapshot's layout: nested down to each step's fields, then one line per call, write, alert, answer field or note. */
function layout(v: Json, depth = 0, indent = ""): string {
  if (v === null || typeof v !== "object" || depth >= 6) return JSON.stringify(v);
  const inner = `${indent}  `;
  if (Array.isArray(v)) return v.length === 0 ? "[]" : `[\n${v.map((x) => inner + layout(x, depth + 1, inner)).join(",\n")}\n${indent}]`;
  const entries = Object.entries(v);
  return entries.length === 0 ? "{}" : `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${layout(x, depth + 1, inner)}`).join(",\n")}\n${indent}}`;
}

test("golden: the snapshot holds exactly the registered records", () => {
  if (UPDATE) {
    const missing = registered.filter((r) => !(r.name in produced[r.section]));
    assert.deepEqual(missing, [], "every golden test must pass before the snapshot is written (run the whole file)");
    mkdirSync(new URL("./__golden__/", import.meta.url), { recursive: true });
    const file = { about: "Golden snapshot of the live Stripe path - see stripeGolden.test.ts. Written only with UPDATE_GOLDEN=1; never edit it by hand.", ...produced };
    writeFileSync(GOLDEN_URL, `${layout(file)}\n`);
    return;
  }
  assert.ok(GOLDEN, "no snapshot: run UPDATE_GOLDEN=1 node --test src/lib/booking/stripeGolden.test.ts once");
  for (const section of ["configs", "scenarios", "routes"] as const) {
    assert.deepEqual(Object.keys(GOLDEN[section] ?? {}), registered.filter((r) => r.section === section).map((r) => r.name), `${section}: records in the snapshot`);
  }
});

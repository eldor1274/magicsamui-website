// Beam design steps S3.1 and S3.4, the logging promises (round-3 triage): an unreadable Beam switch or number gives ONE
// config_warning per variable and process, by NAME only - never the value; Stripe and the demo never read the Beam
// options, so they never warn about them; and a page render on any other deployment logs nothing new.
//
// configWarning (config.ts) deduplicates per variable name per process, and `node --test src/lib/booking` runs every test
// file in ONE process (index.js), where other files warn first. So each test here loads its own instance of config.ts
// (freshConfig: a new module URL, whose warning set starts empty) and is independent of every other test and file: the
// Stripe and demo calls (nothing may be logged); one Beam config (one line per variable), then the same and other Beam
// calls again on that instance (no new line); a locked Beam page on its own.

import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { BEAM_LIVE_BASE, BEAM_PLAYGROUND_BASE } from "./config.ts";
import type { Env } from "./config.ts";
import { STRIPE_LIVE_ENV, STRIPE_TEST_ENV, TOKEN_SECRET } from "./testkit.ts";

type ConfigModule = typeof import("./config.ts");
let instances = 0;
/** A new instance of config.ts (its own module URL): nothing has been warned about in it yet. */
async function freshConfig(): Promise<ConfigModule> {
  instances++;
  return (await import(`${new URL("./config.ts", import.meta.url).href}?warnings=${instances}`)) as ConfigModule;
}

/** Unreadable values for every Beam option that can warn, and the card fee Beam warns about (the triage's set, plus two). */
const GARBAGE: Env = {
  BEAM_EWALLETS: "maybe",
  BEAM_PROMPTPAY: "?",
  BEAM_PENDING_GRACE_MINUTES: "abc",
  BEAM_LATE_WATCH_DAYS: "1.5",
  BEAM_WECHAT_PAY: "soon",
  BOOKING_CARD_FEE_PCT: "7",
};
const KEYS: Env = { BEAM_MERCHANT_ID: "m", BEAM_API_KEY: "k" };
const HMAC: Env = { BEAM_WEBHOOK_HMAC_KEY: Buffer.from("test-only-beam-hmac-key-01234567").toString("base64") };
const BEAM_PG: Env = { BOOKING_PAYMENT_PROVIDER: "beam", BEAM_API_BASE: BEAM_PLAYGROUND_BASE, ...KEYS, BOOKING_TOKEN_SECRET: TOKEN_SECRET };
/** beam-live with the writes and every other condition: locked in code (LIVE_FULFILMENT_READY.beam is false). */
const BEAM_LIVE_LOCKED: Env = {
  ...STRIPE_LIVE_ENV,
  ...BEAM_PG,
  ...HMAC,
  BEAM_API_BASE: BEAM_LIVE_BASE,
  CLOUDBEDS_SEND_STATUS_EMAIL: "true",
};

/** Every config entry point a request, a page render or the layout calls; a locked one throws (caught). */
function callEverything(config: ConfigModule, env: Env): void {
  const calls: (() => unknown)[] = [
    () => config.getBookingConfig(env),
    () => config.toPublicConfig(config.getBookingConfig(env), env),
    () => config.getPublicBookingConfig(env),
    () => config.getInventoryConfig(env),
    () => config.getFulfilmentConfig(env),
    () => config.getStripeDrainConfig(env),
    () => config.finishesLiveStripePayments(env),
    () => config.finishesLivePayments(env),
    () => config.resolveBookingEngine(env),
  ];
  for (const call of calls) {
    try {
      call();
    } catch {
      // A locked or misconfigured config: what matters is what it logged.
    }
  }
}

/** console.warn captured for this test: each call as one string. */
function captureWarnings(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => void lines.push(args.map(String).join(" ")));
  return lines;
}

/** The line configWarning prints. */
const line = (name: string, reason: string) => `[booking] config_warning ${JSON.stringify({ name, reason })}`;

/** What a Beam config logs for GARBAGE's Beam options, in the order beamOptionsOf reads them. */
const OPTION_LINES = [
  line("BEAM_PROMPTPAY", "not on/off: treated as on"),
  line("BEAM_EWALLETS", "not on/off: treated as on"),
  line("BEAM_WECHAT_PAY", "not on/off: treated as off"),
  line("BEAM_PENDING_GRACE_MINUTES", "not a number: 20 is used"),
  line("BEAM_LATE_WATCH_DAYS", "not a whole number from 3 to 30: 3 is used"),
];

test("Stripe and the demo never warn about the Beam options (nor the card fee): no config_warning for garbage BEAM_* values, on any entry point", async (t) => {
  const config = await freshConfig();
  const warnings = captureWarnings(t);
  const envs: [string, Env][] = [
    ["stripe-test", STRIPE_TEST_ENV],
    ["stripe-live", STRIPE_LIVE_ENV],
    ["stripe-live, emergency stop (locked)", { ...STRIPE_LIVE_ENV, BOOKING_ALLOW_LIVE_PAYMENTS: "false" }],
    ["stripe without a key (locked)", { BOOKING_PAYMENT_PROVIDER: "stripe" }],
    ["stripe-mock", { BOOKING_PAYMENT_PROVIDER: "stripe", BOOKING_STRIPE_MOCK: "true" }],
    ["the demo", {}],
    ["the demo with Cloudbeds rates", { CLOUDBEDS_API_KEY: "k" }],
    ["BOOKING_PAYMENT_PROVIDER=beam without keys, locally (the demo)", { BOOKING_PAYMENT_PROVIDER: "beam" }],
    ["the legacy BEAM_API_BASE rule without keys (the demo)", { BEAM_API_BASE: BEAM_PLAYGROUND_BASE }],
    // Stripe with Beam's variables set next to it (a Beam drain could be built from them; no entry point here builds one).
    ["stripe-test with the Beam playground variables", { ...STRIPE_TEST_ENV, BEAM_API_BASE: BEAM_PLAYGROUND_BASE, ...KEYS, ...HMAC }],
    ["stripe-live with the Beam playground variables", { ...STRIPE_LIVE_ENV, BEAM_API_BASE: BEAM_PLAYGROUND_BASE, ...KEYS, ...HMAC }],
    ["stripe-live with the live Beam variables", { ...STRIPE_LIVE_ENV, BEAM_API_BASE: BEAM_LIVE_BASE, ...KEYS, ...HMAC }],
  ];
  for (const [label, env] of envs) {
    callEverything(config, { ...env, ...GARBAGE });
    assert.deepEqual(warnings, [], `${label}: nothing logged`);
  }
  // The garbage did reach the Stripe config (it is read), it just isn't a Beam config.
  assert.equal(config.getBookingConfig({ ...STRIPE_TEST_ENV, ...GARBAGE }).cardFeePct, 7);
  assert.equal(config.getBookingConfig({ ...STRIPE_TEST_ENV, ...GARBAGE }).beam, null);
  assert.deepEqual(warnings, []);
  // The same instance still warns for a Beam config: nothing above was swallowed or already warned about.
  config.getBookingConfig({ ...BEAM_PG, ...GARBAGE });
  assert.equal(warnings.length, Object.keys(GARBAGE).length);
});

test("a Beam config: exactly one config_warning per unreadable variable, by name only - never the value; the same and the other Beam entry points again log no new line", async (t) => {
  const config = await freshConfig();
  const warnings = captureWarnings(t);
  const cfg = config.getBookingConfig({ ...BEAM_PG, ...GARBAGE });
  assert.equal(cfg.paymentMode, "beam-playground");
  // The defaults are used (and the card fee as set).
  assert.deepEqual(
    { promptPay: cfg.beam?.promptPay, ewallets: cfg.beam?.ewallets, wechatPay: cfg.beam?.wechatPay, grace: cfg.beam?.pendingGraceMinutes, watch: cfg.beam?.lateWatchDays, fee: cfg.cardFeePct },
    { promptPay: true, ewallets: true, wechatPay: false, grace: 20, watch: 3, fee: 7 },
  );
  assert.deepEqual(warnings, [
    ...OPTION_LINES,
    line("BOOKING_CARD_FEE_PCT", "set while Beam is the payment provider: keep it unset in Production (unset = 3% on Beam, 5% on Stripe)"),
  ]);
  // One line per variable, naming it, and none carries the raw value.
  for (const [name, raw] of Object.entries(GARBAGE)) {
    const mine = warnings.filter((w) => w.includes(`"name":"${name}"`));
    assert.equal(mine.length, 1, name);
    const reason = (JSON.parse(mine[0].slice(mine[0].indexOf("{"))) as { reason: string }).reason;
    assert.equal(reason.includes(String(raw)), false, `${name}: ${JSON.stringify(raw)} is not in ${JSON.stringify(reason)}`);
  }
  assert.doesNotMatch(warnings.join("\n"), /maybe|soon|abc|\?|1\.5|\b7\b/, "no value is logged");

  // Again, on the same instance: the same call, every other entry point (a locked Beam page and fulfilment included,
  // which read the Beam options too) and other bad values for the same variables - nothing new.
  const before = [...warnings];
  callEverything(config, { ...BEAM_PG, ...GARBAGE });
  callEverything(config, { ...BEAM_PG, BEAM_EWALLETS: "perhaps", BEAM_PROMPTPAY: "!", BEAM_PENDING_GRACE_MINUTES: "x", BEAM_LATE_WATCH_DAYS: "99", BEAM_WECHAT_PAY: "later", BOOKING_CARD_FEE_PCT: "4" });
  const locked = config.getPublicBookingConfig({ ...BEAM_LIVE_LOCKED, ...GARBAGE });
  assert.equal(locked.paymentStatus, "locked");
  assert.ok(locked.feeByMethod, "a locked Beam page reads the Beam options");
  callEverything(config, { ...BEAM_LIVE_LOCKED, ...GARBAGE });
  assert.deepEqual(warnings, before);
});

test("a locked Beam page on its own (a fresh instance): one line per unreadable option, by name only, deduplicated", async (t) => {
  const config = await freshConfig();
  const warnings = captureWarnings(t);
  const locked = config.getPublicBookingConfig({ ...BEAM_LIVE_LOCKED, ...GARBAGE });
  assert.equal(locked.paymentStatus, "locked");
  // The locked fallback reads the options only (the BOOKING_CARD_FEE_PCT line is getBookingConfig's, which threw first).
  assert.deepEqual(warnings, OPTION_LINES);
  config.getPublicBookingConfig({ ...BEAM_LIVE_LOCKED, ...GARBAGE });
  assert.deepEqual(warnings, OPTION_LINES, "deduplicated");
});

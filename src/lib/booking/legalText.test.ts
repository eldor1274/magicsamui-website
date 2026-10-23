// Beam design S5.4: what /privacy and /legal say per provider set - Stripe only, Beam only, Beam with a Stripe drain,
// Stripe with a Beam drain, the demo with a Beam drain - and that every deployment without a Beam config (active or
// drain) renders exactly what it rendered before; plus the preview banner's Beam lines. The two pages and the banner
// are loaded through a "@/" resolve hook, transpiled with the repo's TypeScript and rendered with react-dom/server
// under each environment (process.env is swapped for the render and restored at once).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import nodeModule from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { BEAM_API_KEY, BEAM_HMAC_KEY_B64, BEAM_LIVE_ENV, BEAM_MERCHANT_ID, BEAM_TEST_ENV } from "./beamTestkit.ts";
import { BEAM_LIVE_BASE, BEAM_PLAYGROUND_BASE, getPublicBookingConfig } from "./config.ts";
import type { Env } from "./config.ts";
import { BEAM_LEGAL_NAME, BEAM_SITE_URL, beamConfigExists, paymentProcessorsOf } from "./legalText.ts";
import type { PaymentProcessors } from "./legalText.ts";
import { previewHeadline } from "./paymentCopy.ts";
import { STRIPE_LIVE_ENV, STRIPE_TEST_ENV } from "./testkit.ts";
import type { PublicBookingConfig } from "./types.ts";

/* ------------------------------- environments ------------------------------- */

const READY = { liveFulfilmentReady: true };
const STRIPE_KEYS: Env = { STRIPE_SECRET_KEY: "rk_test_drainkit0123456789", STRIPE_WEBHOOK_SECRET: STRIPE_TEST_ENV.STRIPE_WEBHOOK_SECRET };
const STRIPE_LIVE_KEYS: Env = { STRIPE_SECRET_KEY: STRIPE_LIVE_ENV.STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET: STRIPE_TEST_ENV.STRIPE_WEBHOOK_SECRET };
const BEAM_PG_VARS: Env = { BEAM_API_BASE: BEAM_PLAYGROUND_BASE, BEAM_MERCHANT_ID, BEAM_API_KEY, BEAM_WEBHOOK_HMAC_KEY: BEAM_HMAC_KEY_B64 };
const BEAM_LIVE_VARS: Env = { ...BEAM_PG_VARS, BEAM_API_BASE: BEAM_LIVE_BASE };

/** Every deployment without a Beam config: each must read exactly as before (Stripe and Upstash iff provider stripe). */
const NO_BEAM_CONFIG: Record<string, Env> = {
  "stripe-live (production today)": STRIPE_LIVE_ENV,
  "stripe-live with CLOUDBEDS_SEND_STATUS_EMAIL": { ...STRIPE_LIVE_ENV, CLOUDBEDS_SEND_STATUS_EMAIL: "true" },
  "stripe-live emergency stop": { ...STRIPE_LIVE_ENV, BOOKING_ALLOW_LIVE_PAYMENTS: "false" },
  "stripe-test": STRIPE_TEST_ENV,
  "stripe-mock": { BOOKING_PAYMENT_PROVIDER: "stripe", BOOKING_STRIPE_MOCK: "true" },
  "stripe locked (no key)": { BOOKING_PAYMENT_PROVIDER: "stripe" },
  "stripe locked (live key only)": { BOOKING_PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_live_abcdefghijkl" },
  demo: {},
  "demo with a Stripe drain": { ...STRIPE_TEST_ENV, BOOKING_PAYMENT_PROVIDER: "demo" },
  "provider beam without Beam keys (the demo)": { BOOKING_PAYMENT_PROVIDER: "beam" },
  "provider typo": { ...STRIPE_LIVE_ENV, BOOKING_PAYMENT_PROVIDER: "stirpe" },
  "stripe-live with live Beam variables (code switch off: no Beam drain)": { ...STRIPE_LIVE_ENV, ...BEAM_LIVE_VARS },
  "stripe-live with playground Beam keys but no webhook key (no Beam drain)": { ...STRIPE_LIVE_ENV, ...BEAM_PG_VARS, BEAM_WEBHOOK_HMAC_KEY: "" },
  "stripe-live with a Beam base only": { ...STRIPE_LIVE_ENV, BEAM_API_BASE: BEAM_PLAYGROUND_BASE },
  "stripe-live with Beam keys but no base": { ...STRIPE_LIVE_ENV, ...BEAM_PG_VARS, BEAM_API_BASE: "" },
  "beam-live locked in code, Stripe keys kept": { ...BEAM_LIVE_ENV, ...STRIPE_LIVE_KEYS },
  "beam-live locked in code": BEAM_LIVE_ENV,
};

/** The provider sets with a Beam config, and what the pages name for each. */
const WITH_BEAM: Record<string, { env: Env; expect: PaymentProcessors }> = {
  "Beam only (beam-playground)": { env: BEAM_TEST_ENV, expect: { stripe: false, beam: true, upstash: true } },
  "Beam only (legacy rule: no provider variable, BEAM_API_BASE set)": {
    env: { ...BEAM_TEST_ENV, BOOKING_PAYMENT_PROVIDER: undefined },
    expect: { stripe: false, beam: true, upstash: true },
  },
  "Beam with a Stripe drain": { env: { ...BEAM_TEST_ENV, ...STRIPE_KEYS }, expect: { stripe: true, beam: true, upstash: true } },
  "Stripe (live) with a Beam drain (the instant fallback)": { env: { ...STRIPE_LIVE_ENV, ...BEAM_PG_VARS }, expect: { stripe: true, beam: true, upstash: true } },
  "Stripe (test) with a Beam drain": { env: { ...STRIPE_TEST_ENV, ...BEAM_PG_VARS }, expect: { stripe: true, beam: true, upstash: true } },
  "the demo with a Beam drain": { env: { ...BEAM_TEST_ENV, BOOKING_PAYMENT_PROVIDER: "demo" }, expect: { stripe: false, beam: true, upstash: true } },
  "the demo with a Beam drain and a Stripe drain": {
    env: { ...BEAM_TEST_ENV, ...STRIPE_KEYS, BOOKING_PAYMENT_PROVIDER: "demo" },
    expect: { stripe: true, beam: true, upstash: true },
  },
};

/* ------------------------------ page rendering ------------------------------ */

let hooked = false;
/** "@/" -> src/, extensionless relative imports of src files, and .tsx transpiled with the repo's TypeScript. */
function hookPages(): void {
  if (hooked) return;
  hooked = true;
  type Resolve = (s: string, c: { parentURL?: string }, n: (s: string, c: { parentURL?: string }) => unknown) => unknown;
  type Load = (u: string, c: unknown, n: (u: string, c: unknown) => unknown) => unknown;
  const { registerHooks } = nodeModule as unknown as { registerHooks?: (hooks: { resolve: Resolve; load: Load }) => void };
  if (!registerHooks) throw new Error("module.registerHooks is required (Node 22.15+ / 23.5+)");
  const src = fileURLToPath(new URL("../../", import.meta.url));
  const probe = (base: URL) => {
    for (const ext of ["", ".ts", ".tsx", "/index.ts"]) {
      const url = new URL(`${base.href}${ext}`);
      const path = fileURLToPath(url);
      if (existsSync(path) && statSync(path).isFile()) return { url: url.href, shortCircuit: true };
    }
    return null;
  };
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith("@/")) return probe(new URL(`../../${specifier.slice(2)}`, import.meta.url)) ?? nextResolve(specifier, context);
      const parent = context.parentURL;
      if (specifier.startsWith(".") && parent?.startsWith("file:") && fileURLToPath(parent).startsWith(src)) {
        return probe(new URL(specifier, parent)) ?? nextResolve(specifier, context);
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!url.startsWith("file:") || !url.endsWith(".tsx") || !fileURLToPath(url).startsWith(src)) return nextLoad(url, context);
      const out = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        fileName: fileURLToPath(url),
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
      });
      return { format: "module", source: out.outputText, shortCircuit: true };
    },
  });
}

interface Pages {
  Privacy: ComponentType;
  Legal: ComponentType;
  Banner: ComponentType<Record<string, unknown>>;
}
let pages: Pages | null = null;
async function loadPages(): Promise<Pages> {
  if (pages) return pages;
  hookPages();
  pages = {
    Privacy: (await import("../../app/privacy/page.tsx")).default,
    Legal: (await import("../../app/legal/page.tsx")).default,
    Banner: (await import("../../components/booking/PreviewBanner.tsx")).default as unknown as ComponentType<Record<string, unknown>>,
  };
  return pages;
}

/** Runs `fn` with process.env replaced by exactly `env` (the pages read process.env), restoring it at once. */
function withEnv<T>(env: Env, fn: () => T): T {
  const saved = { ...process.env };
  const replace = (next: Env) => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    for (const [k, v] of Object.entries(next)) if (v !== undefined) process.env[k] = v;
  };
  replace(env);
  try {
    return fn();
  } finally {
    replace(saved);
  }
}

const render = (Page: ComponentType, env: Env) => withEnv(env, () => renderToStaticMarkup(createElement(Page)));
/** The rendered text, tags removed and the escapes renderToStaticMarkup writes decoded, spaces collapsed. */
const textOf = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/ ([.,:)])/g, "$1")
    .replace(/\( /g, "(");

const DETAILS_TO_CLOUDBEDS =
  "When you book through our own direct booking page on this website (where it is offered), the details you enter (name, email address, phone number, country, postcode, arrival time and requests) pass through our website's server to Cloudbeds, which creates your reservation. Our server keeps them only briefly, as a one-way code, to prevent abuse of the booking form (for about 40 minutes).";
/** The Stripe page's paragraph, word for word as before. */
const STRIPE_PRIVACY =
  `${DETAILS_TO_CLOUDBEDS} Card, Apple Pay, Google Pay and PromptPay payments are processed by Stripe on its own secure checkout page. Stripe receives your email address (for your payment receipt) ` +
  "and the payment details you enter there — we never see or store your full card number. Stripe also uses payment data for its own purposes, such as fraud prevention and legal compliance, under its own privacy policy.";
const STRIPE_COOKIES = "Stripe sets cookies on its own checkout page that are needed to process your payment and prevent fraud.";
const STRIPE_LEGAL = "Online payments on our own direct booking pages may be processed by Stripe. Card details are entered on Stripe's secure checkout page and never reach our own systems.";
const BEAM_PRIVACY = `Beam (${BEAM_LEGAL_NAME}) processes card, e-wallet and Thai PromptPay QR payments on its own secure payment page, including the payment details you enter there — we never see or store your full card number.`;
const BEAM_NO_PII = "We send Beam no name, email address or phone number: only the booking reference, what was booked (rooms, dates and number of guests) and the amounts.";
const BEAM_LEGAL = `Online payments on our own direct booking pages may be processed by Beam (${BEAM_LEGAL_NAME}). Payments are made on Beam's secure payment page, and card details never reach our own systems.`;
const BOTH = "Depending on the booking, the payment is processed by Stripe or by Beam.";

/* ---------------------------------- tests ---------------------------------- */

test("no Beam config (active or drain): the pages name Stripe and Upstash exactly while the provider is stripe, as before", () => {
  for (const [label, env] of Object.entries(NO_BEAM_CONFIG)) {
    assert.equal(beamConfigExists(env), false, label);
    const stripe = getPublicBookingConfig(env).provider === "stripe";
    assert.deepEqual(paymentProcessorsOf(env), { stripe, beam: false, upstash: stripe }, label);
  }
  // The demo with a Stripe drain names nothing, as before (a drain alone changes nothing without a Beam config).
  assert.deepEqual(paymentProcessorsOf(NO_BEAM_CONFIG["demo with a Stripe drain"]), { stripe: false, beam: false, upstash: false });
  assert.deepEqual(paymentProcessorsOf(STRIPE_LIVE_ENV), { stripe: true, beam: false, upstash: true });
});

test("with a Beam config: Beam always, Stripe while it is the provider or drains, Upstash", () => {
  for (const [label, { env, expect }] of Object.entries(WITH_BEAM)) {
    assert.equal(beamConfigExists(env), true, label);
    assert.deepEqual(paymentProcessorsOf(env), expect, label);
  }
  // beam-live counts once the code switch is on: active (also during an emergency stop) or as the drain of a Stripe page.
  assert.deepEqual(paymentProcessorsOf(BEAM_LIVE_ENV, READY), { stripe: false, beam: true, upstash: true });
  assert.deepEqual(paymentProcessorsOf({ ...BEAM_LIVE_ENV, BOOKING_ALLOW_LIVE_PAYMENTS: "false" }, READY), { stripe: false, beam: true, upstash: true });
  assert.deepEqual(paymentProcessorsOf({ ...BEAM_LIVE_ENV, ...STRIPE_LIVE_KEYS }, READY), { stripe: true, beam: true, upstash: true });
  assert.deepEqual(paymentProcessorsOf({ ...STRIPE_LIVE_ENV, ...BEAM_LIVE_VARS }, READY), { stripe: true, beam: true, upstash: true });
  // ...and not while it is off (the default): nothing can be paid through Beam then.
  assert.deepEqual(paymentProcessorsOf({ ...STRIPE_LIVE_ENV, ...BEAM_LIVE_VARS }), { stripe: true, beam: false, upstash: true });
});

test("privacy and legal without a Beam config: Stripe's wording on a Stripe page, none on the demo, no Beam word anywhere", async () => {
  const { Privacy, Legal } = await loadPages();
  for (const [label, env] of Object.entries(NO_BEAM_CONFIG)) {
    const privacy = textOf(render(Privacy, env));
    const legal = textOf(render(Legal, env));
    assert.doesNotMatch(privacy + legal, /Beam/, label);
    const stripe = getPublicBookingConfig(env).provider === "stripe";
    assert.equal(privacy.includes(STRIPE_PRIVACY), stripe, label);
    assert.equal(privacy.includes(STRIPE_COOKIES), stripe, label);
    assert.equal(privacy.includes("Stripe — online payments on our own direct booking pages Upstash — temporary booking-process data (holds, payment status, abuse limits) Anthropic"), stripe, label);
    assert.equal(privacy.includes("Upstash — temporary booking-process data"), stripe, label);
    assert.equal(privacy.includes("payment providers or by Stripe and never reach our own systems"), stripe, label);
    assert.ok(privacy.includes(`Last updated: ${stripe ? "5 October 2026" : "15 August 2026"}`), label);
    assert.equal(legal.includes(STRIPE_LEGAL), stripe, label);
  }
});

test("Beam variables that make no Beam config change no byte of either page", async () => {
  const { Privacy, Legal } = await loadPages();
  const same: Array<[string, Env]> = [
    ["stripe-live with live Beam variables (code switch off: no Beam drain)", STRIPE_LIVE_ENV],
    ["stripe-live with playground Beam keys but no webhook key (no Beam drain)", STRIPE_LIVE_ENV],
    ["stripe-live with a Beam base only", STRIPE_LIVE_ENV],
    ["stripe-live with Beam keys but no base", STRIPE_LIVE_ENV],
    ["beam-live locked in code, Stripe keys kept", {}],
    ["beam-live locked in code", {}],
    ["provider beam without Beam keys (the demo)", {}],
    ["demo with a Stripe drain", {}],
  ];
  for (const [label, plain] of same) {
    assert.equal(render(Privacy, NO_BEAM_CONFIG[label]), render(Privacy, plain), label);
    assert.equal(render(Legal, NO_BEAM_CONFIG[label]), render(Legal, plain), label);
  }
});

test("privacy and legal, Beam only: Beam's processing in plain words, no Stripe wording and no receipt promise", async () => {
  const { Privacy, Legal } = await loadPages();
  // Beam's legal name as its public terms give it, and its public site (where its terms and privacy policy are).
  assert.equal(BEAM_LEGAL_NAME, "Beam Data Co., Ltd.");
  assert.equal(BEAM_SITE_URL, "https://www.beamcheckout.com/");
  for (const label of ["Beam only (beam-playground)", "Beam only (legacy rule: no provider variable, BEAM_API_BASE set)", "the demo with a Beam drain"]) {
    const html = render(Privacy, WITH_BEAM[label].env);
    const privacy = textOf(html);
    assert.ok(privacy.includes("Last updated: 23 October 2026"), label);
    assert.ok(privacy.includes(DETAILS_TO_CLOUDBEDS), label);
    assert.ok(privacy.includes(BEAM_PRIVACY), label);
    assert.ok(privacy.includes(BEAM_NO_PII), label);
    assert.ok(privacy.includes("Beam may also use payment data for its own purposes, such as fraud prevention and legal compliance, under its own terms and privacy policy, published at beamcheckout.com."), label);
    assert.ok(html.includes(`href="${BEAM_SITE_URL}"`), label);
    assert.ok(privacy.includes("Beam may set cookies on its own payment page that are needed to process your payment and prevent fraud."), label);
    assert.ok(privacy.includes(`Beam (${BEAM_LEGAL_NAME}) — online payments on our own direct booking pages`), label);
    assert.ok(privacy.includes("Upstash — temporary booking-process data (holds, payment status, abuse limits)"), label);
    assert.ok(privacy.includes("Payment card details are handled by Cloudbeds and its payment providers or by Beam and never reach our own systems."), label);
    assert.doesNotMatch(privacy, /Stripe/, label);
    assert.doesNotMatch(privacy, /receipt/i, label);
    assert.doesNotMatch(privacy, new RegExp(BOTH), label);
    const legal = textOf(render(Legal, WITH_BEAM[label].env));
    assert.ok(legal.includes(BEAM_LEGAL), label);
    assert.doesNotMatch(legal, /Stripe/, label);
  }
});

test("privacy and legal with both providers (a Stripe drain on Beam, or a Beam drain on Stripe): both named, the Stripe line kept", async () => {
  const { Privacy, Legal } = await loadPages();
  for (const label of ["Beam with a Stripe drain", "Stripe (live) with a Beam drain (the instant fallback)", "Stripe (test) with a Beam drain", "the demo with a Beam drain and a Stripe drain"]) {
    const html = render(Privacy, WITH_BEAM[label].env);
    const privacy = textOf(html);
    assert.ok(privacy.includes("Last updated: 23 October 2026"), label);
    assert.ok(privacy.includes(`${DETAILS_TO_CLOUDBEDS} ${BOTH}`), label);
    assert.ok(privacy.includes("Stripe processes card, Apple Pay, Google Pay and PromptPay payments on its own secure checkout page."), label);
    assert.ok(html.includes('href="https://stripe.com/privacy"'), label);
    assert.ok(privacy.includes(BEAM_PRIVACY) && privacy.includes(BEAM_NO_PII), label);
    assert.ok(privacy.includes("Stripe sets cookies on its own checkout page"), label);
    assert.ok(privacy.includes("Beam may set cookies on its own payment page"), label);
    assert.ok(privacy.includes("Stripe — online payments on our own direct booking pages"), label);
    assert.ok(privacy.includes(`Beam (${BEAM_LEGAL_NAME}) — online payments on our own direct booking pages`), label);
    assert.ok(privacy.includes("Upstash — temporary booking-process data"), label);
    assert.ok(privacy.includes("Payment card details are handled by Cloudbeds and its payment providers, by Stripe or by Beam and never reach our own systems."), label);
    // The Stripe-only paragraph is not repeated next to the Beam one.
    assert.ok(!privacy.includes(STRIPE_PRIVACY), label);
    const legal = textOf(render(Legal, WITH_BEAM[label].env));
    assert.ok(legal.includes(STRIPE_LEGAL) && legal.includes(BEAM_LEGAL), label);
    assert.equal(legal.split("Online payments").length - 1, 3, `${label}: one heading, two lines`);
  }
});

/* ------------------------------ preview banner ------------------------------ */

const THEME_HREF = { magic: "/booking-preview?theme=magic", classic: "/booking-preview?theme=classic" };
/** The banner as BookingApp renders it for a page with this public config. */
function bannerOf(Banner: Pages["Banner"], cfg: PublicBookingConfig): string {
  return renderToStaticMarkup(
    createElement(Banner, {
      paymentMode: cfg.paymentMode,
      paymentStatus: cfg.paymentStatus,
      dataSource: cfg.dataSource,
      theme: "magic",
      themeHref: THEME_HREF,
      provider: cfg.provider,
      cloudbedsWrites: cfg.cloudbedsWrites,
      whatsappUrl: cfg.whatsappUrl,
    }),
  );
}

test("preview banner, Beam lines: the playground says whether the Cloudbeds reservation is real, as Stripe's test mode does", async () => {
  const { Banner } = await loadPages();
  const real = textOf(bannerOf(Banner, getPublicBookingConfig(BEAM_TEST_ENV)));
  assert.ok(real.includes("Beam · Test mode"));
  assert.ok(real.includes("a REAL Cloudbeds reservation is held and confirmed or cancelled. Test bookings need an arrival 12+ months ahead and the owner's test email."));
  assert.ok(real.includes("Real Cloudbeds reservations"));
  assert.doesNotMatch(real, /Stripe/);
  // Local only: the playground with the simulated Cloudbeds writer.
  const localEnv: Env = { ...BEAM_TEST_ENV, CLOUDBEDS_API_KEY_BOOKING: undefined };
  const simulated = textOf(bannerOf(Banner, getPublicBookingConfig(localEnv)));
  assert.equal(getPublicBookingConfig(localEnv).cloudbedsWrites, "mock");
  assert.ok(simulated.includes("payments go to Beam's playground (Beam test cards and test payments only, no real money moves); the reservation is simulated."));
  assert.ok(simulated.includes("Reservation simulated"));
  // A fully live Beam page shows no banner; a locked one only the lock (no writes chip).
  const live = { ...getPublicBookingConfig(BEAM_TEST_ENV), paymentMode: "beam-live", live: true, testMode: false } as PublicBookingConfig;
  assert.equal(bannerOf(Banner, live), "");
  const locked = textOf(bannerOf(Banner, getPublicBookingConfig(BEAM_LIVE_ENV)));
  assert.ok(locked.includes("Beam · Locked") && locked.includes("Payments locked"));
  assert.doesNotMatch(locked, /Real Cloudbeds reservations|Reservation simulated|No reservation is made/);
});

test("preview banner on Stripe and the demo: the writes chip only on Stripe, as before (provider beam without keys stays the demo)", async () => {
  const { Banner } = await loadPages();
  const stripeTest = textOf(bannerOf(Banner, getPublicBookingConfig(STRIPE_TEST_ENV)));
  assert.ok(stripeTest.includes("Stripe · Test mode") && stripeTest.includes("Real Cloudbeds reservations"));
  const mock = textOf(bannerOf(Banner, getPublicBookingConfig({ BOOKING_PAYMENT_PROVIDER: "stripe", BOOKING_STRIPE_MOCK: "true" })));
  assert.ok(mock.includes("Stripe · MOCK") && mock.includes("Reservation simulated"));
  assert.equal(bannerOf(Banner, getPublicBookingConfig(STRIPE_LIVE_ENV)), "");
  for (const env of [{}, { BOOKING_PAYMENT_PROVIDER: "beam" }]) {
    const demo = textOf(bannerOf(Banner, getPublicBookingConfig(env)));
    assert.ok(demo.includes("demo mode"), JSON.stringify(env));
    assert.doesNotMatch(demo, /Real Cloudbeds reservations|Reservation simulated|No reservation is made/, JSON.stringify(env));
  }
});

test("previewHeadline: the Beam lines per writer and the live line; the Stripe and demo lines unchanged", () => {
  assert.equal(
    previewHeadline({ paymentMode: "beam-playground", dataSource: "cloudbeds", cloudbedsWrites: "live" }),
    "Beam test mode: payments go to Beam's playground (Beam test cards and test payments only, no real money moves) - but a REAL " +
      "Cloudbeds reservation is held and confirmed or cancelled. Test bookings need an arrival 12+ months ahead and the owner's test email.",
  );
  assert.equal(
    previewHeadline({ paymentMode: "beam-playground", dataSource: "cloudbeds", cloudbedsWrites: "mock" }),
    "Beam test mode: live Cloudbeds availability, payments go to Beam's playground (Beam test cards and test payments only, no real money moves); the reservation is simulated.",
  );
  assert.equal(
    previewHeadline({ paymentMode: "beam-playground", dataSource: "demo", cloudbedsWrites: "mock" }),
    "Beam test mode: simulated availability, payments go to Beam's playground (Beam test cards and test payments only, no real money moves); the reservation is simulated.",
  );
  assert.equal(
    previewHeadline({ paymentMode: "beam-live", dataSource: "cloudbeds", cloudbedsWrites: "live" }),
    "LIVE payments: real card, e-wallet and PromptPay payments are taken through Beam and real reservations are made in Cloudbeds.",
  );
  assert.equal(
    previewHeadline({ paymentMode: "stripe-live", dataSource: "cloudbeds" }),
    "LIVE payments: real cards are charged through Stripe and real reservations are made in Cloudbeds.",
  );
  assert.equal(previewHeadline({ paymentMode: "demo", dataSource: "demo" }), "demo mode: availability and prices are simulated, no real payment is taken.");
});

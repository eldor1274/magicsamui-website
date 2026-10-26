// Beam design S5.2: how a Beam guest chooses to pay (card or e-wallet, or Thai PromptPay QR) and what each method
// costs - the labels per method, the fee line hidden at a 0 fee, the summary before a choice, a method switch after
// price_changed, a reload keeping an offered method, analytics payment_type per method - and that every Stripe and
// demo string, price, request and rendered page stays exactly as before. The booking page's state (components/
// booking/state.ts) and the payment step and summary are loaded through the same "@/" resolve hook the route tests
// use, the two components transpiled with the repo's TypeScript and rendered with react-dom/server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import nodeModule from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { site } from "../../data/site.ts";
import { buildOffers } from "./availability.ts";
import { BEAM_LIVE_ENV, BEAM_LIVE_STOPPED_ENV, BEAM_TEST_ENV, makeBeamKit } from "./beamTestkit.ts";
import { createBookingAnalytics } from "./clientAnalytics.ts";
import type { RecordedBookingEvent } from "./clientAnalytics.ts";
import { getPublicBookingConfig, toPublicConfig } from "./config.ts";
import type { Env } from "./config.ts";
import { addDays } from "./dates.ts";
import { demoInventory } from "./demoProvider.ts";
import {
  CHOOSE_METHOD_HINT,
  DEMO_COPY_CONFIG,
  OVER_MAX_CHARGE_MESSAGE,
  PROMPTPAY_HINT,
  beamSecurePayment,
  feeLineHidden,
  noFeeAlternative,
  overMaxChargeNote,
  payMethodFeeLabel,
  payMethodOptions,
  paymentMethodLabels,
  payWithText,
  providerCopy,
  resultsFeeNotes,
} from "./paymentCopy.ts";
import { analyticsPaymentType } from "./payments/provider.ts";
import { checkoutPayMethod, computeQuote, feeSatangAt, pageOffersMethodChoice, pagePayMethod, pagePayMethods, pagePricing } from "./quote.ts";
import { GUEST, STRIPE_LIVE_ENV, STRIPE_TEST_ENV } from "./testkit.ts";
import type { AvailabilityResponse, CartItem, PayMethod, PaymentMode, PublicBookingConfig, Quote } from "./types.ts";

type StateModule = typeof import("../../components/booking/state.ts");
type BookingState = import("../../components/booking/state.ts").BookingState;

const MOCK_ENV: Env = { BOOKING_PAYMENT_PROVIDER: "stripe", BOOKING_STRIPE_MOCK: "true" };
const LOCKED_STRIPE_ENV: Env = { BOOKING_PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_live_abcdefghijkl" };
/** Every Stripe and demo deployment shape (BOOKING_PAYMENT_PROVIDER=beam without Beam keys is the demo). */
const STRIPE_DEMO_ENVS: Record<string, Env> = {
  "stripe-live": STRIPE_LIVE_ENV,
  "stripe-live+email": { ...STRIPE_LIVE_ENV, CLOUDBEDS_SEND_STATUS_EMAIL: "true" },
  "stripe-test": STRIPE_TEST_ENV,
  "stripe-mock": MOCK_ENV,
  "stripe-locked": LOCKED_STRIPE_ENV,
  "stripe-fee-0": { ...MOCK_ENV, BOOKING_CARD_FEE_PCT: "0" },
  demo: {},
  "demo-beam-nokeys": { BOOKING_PAYMENT_PROVIDER: "beam" },
};
const config = (env: Env): PublicBookingConfig => getPublicBookingConfig(env);
const beamPage = (env: Env = {}) => config({ ...BEAM_TEST_ENV, ...env });
const beamLivePage = () => toPublicConfig(makeBeamKit({ env: BEAM_LIVE_ENV }).config, BEAM_LIVE_ENV);
/** Every Beam method-choice page shape: playground (defaults and each switch), beam-live, and a locked Beam page (the emergency stop since S7.1). */
const BEAM_PAGES: Record<string, () => PublicBookingConfig> = {
  playground: () => beamPage(),
  "wechat-on": () => beamPage({ BEAM_WECHAT_PAY: "on" }),
  "ewallets-off": () => beamPage({ BEAM_EWALLETS: "off" }),
  "promptpay-off": () => beamPage({ BEAM_PROMPTPAY: "off" }),
  "promptpay-fee-1": () => beamPage({ BEAM_PROMPTPAY_FEE_PCT: "1" }),
  live: beamLivePage,
  locked: () => config(BEAM_LIVE_STOPPED_ENV),
};
const strip = (html: string) => html.replace(/<!-- -->/g, "");

/* ------------------------- loading the booking page ------------------------- */

let hooked = false;
/** "@/" -> src/, extensionless relative imports of the components, and .tsx transpiled with the repo's TypeScript. */
function hookBookingPage(): void {
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
      // Round 7: the results list's room cards import next/image, a CommonJS module whose component is its default's
      // default when Node imports it: a module that hands on that component (as Next's bundler does).
      if (specifier === "next/image") {
        const real = import.meta.resolve("next/image.js");
        const image = `import m from ${JSON.stringify(real)}; export default m.default ?? m;`;
        return { url: `data:text/javascript,${encodeURIComponent(image)}`, shortCircuit: true };
      }
      // ...and their modals' theme root imports next/font/google, which only Next can load: a stand-in font.
      if (specifier === "next/font/google") {
        const font = "export function Poppins() { return { className: 'stub-poppins', variable: 'stub-poppins-var', style: { fontFamily: 'stub' } }; }";
        return { url: `data:text/javascript,${encodeURIComponent(font)}`, shortCircuit: true };
      }
      if (specifier.startsWith("@/")) return probe(new URL(`../../${specifier.slice(2)}`, import.meta.url)) ?? nextResolve(specifier, context);
      const parent = context.parentURL;
      if (specifier.startsWith(".") && parent?.startsWith("file:") && fileURLToPath(parent).startsWith(src)) {
        return probe(new URL(specifier, parent)) ?? nextResolve(specifier, context);
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      // Round 7: the theme root's stylesheet (booking.css) is Next's to bundle; here it is an empty module.
      if (url.startsWith("file:") && url.endsWith(".css") && fileURLToPath(url).startsWith(src)) return { format: "module", source: "export default {};", shortCircuit: true };
      if (!url.startsWith("file:") || !url.endsWith(".tsx") || !fileURLToPath(url).startsWith(src)) return nextLoad(url, context);
      const out = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        fileName: fileURLToPath(url),
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
      });
      return { format: "module", source: out.outputText, shortCircuit: true };
    },
  });
}

async function loadState(): Promise<StateModule> {
  hookBookingPage();
  return import("../../components/booking/state.ts");
}

async function loadComponents() {
  hookBookingPage();
  return {
    state: await loadState(),
    PaymentStep: (await import("../../components/booking/checkout/PaymentStep.tsx")).default,
    ReservationSummary: (await import("../../components/booking/summary/ReservationSummary.tsx")).default,
  };
}

/**
 * Runs `fn` with no global window, as on the server (round 7): next/image reads window when it loads, and another test
 * file of this process (`node --test src/lib/booking` imports them all) may have left a stand-in window behind.
 */
async function withoutWindow<T>(fn: () => Promise<T> | T): Promise<T> {
  const g = globalThis as { window?: unknown };
  const had = Object.prototype.hasOwnProperty.call(g, "window");
  const before = g.window;
  delete g.window;
  try {
    return await fn();
  } finally {
    if (had) g.window = before;
  }
}

/** The results list and the secure-payment window's content builder (round 7). */
async function loadResultsAndModal() {
  hookBookingPage();
  return withoutWindow(async () => ({
    ResultsList: (await import("../../components/booking/results/ResultsList.tsx")).default,
    modal: await import("../../components/booking/checkout/SecurePaymentModal.tsx"),
    badges: await import("../../components/booking/checkout/PaymentMethodBadges.tsx"),
  }));
}

/** Text as renderToStaticMarkup escapes it. */
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/* ------------------------------- fixtures ------------------------------- */

const SLUG = "sunrise-suite";

/** A demo availability answer for a page with this config (first stay from 2 Nov 2026 where the Sunrise Suite is free). */
function availabilityFor(cfg: PublicBookingConfig, bumpSatang = 0): AvailabilityResponse {
  for (let i = 0; i < 200; i++) {
    const checkIn = addDays("2026-11-02", i);
    const checkOut = addDays(checkIn, 3);
    const offers = buildOffers(demoInventory(checkIn, checkOut), 2, cfg.ratePlans);
    if (!offers.find((o) => o.slug === SLUG)?.available) continue;
    // bumpSatang: the server's rates moved (a price_changed answer prices with these).
    const bumped = offers.map((o) => ({ ...o, rates: o.rates.map((r) => ({ ...r, baseNightly: r.baseNightly.map((n) => ({ ...n, amountSatang: n.amountSatang + bumpSatang })) })) }));
    return { ok: true, search: { checkIn, checkOut, adults: 2 }, nights: 3, dataSource: "demo", config: cfg, promo: null, offers: bumped, generatedAt: "2026-10-23T05:00:00.000Z" };
  }
  throw new Error("no stay");
}

const ITEM: CartItem = { id: "c1", slug: SLUG, ratePlanId: "standard", adults: 2, addonIds: [] };

/** A booking on the payment step of a page with this config. */
function paymentState(st: StateModule, cfg: PublicBookingConfig): BookingState {
  const data = availabilityFor(cfg);
  const search = { checkIn: data.search.checkIn, checkOut: data.search.checkOut, adults: 2, promo: "" };
  return {
    ...st.initialBookingState(),
    hydrated: true,
    step: "payment",
    search,
    cart: [ITEM],
    cartKey: st.datesKey(search),
    guest: { ...GUEST, agreedToPolicy: true },
    results: { status: "ready", data, error: null, requestKey: st.searchKey(search) },
  };
}

/** computeQuote for the fixture's cart at `cardFeePct`. */
function quoteAt(data: AvailabilityResponse, cardFeePct: number): Quote {
  return computeQuote(
    { checkIn: data.search.checkIn, checkOut: data.search.checkOut, items: [{ slug: SLUG, ratePlanId: "standard", adults: 2, addonIds: [] }], promo: null, pricing: { cardFeePct, depositPct: data.config.depositPct } },
    data.offers,
  );
}

/* --------------------- Stripe and the demo: exactly as before --------------------- */

const STRIPE_COPY = {
  brand: "Stripe",
  secureLine: "Secure payment by Stripe",
  payHeading: "Pay securely with Stripe",
  payExplainer:
    "When you press Pay we reserve your room in our booking system and hold it for 30 minutes while you pay on Stripe's secure checkout - by Visa, Mastercard, Apple Pay, Google Pay or Thai PromptPay QR. You then come straight back here with your booking reference. Card details are entered on Stripe's PCI DSS compliant page - never on our site.",
  payButtonSuffix: "securely with Stripe",
  busyLabel: "Reserving your room...",
  payAnnouncement: "Reserving your room and taking you to Stripe's secure payment page.",
  perk: { title: "Secure payment by Stripe", text: "Visa, Mastercard, Apple Pay, Google Pay or Thai PromptPay." },
};
const STRIPE_FEE = (pct: number) =>
  `A ${pct}% payment processing fee applies to online payments (card, wallet or PromptPay). It is shown as its own line and already included in the total below - there are no other charges at checkout.`;
const DEMO_COPY = {
  brand: "Beam",
  secureLine: "Secure payment by Beam",
  payHeading: "Pay securely with Beam",
  payExplainer:
    "You'll go to Beam's secure payment page to pay by card or Thai PromptPay QR, then come straight back here with your booking reference. Card details are entered on Beam's PCI DSS compliant page - never on our site.",
  payButtonSuffix: "securely with Beam",
  busyLabel: "Taking you to Beam...",
  payAnnouncement: "Taking you to Beam's secure payment page.",
  perk: { title: "Secure payment by Beam", text: "Cards from any country, or Thai PromptPay." },
};
const DEMO_FEE = (pct: number) =>
  `A ${pct}% payment processing fee applies to online payments (card or PromptPay). It is shown as its own line and already included in the total below - there are no other charges at checkout.`;

test("the Stripe and demo copy snapshot is unchanged (design S5.2): wording, badges, no method choice, no Beam fee notes", () => {
  for (const [name, env] of Object.entries(STRIPE_DEMO_ENVS)) {
    const c = config(env);
    const stripe = c.provider === "stripe";
    assert.ok(stripe || c.paymentMode === "demo", name);
    const { feeExplainer, ...copy } = providerCopy(c);
    assert.deepEqual(copy, stripe ? STRIPE_COPY : DEMO_COPY, name);
    for (const pct of [0, 3, 5]) assert.equal(feeExplainer(pct), (stripe ? STRIPE_FEE : DEMO_FEE)(pct), `${name} ${pct}%`);
    assert.deepEqual(paymentMethodLabels(c), stripe ? ["Visa", "Mastercard", "PromptPay", "Apple Pay", "Google Pay"] : ["Visa", "Mastercard", "JCB", "Amex", "UnionPay", "PromptPay"], name);
    assert.equal(payWithText(c), stripe ? "Visa, Mastercard, Apple Pay, Google Pay or Thai PromptPay QR" : "Visa, Mastercard, JCB, Amex, UnionPay or Thai PromptPay QR", name);
    assert.equal(c.feeByMethod, undefined, name);
    assert.equal(pageOffersMethodChoice(c), false, name);
    assert.deepEqual(payMethodOptions(c), [], name);
    assert.deepEqual(pagePayMethods(c), [], name);
    assert.equal(resultsFeeNotes(c), null, name);
    assert.equal(beamSecurePayment(c), null, name);
    assert.equal(feeLineHidden(c, { cardFeeSatang: 0 }), false, `${name}: a 0 fee keeps its line as before`);
    for (const m of ["card_ewallet", "promptpay", "", null, undefined, "bogus", 1]) {
      assert.equal(noFeeAlternative(c, m), null, name);
      assert.equal(pagePayMethod(c, m), null, name);
      assert.deepEqual(checkoutPayMethod(c, m), {}, `${name}: a Stripe or demo request never gains payMethod`);
      assert.deepEqual(pagePricing(c, m), { cardFeePct: c.cardFeePct, depositPct: c.depositPct }, name);
    }
  }
  const { feeExplainer, ...demo } = providerCopy(DEMO_COPY_CONFIG);
  assert.deepEqual(demo, DEMO_COPY);
  assert.equal(feeExplainer(3), DEMO_FEE(3));
  // Hand-made: a Stripe or demo config that somehow carries Beam's feeByMethod still prices, words and sends as before.
  for (const provider of ["stripe", "demo"] as const) {
    const c = { ...config(MOCK_ENV), provider, feeByMethod: { card_ewallet: 3, promptpay: 0 } };
    assert.equal(pageOffersMethodChoice(c), false);
    assert.deepEqual(pagePricing(c, "promptpay"), { cardFeePct: c.cardFeePct, depositPct: c.depositPct });
    assert.deepEqual(checkoutPayMethod(c, "promptpay"), {});
    assert.deepEqual(payMethodOptions(c), []);
    assert.equal(providerCopy(c).brand, provider === "stripe" ? "Stripe" : "Beam");
    assert.equal(providerCopy(c).busyLabel, provider === "stripe" ? STRIPE_COPY.busyLabel : DEMO_COPY.busyLabel);
  }
});

/* ------------------------------ Beam: per method ------------------------------ */

test("Beam labels per method (design S5.2): card or e-wallet with its brands and wallets and the 3% fee, Thai PromptPay QR with no fee; each switch respected", () => {
  const CARD = "Visa, Mastercard, JCB, American Express, Alipay, LINE Pay, TrueMoney or ShopeePay. 3% payment processing fee.";
  const PROMPTPAY = { method: "promptpay", title: "Thai PromptPay QR", description: "Scan with any Thai banking app. No fee.", feePct: 0 };
  for (const page of ["playground", "live", "locked"]) {
    const c = BEAM_PAGES[page]();
    assert.equal(pageOffersMethodChoice(c), true, page);
    assert.deepEqual(payMethodOptions(c), [{ method: "card_ewallet", title: "Card or e-wallet", description: CARD, feePct: 3 }, PROMPTPAY], page);
    assert.deepEqual(paymentMethodLabels(c), ["Visa", "Mastercard", "JCB", "Amex", "PromptPay", "Alipay", "LINE Pay", "TrueMoney", "ShopeePay"], page);
  }
  assert.deepEqual(payMethodOptions(BEAM_PAGES["wechat-on"]())[0].description, "Visa, Mastercard, JCB, American Express, Alipay, LINE Pay, TrueMoney, ShopeePay or WeChat Pay. 3% payment processing fee.");
  assert.deepEqual(paymentMethodLabels(BEAM_PAGES["wechat-on"]()).slice(-1), ["WeChat Pay"]);
  assert.deepEqual(payMethodOptions(BEAM_PAGES["ewallets-off"]()), [
    { method: "card_ewallet", title: "Card", description: "Visa, Mastercard, JCB or American Express. 3% payment processing fee.", feePct: 3 },
    PROMPTPAY,
  ]);
  assert.deepEqual(paymentMethodLabels(BEAM_PAGES["ewallets-off"]()), ["Visa", "Mastercard", "JCB", "Amex", "PromptPay"]);
  // BEAM_PROMPTPAY=off: no PromptPay radio, badge or price.
  const noPromptPay = BEAM_PAGES["promptpay-off"]();
  assert.deepEqual(payMethodOptions(noPromptPay).map((o) => o.method), ["card_ewallet"]);
  assert.ok(!paymentMethodLabels(noPromptPay).includes("PromptPay"));
  assert.equal(pagePayMethod(noPromptPay, "promptpay"), null);
  assert.deepEqual(pagePricing(noPromptPay, "promptpay"), { cardFeePct: 3, depositPct: 100 }, "a switched-off PromptPay prices as card/e-wallet");
  assert.deepEqual(payMethodOptions(BEAM_PAGES["promptpay-fee-1"]())[1], { ...PROMPTPAY, description: "Scan with any Thai banking app. 1% payment processing fee.", feePct: 1 });
  // The amount on the right of each radio.
  assert.equal(payMethodFeeLabel(39_300), "+ THB 393.00");
  assert.equal(payMethodFeeLabel(1_234_567), "+ THB 12,345.67");
  assert.equal(payMethodFeeLabel(0), "No fee");
  // Pricing and the request follow the chosen group; anything else is not sent.
  const c = beamPage();
  assert.deepEqual(pagePricing(c, null), { cardFeePct: 3, depositPct: 100 }, "no method yet: the card/e-wallet total");
  assert.deepEqual(pagePricing(c, "card_ewallet"), { cardFeePct: 3, depositPct: 100 });
  assert.deepEqual(pagePricing(c, "promptpay"), { cardFeePct: 0, depositPct: 100 });
  assert.deepEqual(pagePricing(beamPage({ BEAM_PROMPTPAY_FEE_PCT: "1" }), "promptpay"), { cardFeePct: 1, depositPct: 100 });
  assert.deepEqual(checkoutPayMethod(c, "card_ewallet"), { payMethod: "card_ewallet" });
  assert.deepEqual(checkoutPayMethod(c, "promptpay"), { payMethod: "promptpay" });
  for (const m of [null, undefined, "", "card", "PROMPTPAY", 0]) assert.deepEqual(checkoutPayMethod(c, m), {}, String(m));
  assert.deepEqual(checkoutPayMethod(noPromptPay, "promptpay"), {}, "never a group the page no longer offers");
});

test("Beam copy (design S5.2): explainer, PromptPay hint, busy label, announcement, perk and the secure-payment window - no Stripe, no receipt", () => {
  const c = beamPage();
  const { feeExplainer, ...copy } = providerCopy(c);
  assert.deepEqual(copy, {
    brand: "Beam",
    secureLine: "Secure payment by Beam",
    payHeading: "Pay securely with Beam",
    payExplainer:
      "When you press Pay we reserve your room in our booking system and hold it for 30 minutes while you pay on Beam's secure payment page. You then come straight back here with your booking reference. Card details are entered on Beam's PCI DSS compliant page - never on our site.",
    payButtonSuffix: "securely with Beam",
    busyLabel: "Reserving your room...",
    payAnnouncement: "Reserving your room and taking you to Beam's secure payment page.",
    perk: { title: "Secure payment by Beam", text: "Cards from any country, e-wallets or Thai PromptPay QR." },
  });
  const EXPLAINER =
    "A 3% payment processing fee applies when you pay by card or e-wallet. Thai PromptPay QR has no fee. It is shown as its own line and already included in the total below - there are no other charges at checkout.";
  for (const pct of [0, 3, 5]) assert.equal(feeExplainer(pct), EXPLAINER, "the page's own fees by method, whatever line is shown");
  assert.equal(PROMPTPAY_HINT, "Scan the QR in your banking app. The bank's confirmation can take a few minutes - please don't pay twice.");
  // Each switch keeps the copy true.
  const rule = (env: Env) => providerCopy(beamPage(env)).feeExplainer(3).replace(/ It is shown as its own line[\s\S]*$/, "");
  assert.equal(rule({ BEAM_EWALLETS: "off" }), "A 3% payment processing fee applies when you pay by card. Thai PromptPay QR has no fee.");
  assert.equal(rule({ BEAM_PROMPTPAY: "off" }), "A 3% payment processing fee applies when you pay by card or e-wallet.");
  assert.equal(rule({ BEAM_PROMPTPAY_FEE_PCT: "1" }), "A 3% payment processing fee applies when you pay by card or e-wallet, and 1% with Thai PromptPay QR.");
  assert.equal(rule({ BEAM_PROMPTPAY_FEE_PCT: "3" }), "A 3% payment processing fee applies to every online payment.");
  assert.equal(rule({ BOOKING_CARD_FEE_PCT: "0", BEAM_PROMPTPAY_FEE_PCT: "1" }), "A 1% payment processing fee applies when you pay with Thai PromptPay QR. Paying by card or e-wallet has no fee.");
  assert.equal(rule({ BOOKING_CARD_FEE_PCT: "0" }), "There is no payment processing fee.");
  assert.equal(providerCopy(beamPage({ BEAM_EWALLETS: "off" })).perk.text, "Cards from any country or Thai PromptPay QR.");
  assert.equal(providerCopy(beamPage({ BEAM_PROMPTPAY: "off" })).perk.text, "Cards from any country or e-wallets.");
  assert.equal(providerCopy(beamPage({ BEAM_PROMPTPAY: "off", BEAM_EWALLETS: "off" })).perk.text, "Cards from any country.");
  // The secure-payment window ("Learn more").
  const modal = beamSecurePayment(c);
  assert.ok(modal);
  assert.deepEqual(
    modal.points.map((p) => [p.kind, p.title]),
    [
      ["card", "Cards, including overseas cards"],
      ["wallet", "E-wallets"],
      ["promptpay", "Thai PromptPay QR"],
      ["lock", "Card details never touch our site"],
      ["hold", "Your room is held while you pay"],
    ],
  );
  assert.equal(modal.points[0].body, "Visa, Mastercard, JCB and American Express issued in Thailand or abroad. Your bank may convert the Thai baht amount to your currency.");
  assert.equal(modal.points[1].body, "Pay with Alipay, LINE Pay, TrueMoney or ShopeePay on Beam's page.");
  assert.match(modal.points[2].body, /No fee\. The bank's confirmation can take a few minutes - please don't pay twice\.$/);
  assert.match(modal.points[4].body, /hold it for 30 minutes/);
  assert.equal(modal.feeNote, "A 3% payment processing fee applies when you pay by card or e-wallet. Thai PromptPay QR has no fee. It is shown as its own line in your reservation summary before you pay - no hidden charges.");
  assert.deepEqual(beamSecurePayment(beamPage({ BEAM_PROMPTPAY: "off", BEAM_EWALLETS: "off" }))?.points.map((p) => p.kind), ["card", "lock", "hold"]);
  // Nothing on any Beam page names Stripe, promises a receipt or mentions UnionPay (not on Beam's card list).
  for (const [page, make] of Object.entries(BEAM_PAGES)) {
    const p = make();
    const pc = providerCopy(p);
    const all = [
      ...Object.values(pc).filter((v): v is string => typeof v === "string"),
      pc.perk.title,
      pc.perk.text,
      pc.feeExplainer(3),
      ...payMethodOptions(p).flatMap((o) => [o.title, o.description]),
      ...(beamSecurePayment(p)?.points.flatMap((x) => [x.title, x.body]) ?? []),
      beamSecurePayment(p)?.feeNote ?? "",
      resultsFeeNotes(p)?.card ?? "",
      resultsFeeNotes(p)?.results ?? "",
      noFeeAlternative(p, null) ?? "",
      PROMPTPAY_HINT,
      CHOOSE_METHOD_HINT,
    ].join(" ");
    assert.doesNotMatch(all, /Stripe|receipt|UnionPay|Apple Pay|Google Pay/i, page);
  }
});

test("results and room cards on Beam (design S5.2; round 7: short room-card lines): '+ 3% fee by card or e-wallet' and 'No fee with PromptPay'", () => {
  // Round 7: the room cards' note is short lines (one long line squeezed the rate's description on a narrow card).
  assert.deepEqual(resultsFeeNotes(beamPage()), {
    card: ["+ 3% fee by card or e-wallet", "No fee with PromptPay"],
    results: "Prices are for the stay; a 3% payment processing fee is added when you pay by card or e-wallet (none with PromptPay).",
  });
  assert.deepEqual(resultsFeeNotes(beamPage({ BEAM_EWALLETS: "off" }))?.card, ["+ 3% fee by card", "No fee with PromptPay"]);
  assert.deepEqual(resultsFeeNotes(beamPage({ BEAM_PROMPTPAY: "off" })), {
    card: ["+ 3% payment processing fee"],
    results: "Prices are for the stay; a 3% payment processing fee is added to every online payment.",
  });
  assert.deepEqual(resultsFeeNotes(beamPage({ BEAM_PROMPTPAY_FEE_PCT: "1" }))?.card, ["+ 3% fee by card or e-wallet", "+ 1% fee with PromptPay"]);
  assert.deepEqual(resultsFeeNotes(beamPage({ BEAM_PROMPTPAY_FEE_PCT: "3" }))?.card, ["+ 3% payment processing fee"], "the same fee for both: one line");
  assert.deepEqual(resultsFeeNotes(beamPage({ BOOKING_CARD_FEE_PCT: "0", BEAM_PROMPTPAY_FEE_PCT: "1" }))?.card, ["+ 1% fee with PromptPay", "No fee by card or e-wallet"]);
  assert.deepEqual(resultsFeeNotes(beamPage({ BOOKING_CARD_FEE_PCT: "0" })), { card: null, results: null });
  // Every line stays short (at most 28 characters, the longest being '+ 3% fee by card or e-wallet'), names no Stripe, promises no receipt.
  for (const [name, make] of Object.entries(BEAM_PAGES)) {
    for (const line of resultsFeeNotes(make())?.card ?? []) {
      assert.ok(line.length <= 28, `${name}: ${line}`);
      assert.doesNotMatch(line, /Stripe|receipt/i, name);
    }
  }
  // The card/e-wallet fee is what the results price with (the same number as cardFeePct on a Beam config).
  assert.equal(pagePricing(beamPage(), null).cardFeePct, beamPage().cardFeePct);
});

/* ------------------------------- the summary ------------------------------- */

test("the summary before a choice (design S5.2): the card/e-wallet total with 'No fee with Thai PromptPay QR'; a 0 fee hides the line; a total never rises after the choice", async () => {
  const st = await loadState();
  for (const [page, make] of Object.entries(BEAM_PAGES)) {
    const c = make();
    const s = paymentState(st, c);
    const data = s.results.data;
    assert.ok(data);
    const none = st.selectQuote(s);
    const card = st.selectQuote({ ...s, payMethod: "card_ewallet" });
    assert.ok(none && card);
    assert.deepEqual(none, quoteAt(data, c.feeByMethod?.card_ewallet ?? -1), `${page}: before a choice, the card/e-wallet fee`);
    assert.deepEqual(card, none, `${page}: choosing card/e-wallet changes nothing`);
    const pp = c.feeByMethod?.promptpay;
    const promptpay = st.selectQuote({ ...s, payMethod: "promptpay" });
    if (pp === undefined) {
      assert.deepEqual(promptpay, none, `${page}: a PromptPay choice the page doesn't offer is priced as no choice`);
      assert.equal(noFeeAlternative(c, null), null, page);
      continue;
    }
    assert.ok(promptpay);
    assert.deepEqual(promptpay, quoteAt(data, pp), page);
    assert.ok(promptpay.totalSatang <= none.totalSatang, `${page}: never higher than the total shown before the choice`);
    assert.equal(feeSatangAt(none, pp), promptpay.cardFeeSatang, `${page}: the radio's fee is the quote's`);
    assert.equal(feeSatangAt(none, 3), none.cardFeeSatang);
    if (pp === 0) {
      assert.equal(promptpay.cardFeeSatang, 0);
      assert.equal(promptpay.totalSatang, promptpay.feeBaseSatang);
      assert.equal(feeLineHidden(c, promptpay), true, `${page}: a 0 fee hides the line`);
      // Round 7: not on a locked Beam page, which offers no choice.
      assert.equal(noFeeAlternative(c, null), c.paymentStatus === "locked" ? null : "No fee with Thai PromptPay QR", page);
    } else {
      assert.equal(feeLineHidden(c, promptpay), false, page);
      assert.equal(noFeeAlternative(c, null), null, `${page}: PromptPay has a fee`);
    }
    assert.equal(feeLineHidden(c, none), false, page);
    assert.equal(noFeeAlternative(c, "card_ewallet"), null, `${page}: chosen`);
    assert.equal(noFeeAlternative(c, "promptpay"), null, `${page}: chosen`);
  }
  // Stripe and the demo: the client quote is exactly computeQuote at config.cardFeePct, whatever a state holds.
  for (const [name, env] of Object.entries(STRIPE_DEMO_ENVS)) {
    const c = config(env);
    const s = paymentState(st, c);
    const data = s.results.data;
    assert.ok(data);
    const expected = quoteAt(data, c.cardFeePct);
    for (const payMethod of [undefined, null, "card_ewallet", "promptpay"] as const) {
      assert.deepEqual(st.selectQuote({ ...s, payMethod }), expected, `${name} ${payMethod}`);
      assert.equal(st.pricingKey({ ...s, payMethod }), JSON.stringify([data.search.checkIn, data.search.checkOut, "", st.cartInputs(s.cart)]), `${name} ${payMethod}`);
    }
  }
});

test("a method switch after price_changed re-prices (design S5.2): the server's quote is for the method it was given; another method is priced with its own fee; switching back shows the server's quote", async () => {
  const st = await loadState();
  const s0 = paymentState(st, beamPage());
  const data = s0.results.data;
  assert.ok(data);
  const s1 = st.bookingReducer(s0, { type: "setPayMethod", payMethod: "card_ewallet" });
  assert.equal(s1.payMethod, "card_ewallet");
  // The server priced the stay higher (its rates moved by 100 THB a night) for card/e-wallet.
  const server = quoteAt(availabilityFor(beamPage(), 10_000), 3);
  const error = { code: "price_changed" as const, message: "The price has changed.", newTotalSatang: server.totalSatang, newDueNowSatang: server.dueNowSatang };
  const s2 = st.bookingReducer(st.bookingReducer(s1, { type: "checkoutStarted" }), { type: "checkoutFailed", error, quote: server });
  assert.deepEqual(st.selectQuote(s2), server, "the server's quote is shown and paid");
  assert.equal(s2.checkout.error?.code, "price_changed");
  // PromptPay: its own (0) fee - the card/e-wallet server quote is not reused for another method, and its panel goes.
  const s3 = st.bookingReducer(s2, { type: "setPayMethod", payMethod: "promptpay" });
  assert.equal(s3.payMethod, "promptpay");
  assert.deepEqual(s3.checkout, { status: "idle", error: null }, "the 'price has changed' panel is stale once the method changes");
  const q3 = st.selectQuote(s3);
  assert.ok(q3);
  assert.equal(q3.cardFeePct, 0);
  assert.equal(q3.cardFeeSatang, 0);
  assert.deepEqual(q3, quoteAt(data, 0));
  assert.notEqual(st.pricingKey(s3), st.pricingKey(s2), "the key carries the method");
  // Back to card/e-wallet: the server's quote for it again.
  const s4 = st.bookingReducer(s3, { type: "setPayMethod", payMethod: "card_ewallet" });
  assert.deepEqual(st.selectQuote(s4), server);
  // A price_changed for PromptPay keys its own server quote.
  const serverPp = quoteAt(availabilityFor(beamPage(), 10_000), 0);
  const s5 = st.bookingReducer(s3, { type: "checkoutFailed", error: { ...error, newTotalSatang: serverPp.totalSatang }, quote: serverPp });
  assert.deepEqual(st.selectQuote(s5), serverPp);
  assert.deepEqual(st.selectQuote(st.bookingReducer(s5, { type: "setPayMethod", payMethod: "card_ewallet" })), quoteAt(data, 3));
});

test("choosing a method (design S5.2): only an offered group, never while a checkout runs; it answers 'Please choose how to pay'; a Stripe or demo state never gains one", async () => {
  const st = await loadState();
  const s = paymentState(st, beamPage());
  for (const status of ["submitting", "redirecting"] as const) {
    const busy = { ...s, checkout: { status, error: null } };
    assert.equal(st.bookingReducer(busy, { type: "setPayMethod", payMethod: "promptpay" }), busy, status);
  }
  const off = paymentState(st, beamPage({ BEAM_PROMPTPAY: "off" }));
  assert.equal(st.bookingReducer(off, { type: "setPayMethod", payMethod: "promptpay" }), off, "PromptPay switched off");
  assert.equal(st.bookingReducer(off, { type: "setPayMethod", payMethod: "bogus" as PayMethod }), off);
  const chosen = st.bookingReducer(s, { type: "setPayMethod", payMethod: "promptpay" });
  assert.equal(st.bookingReducer(chosen, { type: "setPayMethod", payMethod: "promptpay" }), chosen, "the same method again changes nothing");
  // The server's 400 'Please choose how to pay' (fixStep payment): back to the payment step's choice, cleared.
  const refusal = { code: "invalid_request" as const, message: "Please choose how to pay", fixStep: "payment" as const };
  const onGuest = { ...chosen, step: "guest" as const };
  const refused = st.bookingReducer(onGuest, { type: "checkoutFailed", error: refusal });
  assert.equal(refused.step, "payment");
  assert.equal(refused.payMethod, null);
  assert.deepEqual(refused.checkout, { status: "error", error: refusal });
  assert.equal(st.selectQuote(refused)?.cardFeePct, 3, "priced as no choice: the card/e-wallet total");
  const rechosen = st.bookingReducer(refused, { type: "setPayMethod", payMethod: "card_ewallet" });
  assert.deepEqual(rechosen.checkout, { status: "idle", error: null }, "the choice answers it");
  // Other errors stay (a paused page, a refused earlier attempt): a new method doesn't answer them.
  for (const code of ["live_payments_locked", "upstream_error", "payment_unavailable", "rate_limited"] as const) {
    const withError = { ...s, checkout: { status: "error" as const, error: { code, message: "m" } } };
    assert.deepEqual(st.bookingReducer(withError, { type: "setPayMethod", payMethod: "card_ewallet" }).checkout, withError.checkout, code);
  }
  // Stripe and the demo: setPayMethod is a no-op and a fixStep 'payment' answer is handled as any invalid_request.
  for (const [name, env] of Object.entries(STRIPE_DEMO_ENVS)) {
    const plain = paymentState(st, config(env));
    for (const payMethod of ["card_ewallet", "promptpay"] as const) assert.equal(st.bookingReducer(plain, { type: "setPayMethod", payMethod }), plain, name);
    const failed = st.bookingReducer({ ...plain, step: "guest" }, { type: "checkoutFailed", error: refusal });
    assert.deepEqual(failed, { ...plain, step: "guest", checkout: { status: "error", error: refusal } }, name);
    assert.equal("payMethod" in failed, false, name);
    assert.equal("payMethod" in st.initialBookingState(), false);
  }
});

test("a reload keeps an offered method and drops one the page no longer offers (BEAM_PROMPTPAY switched off); a Stripe save is byte for byte as before", async () => {
  const st = await loadState();
  const today = "2026-10-23";
  const chosen = st.bookingReducer(paymentState(st, beamPage()), { type: "setPayMethod", payMethod: "promptpay" });
  const saved = st.sanitizePersisted(JSON.parse(JSON.stringify(st.toPersisted(chosen))));
  assert.equal(saved?.payMethod, "promptpay");
  const hydrate = (cfg: PublicBookingConfig | undefined) =>
    st.bookingReducer(st.initialBookingState(), { type: "hydrate", persisted: saved, initialSearch: null, resume: null, today, ...(cfg ? { config: cfg } : {}) });
  const kept = hydrate(beamPage());
  assert.equal(kept.payMethod, "promptpay");
  assert.equal(kept.step, "payment");
  for (const cfg of [beamPage({ BEAM_PROMPTPAY: "off" }), config(STRIPE_LIVE_ENV), config({}), undefined]) {
    const dropped = hydrate(cfg);
    assert.equal("payMethod" in dropped, false, cfg?.paymentMode ?? "no config");
    assert.equal(dropped.step, "payment");
  }
  // A card/e-wallet choice survives PromptPay being switched off.
  const card = st.sanitizePersisted(JSON.parse(JSON.stringify(st.toPersisted({ ...chosen, payMethod: "card_ewallet" }))));
  const cardKept = st.bookingReducer(st.initialBookingState(), { type: "hydrate", persisted: card, initialSearch: null, resume: null, today, config: beamPage({ BEAM_PROMPTPAY: "off" }) });
  assert.equal(cardKept.payMethod, "card_ewallet");
  // A new public config while the page is open (a fresh search) drops what it no longer offers.
  const fresh = (cfg: PublicBookingConfig) => {
    const data = availabilityFor(cfg);
    const key = st.searchKey({ ...kept.search });
    return st.bookingReducer({ ...kept, results: { ...kept.results, requestKey: key } }, { type: "searchSucceeded", key, data });
  };
  assert.equal(fresh(beamPage()).payMethod, "promptpay");
  assert.equal(fresh(beamPage({ BEAM_PROMPTPAY: "off" })).payMethod, null);
  assert.equal(st.selectQuote(fresh(beamPage({ BEAM_PROMPTPAY: "off" })))?.cardFeePct, 3);
  // Only the two groups are read back from storage.
  for (const bogus of ["card", "PROMPTPAY", 1, null, {}]) {
    const raw = { ...JSON.parse(JSON.stringify(st.toPersisted(chosen))), payMethod: bogus };
    assert.equal("payMethod" in (st.sanitizePersisted(raw) ?? {}), false, String(bogus));
  }
  // Stripe: the saved booking has exactly the keys it had before, in the same order.
  const stripe = paymentState(st, config(STRIPE_LIVE_ENV));
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(st.toPersisted(stripe)))), ["v", "step", "search", "cart", "cartKey", "guest", "landingKey", "termsVersion", "savedAt"]);
  const stripeSaved = st.sanitizePersisted(JSON.parse(JSON.stringify(st.toPersisted(stripe))));
  assert.deepEqual(Object.keys(stripeSaved ?? {}), ["v", "step", "search", "cart", "cartKey", "guest", "landingKey", "termsVersion", "savedAt"]);
});

test("a paid booking clears the saved method with the cart (design S5.2): the next booking chooses again", async () => {
  const st = await loadState();
  const chosen = st.bookingReducer(paymentState(st, beamPage()), { type: "setPayMethod", payMethod: "promptpay" });
  const g = globalThis as { window?: unknown; sessionStorage?: unknown };
  const before = { window: g.window, sessionStorage: g.sessionStorage };
  const store = new Map<string, string>([[st.STORAGE_KEY, JSON.stringify(st.toPersisted(chosen))]]);
  g.window = {};
  g.sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  try {
    assert.equal(st.readPersistedBooking()?.payMethod, "promptpay");
    st.clearPersistedCart();
    const after = JSON.parse(store.get(st.STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    assert.deepEqual(after.cart, []);
    assert.equal(after.step, "search");
    assert.equal("payMethod" in after, false);
  } finally {
    g.window = before.window;
    g.sessionStorage = before.sessionStorage;
  }
});

/* ------------------------------- analytics ------------------------------- */

test("analytics payment_type per method (design S5.2): Beam 'card_or_ewallet' or 'promptpay'; Stripe keeps 'stripe', the demo 'demo'", (t) => {
  t.mock.method(console, "debug", () => undefined);
  const MODES: PaymentMode[] = ["demo", "beam-playground", "beam-live", "stripe-mock", "stripe-test", "stripe-live"];
  for (const mode of MODES) {
    for (const m of [null, undefined, "card_ewallet", "promptpay"] as const) {
      const expected = mode.startsWith("beam-") ? (m === "promptpay" ? "promptpay" : "card_or_ewallet") : mode.startsWith("stripe-") ? "stripe" : "demo";
      assert.equal(analyticsPaymentType(mode, m), expected, `${mode} ${m}`);
    }
    assert.equal(analyticsPaymentType(mode), mode.startsWith("beam-") ? "card_or_ewallet" : mode.startsWith("stripe-") ? "stripe" : "demo");
  }
  const g = globalThis as { window?: unknown };
  const before = g.window;
  const win: { dataLayer: unknown[]; __bookingEvents?: RecordedBookingEvent[] } = { dataLayer: [] };
  g.window = win;
  try {
    const q = quoteAt(availabilityFor(beamPage()), 3);
    const sent = (mode: PaymentMode, m?: PayMethod | null) => {
      createBookingAnalytics(mode, "preview").addPaymentInfo(q, m);
      return win.__bookingEvents?.at(-1)?.params.payment_type;
    };
    assert.equal(sent("beam-playground", "promptpay"), "promptpay");
    assert.equal(sent("beam-live", "card_ewallet"), "card_or_ewallet");
    assert.equal(sent("stripe-live"), "stripe");
    assert.equal(sent("stripe-live", "promptpay"), "stripe", "Stripe ignores a method");
    assert.equal(sent("demo", "promptpay"), "demo");
    assert.deepEqual(win.dataLayer, [], "disabled outside live production: nothing sent");
  } finally {
    g.window = before;
  }
});

/* ------------------------------ the rendered page ------------------------------ */

test("the payment step on Beam (design S5.2): a required choice with no default, Pay disabled until chosen, the fee by method, PromptPay's hint; Stripe and the demo show no choice", async () => {
  const { state: st, PaymentStep } = await loadComponents();
  const render = (cfg: PublicBookingConfig, payMethod: PayMethod | null, extra: Record<string, unknown> = {}) => {
    const s = paymentState(st, cfg);
    const quote = st.selectQuote({ ...s, payMethod });
    assert.ok(quote);
    const noop = () => undefined;
    return strip(
      renderToStaticMarkup(
        createElement(PaymentStep, {
          quote,
          cart: s.cart,
          guest: s.guest,
          checkIn: s.search.checkIn ?? "",
          checkOut: s.search.checkOut ?? "",
          paymentMode: cfg.paymentMode,
          paymentStatus: cfg.paymentStatus,
          submitting: false,
          error: null,
          onPay: noop,
          onEditGuest: noop,
          onEditRooms: noop,
          config: cfg,
          payMethod,
          onPayMethodChange: noop,
          ...extra,
        }),
      ),
    );
  };
  const payButton = (html: string) => /<button type="button"[^>]*>(?:(?!<\/button>).)*Pay THB/.exec(html)?.[0] ?? "";
  const c = beamPage();
  const none = render(c, null);
  assert.equal((none.match(/name="payMethod"/g) ?? []).length, 2);
  assert.doesNotMatch(none, /checked=""/, "no default");
  // Round 7 (round-6 triage): a required radio group, its hint while nothing is chosen, PromptPay's hint in a live region.
  const radios = none.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
  assert.equal(radios.length, 2);
  for (const r of radios) assert.match(r, /required=""/, r);
  for (const m of ["card_ewallet", "promptpay"]) {
    assert.ok(radios.some((r) => r.includes(`aria-labelledby="booking-pay-method-${m}-title booking-pay-method-${m}-fee"`) && r.includes(`aria-describedby="booking-pay-method-${m}-text"`)), m);
  }
  assert.match(none, /<fieldset id="booking-pay-method" aria-describedby="booking-pay-method-hint"/);
  assert.match(none, /<p id="booking-pay-method-hint"[^>]*>/);
  assert.match(none, /<div aria-live="polite"><\/div><\/fieldset>/, "the live region is there, empty, before PromptPay is chosen");
  assert.match(none, /How would you like to pay\?/);
  assert.match(none, /Card or e-wallet/);
  assert.match(none, /Thai PromptPay QR/);
  assert.match(none, />No fee</);
  assert.match(none, />\+ THB [\d,]+\.\d\d</);
  assert.ok(none.includes(CHOOSE_METHOD_HINT.replace(/'/g, "&#x27;")));
  assert.match(payButton(none), /disabled=""/, "Pay stays disabled until a method is chosen");
  assert.match(payButton(none), /aria-describedby="booking-pay-method-hint"/);
  assert.match(none, /Payment processing fee \(3%\)<span class="[^"]*">No fee with Thai PromptPay QR<\/span>/, "before a choice: the card/e-wallet total and how it can be lower");
  assert.doesNotMatch(none, /Stripe|receipt/i);
  const promptpay = render(c, "promptpay");
  assert.match(promptpay, /id="booking-pay-method-promptpay"[^>]*checked=""|checked=""[^>]*id="booking-pay-method-promptpay"/);
  assert.match(promptpay, /<fieldset id="booking-pay-method" class=/, "no hint reference once a method is chosen");
  assert.ok(promptpay.includes(`<div aria-live="polite"><p class="flex items-start gap-2 rounded-(--bk-radius-control) bg-(--bk-surface-muted) p-3 text-xs text-(--bk-text)">`) && /<div aria-live="polite"><p[^>]*>(?:(?!<\/p>).)*Scan the QR in your banking app/.test(promptpay), "PromptPay's hint is read out");
  assert.doesNotMatch(payButton(promptpay), /disabled=""/);
  assert.doesNotMatch(promptpay, /Payment processing fee/, "a 0 fee hides the line");
  assert.ok(promptpay.includes(PROMPTPAY_HINT.replace(/'/g, "&#x27;")));
  assert.ok(!promptpay.includes(CHOOSE_METHOD_HINT.replace(/'/g, "&#x27;")));
  const card = render(c, "card_ewallet");
  assert.match(card, /Payment processing fee \(3%\)<\/dt>/);
  assert.doesNotMatch(card, /No fee with Thai PromptPay QR/);
  assert.doesNotMatch(payButton(card), /disabled=""/);
  // PromptPay switched off: one radio, still required.
  const off = render(beamPage({ BEAM_PROMPTPAY: "off" }), null);
  assert.equal((off.match(/name="payMethod"/g) ?? []).length, 1);
  assert.doesNotMatch(off, /PromptPay/);
  assert.match(payButton(off), /disabled=""/);
  // A locked Beam page: payments are locked, so no choice is offered - and no "No fee with Thai PromptPay QR" either (round 7).
  const lockedStep = render(config(BEAM_LIVE_STOPPED_ENV), null);
  assert.doesNotMatch(lockedStep, /name="payMethod"/);
  assert.doesNotMatch(lockedStep, /No fee with Thai PromptPay QR/);
  // The server's 'Please choose how to pay' answer points to the choice.
  const refusal = { code: "invalid_request", message: "Please choose how to pay", fixStep: "payment" };
  const refused = render(c, null, { error: refusal });
  assert.match(refused, /Please choose how to pay<\/p>/);
  assert.match(refused, /Choose how to pay<\/button>/);
  // Stripe and the demo: no choice, Pay as before - also with a hand-made fixStep 'payment' answer.
  for (const [name, env] of Object.entries(STRIPE_DEMO_ENVS)) {
    const cfg = config(env);
    for (const m of [null, "promptpay"] as const) {
      const html = render(cfg, m);
      assert.doesNotMatch(html, /name="payMethod"|How would you like to pay|No fee with Thai PromptPay QR/, name);
      assert.doesNotMatch(html, /type="radio"|required=""|aria-live="polite"><\/div><\/fieldset>/, `${name}: no Beam radio markup`);
      if (cfg.paymentStatus === "ok") assert.doesNotMatch(payButton(html), /disabled=""/, name);
    }
    const html = render(cfg, null, { error: refusal });
    assert.match(html, /Something in your reservation needs a look/, name);
    assert.doesNotMatch(html, /Choose how to pay/, name);
  }
});

/* -------------------- Beam's limit of one online payment (THB 200,000, 26 Oct 2026) -------------------- */

/** A quote's fee base and room line at `feeBase` satang (all overMaxChargeNote reads), with an optional larger room line (a promo). */
const limitQuote = (feeBase: number, roomSatang = feeBase) => ({ feeBaseSatang: feeBase, lines: [{ roomSatang }] as Quote["lines"] });
const LIMIT = "Online payments are limited to THB 200,000.00 per payment (including the fee)";
const OVER_ALL = `${LIMIT}, so this stay can't be paid online. Message us on WhatsApp and we'll book it for you.`;
const OVER_CARD = (card: string) => `${LIMIT}, so this stay can't be paid by ${card}. You can pay with Thai PromptPay QR, or message us on WhatsApp and we'll book it for you.`;

test("overMaxChargeNote: the payment step's early word for a stay above Beam's THB 200,000 per payment, per method and fee-inclusive; never on a Stripe, demo or locked page", () => {
  const c = beamPage();
  // 194,174.75 + 3% = 199,999.99 (every method within); 194,174.77 + 3% = 200,000.01 (card over, PromptPay within).
  for (const m of [null, "card_ewallet", "promptpay"] as const) assert.equal(overMaxChargeNote(c, limitQuote(19_417_475), m), null, `${m}: within`);
  assert.equal(overMaxChargeNote(c, limitQuote(19_417_477), null), OVER_CARD("card or e-wallet"), "before a choice: said at once");
  assert.equal(overMaxChargeNote(c, limitQuote(19_417_477), "card_ewallet"), OVER_CARD("card or e-wallet"));
  assert.equal(overMaxChargeNote(c, limitQuote(19_417_477), "promptpay"), null, "PromptPay chosen and within: nothing");
  // Exactly THB 200,000.00 by PromptPay is within; one satang more is over for every method.
  assert.equal(overMaxChargeNote(c, limitQuote(20_000_000), "promptpay"), null);
  for (const m of [null, "card_ewallet", "promptpay"] as const) assert.equal(overMaxChargeNote(c, limitQuote(20_000_001), m), OVER_ALL, `${m}: over for all`);
  // A room line above the limit (a promo brings the fee base under it): over for every method, as the checkout refuses it.
  for (const m of [null, "card_ewallet", "promptpay"] as const) assert.equal(overMaxChargeNote(c, limitQuote(15_000_000, 20_000_001), m), OVER_ALL, `${m}: a room line`);
  // The switches: no PromptPay -> nothing else to offer; no e-wallets -> "card"; a PromptPay fee prices PromptPay too.
  assert.equal(overMaxChargeNote(beamPage({ BEAM_PROMPTPAY: "off" }), limitQuote(19_417_477), null), OVER_ALL);
  assert.equal(overMaxChargeNote(beamPage({ BEAM_EWALLETS: "off" }), limitQuote(19_417_477), "card_ewallet"), OVER_CARD("card"));
  assert.equal(overMaxChargeNote(beamPage({ BEAM_PROMPTPAY_FEE_PCT: "3" }), limitQuote(19_417_477), "promptpay"), OVER_ALL);
  assert.equal(overMaxChargeNote(beamLivePage(), limitQuote(19_417_477), null), OVER_CARD("card or e-wallet"), "beam-live");
  // A stored method the page no longer offers counts as no choice.
  assert.equal(overMaxChargeNote(beamPage({ BEAM_PROMPTPAY: "off" }), limitQuote(19_417_475), "promptpay"), null);
  // Never on a locked Beam page (no choice is offered there), nor on any Stripe or demo page, whatever the amount.
  assert.equal(overMaxChargeNote(config(BEAM_LIVE_STOPPED_ENV), limitQuote(30_000_000), null), null);
  for (const [name, env] of Object.entries(STRIPE_DEMO_ENVS)) {
    for (const m of [null, "card_ewallet", "promptpay"] as const) assert.equal(overMaxChargeNote(config(env), limitQuote(150_000_000), m), null, `${name} ${m}`);
  }
});

test("the payment step shows Beam's limit early: the note and a WhatsApp link in the method choice's live region for a stay over it, nothing within it; never on a Stripe or demo page", async () => {
  const { state: st, PaymentStep } = await loadComponents();
  const noop = () => undefined;
  /** The payment step with the fixture's stay at `bumpSatang` more per night, priced as the page prices it. */
  const render = (cfg: PublicBookingConfig, payMethod: PayMethod | null, bumpSatang: number) => {
    const s = paymentState(st, cfg);
    const data = availabilityFor(cfg, bumpSatang);
    const quote = st.selectQuote({ ...s, results: { ...s.results, data }, payMethod });
    assert.ok(quote);
    const props = { quote, cart: s.cart, guest: s.guest, checkIn: data.search.checkIn, checkOut: data.search.checkOut, paymentMode: cfg.paymentMode, paymentStatus: cfg.paymentStatus, submitting: false, error: null, onPay: noop, onEditGuest: noop, onEditRooms: noop, config: cfg, payMethod, onPayMethodChange: noop };
    return { quote, html: strip(renderToStaticMarkup(createElement(PaymentStep, props))) };
  };
  const c = beamPage();
  // Three nights at about THB 72,000: THB 216,000+ by card (3%) and by PromptPay - over for both.
  const big = render(c, "promptpay", 7_000_000);
  assert.ok(big.quote.dueNowSatang > 20_000_000);
  assert.ok(big.html.includes(esc(OVER_ALL)), big.html);
  assert.match(big.html, /<div aria-live="polite"><p[^>]*>(?:(?!<\/p>).)*Scan the QR(?:(?!<\/div>).)*Online payments are limited to THB 200,000\.00/, "after PromptPay's hint, in the live region");
  assert.ok(big.html.includes(`href="${esc(`${site.whatsapp}?text=${encodeURIComponent(OVER_MAX_CHARGE_MESSAGE)}`)}" target="_blank" rel="noopener noreferrer"`), "a WhatsApp link with the limit message");
  // Before a choice: the card total is over, PromptPay within -> the note names PromptPay.
  // A fee base of about THB 197,000 (3 nights): THB 202,910 or so by card, within the limit by PromptPay.
  const perNight = Math.round((19_700_000 - render(c, "promptpay", 0).quote.feeBaseSatang) / 3);
  const mid = render(c, null, perNight);
  assert.ok(mid.quote.dueNowSatang > 20_000_000, `card total ${mid.quote.dueNowSatang}`);
  assert.ok(mid.quote.feeBaseSatang <= 20_000_000, `PromptPay total ${mid.quote.feeBaseSatang}`);
  assert.ok(mid.html.includes(esc(OVER_CARD("card or e-wallet"))), mid.html);
  assert.ok(!render(c, "promptpay", perNight).html.includes(esc(LIMIT)), "PromptPay chosen and within: no note");
  // The fixture's own stay: no note, the live region empty before a choice (as before).
  const small = render(c, null, 0);
  assert.ok(!small.html.includes(esc(LIMIT)));
  assert.match(small.html, /<div aria-live="polite"><\/div><\/fieldset>/);
  // Stripe and the demo: never a note, whatever the amount.
  for (const [name, env] of Object.entries(STRIPE_DEMO_ENVS)) {
    for (const m of [null, "promptpay"] as const) assert.ok(!render(config(env), m, 7_000_000).html.includes("Online payments are limited"), `${name} ${m}`);
  }
});

test("the reservation summary on Beam (design S5.2): the fee line with 'No fee with Thai PromptPay QR' before a choice, none at a 0 fee; Stripe keeps its line at any fee", async () => {
  const { state: st, ReservationSummary } = await loadComponents();
  const render = (cfg: PublicBookingConfig, payMethod: PayMethod | null) => {
    const s = { ...paymentState(st, cfg), ...(payMethod ? { payMethod } : {}) };
    const quote = st.selectQuote(s);
    const value = { state: s, config: cfg } as unknown as import("../../components/booking/state.ts").BookingContextValue;
    const summary = createElement(ReservationSummary, { variant: "sidebar", quote, cart: s.cart, checkIn: s.search.checkIn, checkOut: s.search.checkOut, cta: null, onLearnMore: () => undefined });
    return strip(renderToStaticMarkup(createElement(st.BookingContext.Provider, { value }, summary)));
  };
  const c = beamPage();
  const none = render(c, null);
  assert.match(none, /Payment processing fee \(3%\)/);
  assert.match(none, /No fee with Thai PromptPay QR/);
  assert.ok(none.includes("A 3% payment processing fee applies when you pay by card or e-wallet. Thai PromptPay QR has no fee."));
  const promptpay = render(c, "promptpay");
  assert.doesNotMatch(promptpay, /Payment processing fee|No fee with Thai PromptPay QR/);
  const card = render(c, "card_ewallet");
  assert.match(card, /Payment processing fee \(3%\)/);
  assert.doesNotMatch(card, /No fee with Thai PromptPay QR/);
  // Round 7 (round-6 triage): a locked Beam page shows no choice, so its summary has no "No fee with Thai PromptPay QR" either.
  const locked = config(BEAM_LIVE_STOPPED_ENV);
  assert.equal(locked.paymentStatus, "locked");
  assert.equal(pageOffersMethodChoice(locked), true);
  const lockedHtml = render(locked, null);
  assert.match(lockedHtml, /Payment processing fee \(3%\)/);
  assert.doesNotMatch(lockedHtml, /No fee with Thai PromptPay QR/);
  for (const [name, env] of Object.entries(STRIPE_DEMO_ENVS)) {
    const cfg = config(env);
    const html = render(cfg, "promptpay");
    assert.match(html, new RegExp(`Payment processing fee \\(${cfg.cardFeePct}%\\)`), `${name}: the line stays, at 0% too`);
    assert.doesNotMatch(html, /No fee with Thai PromptPay QR/, name);
  }
});

/* ------------------- round 7: the round-6 triage's copy and wiring gaps ------------------- */

test("noFeeAlternative on a locked Beam page is null (round 7: it offers no choice, as its payment step shows none); every other Beam page as before", () => {
  const locked = config(BEAM_LIVE_STOPPED_ENV);
  assert.equal(locked.paymentStatus, "locked");
  for (const m of [null, undefined, "card_ewallet", "promptpay"]) assert.equal(noFeeAlternative(locked, m), null, String(m));
  assert.equal(noFeeAlternative({ ...locked, paymentStatus: "ok" }, null), "No fee with Thai PromptPay QR", "the same page unlocked");
  assert.equal(noFeeAlternative(beamPage(), null), "No fee with Thai PromptPay QR");
  assert.equal(noFeeAlternative(beamLivePage(), null), "No fee with Thai PromptPay QR");
  assert.equal(noFeeAlternative(config(BEAM_LIVE_ENV), null), "No fee with Thai PromptPay QR", "the beam-live page itself (since S7.1)");
  assert.equal(noFeeAlternative(beamPage(), "promptpay"), null);
  assert.equal(noFeeAlternative(beamPage({ BEAM_PROMPTPAY: "off" }), null), null);
  // Stripe and the demo: null, also when locked.
  for (const [name, env] of Object.entries(STRIPE_DEMO_ENVS)) assert.equal(noFeeAlternative(config(env), null), null, name);
});

/** The Stripe and demo secure-payment window as it is (0bcc14b, SecurePaymentModal.tsx). */
const STRIPE_POINTS = (holdMinutes: number) => [
  {
    title: "Visa and Mastercard, from any country",
    body: "Cards issued in Thailand or abroad. Your bank may convert the Thai baht amount to your currency. American Express, JCB and UnionPay aren't accepted online - message us and we'll help.",
  },
  { title: "Apple Pay and Google Pay", body: "Offered on Stripe's page when your device and browser support them." },
  { title: "Thai PromptPay QR", body: "Scan the QR code with any Thai banking app and the payment is confirmed in seconds." },
  { title: "Card details never touch our site", body: "You enter them on Stripe's PCI DSS compliant hosted checkout. We never see or store your card number." },
  {
    title: "Your room is held while you pay",
    body: `We reserve your room before you pay and hold it for ${holdMinutes} minutes. If you cancel or the time runs out, nothing is charged and the room is released. 3-D Secure checks by your bank happen on Stripe's page.`,
  },
];
const DEMO_POINTS = [
  {
    title: "Cards, including overseas cards",
    body: "Visa, Mastercard, JCB, American Express and UnionPay issued in Thailand or abroad. Your bank may convert the Thai baht amount to your currency.",
  },
  { title: "Thai PromptPay QR", body: "Scan the QR code with any Thai banking app and the payment is confirmed in seconds." },
  { title: "Card details never touch our site", body: "You enter them on Beam's PCI DSS compliant hosted payment page. We never see or store your card number." },
  { title: "3-D Secure by your bank", body: "If your bank asks you to confirm the payment (OTP or app approval), Beam handles it on the same page." },
];
const STRIPE_MODAL_FEE =
  "The payment processing fee is shown as its own line in your reservation summary before you pay - the same for every payment method, no hidden charges.";
const DEMO_MODAL_FEE = "The payment processing fee (card or PromptPay) is shown as its own line in your reservation summary before you pay - no hidden charges.";
const STRIPE_INTRO =
  "<p>Payments are processed by <strong>Stripe</strong> (stripe.com), a global payment provider. You pay on Stripe&#x27;s secure hosted checkout and come straight back here with your booking reference.</p>";
const BEAM_INTRO =
  "Payments are processed by <strong>Beam</strong> (beamcheckout.com), a Thai payment gateway. You pay on Beam&#x27;s secure hosted page";

test("the secure-payment window ('Learn more', round 7): every Beam page shows beamSecurePayment's points and fee note and paymentMethodLabels' badges; Stripe and the demo keep their content exactly", async () => {
  const { modal, badges } = await loadResultsAndModal();
  const icons = await import("lucide-react");
  const ICON = { card: icons.CreditCard, wallet: icons.Wallet, promptpay: icons.QrCode, lock: icons.Lock, hold: icons.Smartphone };
  type Content = ReturnType<typeof modal.securePaymentContent>;
  const intro = (c: Content) => strip(renderToStaticMarkup(createElement("p", null, c.intro)));
  const text = (c: Content) => c.points.map(({ title, body }) => ({ title, body }));
  for (const [name, make] of Object.entries(BEAM_PAGES)) {
    const c = make();
    const beam = beamSecurePayment(c);
    assert.ok(beam, name);
    const content = modal.securePaymentContent(c);
    assert.equal(content.title, "Secure payment by Beam", name);
    assert.deepEqual(
      content.points.map(({ icon, title, body }) => ({ icon, title, body })),
      beam.points.map(({ kind, title, body }) => ({ icon: ICON[kind], title, body })),
      name,
    );
    assert.equal(content.feeNote, beam.feeNote, name);
    assert.deepEqual(content.methods, paymentMethodLabels(c), name);
    assert.ok(intro(content).includes(BEAM_INTRO), name);
    const all = [content.title, intro(content), ...text(content).flatMap((p) => [p.title, p.body]), content.feeNote].join(" ");
    assert.doesNotMatch(all, /Stripe|receipt|UnionPay|confirmed in seconds|card or PromptPay\)/i, `${name}: never the demo's points or Stripe's words`);
  }
  for (const [name, env] of Object.entries(STRIPE_DEMO_ENVS)) {
    const c = config(env);
    const content = modal.securePaymentContent(c);
    if (c.provider === "stripe") {
      assert.equal(content.title, "Secure payment by Stripe", name);
      assert.equal(intro(content), STRIPE_INTRO, name);
      assert.deepEqual(text(content), STRIPE_POINTS(c.holdMinutes), name);
      assert.deepEqual(content.points.map((p) => p.icon), [icons.CreditCard, icons.Wallet, icons.QrCode, icons.Lock, icons.Smartphone], name);
      assert.equal(content.feeNote, STRIPE_MODAL_FEE, name);
    } else {
      assert.equal(content.title, "Secure payment by Beam", name);
      assert.ok(intro(content).includes(BEAM_INTRO), name);
      assert.deepEqual(text(content), DEMO_POINTS, name);
      assert.deepEqual(content.points.map((p) => p.icon), [icons.CreditCard, icons.QrCode, icons.Lock, icons.Smartphone], name);
      assert.equal(content.feeNote, DEMO_MODAL_FEE, name);
    }
    assert.deepEqual(content.methods, paymentMethodLabels(c), name);
  }
  // Outside the booking app (no config): the demo's content with every badge.
  const outside = modal.securePaymentContent(null);
  assert.deepEqual(text(outside), DEMO_POINTS);
  assert.deepEqual(outside.methods, badges.ALL_METHODS);
  assert.equal(outside.feeNote, DEMO_MODAL_FEE);
  // The modal renders the builder's content (wiring).
  const src = readFileSync(new URL("../../components/booking/checkout/SecurePaymentModal.tsx", import.meta.url), "utf8");
  assert.ok(src.includes("  const content = securePaymentContent(config);"));
  assert.ok(src.includes("  if (config && beam) {") && src.includes("      feeNote: beam.feeNote,"));
});

/** The results list for a page with this config (its rooms and its fee notes). */
async function renderResults(cfg: PublicBookingConfig): Promise<string> {
  const { ResultsList } = await loadResultsAndModal();
  const noop = () => undefined;
  return withoutWindow(() =>
    strip(
      renderToStaticMarkup(
        createElement(ResultsList, {
          availability: availabilityFor(cfg),
          status: "ready",
          error: null,
          cart: [],
          searchAdults: 2,
          blockedReason: () => null,
          onAdd: noop,
          onRetry: noop,
          onChangeDates: noop,
        }),
      ),
    ),
  );
}

test("the results header (round 7): every Beam page says resultsFeeNotes(config).results; Stripe and the demo keep '... added to every online payment.'", async () => {
  const header = (html: string) => /<span class="block text-\(--bk-frame-text-muted\)">([^<]*)<\/span>/.exec(html)?.[1] ?? null;
  for (const [name, make] of Object.entries(BEAM_PAGES)) {
    const c = make();
    const notes = resultsFeeNotes(c);
    assert.ok(notes, name);
    assert.equal(header(await renderResults(c)), notes.results === null ? null : esc(notes.results), name);
  }
  // Fee 0 on both groups: no header line.
  assert.equal(header(await renderResults(beamPage({ BOOKING_CARD_FEE_PCT: "0" }))), null);
  for (const [name, env] of Object.entries(STRIPE_DEMO_ENVS)) {
    const c = config(env);
    const expected = c.cardFeePct > 0 ? `Prices are for the stay; a ${c.cardFeePct}% payment processing fee is added to every online payment.` : null;
    assert.equal(header(await renderResults(c)), expected, name);
  }
});

/** The rate rows of a rendered results list: each row's grid, its price column and the fee lines under the price. */
function rateRows(html: string) {
  const rows = [...html.matchAll(/<li class="border-b border-\(--bk-border\) last:border-b-0"><div class="([^"]*)">([\s\S]*?)<\/li>/g)];
  return rows.map(([, grid, body]) => {
    const price = /<div class="col-span-2 flex items-center justify-between gap-4 sm:contents"><div class="([^"]*)">([\s\S]*?)<\/div><button/.exec(body);
    assert.ok(price, "a price column");
    const lines = [...price[2].matchAll(/<p class="text-xs text-\(--bk-text-muted\)">([^<]*)<\/p>/g)].map((m) => m[1]);
    return { grid, priceClass: price[1], lines };
  });
}

const STRIPE_ROW_GRID = "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-3 px-4 py-3.5 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]";
const BEAM_ROW_GRID = "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-3 px-4 py-3.5 sm:grid-cols-[auto_minmax(7rem,1fr)_auto_auto]";

test("room cards (round 7): every Beam page shows resultsFeeNotes' short lines under each price, in a price column of at most 11rem next to a description of at least 7rem; Stripe and the demo keep their row and '+ X% payment processing fee'", async () => {
  for (const [name, make] of Object.entries(BEAM_PAGES)) {
    const c = make();
    const rows = rateRows(await renderResults(c));
    assert.ok(rows.length > 0, name);
    const expected = (resultsFeeNotes(c)?.card ?? []).map(esc);
    for (const row of rows) {
      assert.equal(row.grid, BEAM_ROW_GRID, name);
      assert.equal(row.priceClass, "sm:max-w-44 sm:text-right", name);
      assert.match(row.lines[0], /^\d+ Nights?$/, name);
      assert.deepEqual(row.lines.slice(1), expected, name);
      assert.ok(!row.lines.some((l) => l.includes("payment processing fee by")), `${name}: never the long line`);
    }
  }
  const zero = rateRows(await renderResults(beamPage({ BOOKING_CARD_FEE_PCT: "0" })));
  assert.ok(zero.length > 0);
  for (const row of zero) assert.deepEqual(row.lines.slice(1), [], "no fee: no line");
  for (const [name, env] of Object.entries(STRIPE_DEMO_ENVS)) {
    const c = config(env);
    for (const row of rateRows(await renderResults(c))) {
      assert.equal(row.grid, STRIPE_ROW_GRID, name);
      assert.equal(row.priceClass, "sm:text-right", name);
      assert.deepEqual(row.lines.slice(1), c.cardFeePct > 0 ? [`+ ${c.cardFeePct}% payment processing fee`] : [], name);
    }
  }
});

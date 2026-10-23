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
import { buildOffers } from "./availability.ts";
import { BEAM_LIVE_ENV, BEAM_TEST_ENV, makeBeamKit } from "./beamTestkit.ts";
import { createBookingAnalytics } from "./clientAnalytics.ts";
import type { RecordedBookingEvent } from "./clientAnalytics.ts";
import { getPublicBookingConfig, toPublicConfig } from "./config.ts";
import type { Env } from "./config.ts";
import { addDays } from "./dates.ts";
import { demoInventory } from "./demoProvider.ts";
import {
  CHOOSE_METHOD_HINT,
  DEMO_COPY_CONFIG,
  PROMPTPAY_HINT,
  beamSecurePayment,
  feeLineHidden,
  noFeeAlternative,
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
/** Every Beam method-choice page shape: playground (defaults and each switch), beam-live, and a locked Beam page. */
const BEAM_PAGES: Record<string, () => PublicBookingConfig> = {
  playground: () => beamPage(),
  "wechat-on": () => beamPage({ BEAM_WECHAT_PAY: "on" }),
  "ewallets-off": () => beamPage({ BEAM_EWALLETS: "off" }),
  "promptpay-off": () => beamPage({ BEAM_PROMPTPAY: "off" }),
  "promptpay-fee-1": () => beamPage({ BEAM_PROMPTPAY_FEE_PCT: "1" }),
  live: beamLivePage,
  locked: () => config(BEAM_LIVE_ENV),
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

test("results and room cards on Beam (design S5.2): '+ 3% payment processing fee by card or e-wallet (none with PromptPay)'", () => {
  assert.deepEqual(resultsFeeNotes(beamPage()), {
    card: "+ 3% payment processing fee by card or e-wallet (none with PromptPay)",
    results: "Prices are for the stay; a 3% payment processing fee is added when you pay by card or e-wallet (none with PromptPay).",
  });
  assert.deepEqual(resultsFeeNotes(beamPage({ BEAM_EWALLETS: "off" }))?.card, "+ 3% payment processing fee by card (none with PromptPay)");
  assert.deepEqual(resultsFeeNotes(beamPage({ BEAM_PROMPTPAY: "off" })), {
    card: "+ 3% payment processing fee",
    results: "Prices are for the stay; a 3% payment processing fee is added to every online payment.",
  });
  assert.equal(resultsFeeNotes(beamPage({ BEAM_PROMPTPAY_FEE_PCT: "1" }))?.card, "+ 3% payment processing fee by card or e-wallet (1% with PromptPay)");
  assert.equal(resultsFeeNotes(beamPage({ BOOKING_CARD_FEE_PCT: "0", BEAM_PROMPTPAY_FEE_PCT: "1" }))?.card, "+ 1% payment processing fee with PromptPay (none by card or e-wallet)");
  assert.deepEqual(resultsFeeNotes(beamPage({ BOOKING_CARD_FEE_PCT: "0" })), { card: null, results: null });
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
      assert.equal(noFeeAlternative(c, null), "No fee with Thai PromptPay QR", page);
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
  // A locked Beam page: payments are locked, so no choice is offered.
  assert.doesNotMatch(render(config(BEAM_LIVE_ENV), null), /name="payMethod"/);
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
      if (cfg.paymentStatus === "ok") assert.doesNotMatch(payButton(html), /disabled=""/, name);
    }
    const html = render(cfg, null, { error: refusal });
    assert.match(html, /Something in your reservation needs a look/, name);
    assert.doesNotMatch(html, /Choose how to pay/, name);
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
  for (const [name, env] of Object.entries(STRIPE_DEMO_ENVS)) {
    const cfg = config(env);
    const html = render(cfg, "promptpay");
    assert.match(html, new RegExp(`Payment processing fee \\(${cfg.cardFeePct}%\\)`), `${name}: the line stays, at 0% too`);
    assert.doesNotMatch(html, /No fee with Thai PromptPay QR/, name);
  }
});

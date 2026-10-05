import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOffers } from "./availability.ts";
import { analyticsEnabled, buildAnalyticsItem, createBookingAnalytics, purchaseParams } from "./clientAnalytics.ts";
import type { RecordedBookingEvent } from "./clientAnalytics.ts";
import { addDays } from "./dates.ts";
import { classifyDemoCard, formatCardNumber, isValidExpiry } from "./demoCards.ts";
import { demoInventory } from "./demoProvider.ts";
import { computeQuote } from "./quote.ts";
import type { BookingSummary, Quote } from "./types.ts";

/* ----------------------- browser stand-ins for emit() ----------------------- */

interface FakeWindow {
  dataLayer: unknown[];
  __bookingEvents?: RecordedBookingEvent[];
}

function fakeBrowser(): { win: FakeWindow; store: Map<string, string> } {
  const store = new Map<string, string>();
  const win: FakeWindow = { dataLayer: [] };
  Object.assign(globalThis, {
    window: win,
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  return { win, store };
}

/** A real demo quote (first stay where the Sunrise Suite is free). */
function sampleQuote(): Quote {
  for (let i = 0; i < 200; i++) {
    const checkIn = addDays("2026-11-02", i);
    const checkOut = addDays(checkIn, 3);
    const offers = buildOffers(demoInventory(checkIn, checkOut), 2);
    if (!offers.find((o) => o.slug === "sunrise-suite")?.available) continue;
    return computeQuote(
      {
        checkIn,
        checkOut,
        items: [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }],
        promo: null,
        pricing: { cardFeePct: 5, depositPct: 100 },
      },
      offers,
    );
  }
  throw new Error("no stay");
}

function sampleBooking(quote: Quote, ref: string): BookingSummary {
  return {
    ref,
    paymentMode: "beam-live",
    checkIn: quote.checkIn,
    checkOut: quote.checkOut,
    nights: quote.nights,
    items: [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }],
    itemRoomSatang: quote.lines.map((l) => l.roomSatang),
    promoCode: null,
    totalSatang: quote.totalSatang,
    cardFeeSatang: quote.cardFeeSatang,
    dueNowSatang: quote.dueNowSatang,
    createdAt: "2026-10-05T03:00:00.000Z",
    linkExpiresAt: "2026-10-05T03:30:00.000Z",
  };
}

const PII_KEYS = ["firstName", "lastName", "email", "phone", "dialCode", "first_name", "last_name"];

test("analytics only send in beam-live on the production deployment", () => {
  assert.equal(analyticsEnabled("demo", "production"), false);
  assert.equal(analyticsEnabled("beam-playground", "production"), false);
  assert.equal(analyticsEnabled("beam-live", "preview"), false);
  assert.equal(analyticsEnabled("beam-live", undefined), false);
  assert.equal(analyticsEnabled("beam-live", "production"), true);
});

test("ecommerce item mirrors the Cloudbeds shape (per-night price, nights quantity, no PII)", () => {
  const item = buildAnalyticsItem({
    slug: "sunrise-suite",
    ratePlanId: "standard",
    adults: 2,
    nights: 3,
    roomSatang: 1_875_000,
    checkIn: "2026-10-28",
    checkOut: "2026-10-31",
  });
  assert.deepEqual(item, {
    item_id: "462960",
    // Cloudbeds' roomTypeName, so GA4 never lists one item_id under two names.
    item_name: "Sunrise Seaview Private Jet Plunge Pool Suite",
    item_category: "accommodation",
    item_package_id: "0",
    item_package_name: "Standard Rate",
    price: 6250,
    quantity: 3,
    start_date: "2026-10-28",
    end_date: "2026-10-31",
    nights: 3,
    adults: 2,
    kids: 0,
    total_guests: 2,
    affiliation: "Magic Suites & Villas",
  });
});

test("disabled analytics never touch window.dataLayer; events are only recorded locally", () => {
  const { win } = fakeBrowser();
  const quote = sampleQuote();
  const analytics = createBookingAnalytics("demo", "production");
  assert.equal(analytics.enabled, false);
  analytics.addToCart(quote.lines[0], quote);
  analytics.beginCheckout(quote);
  assert.equal(win.dataLayer.length, 0);
  assert.deepEqual(
    win.__bookingEvents?.map((e) => e.name),
    ["add_to_cart", "begin_checkout"],
  );
  const begin = win.__bookingEvents?.[1].params;
  assert.equal(begin?.property_id, "235064");
  assert.equal(begin?.currency, "THB");
  assert.equal(begin?.subtotal, (quote.totalSatang - quote.cardFeeSatang) / 100);
  // beam-live outside the production deployment is still disabled.
  createBookingAnalytics("beam-live", "preview").addToCart(quote.lines[0], quote);
  assert.equal(win.dataLayer.length, 0);
});

test("enabled analytics push one gtag Arguments entry per event", () => {
  const { win } = fakeBrowser();
  const quote = sampleQuote();
  createBookingAnalytics("beam-live", "production").addToCart(quote.lines[0], quote);
  assert.equal(win.dataLayer.length, 1);
  const entry = Array.from(win.dataLayer[0] as ArrayLike<unknown>);
  assert.equal(entry[0], "event");
  assert.equal(entry[1], "add_to_cart");
  const params = entry[2] as Record<string, unknown>;
  assert.equal(params.property_id, "235064");
  assert.equal(params.be_source, "magicsamui-direct");
  assert.equal(params.value, quote.lines[0].roomSatang / 100);
});

test("purchase fires once per ref; the tab guard waits for gtag's event_callback", () => {
  const { win, store } = fakeBrowser();
  const quote = sampleQuote();
  const booking = sampleBooking(quote, "MSV-20261005-T3ST");
  const live = createBookingAnalytics("beam-live", "production");
  live.purchase(booking);
  live.purchase(booking);
  assert.equal(win.dataLayer.length, 1, "queued once");
  const params = Array.from(win.dataLayer[0] as ArrayLike<unknown>)[2] as Record<string, unknown>;
  assert.equal(params.transaction_id, booking.ref);
  assert.equal(params.value, booking.dueNowSatang / 100);
  assert.equal(params.tax, booking.cardFeeSatang / 100);
  assert.equal(params.subtotal, (booking.totalSatang - booking.cardFeeSatang) / 100);
  assert.equal(store.size, 0, "not marked sent before gtag confirms");
  (params.event_callback as () => void)();
  assert.equal(store.get("msv_booking_purchase_sent_MSV-20261005-T3ST"), "1");

  // Demo: recorded once, guard set straight away.
  const demoBooking = { ...sampleBooking(quote, "MSV-20261005-D3MO"), paymentMode: "demo" as const };
  const demo = createBookingAnalytics("demo", "production");
  demo.purchase(demoBooking);
  demo.purchase(demoBooking);
  assert.equal(win.__bookingEvents?.filter((e) => e.name === "purchase").length, 1);
  assert.equal(store.get("msv_booking_purchase_sent_MSV-20261005-D3MO"), "1");
});

test("no analytics payload carries personal data", () => {
  const { win } = fakeBrowser();
  const quote = sampleQuote();
  const analytics = createBookingAnalytics("demo", "production");
  analytics.addToCart(quote.lines[0], quote);
  analytics.removeFromCart(quote.lines[0], quote);
  analytics.beginCheckout(quote);
  analytics.addPaymentInfo(quote);
  analytics.helpShown();
  analytics.helpClick("whatsapp");
  analytics.purchase({ ...sampleBooking(quote, "MSV-20261005-PII0"), paymentMode: "demo" });
  const all = JSON.stringify([win.__bookingEvents, purchaseParams(sampleBooking(quote, "MSV-20261005-PII1"))]);
  for (const key of PII_KEYS) assert.equal(all.includes(`"${key}"`), false, key);
  assert.equal(win.__bookingEvents?.length, 7);
});

test("demo checkout accepts only Beam playground test cards", () => {
  assert.deepEqual(classifyDemoCard("4111 1111 1111 1111"), { ok: true, outcome: "paid", brand: "Visa" });
  assert.deepEqual(classifyDemoCard("5372074248113841"), { ok: true, outcome: "paid", brand: "Mastercard" });
  assert.deepEqual(classifyDemoCard("378282246310005"), { ok: true, outcome: "paid", brand: "Amex" });
  assert.deepEqual(classifyDemoCard("4111111111000025"), { ok: true, outcome: "declined", brand: "Visa" });
  assert.deepEqual(classifyDemoCard("4943129900084541"), { ok: true, outcome: "insufficient_funds", brand: "Visa" });
  const other = classifyDemoCard("4242424242424242");
  assert.equal(other.ok, false);
  if (!other.ok) assert.equal(other.message, "Demo only: use a Beam test card such as 4111 1111 1111 1111");
  assert.equal(formatCardNumber("378282246310005"), "3782 822463 10005");
  assert.equal(isValidExpiry("12/30", new Date("2026-10-05")), true);
  assert.equal(isValidExpiry("09/26", new Date("2026-10-05")), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { analyticsEnabled, buildAnalyticsItem } from "./clientAnalytics.ts";
import { classifyDemoCard, formatCardNumber, isValidExpiry } from "./demoCards.ts";

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
    item_name: item.item_name,
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

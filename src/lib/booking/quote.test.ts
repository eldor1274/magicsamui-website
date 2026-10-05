import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDONS } from "./catalogue.ts";
import { eachNight } from "./dates.ts";
import { formatThb, formatThbWithCode } from "./format.ts";
import {
  addonEligibleNights,
  buildRateOffers,
  computeQuote,
  demoNightlySatang,
  percentOf,
  rateTotalForAdults,
  resolvePromo,
  satangToBaht,
  QuoteError,
} from "./quote.ts";
import type { RoomOffer } from "./types.ts";

function offerFor(slug: string, referenceThb: number, checkIn: string, checkOut: string, adults = 2): RoomOffer {
  const nightly = eachNight(checkIn, checkOut).map((date) => ({ date, amountSatang: demoNightlySatang(referenceThb, date) }));
  return { slug, available: true, unavailableReason: null, remaining: 1, fitsParty: true, rates: buildRateOffers(nightly, adults) };
}

const PRICING = { cardFeePct: 5, depositPct: 100 };

test("demo nightly rate: weekend x1.1, high season x1.3, whole baht", () => {
  assert.equal(demoNightlySatang(4500, "2026-10-28"), 450_000); // Wed
  assert.equal(demoNightlySatang(4500, "2026-10-30"), 495_000); // Fri
  assert.equal(demoNightlySatang(4500, "2026-12-24"), 585_000); // Thu, high season
  assert.equal(demoNightlySatang(4500, "2026-12-25"), 643_500); // Fri, high season: 4500*1.43
  assert.equal(demoNightlySatang(1234, "2026-12-25"), 176_500); // 1764.62 -> 1765 THB
});

test("percentOf rounds half-up to a satang", () => {
  assert.equal(percentOf(1, 50), 1);
  assert.equal(percentOf(1_855_500, 5), 92_775);
  assert.equal(percentOf(1_948_275, 30), 584_483);
  assert.equal(percentOf(999, 2.5), 25);
});

test("full quote in satang: rooms, promo, add-on weekdays, visible card fee", () => {
  const checkIn = "2026-10-28";
  const checkOut = "2026-10-31"; // Wed, Thu, Fri nights
  const offers = [offerFor("sunrise-suite", 4500, checkIn, checkOut)];
  const q = computeQuote(
    {
      checkIn,
      checkOut,
      items: [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: ["breakfast-pp"] }],
      promo: { code: "DIRECT", pct: 10, label: "Direct" },
      pricing: PRICING,
    },
    offers,
  );
  assert.equal(q.nights, 3);
  assert.equal(q.roomsSubtotalSatang, 1_395_000); // 4500 + 4500 + 4950
  assert.equal(q.addonsSubtotalSatang, 600_000); // 3 eligible nights x 2 guests x 1,000
  assert.equal(q.promo?.discountSatang, 139_500); // 10% of rooms only
  assert.equal(q.feeBaseSatang, 1_855_500);
  assert.equal(q.cardFeeSatang, 92_775);
  assert.equal(q.totalSatang, 1_948_275);
  assert.equal(q.dueNowSatang, 1_948_275);
  assert.equal(q.balanceSatang, 0);
  assert.equal(formatThbWithCode(q.totalSatang), "THB 19,482.75");
  for (const v of [q.roomsSubtotalSatang, q.cardFeeSatang, q.totalSatang, q.dueNowSatang]) {
    assert.equal(Number.isInteger(v), true);
  }
});

test("breakfast rate plan adds 1,000 THB per guest per night at the chosen adults", () => {
  const checkIn = "2026-11-02";
  const checkOut = "2026-11-05"; // Mon-Wed nights, no weekend
  const offers = [offerFor("seaview-2br", 6000, checkIn, checkOut, 4)];
  const breakfast = offers[0].rates.find((r) => r.ratePlanId === "breakfast");
  assert.ok(breakfast);
  assert.equal(breakfast.totalSatang, (18_000 + 12_000) * 100); // 3 x 6000 + 3 x 4 x 1000
  assert.equal(rateTotalForAdults(breakfast, 3), (18_000 + 9_000) * 100);
  const q = computeQuote(
    {
      checkIn,
      checkOut,
      items: [{ slug: "seaview-2br", ratePlanId: "breakfast", adults: 3, addonIds: [] }],
      promo: null,
      pricing: PRICING,
    },
    offers,
  );
  assert.equal(q.roomsSubtotalSatang, 2_700_000);
  assert.deepEqual(
    q.lines[0].nightly.map((n) => n.amountSatang),
    [900_000, 900_000, 900_000],
  );
});

test("add-on only counts Wed/Thu/Fri nights", () => {
  const addon = ADDONS["breakfast-pp"];
  assert.deepEqual(addonEligibleNights(addon, "2026-11-01", "2026-11-08"), ["2026-11-04", "2026-11-05", "2026-11-06"]);
  assert.deepEqual(addonEligibleNights(addon, "2026-11-07", "2026-11-10"), []); // Sat-Mon
});

test("deposit percentage and minimum charge", () => {
  const checkIn = "2026-11-02";
  const checkOut = "2026-11-03";
  const offers = [offerFor("garden-suite", 3000, checkIn, checkOut)];
  const q = computeQuote(
    { checkIn, checkOut, items: [{ slug: "garden-suite", ratePlanId: "standard", adults: 1, addonIds: [] }], promo: null, pricing: { cardFeePct: 5, depositPct: 30 } },
    offers,
  );
  assert.equal(q.totalSatang, 315_000);
  assert.equal(q.dueNowSatang, 94_500);
  assert.equal(q.balanceSatang, 220_500);
});

test("multiple rooms sum per line; missing rate throws QuoteError", () => {
  const checkIn = "2026-11-02";
  const checkOut = "2026-11-04";
  const offers = [offerFor("garden-suite", 3000, checkIn, checkOut), offerFor("sunrise-suite", 4500, checkIn, checkOut)];
  const q = computeQuote(
    {
      checkIn,
      checkOut,
      items: [
        { slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] },
        { slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] },
      ],
      promo: null,
      pricing: { cardFeePct: 0, depositPct: 100 },
    },
    offers,
  );
  assert.equal(q.roomsSubtotalSatang, 1_500_000);
  assert.equal(q.cardFeeSatang, 0);
  assert.throws(
    () =>
      computeQuote(
        { checkIn, checkOut, items: [{ slug: "honeymoon-suite", ratePlanId: "standard", adults: 2, addonIds: [] }], promo: null, pricing: PRICING },
        offers,
      ),
    QuoteError,
  );
});

test("promo codes: DIRECT any case, unknown codes get a friendly error", () => {
  assert.deepEqual(resolvePromo(" direct ", 10), { code: "DIRECT", valid: true, pct: 10, label: "Direct booking discount (10%)" });
  const bad = resolvePromo("SUMMER", 10);
  assert.equal(bad?.valid, false);
  assert.equal(resolvePromo("", 10), null);
  assert.equal(resolvePromo("DIRECT", 0)?.valid, false);
  // Only the demo (promo switched on) hints at DIRECT; otherwise the message stays neutral.
  assert.match(bad && !bad.valid ? bad.message : "", /Try DIRECT/);
  const off = resolvePromo("SUMMER", 0);
  assert.equal(off && !off.valid && off.message.includes("DIRECT"), false);
});

test("occupancy extras are added per stay at the booked party size", () => {
  const nightly = [{ date: "2026-11-11", amountSatang: 900_000 }, { date: "2026-11-12", amountSatang: 900_000 }];
  const extra = { "3": 150_000, "4": 300_000 };
  const [standard, breakfast] = buildRateOffers(nightly, 3, extra);
  assert.equal(standard.totalSatang, 1_800_000 + 150_000);
  assert.equal(rateTotalForAdults(standard, 2), 1_800_000);
  assert.equal(rateTotalForAdults(standard, 4), 2_100_000);
  assert.equal(rateTotalForAdults(breakfast, 4), 2_100_000 + 100_000 * 4 * 2);
  const offer = { slug: "seaview-2br", available: true, unavailableReason: null, remaining: 1, fitsParty: true, rates: [standard, breakfast] };
  const q = computeQuote(
    { checkIn: "2026-11-11", checkOut: "2026-11-13", items: [{ slug: "seaview-2br", ratePlanId: "standard", adults: 4, addonIds: [] }], promo: null, pricing: { cardFeePct: 0, depositPct: 100 } },
    [offer],
  );
  assert.equal(q.lines[0].occupancyExtraSatang, 300_000);
  assert.equal(q.lines[0].roomSatang, 2_100_000);
});

test("money formatting from integers", () => {
  assert.equal(formatThb(1_875_000), "18,750.00");
  assert.equal(formatThb(93_750), "937.50");
  assert.equal(formatThb(5), "0.05");
  assert.equal(formatThb(-139_500), "-1,395.00");
  assert.equal(satangToBaht(1_968_750), 19_687.5);
});

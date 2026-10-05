import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOffers } from "./availability.ts";
import { ROOM_UNITS } from "./catalogue.ts";
import { addDays, eachNight, isHighSeason, isWeekendNight } from "./dates.ts";
import { areUnitsFree, demoInventory, isUnitBooked } from "./demoProvider.ts";
import type { UnitId } from "./types.ts";

const UNITS: UnitId[] = ["HM", "SR", "GS", "SVL", "TUX", "TUXL"];

test("demo availability is deterministic", () => {
  const a = demoInventory("2026-11-10", "2026-11-13");
  const b = demoInventory("2026-11-10", "2026-11-13");
  assert.deepEqual(a, b);
});

test("about 35% of unit-nights are booked, denser at weekends and in high season", () => {
  let booked = 0;
  let total = 0;
  let wkBooked = 0;
  let wkTotal = 0;
  let hsBooked = 0;
  let hsTotal = 0;
  let lowWeekdayBooked = 0;
  let lowWeekdayTotal = 0;
  for (let i = 0; i < 540; i++) {
    const d = addDays("2026-10-05", i);
    for (const u of UNITS) {
      const b = isUnitBooked(u, d) ? 1 : 0;
      booked += b;
      total += 1;
      if (isWeekendNight(d)) {
        wkBooked += b;
        wkTotal += 1;
      }
      if (isHighSeason(d)) {
        hsBooked += b;
        hsTotal += 1;
      } else if (!isWeekendNight(d)) {
        lowWeekdayBooked += b;
        lowWeekdayTotal += 1;
      }
    }
  }
  const rate = booked / total;
  assert.ok(rate > 0.28 && rate < 0.45, `overall occupancy ${rate.toFixed(3)}`);
  assert.ok(hsBooked / hsTotal > lowWeekdayBooked / lowWeekdayTotal, "high season denser");
  assert.ok(wkBooked / wkTotal > lowWeekdayBooked / lowWeekdayTotal, "weekends denser");
});

test("a room type is available only when all its units are free every night", () => {
  const checkIn = "2026-11-10";
  const checkOut = "2026-11-14";
  const nights = eachNight(checkIn, checkOut);
  const inv = demoInventory(checkIn, checkOut);
  for (const room of inv) {
    assert.equal(room.available, areUnitsFree(ROOM_UNITS[room.slug], nights), room.slug);
    assert.equal(room.remaining, room.available ? 1 : 0);
    assert.equal(room.baseNightly.length, room.available ? nights.length : 0);
  }
  // A combo can't be available while one of its suites is sold out.
  const bySlug = new Map(inv.map((r) => [r.slug, r]));
  if (!bySlug.get("honeymoon-suite")?.available) assert.equal(bySlug.get("tower-club-3br")?.available, false);
});

test("most searches show some sold-out rooms and some available rooms", () => {
  let mixed = 0;
  const searches = 40;
  for (let i = 0; i < searches; i++) {
    const checkIn = addDays("2026-10-20", i * 9);
    const offers = buildOffers(demoInventory(checkIn, addDays(checkIn, 3)), 2);
    const bookable = offers.filter((o) => o.unavailableReason !== "not-bookable");
    const avail = bookable.filter((o) => o.available).length;
    if (avail > 0 && avail < bookable.length) mixed++;
  }
  assert.ok(mixed / searches > 0.7, `mixed results in ${mixed}/${searches} searches`);
});

test("offers include tuxedo-3br as not bookable and flag party fit", () => {
  const offers = buildOffers(demoInventory("2026-11-10", "2026-11-12"), 4);
  const tux3 = offers.find((o) => o.slug === "tuxedo-3br");
  assert.equal(tux3?.unavailableReason, "not-bookable");
  assert.equal(offers.find((o) => o.slug === "garden-suite")?.fitsParty, false);
  assert.equal(offers.find((o) => o.slug === "seaview-2br")?.fitsParty, true);
});

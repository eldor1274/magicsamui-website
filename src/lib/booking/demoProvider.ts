// Demo inventory: deterministic, realistic-looking occupancy so the preview
// works with no Cloudbeds key and gives the same answer for the same dates.
//
// Each physical unit gets a simulated booking history: walking day by day
// from a fixed epoch, a stay of 2-6 nights starts with a small probability
// (higher on Friday/Saturday and in high season). Stays come out as runs of
// booked nights like a real calendar, with roughly 35% of unit-nights booked
// overall. A room type is available only when all its units are free on
// every night of the stay.

import { getBookableRooms } from "./catalogue.ts";
import { addDays, compareIso, eachNight, isHighSeason, isWeekendNight } from "./dates.ts";
import { demoNightlySatang } from "./quote.ts";
import type { IsoDate, RoomInventory, UnitId } from "./types.ts";

const EPOCH: IsoDate = "2025-01-01";

/** Deterministic hash -> [0, 1). FNV-1a with a murmur3 finaliser for good spread. */
export function hashUnit(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4_294_967_296;
}

function stayStartProbability(date: IsoDate): number {
  if (isHighSeason(date)) return isWeekendNight(date) ? 0.3 : 0.22;
  return isWeekendNight(date) ? 0.17 : 0.1;
}

interface UnitCalendar {
  computedUntil: IsoDate;
  booked: Set<IsoDate>;
  /** Next date the simulation resumes from (may be past computedUntil mid-stay). */
  cursor: IsoDate;
}

const calendars = new Map<UnitId, UnitCalendar>();

function extendCalendar(unit: UnitId, until: IsoDate): UnitCalendar {
  let cal = calendars.get(unit);
  if (!cal) {
    cal = { computedUntil: addDays(EPOCH, -1), booked: new Set(), cursor: EPOCH };
    calendars.set(unit, cal);
  }
  if (compareIso(cal.computedUntil, until) >= 0) return cal;
  let d = cal.cursor;
  while (compareIso(d, until) <= 0) {
    if (hashUnit(`${unit}|${d}|start`) < stayStartProbability(d)) {
      const length = 2 + Math.floor(hashUnit(`${unit}|${d}|len`) * 5); // 2..6 nights
      for (let i = 0; i < length; i++) cal.booked.add(addDays(d, i));
      d = addDays(d, length);
    } else {
      d = addDays(d, 1);
    }
  }
  cal.cursor = d;
  cal.computedUntil = until;
  return cal;
}

/** Whether a unit is booked on the night starting `date` in the demo calendar. */
export function isUnitBooked(unit: UnitId, date: IsoDate): boolean {
  if (compareIso(date, EPOCH) < 0) return false;
  return extendCalendar(unit, date).booked.has(date);
}

export function areUnitsFree(units: UnitId[], nights: IsoDate[]): boolean {
  return units.every((u) => nights.every((n) => !isUnitBooked(u, n)));
}

/** Demo availability + nightly rates for every bookable room type. */
export function demoInventory(checkIn: IsoDate, checkOut: IsoDate): RoomInventory[] {
  const nights = eachNight(checkIn, checkOut);
  return getBookableRooms().map((room) => {
    const available = areUnitsFree(room.units, nights);
    return {
      slug: room.slug,
      available,
      remaining: available ? 1 : 0,
      baseNightly: available
        ? nights.map((date) => ({ date, amountSatang: demoNightlySatang(room.referencePriceThb, date) }))
        : [],
    };
  });
}

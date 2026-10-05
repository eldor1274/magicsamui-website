import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  addMonths,
  diffDays,
  eachNight,
  formatDisplayDate,
  formatStayRange,
  isHighSeason,
  isIsoDate,
  isWeekendNight,
  monthGrid,
  nightsBetween,
  todayInBangkok,
  validateStayDates,
  weekday,
} from "./dates.ts";

test("isIsoDate accepts real dates only", () => {
  assert.equal(isIsoDate("2026-10-28"), true);
  assert.equal(isIsoDate("2028-02-29"), true);
  assert.equal(isIsoDate("2026-02-29"), false);
  assert.equal(isIsoDate("2026-13-01"), false);
  assert.equal(isIsoDate("2026-1-01"), false);
  assert.equal(isIsoDate(20261028), false);
});

test("todayInBangkok uses UTC+7 regardless of host time zone", () => {
  assert.equal(todayInBangkok(new Date("2026-10-04T16:59:59Z")), "2026-10-04");
  assert.equal(todayInBangkok(new Date("2026-10-04T17:00:00Z")), "2026-10-05");
  assert.equal(todayInBangkok(new Date("2026-12-31T17:30:00Z")), "2027-01-01");
});

test("day arithmetic across month, year and leap boundaries", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(diffDays("2026-10-28", "2026-10-31"), 3);
  assert.equal(nightsBetween("2026-12-30", "2027-01-02"), 3);
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2026-10-05", 18), "2028-04-05");
});

test("eachNight is check-in inclusive, check-out exclusive", () => {
  assert.deepEqual(eachNight("2026-10-28", "2026-10-31"), ["2026-10-28", "2026-10-29", "2026-10-30"]);
  assert.deepEqual(eachNight("2026-10-28", "2026-10-28"), []);
});

test("weekday, weekend nights and high season", () => {
  assert.equal(weekday("2026-10-28"), 3); // Wednesday
  assert.equal(isWeekendNight("2026-10-30"), true); // Friday
  assert.equal(isWeekendNight("2026-10-31"), true); // Saturday
  assert.equal(isWeekendNight("2026-11-01"), false); // Sunday
  assert.equal(isHighSeason("2026-12-19"), false);
  assert.equal(isHighSeason("2026-12-20"), true);
  assert.equal(isHighSeason("2027-01-10"), true);
  assert.equal(isHighSeason("2027-01-11"), false);
  assert.equal(isHighSeason("2027-07-01"), true);
  assert.equal(isHighSeason("2027-08-31"), true);
  assert.equal(isHighSeason("2027-09-01"), false);
});

test("validateStayDates enforces past, order, 30 nights and 18-month window", () => {
  const limits = { today: "2026-10-05", maxNights: 30, bookingWindowMonths: 18 };
  assert.equal(validateStayDates("2026-10-05", "2026-10-06", limits), null);
  assert.equal(validateStayDates("2026-10-04", "2026-10-06", limits), "checkin_in_past");
  assert.equal(validateStayDates("2026-10-10", "2026-10-10", limits), "checkout_not_after_checkin");
  assert.equal(validateStayDates("2026-10-10", "2026-11-09", limits), null); // 30 nights
  assert.equal(validateStayDates("2026-10-10", "2026-11-10", limits), "too_many_nights");
  assert.equal(validateStayDates("2028-04-01", "2028-04-05", limits), null);
  assert.equal(validateStayDates("2028-04-03", "2028-04-06", limits), "beyond_booking_window");
  assert.equal(validateStayDates("2026-02-30", "2026-03-02", limits), "invalid_date");
});

test("display formats match Cloudbeds", () => {
  assert.equal(formatDisplayDate("2026-10-28"), "Oct 28, 2026");
  assert.equal(formatStayRange("2026-10-28", "2026-10-31"), "Oct 28, 2026 → Oct 31, 2026");
});

test("monthGrid pads to whole Sunday-first weeks", () => {
  const grid = monthGrid(2026, 9); // October 2026 starts on a Thursday
  assert.equal(grid[0].slice(0, 4).every((c) => c === null), true);
  assert.equal(grid[0][4], "2026-10-01");
  assert.equal(grid.every((w) => w.length === 7), true);
  assert.equal(grid.flat().filter(Boolean).length, 31);
});

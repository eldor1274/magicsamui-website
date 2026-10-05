// Small, pure calendar-date helpers. All dates are ISO "YYYY-MM-DD" strings
// for the property's local calendar (Asia/Bangkok). Arithmetic runs on UTC
// midnights so the host machine's time zone can never shift a day.
// Thailand is UTC+7 all year (no daylight saving since 1920), so "today in
// Bangkok" is a fixed offset from UTC.

import type { IsoDate } from "./types.ts";

const DAY_MS = 86_400_000;
const BANGKOK_OFFSET_MS = 7 * 3_600_000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
export const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAYS_MIN = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
export const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** True for a real calendar date in "YYYY-MM-DD" form (rejects 2026-02-30). */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string") return false;
  const m = ISO_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo - 1);
}

/** monthIndex is 0-based. */
export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function toUtcMs(date: IsoDate): number {
  const m = ISO_RE.exec(date);
  if (!m) throw new RangeError(`Invalid ISO date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fromUtcMs(ms: number): IsoDate {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function toIsoDate(year: number, monthIndex: number, day: number): IsoDate {
  return fromUtcMs(Date.UTC(year, monthIndex, day));
}

export function parseIsoDate(date: IsoDate): { year: number; monthIndex: number; day: number } {
  const ms = toUtcMs(date);
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), monthIndex: d.getUTCMonth(), day: d.getUTCDate() };
}

/** Today's date on the property's calendar (Asia/Bangkok). */
export function todayInBangkok(now: Date = new Date()): IsoDate {
  return fromUtcMs(Math.floor((now.getTime() + BANGKOK_OFFSET_MS) / DAY_MS) * DAY_MS);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** Adds calendar months, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const { year, monthIndex, day } = parseIsoDate(date);
  const target = new Date(Date.UTC(year, monthIndex + months, 1));
  const y = target.getUTCFullYear();
  const mi = target.getUTCMonth();
  return toIsoDate(y, mi, Math.min(day, daysInMonth(y, mi)));
}

/** Whole days from a to b (b - a). */
export function diffDays(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

export function compareIso(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function nightsBetween(checkIn: IsoDate, checkOut: IsoDate): number {
  return diffDays(checkIn, checkOut);
}

/** The dates of each night of a stay: check-in inclusive, check-out exclusive. */
export function eachNight(checkIn: IsoDate, checkOut: IsoDate): IsoDate[] {
  const n = diffDays(checkIn, checkOut);
  const out: IsoDate[] = [];
  for (let i = 0; i < n; i++) out.push(addDays(checkIn, i));
  return out;
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekday(date: IsoDate): number {
  return new Date(toUtcMs(date)).getUTCDay();
}

/** Friday and Saturday nights. */
export function isWeekendNight(date: IsoDate): boolean {
  const w = weekday(date);
  return w === 5 || w === 6;
}

/** High season nights: 20 Dec - 10 Jan and 1 Jul - 31 Aug (inclusive). */
export function isHighSeason(date: IsoDate): boolean {
  const { monthIndex, day } = parseIsoDate(date);
  if (monthIndex === 11 && day >= 20) return true;
  if (monthIndex === 0 && day <= 10) return true;
  return monthIndex === 6 || monthIndex === 7;
}

export interface StayValidationLimits {
  today: IsoDate;
  maxNights: number;
  bookingWindowMonths: number;
}

export type StayDateError =
  | "invalid_date"
  | "checkin_in_past"
  | "checkout_not_after_checkin"
  | "too_many_nights"
  | "beyond_booking_window";

/** Validates a stay; returns null when fine. */
export function validateStayDates(
  checkIn: unknown,
  checkOut: unknown,
  limits: StayValidationLimits,
): StayDateError | null {
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) return "invalid_date";
  if (compareIso(checkIn, limits.today) < 0) return "checkin_in_past";
  const nights = diffDays(checkIn, checkOut);
  if (nights < 1) return "checkout_not_after_checkin";
  if (nights > limits.maxNights) return "too_many_nights";
  if (compareIso(checkOut, addMonths(limits.today, limits.bookingWindowMonths)) > 0) {
    return "beyond_booking_window";
  }
  return null;
}

export const STAY_DATE_ERROR_MESSAGES: Record<StayDateError, string> = {
  invalid_date: "Please choose valid check-in and check-out dates.",
  checkin_in_past: "Check-in can't be in the past.",
  checkout_not_after_checkin: "Check-out must be at least one night after check-in.",
  too_many_nights: "Online bookings are limited to 30 nights - message us for longer stays.",
  beyond_booking_window: "We take bookings up to 18 months ahead.",
};

/* ------------------------------ display ------------------------------ */

/** "Oct 28, 2026" (the Cloudbeds format). */
export function formatDisplayDate(date: IsoDate): string {
  const { year, monthIndex, day } = parseIsoDate(date);
  return `${MONTHS_SHORT[monthIndex]} ${day}, ${year}`;
}

/** "Wed, Oct 28, 2026". */
export function formatDisplayDateWithWeekday(date: IsoDate): string {
  return `${WEEKDAYS_SHORT[weekday(date)]}, ${formatDisplayDate(date)}`;
}

/** "October 2026" (monthIndex 0-based). */
export function formatMonthLabel(year: number, monthIndex: number): string {
  return `${MONTHS_LONG[monthIndex]} ${year}`;
}

/** "Oct 28, 2026 → Oct 31, 2026". */
export function formatStayRange(checkIn: IsoDate, checkOut: IsoDate, separator = " → "): string {
  return `${formatDisplayDate(checkIn)}${separator}${formatDisplayDate(checkOut)}`;
}

export function formatNights(n: number): string {
  return `${n} ${n === 1 ? "Night" : "Nights"}`;
}

/**
 * Calendar grid for one month: weeks (Sunday first) of ISO dates, with null
 * for the padding cells before day 1 and after the last day.
 */
export function monthGrid(year: number, monthIndex: number): (IsoDate | null)[][] {
  const first = toIsoDate(year, monthIndex, 1);
  const lead = weekday(first);
  const total = daysInMonth(year, monthIndex);
  const cells: (IsoDate | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= total; d++) cells.push(toIsoDate(year, monthIndex, d));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (IsoDate | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Shifts a {year, monthIndex} pair by n months. */
export function shiftMonth(year: number, monthIndex: number, n: number): { year: number; monthIndex: number } {
  const d = new Date(Date.UTC(year, monthIndex + n, 1));
  return { year: d.getUTCFullYear(), monthIndex: d.getUTCMonth() };
}

/** "20261028" - compact form used in booking references. */
export function compactDate(date: IsoDate): string {
  return date.replace(/-/g, "");
}

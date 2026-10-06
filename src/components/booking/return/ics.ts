// OWNER: ui-checkout
// Builds an "Add to calendar" .ics file for a confirmed stay, in the
// browser. Contains the booking reference and stay facts only (no PII).
// Koh Samui is UTC+7 all year (no daylight saving), so local check-in
// 15:00 = 08:00Z and check-out 11:00 = 04:00Z (the times in HOUSE_POLICIES).

import { site } from "@/data/site";
import { HOUSE_POLICIES } from "@/lib/booking/catalogue";
import { isBookingRef } from "@/lib/booking/ref";
import type { IsoDate } from "@/lib/booking/types";

const BANGKOK_OFFSET_HOURS = 7;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "2026-10-28" + 15 (local hour) -> "20261028T080000Z". */
export function bangkokLocalToUtcStamp(date: IsoDate, localHour: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d, localHour - BANGKOK_OFFSET_HOURS, 0, 0));
  return `${utc.getUTCFullYear()}${pad(utc.getUTCMonth() + 1)}${pad(utc.getUTCDate())}T${pad(utc.getUTCHours())}0000Z`;
}

function utcStamp(at: Date): string {
  return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`;
}

/** RFC 5545 TEXT escaping. */
function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Folds content lines longer than 75 characters (continuation lines start with a space). */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length > 0) {
    parts.push(` ${rest.slice(0, 74)}`);
    rest = rest.slice(74);
  }
  return parts.join("\r\n");
}

export interface StayCalendarInput {
  ref: string;
  checkIn: IsoDate;
  checkOut: IsoDate;
  rooms: string[];
  now?: Date;
}

export function buildStayIcs({ ref: rawRef, checkIn, checkOut, rooms, now = new Date() }: StayCalendarInput): string {
  // Only a well-formed reference goes into the file (it is also the UID, a
  // property that is not TEXT-escaped): never a raw value with line breaks.
  const ref = isBookingRef(rawRef) ? rawRef : "booking";
  const description = [
    ref === "booking" ? "" : `Booking reference ${ref}`,
    rooms.length > 0 ? `Rooms: ${rooms.join(", ")}` : "",
    `${HOUSE_POLICIES.checkIn}. ${HOUSE_POLICIES.checkOut}.`,
    `Questions: WhatsApp ${site.phones[0].number}`,
  ]
    .filter(Boolean)
    .join("\n");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Magic Suites & Villas//Direct booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${ref === "booking" ? `booking-${utcStamp(now)}` : ref}@${site.domain}`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${bangkokLocalToUtcStamp(checkIn, 15)}`,
    `DTEND:${bangkokLocalToUtcStamp(checkOut, 11)}`,
    `SUMMARY:${escapeText(`Stay at ${site.name}`)}`,
    `LOCATION:${escapeText(site.address)}`,
    `DESCRIPTION:${escapeText(description)}`,
    `URL:https://${site.domain}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** Triggers a download of the .ics file (browser only). */
export function downloadIcs(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

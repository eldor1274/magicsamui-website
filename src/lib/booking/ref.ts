// Booking reference format, shared by the server (token.ts) and the browser
// (return page, calendar file). Isomorphic: no Node APIs.

/** "MSV-20261005-7F3K": creation date (Bangkok) + 4 characters without 0/O/1/I. */
export const BOOKING_REF_RE = /^MSV-\d{8}-[A-HJ-NP-Z2-9]{4}$/;

export function isBookingRef(v: unknown): v is string {
  return typeof v === "string" && BOOKING_REF_RE.test(v);
}

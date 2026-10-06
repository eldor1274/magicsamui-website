// Staff access for Stage B (Stripe TEST keys with REAL Cloudbeds writes).
//
// Cloudbeds has no sandbox, so a test hold blocks real OTA inventory. The
// test guest email alone is not a secret (it may be a published address), so
// a test hold also needs this browser to carry the staff cookie: POST the
// BOOKING_TEST_ACCESS_KEY to /api/booking/test-access once, and the server
// sets an httpOnly cookie holding an HMAC of the key (never the key itself).
// Server only.

import { createHmac, timingSafeEqual } from "node:crypto";

export const TEST_ACCESS_COOKIE = "msv_booking_test_access";
/** How long the staff cookie lasts (seconds). */
export const TEST_ACCESS_MAX_AGE = 12 * 3600;

/** The cookie value for an access key: HMAC(tokenSecret, key), so the key itself never sits in a browser. */
export function testAccessCookieValue(tokenSecret: string, accessKey: string): string {
  return createHmac("sha256", tokenSecret).update(`msv-test-access|${accessKey}`).digest("hex");
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** True when the presented key equals the configured one (constant time). */
export function testAccessKeyMatches(configured: string | null, presented: unknown): boolean {
  return configured !== null && typeof presented === "string" && sameString(configured, presented.trim());
}

/** True when the request's cookie value proves the staff key. */
export function hasTestAccess(accessKey: string | null, tokenSecret: string, cookieValue: string | null | undefined): boolean {
  if (!accessKey || !cookieValue) return false;
  return sameString(cookieValue, testAccessCookieValue(tokenSecret, accessKey));
}

/** Reads one cookie from a Cookie header (no dependency on next/headers, so it is testable). */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return null;
}

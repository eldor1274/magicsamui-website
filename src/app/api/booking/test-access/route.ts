import { getBookingConfig } from "@/lib/booking/config";
import { apiError, clientIp, createRateLimiter, json, logEvent, readJsonBody } from "@/lib/booking/routeUtils";
import { TEST_ACCESS_COOKIE, TEST_ACCESS_MAX_AGE, testAccessCookieValue, testAccessKeyMatches } from "@/lib/booking/testAccess";

// Stage B only (Stripe TEST keys + REAL Cloudbeds writes): staff unlock test
// holds in THIS browser by posting BOOKING_TEST_ACCESS_KEY once:
//   fetch("/api/booking/test-access", { method: "POST",
//     headers: { "content-type": "application/json" },
//     body: JSON.stringify({ key: "<BOOKING_TEST_ACCESS_KEY>" }) })
// The answer sets an httpOnly cookie holding an HMAC of the key (never the
// key). DELETE clears it. 404 in every other mode, so it reveals nothing.
export const runtime = "nodejs";

const isRateLimited = createRateLimiter(5, 10 * 60_000);

function guardActive() {
  try {
    const config = getBookingConfig();
    return config.testGuard?.accessKey ? { config, accessKey: config.testGuard.accessKey } : null;
  } catch {
    return null;
  }
}

function cookie(value: string, maxAge: number): string {
  return `${TEST_ACCESS_COOKIE}=${value}; Path=/api/booking; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

export async function POST(request: Request) {
  const active = guardActive();
  if (!active) return apiError(404, "not_found", "Not found.");
  if (isRateLimited(clientIp(request))) return apiError(429, "rate_limited", "Too many attempts - please wait a few minutes.");
  const body = await readJsonBody(request, 1_024);
  if (!body.ok) return body.response;
  const key = typeof body.value === "object" && body.value !== null ? (body.value as Record<string, unknown>).key : undefined;
  if (!testAccessKeyMatches(active.accessKey, key)) {
    logEvent("test_access_refused");
    return apiError(403, "invalid_request", "Not accepted.");
  }
  logEvent("test_access_granted");
  const res = json({ ok: true, validForHours: TEST_ACCESS_MAX_AGE / 3600 });
  res.headers.append("Set-Cookie", cookie(testAccessCookieValue(active.config.tokenSecret, active.accessKey), TEST_ACCESS_MAX_AGE));
  return res;
}

export async function DELETE() {
  const res = json({ ok: true });
  res.headers.append("Set-Cookie", cookie("", 0));
  return res;
}

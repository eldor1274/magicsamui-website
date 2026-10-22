import { runCheckout } from "@/lib/booking/checkout";
import { getBookingConfig } from "@/lib/booking/config";
import type { BookingConfig } from "@/lib/booking/config";
import {
  apiError,
  clientIp,
  configErrorResponse,
  createRateLimiter,
  json,
  logEvent,
  readJsonBody,
} from "@/lib/booking/routeUtils";
import { getBeamDeps, getStripeDeps } from "@/lib/booking/runtime";
import { TEST_ACCESS_COOKIE, readCookie } from "@/lib/booking/testAccess";
import { resolveOrigin } from "@/lib/booking/urls";

// Booking checkout: re-quotes on the server (the client never sends prices),
// then demo -> simulated payment page; stripe and beam -> HOLD FIRST in
// Cloudbeds, assert the price, then a Stripe Checkout Session (see
// lib/booking/stripeCheckout.ts) or a Beam payment link of the guest's method
// group (lib/booking/beamCheckout.ts; Beam design S4.6).
export const runtime = "nodejs";
export const maxDuration = 30;
/** The checkout chain answers by this long after the request arrived (maxDuration minus a margin). */
const CHECKOUT_BUDGET_MS = 25_000;

const isRateLimited = createRateLimiter(10, 10 * 60_000);

export async function POST(request: Request) {
  const deadlineMs = Date.now() + CHECKOUT_BUDGET_MS;
  let config: BookingConfig;
  try {
    config = getBookingConfig();
  } catch (e) {
    return configErrorResponse(e);
  }
  if (isRateLimited(clientIp(request))) {
    return apiError(429, "rate_limited", "Too many attempts - please wait a few minutes and try again.");
  }
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  try {
    const result = await runCheckout(body.value, {
      config,
      origin: resolveOrigin(request.headers.get("host"), process.env),
      log: logEvent,
      stripe: getStripeDeps(config) ?? undefined,
      // Beam modes: every Beam call ends by the route's deadline too (null outside the Beam modes).
      beam: getBeamDeps(config, { deadlineMs }) ?? undefined,
      clientIp: clientIp(request) === "unknown" ? null : clientIp(request),
      testAccessToken: readCookie(request.headers.get("cookie"), TEST_ACCESS_COOKIE),
      deadlineMs,
    });
    return json(result.body, result.status);
  } catch (e) {
    logEvent("checkout_error", { message: e instanceof Error ? e.message : String(e) });
    return apiError(500, "server_error", "Something went wrong on our side. Nothing has been charged.");
  }
}

import type { NextRequest } from "next/server";
import { getFulfilmentConfig } from "@/lib/booking/config";
import type { BookingConfig } from "@/lib/booking/config";
import { apiError, clientIp, configErrorResponse, createRateLimiter, json, logEvent } from "@/lib/booking/routeUtils";
import { providerDepsFor } from "@/lib/booking/runtime";
import { runStatus } from "@/lib/booking/status";

// Payment status for the return page: verifies the signed booking token,
// then reads a signed demo proof (demo), or asks the provider (Stripe, Beam)
// - and, in the hold-first modes, confirms a paid booking in Cloudbeds
// (idempotent; the webhook does the same). The provider's deps are picked by
// the booking's provider: the active config's, or that provider's drain.
export const runtime = "nodejs";
export const maxDuration = 30;
/** Every Beam call of a status request ends by this long after it arrived (maxDuration minus a margin; Stripe ignores it). */
const STATUS_BUDGET_MS = 25_000;
const isRateLimited = createRateLimiter(120, 60_000);

export async function GET(request: NextRequest) {
  const deadlineMs = Date.now() + STATUS_BUDGET_MS;
  let config: BookingConfig;
  try {
    config = getFulfilmentConfig();
  } catch (e) {
    return configErrorResponse(e);
  }
  if (isRateLimited(clientIp(request))) {
    return apiError(429, "rate_limited", "Checking too often - please wait a moment.");
  }
  const sp = request.nextUrl.searchParams;
  const result = await runStatus(
    { t: sp.get("t"), p: sp.get("p"), l: sp.get("l"), s: sp.get("s") ?? sp.get("session_id") },
    { config, log: logEvent, providerDeps: providerDepsFor(config, process.env, { deadlineMs }) },
  );
  return json(result.body, result.status);
}

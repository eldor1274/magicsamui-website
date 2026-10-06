import type { NextRequest } from "next/server";
import { getFulfilmentConfig } from "@/lib/booking/config";
import type { BookingConfig } from "@/lib/booking/config";
import { apiError, clientIp, configErrorResponse, createRateLimiter, json, logEvent } from "@/lib/booking/routeUtils";
import { getStripeDeps, getStripeFulfilmentDeps } from "@/lib/booking/runtime";
import { runStatus } from "@/lib/booking/status";

// Payment status for the return page: verifies the signed booking token,
// then reads a signed demo proof (demo), asks Beam (playground/live) or asks
// Stripe - and, in Stripe modes, confirms a paid booking in Cloudbeds
// (idempotent; the webhook does the same).
export const runtime = "nodejs";
export const maxDuration = 30;
const isRateLimited = createRateLimiter(120, 60_000);

export async function GET(request: NextRequest) {
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
    { config, log: logEvent, stripe: getStripeDeps(config) ?? undefined, stripeDrain: () => getStripeFulfilmentDeps() },
  );
  return json(result.body, result.status);
}

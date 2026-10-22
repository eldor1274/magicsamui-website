import type { NextRequest } from "next/server";
import { getFulfilmentConfig } from "@/lib/booking/config";
import type { BookingConfig } from "@/lib/booking/config";
import { beamFallbackFor } from "@/lib/booking/routeFallback";
import { apiError, clientIp, configErrorResponse, createRateLimiter, json, logConfigError, logEvent } from "@/lib/booking/routeUtils";
import { providerDepsFor } from "@/lib/booking/runtime";
import { runStatus } from "@/lib/booking/status";
import type { ProviderDepsFn } from "@/lib/booking/stripeDeps";

// Payment status for the return page: verifies the signed booking token,
// then reads a signed demo proof (demo), or asks the provider (Stripe, Beam)
// - and, in the hold-first modes, confirms a paid booking in Cloudbeds
// (idempotent; the webhook does the same). The provider's deps are picked by
// the booking's provider: the active config's, or that provider's drain.
// After a TYPO in the config (payment_misconfigured, invalid_beam_base; never
// a lock) a Beam booking is still answered from the Beam fulfilment deps
// (routeFallback.ts, design S4.9); every other request gets the config error.
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
    const fallback = beamFallbackFor(e, request.nextUrl.searchParams.get("t"), process.env, { deadlineMs });
    if (!fallback) return configErrorResponse(e);
    // A Beam booking: the config error is still logged (the config is still broken), then the booking is answered.
    logConfigError(fallback.error);
    return answer(request, fallback.config, () => fallback.providerDeps, fallback.nowMs);
  }
  const active = config;
  return answer(request, active, () => providerDepsFor(active, process.env, { deadlineMs }));
}

/** The rate limit, then runStatus with the deps `providerDeps` builds (after the limit, as always) and the answer. */
async function answer(request: NextRequest, config: BookingConfig, providerDeps: () => ProviderDepsFn, nowMs?: number): Promise<Response> {
  if (isRateLimited(clientIp(request))) {
    return apiError(429, "rate_limited", "Checking too often - please wait a moment.");
  }
  const sp = request.nextUrl.searchParams;
  const result = await runStatus(
    { t: sp.get("t"), p: sp.get("p"), l: sp.get("l"), s: sp.get("s") ?? sp.get("session_id") },
    { config, log: logEvent, providerDeps: providerDeps(), ...(nowMs !== undefined ? { nowMs } : {}) },
  );
  return json(result.body, result.status);
}

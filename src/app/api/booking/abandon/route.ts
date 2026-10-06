import { runAbandon } from "@/lib/booking/abandon";
import { getFulfilmentConfig } from "@/lib/booking/config";
import type { BookingConfig } from "@/lib/booking/config";
import { apiError, clientIp, configErrorResponse, createRateLimiter, json, logEvent, readJsonBody } from "@/lib/booking/routeUtils";
import { getStripeDeps, getStripeFulfilmentDeps } from "@/lib/booking/runtime";

// POST { t, l?, s? }: the guest came back from Stripe via Cancel/Back.
// Expires the Checkout Session and releases the Cloudbeds hold at once
// (a paid session is never cancelled). demo/beam: { state: "not_applicable" }.
export const runtime = "nodejs";
export const maxDuration = 30;

const isRateLimited = createRateLimiter(20, 10 * 60_000);

export async function POST(request: Request) {
  let config: BookingConfig;
  try {
    config = getFulfilmentConfig();
  } catch (e) {
    return configErrorResponse(e);
  }
  if (isRateLimited(clientIp(request))) return apiError(429, "rate_limited", "Too many attempts - please wait a moment.");
  const body = await readJsonBody(request, 8_192);
  if (!body.ok) return body.response;
  const result = await runAbandon(body.value, { config, stripe: getStripeDeps(config), stripeDrain: () => getStripeFulfilmentDeps(), log: logEvent });
  return json(result.body, result.status);
}

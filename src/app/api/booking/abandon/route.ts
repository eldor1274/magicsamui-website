import { runAbandon } from "@/lib/booking/abandon";
import { getFulfilmentConfig } from "@/lib/booking/config";
import type { BookingConfig } from "@/lib/booking/config";
import { apiError, clientIp, configErrorResponse, createRateLimiter, json, logEvent, readJsonBody } from "@/lib/booking/routeUtils";
import { providerDepsFor } from "@/lib/booking/runtime";

// POST { t, l?, s? }: the guest came back from the payment page via
// Cancel/Back. Closes the payment page (Stripe: expires the Checkout Session;
// Beam: disables the payment link) and releases the Cloudbeds hold at once (a
// paid payment is never cancelled). demo: { state: "not_applicable" }.
// The provider's deps are picked by the booking's provider: the active
// config's, or that provider's drain. Beam's gateway comes through runtime.ts
// (loaded on its first Beam call): this route never loads beam.ts statically.
export const runtime = "nodejs";
export const maxDuration = 30;
/** Every Beam call of an abandon request ends by this long after it arrived (maxDuration minus a margin; Stripe ignores it). */
const ABANDON_BUDGET_MS = 25_000;

const isRateLimited = createRateLimiter(20, 10 * 60_000);

export async function POST(request: Request) {
  const deadlineMs = Date.now() + ABANDON_BUDGET_MS;
  let config: BookingConfig;
  try {
    config = getFulfilmentConfig();
  } catch (e) {
    return configErrorResponse(e);
  }
  if (isRateLimited(clientIp(request))) return apiError(429, "rate_limited", "Too many attempts - please wait a moment.");
  const body = await readJsonBody(request, 8_192);
  if (!body.ok) return body.response;
  const result = await runAbandon(body.value, { config, providerDeps: providerDepsFor(config, process.env, { deadlineMs }), log: logEvent });
  return json(result.body, result.status);
}

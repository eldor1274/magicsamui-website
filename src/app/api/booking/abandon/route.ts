import { runAbandon } from "@/lib/booking/abandon";
import { getFulfilmentConfig } from "@/lib/booking/config";
import type { BookingConfig } from "@/lib/booking/config";
import { beamFallbackFor, beamFallbackPossible } from "@/lib/booking/routeFallback";
import { apiError, clientIp, configErrorResponse, createRateLimiter, json, logConfigError, logEvent, readJsonBody } from "@/lib/booking/routeUtils";
import { providerDepsFor } from "@/lib/booking/runtime";

// POST { t, l?, s? }: the guest came back from the payment page via
// Cancel/Back. Closes the payment page (Stripe: expires the Checkout Session;
// Beam: disables the payment link) and releases the Cloudbeds hold at once (a
// paid payment is never cancelled). demo: { state: "not_applicable" }.
// The provider's deps are picked by the booking's provider: the active
// config's, or that provider's drain. Beam's gateway comes through runtime.ts
// (loaded on its first Beam call): this route never loads beam.ts statically.
// After a TYPO in the config (payment_misconfigured, invalid_beam_base; never
// a lock) a Beam booking is still answered from the Beam fulfilment deps
// (routeFallback.ts, design S4.9): the body is read only when the Beam
// variables could make a Beam config; every other request gets the config
// error, as before.
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
    if (!beamFallbackPossible(e, process.env)) return configErrorResponse(e);
    const read = await readJsonBody(request, 8_192);
    const raw = read.ok ? read.value : null;
    const token = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>).t : undefined;
    const fallback = beamFallbackFor(e, token, process.env, { deadlineMs });
    if (!fallback) return configErrorResponse(e);
    // A Beam booking: the config error is still logged (the config is still broken), then the booking is answered.
    logConfigError(fallback.error);
    if (isRateLimited(clientIp(request))) return apiError(429, "rate_limited", "Too many attempts - please wait a moment.");
    const fell = await runAbandon(raw, { config: fallback.config, providerDeps: fallback.providerDeps, log: logEvent, nowMs: fallback.nowMs });
    return json(fell.body, fell.status);
  }
  if (isRateLimited(clientIp(request))) return apiError(429, "rate_limited", "Too many attempts - please wait a moment.");
  const body = await readJsonBody(request, 8_192);
  if (!body.ok) return body.response;
  const result = await runAbandon(body.value, { config, providerDeps: providerDepsFor(config, process.env, { deadlineMs }), log: logEvent });
  return json(result.body, result.status);
}

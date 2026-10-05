import { getBookingConfig } from "@/lib/booking/config";
import type { BookingConfig } from "@/lib/booking/config";
import { runDemoPay } from "@/lib/booking/demoPay";
import { apiError, clientIp, createRateLimiter, json, readJsonBody } from "@/lib/booking/routeUtils";
import { resolveOrigin } from "@/lib/booking/urls";

// SIMULATED payment for demo mode only (404 in any Beam mode). Receives ONLY
// {t, outcome} - never card data.
const isRateLimited = createRateLimiter(30, 10 * 60_000);

export async function POST(request: Request) {
  let config: BookingConfig;
  try {
    config = getBookingConfig();
  } catch {
    return apiError(404, "not_found", "Not found.");
  }
  if (config.paymentMode !== "demo") return apiError(404, "not_found", "Not found.");
  if (isRateLimited(clientIp(request))) {
    return apiError(429, "rate_limited", "Too many attempts - please wait a moment.");
  }
  const body = await readJsonBody(request, 4_096);
  if (body === undefined) return apiError(400, "invalid_request", "Invalid request body.");
  const result = runDemoPay(body, { config, origin: resolveOrigin(request.headers.get("host"), process.env) });
  return json(result.body, result.status);
}

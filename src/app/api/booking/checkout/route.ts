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
import { resolveOrigin } from "@/lib/booking/urls";

// Booking preview checkout: re-quotes on the server, signs a booking token
// and creates the Beam payment link (or the simulated demo link). The client
// never sends prices. No reservation is created in this preview.
export const maxDuration = 30;

const isRateLimited = createRateLimiter(10, 10 * 60_000);

export async function POST(request: Request) {
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
  if (body === undefined) return apiError(400, "invalid_request", "Invalid request body.");

  try {
    const result = await runCheckout(body, {
      config,
      origin: resolveOrigin(request.headers.get("host"), process.env),
      log: logEvent,
    });
    return json(result.body, result.status);
  } catch (e) {
    logEvent("checkout_error", { message: e instanceof Error ? e.message : String(e) });
    return apiError(500, "server_error", "Something went wrong on our side. Nothing has been charged.");
  }
}

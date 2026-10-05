import type { NextRequest } from "next/server";
import { getBookingConfig } from "@/lib/booking/config";
import type { BookingConfig } from "@/lib/booking/config";
import { apiError, clientIp, configErrorResponse, createRateLimiter, json, logEvent } from "@/lib/booking/routeUtils";
import { runStatus } from "@/lib/booking/status";

// Payment status for the return page: verifies the signed booking token,
// then reads a signed demo proof (demo) or asks Beam (playground/live).
const isRateLimited = createRateLimiter(120, 60_000);

export async function GET(request: NextRequest) {
  let config: BookingConfig;
  try {
    config = getBookingConfig();
  } catch (e) {
    return configErrorResponse(e);
  }
  if (isRateLimited(clientIp(request))) {
    return apiError(429, "rate_limited", "Checking too often - please wait a moment.");
  }
  const sp = request.nextUrl.searchParams;
  const result = await runStatus({ t: sp.get("t"), p: sp.get("p"), l: sp.get("l") }, { config, log: logEvent });
  return json(result.body, result.status);
}

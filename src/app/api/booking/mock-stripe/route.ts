import { getBookingConfig } from "@/lib/booking/config";
import { runMockStripeAction } from "@/lib/booking/mock/mockStripeActions";
import { apiError, json, readJsonBody } from "@/lib/booking/routeUtils";
import { getStripeDeps, mockWorld } from "@/lib/booking/runtime";

// MOCK ONLY (BOOKING_PAYMENT_PROVIDER=stripe + BOOKING_STRIPE_MOCK=true, never
// on production): the buttons of the local fake Stripe checkout page.
// 404 in every other mode.
export const runtime = "nodejs";

export async function POST(request: Request) {
  let config;
  try {
    config = getBookingConfig();
  } catch {
    return apiError(404, "not_found", "Not found.");
  }
  if (config.paymentMode !== "stripe-mock") return apiError(404, "not_found", "Not found.");
  const deps = getStripeDeps(config);
  if (!deps) return apiError(404, "not_found", "Not found.");
  const body = await readJsonBody(request, 4_096);
  if (!body.ok) return body.response;
  const result = await runMockStripeAction(body.value, mockWorld(config).stripe, deps);
  return json(result.body, result.status);
}

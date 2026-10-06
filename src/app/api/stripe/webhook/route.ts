import { getFulfilmentConfig } from "@/lib/booking/config";
import { readCapped, logEvent } from "@/lib/booking/routeUtils";
import { getStripeFulfilmentDeps } from "@/lib/booking/runtime";
import { handleStripeWebhook } from "@/lib/booking/stripeWebhook";

// Stripe webhook (WI-6). Register in Stripe Workbench -> Webhooks for:
// checkout.session.completed, checkout.session.async_payment_succeeded,
// checkout.session.async_payment_failed, checkout.session.expired.
// The signature is verified over the RAW body, so the body is read as bytes
// (capped) and never parsed before verification. Node runtime (node:crypto).
//
// It keeps working while Stripe credentials exist even after
// BOOKING_PAYMENT_PROVIDER is switched away from stripe (drain), so sessions
// already started are still confirmed or released.
export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BODY_BYTES = 512 * 1024;

export async function POST(request: Request) {
  // Fulfilment config: the emergency stop blocks new charges, never confirming paid ones.
  const deps = getStripeFulfilmentDeps();
  if (!deps) {
    try {
      getFulfilmentConfig();
    } catch (e) {
      // Payments locked/misconfigured: 503 so Stripe retries once it is fixed (nothing is lost).
      logEvent("stripe_webhook_config_error", { error: e instanceof Error ? e.name : "unknown" });
      return new Response("booking engine not configured", { status: 503 });
    }
    return new Response("stripe not enabled", { status: 404 });
  }

  const raw = await readCapped(request, MAX_BODY_BYTES);
  if (raw === null) return new Response("payload too large", { status: 413 });
  const result = await handleStripeWebhook(raw, request.headers.get("stripe-signature"), deps);
  return new Response(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}

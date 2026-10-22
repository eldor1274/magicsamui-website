import { handleBeamWebhook } from "@/lib/booking/beamWebhook";
import { NO_STORE, logEvent, readCapped } from "@/lib/booking/routeUtils";
import { getBeamFulfilmentDeps } from "@/lib/booking/runtime";

// Beam webhook (design S4.7). Register in Lighthouse -> Webhooks for:
// payment_link.paid, charge.succeeded, charge.failed, refund.succeeded,
// refund.failed, transaction.created. The handler (lib/booking/beamWebhook.ts)
// verifies X-Beam-Signature over the RAW body (read as capped bytes, never
// parsed before verification), re-reads every payment from Beam and confirms
// a paid booking in Cloudbeds inline: once the paid marker is written a 200 is
// safe, and Beam's response timeout is unknown, so nothing waits for after().
//
// Deps: the active Beam config's, else the Beam drain's (BOOKING_PAYMENT_PROVIDER
// switched away from beam with the Beam variables kept), so links already
// handed out are still finished. With neither, or without BEAM_WEBHOOK_HMAC_KEY,
// it answers 503 before the body is read (Beam retries every non-2xx answer).
export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BODY_BYTES = 64 * 1024;
/** Every Beam call of a delivery ends by this long after it arrived (maxDuration minus a margin). */
const WEBHOOK_BUDGET_MS = 25_000;

export async function POST(request: Request) {
  const deadlineMs = Date.now() + WEBHOOK_BUDGET_MS;
  const deps = getBeamFulfilmentDeps(process.env, { deadlineMs });
  const hmacKey = deps?.config.beamWebhookHmacKey ?? null;
  let raw: Uint8Array = new Uint8Array(0);
  if (!deps) {
    // The handler has no log of its own without deps.
    logEvent("beam_webhook_unconfigured");
  } else if (hmacKey !== null) {
    // Capped read: an oversized body is refused without buffering it.
    const capped = await readCapped(request, MAX_BODY_BYTES);
    if (capped === null) return new Response("payload too large", { status: 413, headers: NO_STORE });
    raw = capped;
  }
  // Unconfigured (no deps or no key): the handler answers 503 before it looks at the body.
  const result = await handleBeamWebhook(raw, request.headers, deps, hmacKey);
  return new Response(result.body, { status: result.status, headers: NO_STORE });
}

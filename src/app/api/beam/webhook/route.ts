import { verifyBeamSignature } from "@/lib/booking/beam";
import { logEvent } from "@/lib/booking/routeUtils";

// Beam webhook receiver (preview). Verifies X-Beam-Signature over the EXACT
// raw body (HMAC-SHA256, key = base64-decoded BEAM_WEBHOOK_HMAC_KEY), answers
// 200 fast and logs a PII-free summary. The preview does NO fulfilment: in
// live mode this is where the paid booking would be created in Cloudbeds
// (idempotently, keyed on event + resource id).
export const runtime = "nodejs";

const MAX_BODY_BYTES = 64 * 1024;

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export async function POST(request: Request) {
  const key = process.env.BEAM_WEBHOOK_HMAC_KEY?.trim();
  if (!key) {
    logEvent("beam_webhook_unconfigured");
    return new Response("webhook not configured", { status: 503 });
  }
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) return new Response("payload too large", { status: 413 });
  if (!verifyBeamSignature(raw, request.headers.get("x-beam-signature"), key)) {
    logEvent("beam_webhook_bad_signature");
    return new Response("invalid signature", { status: 401 });
  }

  const event = request.headers.get("x-beam-event") ?? "unknown";
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw).toString("utf8"));
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // Signed but not JSON: acknowledge so Beam does not keep retrying.
  }
  const order = body.order && typeof body.order === "object" ? (body.order as Record<string, unknown>) : null;

  // Summary only - customer phone/email in the payload are never logged.
  logEvent("beam_webhook", {
    event,
    resourceId: str(body.paymentLinkId) ?? str(body.chargeId) ?? str(body.refundId),
    referenceId: str(body.referenceId) ?? str(order?.referenceId),
    status: str(body.status),
    amount: typeof body.amount === "number" ? body.amount : typeof order?.netAmount === "number" ? order.netAmount : null,
    sourceId: str(body.sourceId),
  });
  return new Response(null, { status: 200 });
}

import { timingSafeEqual } from "node:crypto";
import { getFulfilmentConfig, sweepSecretsOf } from "@/lib/booking/config";
import { logEvent } from "@/lib/booking/routeUtils";
import { getStripeFulfilmentDeps } from "@/lib/booking/runtime";
import { runSweep } from "@/lib/booking/sweep";

// Reconciliation sweeper (WI-7): repairs dropped webhooks and releases stale
// holds. Call every ~10 minutes with header
//   Authorization: Bearer <BOOKING_SWEEP_SECRET>
// A Vercel cron sends `Bearer <CRON_SECRET>`: both secrets are accepted when
// both are set (each compared in constant time). The secret is never accepted
// in the query string. Answers counts only (no PII);
// `openHolds` must be 0 before any change of provider or Stripe keys (drain).
// Keeps running on the Stripe credentials after BOOKING_PAYMENT_PROVIDER is
// switched away from stripe, so in-flight holds are still released.
export const runtime = "nodejs";
export const maxDuration = 60;

function authorized(request: Request, secrets: string[]): boolean {
  const header = request.headers.get("authorization") ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7).trim() : "", "utf8");
  let ok = false;
  for (const secret of secrets) {
    const expected = Buffer.from(secret, "utf8");
    // Every secret is compared (no early exit), each in constant time.
    if (given.length === expected.length && timingSafeEqual(given, expected)) ok = true;
  }
  return ok;
}

const NO_STORE = { "Cache-Control": "no-store" };

async function handle(request: Request): Promise<Response> {
  const secrets = sweepSecretsOf(process.env);
  if (secrets.length === 0) return Response.json({ ok: false, error: "sweeper_disabled" }, { status: 404, headers: NO_STORE });
  if (!authorized(request, secrets)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const deps = getStripeFulfilmentDeps();
  if (!deps) {
    try {
      getFulfilmentConfig();
    } catch {
      return Response.json({ ok: false, error: "not_configured" }, { status: 503, headers: NO_STORE });
    }
    return Response.json({ ok: true, skipped: "no stripe configuration" }, { headers: NO_STORE });
  }
  try {
    const summary = await runSweep(deps);
    // The Cloudbeds side failed: orphan holds were not looked for. A non-2xx makes the cron's curl -f fail visibly.
    if (!summary.cloudbedsOk) {
      return Response.json({ ok: false, error: "cloudbeds_unavailable", mode: deps.config.paymentMode, ...summary }, { status: 502, headers: NO_STORE });
    }
    return Response.json({ ok: true, mode: deps.config.paymentMode, ...summary }, { headers: NO_STORE });
  } catch (e) {
    logEvent("sweep_failed", { error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    return Response.json({ ok: false, error: "sweep_failed" }, { status: 500, headers: NO_STORE });
  }
}

export const GET = handle;
export const POST = handle;

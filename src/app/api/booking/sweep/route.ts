import { bearerMatches } from "@/lib/bearerAuth";
import { getFulfilmentConfig, sweepSecretsOf } from "@/lib/booking/config";
import { logEvent } from "@/lib/booking/routeUtils";
import { getFulfilmentProviderDeps, getStripeFulfilmentDeps } from "@/lib/booking/runtime";
import type { ProviderDeps } from "@/lib/booking/stripeDeps";
import { runSweep } from "@/lib/booking/sweep";
import { sweepProviders } from "@/lib/booking/sweepProviders";
import type { SweepRun } from "@/lib/booking/sweepProviders";

// Reconciliation sweeper (WI-7): repairs dropped webhooks and releases stale
// holds. Call every ~10 minutes with header
//   Authorization: Bearer <BOOKING_SWEEP_SECRET>
// A Vercel cron sends `Bearer <CRON_SECRET>`: both secrets are accepted when
// both are set (each compared in constant time). The secret is never accepted
// in the query string. Answers counts only (no PII);
// `openHolds` must be 0 before any change of provider or Stripe keys (drain).
// Keeps running on the Stripe credentials after BOOKING_PAYMENT_PROVIDER is
// switched away from stripe, so in-flight holds are still released.
// Every configured provider (Beam design S4.8): while a Beam config exists
// (the active one, or the Beam drain after a switch away from beam), one
// request sweeps Stripe (when configured) and Beam through sweepProviders -
// the active provider first when it is Beam, else Stripe first - and adds
// runs[] to the answer (Stripe first). Its top-level counts are the active
// provider's run only: while runs[] is there, EVERY runs[].openHolds, errors
// and paidUnconfirmed must be 0 before any provider's variables or keys
// change. Without a Beam config it runs exactly the single Stripe sweep it
// always ran. Beam's gateway comes through runtime.ts (loaded on its first
// Beam call): this route never loads beam.ts statically.
export const runtime = "nodejs";
export const maxDuration = 60;
/** Every Beam call of a sweep request ends by this long after it arrived (maxDuration minus a margin; Stripe ignores it). */
const SWEEP_BUDGET_MS = 55_000;

const NO_STORE = { "Cache-Control": "no-store" };

async function handle(request: Request): Promise<Response> {
  const secrets = sweepSecretsOf(process.env);
  if (secrets.length === 0) return Response.json({ ok: false, error: "sweeper_disabled" }, { status: 404, headers: NO_STORE });
  if (!bearerMatches(request, secrets)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const deadlineMs = Date.now() + SWEEP_BUDGET_MS;
  // No Beam config (active or drain): null, and the single Stripe sweep below, as before. Building them writes
  // nothing and loads no Beam module; a build that throws means a Beam config exists (its run then fails).
  let beam: ProviderDeps | null | { failed: unknown };
  try {
    beam = getFulfilmentProviderDeps(process.env, "beam", { deadlineMs });
  } catch (e) {
    beam = { failed: e };
  }
  if (beam !== null) return sweepEveryProvider(beam, deadlineMs);
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

/**
 * Stripe (when configured: the active config's or its drain's) and Beam (`beam`: the active config's or the Beam
 * drain's) in one request. Primary is the active config's provider; Beam's deps are built per phase with that
 * phase's end as their deadline (sweepProviders.ts).
 */
async function sweepEveryProvider(beam: ProviderDeps | { failed: unknown }, deadlineMs: number): Promise<Response> {
  let activeMode: string | null = null;
  try {
    activeMode = getFulfilmentConfig().paymentMode;
  } catch {
    activeMode = null;
  }
  const runs: SweepRun[] = [];
  let stripe: ProviderDeps | null | { failed: unknown };
  try {
    stripe = getFulfilmentProviderDeps(process.env, "stripe");
  } catch (e) {
    stripe = { failed: e };
  }
  const isPrimary = (p: ProviderDeps | { failed: unknown }) => "deps" in p && p.deps.config.paymentMode === activeMode;
  if (stripe !== null) {
    const built = stripe;
    runs.push({
      provider: "stripe",
      primary: isPrimary(built),
      open: () => {
        if (!("deps" in built)) throw built.failed;
        return built;
      },
    });
  }
  runs.push({
    provider: "beam",
    primary: isPrimary(beam),
    open: (timing) => {
      if (!("deps" in beam)) throw beam.failed;
      const deps = getFulfilmentProviderDeps(process.env, "beam", timing);
      if (!deps) throw new Error("Beam deps unavailable");
      return deps;
    },
  });
  try {
    const answer = await sweepProviders(runs, { deadlineMs, log: logEvent });
    return Response.json(answer.body, { status: answer.status, headers: NO_STORE });
  } catch (e) {
    logEvent("sweep_failed", { error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    return Response.json({ ok: false, error: "sweep_failed" }, { status: 500, headers: NO_STORE });
  }
}

export const GET = handle;
export const POST = handle;

import { logEvent } from "@/lib/booking/routeUtils";
import { getBeamFulfilmentDeps } from "@/lib/booking/runtime";
import { SUPPORT_LOOKUP_BEAM_BUDGET_MS, handlePaymentLookup, lookupInstanceState } from "@/lib/booking/supportLookup";

// The WhatsApp bot's read-only payment lookup (lib/booking/supportLookup.ts): why a guest's Beam payment failed
// and what to do next. Requires `Authorization: Bearer <BOT_LOOKUP_SECRET>` (32+ characters; unset or shorter:
// 503 for everything). POST only (Next answers 405 to anything else); route handlers other than GET are never
// cached, and every answer says Cache-Control no-store. The Beam key stays on this server: the bot gets answers,
// never credentials.
//
// Deps: the Beam deps that finish Beam payments (the active Beam config's, else the Beam drain's), with every Beam
// call bounded by SUPPORT_LOOKUP_BEAM_BUDGET_MS from the request's arrival; this server instance's state (the
// "unconfigured" line logged once, the rejected tokens counted).
export const runtime = "nodejs";
export const maxDuration = 15;

const INSTANCE = lookupInstanceState();

export function POST(request: Request): Promise<Response> {
  const deadlineMs = Date.now() + SUPPORT_LOOKUP_BEAM_BUDGET_MS;
  return handlePaymentLookup(request, process.env, {
    beamDeps: () => getBeamFulfilmentDeps(process.env, { deadlineMs }),
    log: logEvent,
    instance: INSTANCE,
  });
}

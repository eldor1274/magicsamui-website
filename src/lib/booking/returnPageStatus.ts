// The return page's server-side status check (components/booking/OwnReturnPage.tsx; round 6: moved here so a test
// can reach it): the fulfilment config, the time budget of every Beam call of the render, and runStatus with the
// deps of the booking's provider - exactly as the status API picks them. After a TYPO in the config
// (payment_misconfigured, invalid_beam_base; never a lock) a Beam booking is still checked from the Beam fulfilment
// deps, as the status API does (routeFallback.ts, design S4.9). Server only.

import { getFulfilmentConfig } from "./config.ts";
import type { BookingConfig } from "./config.ts";
import { beamFallbackFor } from "./routeFallback.ts";
import { providerDepsFor } from "./runtime.ts";
import { runStatus } from "./status.ts";
import type { ApiError, StatusResponse } from "./types.ts";

/** Every Beam call of the render's status check ends by this long after it started (the pages' maxDuration minus a margin; Stripe ignores it). */
export const RETURN_PAGE_STATUS_BUDGET_MS = 25_000;

/**
 * The status the return page renders first, for a booking token `t` (with the demo proof `p` and Stripe's session
 * id `s` when the redirect carries them). Called at request time, after the page's rate limit; never throws.
 */
export async function returnPageStatus(t: string, p: string | null, s: string | null): Promise<StatusResponse | ApiError> {
  const deadlineMs = Date.now() + RETURN_PAGE_STATUS_BUDGET_MS;
  try {
    // getFulfilmentConfig: the emergency stop (BOOKING_ALLOW_LIVE_PAYMENTS=false) blocks NEW charges only;
    // a guest who already paid must still see (and get) a confirmed booking.
    // The provider's deps are picked by the booking's provider, exactly as the status API does.
    let config: BookingConfig;
    try {
      config = getFulfilmentConfig();
    } catch (e) {
      // A Beam booking after a typo: the Beam fulfilment deps; anything else: "couldn't check" below, as before.
      const fallback = beamFallbackFor(e, t, process.env, { deadlineMs });
      if (!fallback) throw e;
      const fell = await runStatus({ t, p, l: null, s }, { config: fallback.config, providerDeps: fallback.providerDeps, nowMs: fallback.nowMs });
      return fell.body;
    }
    const result = await runStatus({ t, p, l: null, s }, { config, providerDeps: providerDepsFor(config, process.env, { deadlineMs }) });
    return result.body;
  } catch {
    return { ok: false, error: "payment_unavailable", message: "We couldn't check this payment right now. Please refresh in a moment." };
  }
}

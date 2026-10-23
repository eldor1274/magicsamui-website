// The return page's server-side status check (components/booking/OwnReturnPage.tsx; round 6: moved here so a test
// can reach it): the fulfilment config, the time budget of every Beam call of the render, and runStatus with the
// deps of the booking's provider - exactly as the status API picks them. After a TYPO in the config
// (payment_misconfigured, invalid_beam_base; never a lock) a Beam booking is still checked from the Beam fulfilment
// deps, as the status API does (routeFallback.ts, design S4.9). Server only.
//
// Design S5.3: a Beam answer also carries the Cloudbeds flags of the Beam config that answered it (the active one, the
// Beam drain, or the drain after a typo): whether Cloudbeds emails the guest's confirmation (then the paid page is
// not the confirmation) and whether its writes are real. The public config the page also reads is the locked one
// after a typo (no email, no writes), which would show a paid Beam guest the save/print callout and the terms while
// the Cloudbeds email is on its way. Stripe and demo answers carry none: the page keeps the public config's flags.

import { getFulfilmentConfig } from "./config.ts";
import type { BookingConfig } from "./config.ts";
import { providerOf } from "./payments/provider.ts";
import { beamFallbackFor } from "./routeFallback.ts";
import { providerDepsFor } from "./runtime.ts";
import { runStatus } from "./status.ts";
import type { ProviderDepsFn } from "./stripeDeps.ts";
import type { ApiError, StatusResponse } from "./types.ts";

/** Every Beam call of the render's status check ends by this long after it started (the pages' maxDuration minus a margin; Stripe ignores it). */
export const RETURN_PAGE_STATUS_BUDGET_MS = 25_000;

/** The Cloudbeds flags of the Beam config that answered (design S5.3): the return page's sendsConfirmationEmail and cloudbedsWrites. */
export interface ReturnPageBeamFlags {
  /** config.sendCloudbedsStatusEmail: Cloudbeds emails the guest when fulfil confirms the reservation. */
  sendsConfirmationEmail: boolean;
  cloudbedsWrites: "live" | "mock" | "none";
}

export interface ReturnPageCheck {
  status: StatusResponse | ApiError;
  /** A Beam answer (ok, beam-playground or beam-live) only. */
  beamFlags?: ReturnPageBeamFlags;
}

/** `fn` as it is, noting the config of the Beam deps it hands out (the deps runStatus answers a Beam booking with). */
function noteBeamConfig(fn: ProviderDepsFn): { providerDeps: ProviderDepsFn; beamConfig: () => BookingConfig | null } {
  let beamConfig: BookingConfig | null = null;
  return {
    providerDeps: (provider) => {
      const found = fn(provider);
      if (provider === "beam") beamConfig = found?.deps.config ?? null;
      return found;
    },
    beamConfig: () => beamConfig,
  };
}

function checked(status: StatusResponse | ApiError, beamConfig: BookingConfig | null): ReturnPageCheck {
  if (!status.ok || providerOf(status.paymentMode) !== "beam" || !beamConfig || beamConfig.paymentMode !== status.paymentMode) return { status };
  return { status, beamFlags: { sendsConfirmationEmail: beamConfig.sendCloudbedsStatusEmail, cloudbedsWrites: beamConfig.cloudbedsWrite?.mode ?? "none" } };
}

/**
 * The status the return page renders first, for a booking token `t` (with the demo proof `p` and Stripe's session
 * id `s` when the redirect carries them), and for a Beam answer the flags of the config that answered it. Called at
 * request time, after the page's rate limit; never throws.
 */
export async function returnPageCheck(t: string, p: string | null, s: string | null): Promise<ReturnPageCheck> {
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
      const noted = noteBeamConfig(fallback.providerDeps);
      const fell = await runStatus({ t, p, l: null, s }, { config: fallback.config, providerDeps: noted.providerDeps, nowMs: fallback.nowMs });
      return checked(fell.body, noted.beamConfig());
    }
    const noted = noteBeamConfig(providerDepsFor(config, process.env, { deadlineMs }));
    const result = await runStatus({ t, p, l: null, s }, { config, providerDeps: noted.providerDeps });
    return checked(result.body, noted.beamConfig());
  } catch {
    return { status: { ok: false, error: "payment_unavailable", message: "We couldn't check this payment right now. Please refresh in a moment." } };
  }
}

/** returnPageCheck's status alone (the route tests' view of the page's check). */
export async function returnPageStatus(t: string, p: string | null, s: string | null): Promise<StatusResponse | ApiError> {
  return (await returnPageCheck(t, p, s)).status;
}

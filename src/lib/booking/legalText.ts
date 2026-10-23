// Which payment processors /privacy and /legal name (Beam design S5.4, gap review 9). Server only: it reads the
// booking config.
//
// Without a Beam config (active or drain) both pages read exactly as before: Stripe and Upstash while the provider
// is stripe (getPublicBookingConfig().provider, whatever the Stripe mode or lock), neither otherwise. So every
// Stripe and demo deployment (the current production one included) renders byte for byte as before, and nothing
// more is built or logged for it: without BEAM_API_BASE no Beam config can exist, and none is looked for.
// While a Beam config exists (the fulfilment config is a Beam mode, or getBeamDrainConfig finishes Beam payments
// after a switch away from beam), the pages name Beam. They name Stripe while it is the provider or still drains
// (getStripeDrainConfig). Upstash is named too: it holds the hold-first bookings' holds, payment status and abuse
// limits, the drained ones included. Since S7.1 (LIVE_FULFILMENT_READY.beam true) beam-live is a Beam config too:
// active, or the Beam drain of a Stripe page that carries the live Beam variables - so production names Beam once
// those variables are set, even while BOOKING_PAYMENT_PROVIDER is still stripe.
// The legal entity stays site.legalName: the Beam merchant account must be held by it (a go-live gate, Beam
// question 17). If it is not, /legal, /privacy and the JSON-LD change here.

import { getBeamDrainConfig, getFulfilmentConfig, getPublicBookingConfig, getStripeDrainConfig } from "./config.ts";
import type { Env, ModeOptions } from "./config.ts";

/** Beam's legal name, as its public terms give it. */
export const BEAM_LEGAL_NAME = "Beam Data Co., Ltd.";
/** Beam's public site (its terms and privacy policy are published there). */
export const BEAM_SITE_URL = "https://www.beamcheckout.com/";

export interface PaymentProcessors {
  stripe: boolean;
  beam: boolean;
  upstash: boolean;
}

/**
 * True while a Beam config exists: the fulfilment config (the checkout config, or beam-live during an emergency stop)
 * is a Beam mode, or a Beam drain finishes Beam payments. Never throws. `options`: tests only (the code switch).
 */
export function beamConfigExists(env: Env = process.env, options: ModeOptions = {}): boolean {
  if ((env.BEAM_API_BASE ?? "").trim() === "") return false;
  try {
    if (getFulfilmentConfig(env, options).beam) return true;
  } catch {
    // locked or misconfigured: see the Beam drain
  }
  return getBeamDrainConfig(env, options) !== null;
}

/** The processors the privacy and legal pages name. Never throws. `options`: tests only (the code switch). */
export function paymentProcessorsOf(env: Env = process.env, options: ModeOptions = {}): PaymentProcessors {
  const stripe = getPublicBookingConfig(env).provider === "stripe";
  if (!beamConfigExists(env, options)) return { stripe, beam: false, upstash: stripe };
  return { stripe: stripe || getStripeDrainConfig(env, options) !== null, beam: true, upstash: true };
}

// Route resilience (Beam design S4.9, money review 11): a typo in the booking config must not strand the Beam
// bookings already started. When the active fulfilment config (getFulfilmentConfig) throws a TYPO error -
// payment_misconfigured or invalid_beam_base, e.g. a misspelt BOOKING_PAYMENT_PROVIDER - the status and abandon
// routes and the return page's status check still answer a request whose booking token verifies and names a Beam
// booking, from the Beam fulfilment deps (runtime.ts getFulfilmentProviderDeps: the active Beam config's, or the
// Beam drain's) with the caller's deadline.
//
// Everything else keeps today's answer (the config error): a Stripe or demo booking, a token that does not verify,
// a Beam booking of another mode than those deps', no Beam deps at all (or deps that can't be built), and every
// lock (live_payments_locked) or token_secret_missing error - the golden record 'provider beam live (locked in
// code), Stripe live credentials kept' pins those 503s. The Stripe webhook and the sweeper never depend on the
// active config, and the Beam webhook builds its own Beam deps (S4.7): none of them needs this.
//
// Nothing is built for any other request: the token is first checked against BOOKING_TOKEN_SECRET (every Beam
// config signs with it, as a strong secret) and only a Beam booking's token goes on to the Beam deps, so a
// Stripe, demo or garbage request builds no config, logs nothing and writes nothing more than before. Server only.

import {
  BEAM_LIVE_BASE,
  BEAM_PLAYGROUND_BASE,
  BookingConfigError,
  beamLiveBlockers,
  isStrongTokenSecret,
  resolveDataSource,
  resolveProvider,
  resolveRedis,
} from "./config.ts";
import type { BookingConfig, Env } from "./config.ts";
import { providerOf } from "./payments/provider.ts";
import { getFulfilmentProviderDeps } from "./runtime.ts";
import type { BeamTiming } from "./runtime.ts";
import type { ProviderDeps, ProviderDepsFn } from "./stripeDeps.ts";
import { verifyBookingToken } from "./token.ts";

function trimmed(v: string | undefined): string {
  return (v ?? "").trim();
}

/** The config errors a Beam booking is still answered after: typos, never a lock (live_payments_locked) or a missing token secret. */
export function isBeamFallbackError(e: unknown): e is BookingConfigError {
  return e instanceof BookingConfigError && (e.code === "payment_misconfigured" || e.code === "invalid_beam_base");
}

/** The provider BOOKING_PAYMENT_PROVIDER names, or null for a value that is not one (a typo). Never throws. */
function providerNamed(env: Env): ReturnType<typeof resolveProvider> | null {
  try {
    return resolveProvider(env);
  } catch {
    return null;
  }
}

/**
 * Whether the fallback could answer any request at all, from the error and the variables alone (nothing built,
 * nothing logged): a typo error, a provider other than beam (with beam the Beam config is the active one, which just
 * threw, and there is no Beam drain), a strong BOOKING_TOKEN_SECRET, a Beam API base, both Beam keys and
 * BEAM_WEBHOOK_HMAC_KEY - what getBeamDrainConfig requires - and what the Beam-mode branch of the config requires of
 * the Cloudbeds writes (round 8): with CLOUDBEDS_API_KEY_BOOKING a numeric CLOUDBEDS_PROPERTY_ID, Upstash Redis and
 * live Cloudbeds data; without it no VERCEL_ENV (the simulated writer runs locally only). The live base only when
 * every condition for finishing beam-live payments holds (beamLiveBlockers with `fulfilment`, the code switch
 * LIVE_FULFILMENT_READY.beam among them: true since S7.1). True exactly when getBeamDrainConfig builds a Beam
 * config; false: the route keeps today's code path exactly (the abandon route reads no body).
 */
export function beamFallbackPossible(e: unknown, env: Env): boolean {
  if (!isBeamFallbackError(e) || providerNamed(env) === "beam") return false;
  const base = trimmed(env.BEAM_API_BASE).replace(/\/+$/, "");
  const credentials =
    trimmed(env.BEAM_MERCHANT_ID) !== "" &&
    trimmed(env.BEAM_API_KEY) !== "" &&
    trimmed(env.BEAM_WEBHOOK_HMAC_KEY) !== "" &&
    isStrongTokenSecret(trimmed(env.BOOKING_TOKEN_SECRET));
  if (!credentials) return false;
  if (base === BEAM_LIVE_BASE) return beamLiveBlockers({ ...env, BOOKING_PAYMENT_PROVIDER: "beam" }, { fulfilment: true }).length === 0;
  if (base !== BEAM_PLAYGROUND_BASE) return false;
  // beam-playground: the Cloudbeds writer of the Beam-mode branch of buildBookingConfig.
  if (trimmed(env.CLOUDBEDS_API_KEY_BOOKING) !== "") {
    return /^\d{1,12}$/.test(trimmed(env.CLOUDBEDS_PROPERTY_ID)) && resolveRedis(env) !== null && resolveDataSource(env) === "cloudbeds";
  }
  return trimmed(env.VERCEL_ENV) === "";
}

export interface BeamFallback {
  /** The typo error the active config threw (the route still logs it). */
  error: BookingConfigError;
  /** The Beam fulfilment config, the booking's own: runStatus's and runAbandon's config. */
  config: BookingConfig;
  /** The Beam deps and gateway for "beam", nothing for any other provider. */
  providerDeps: ProviderDepsFn;
  /** The time the token was checked at: runStatus's and runAbandon's nowMs, so they check it at the same time. */
  nowMs: number;
}

/**
 * The fallback for one request, or null (the route answers `e` as before). `token`: the request's booking token
 * (status: ?t, abandon: the body's t). `timing`: the route's (or the page's) deadline for every Beam call, as the
 * normal path passes it to providerDepsFor. Never throws.
 */
export function beamFallbackFor(e: unknown, token: unknown, env: Env, timing: BeamTiming, nowMs: number = Date.now()): BeamFallback | null {
  if (!isBeamFallbackError(e) || !beamFallbackPossible(e, env)) return null;
  // The token alone first: only a Beam booking signed with this deployment's secret goes on to the Beam deps.
  const signed = verifyBookingToken(token, trimmed(env.BOOKING_TOKEN_SECRET), nowMs);
  if (!signed.ok || providerOf(signed.payload.booking.paymentMode) !== "beam") return null;
  let beam: ProviderDeps | null;
  try {
    beam = getFulfilmentProviderDeps(env, "beam", timing);
  } catch {
    return null;
  }
  if (!beam) return null;
  const found = beam;
  const config = found.deps.config;
  const verified = verifyBookingToken(token, config.tokenSecret, nowMs);
  if (!verified.ok || verified.payload.booking.paymentMode !== config.paymentMode) return null;
  return { error: e, config, providerDeps: (provider) => (provider === "beam" ? found : null), nowMs };
}

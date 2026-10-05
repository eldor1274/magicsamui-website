// Simulated Beam payment (demo mode only). The demo checkout page validates
// Beam's published playground test cards in the browser and posts ONLY the
// chosen outcome here - never a card number, expiry, CVV or name. Bodies
// with any other field are rejected so card data can't slip through.

import type { BookingConfig } from "./config.ts";
import { TOKEN_TTL_HOURS } from "./config.ts";
import { createDemoProof, verifyBookingToken } from "./token.ts";
import type { DemoFailureCode, DemoPayOutcome, DemoPayResponse } from "./types.ts";
import { demoReturnUrl } from "./urls.ts";

export interface DemoPayDeps {
  config: BookingConfig;
  origin: string;
  nowMs?: number;
}

export interface DemoPayResult {
  status: number;
  body: DemoPayResponse;
}

const OUTCOMES: DemoPayOutcome[] = ["paid", "declined", "insufficient_funds"];

export function runDemoPay(rawBody: unknown, deps: DemoPayDeps): DemoPayResult {
  if (deps.config.paymentMode !== "demo") {
    return { status: 404, body: { ok: false, error: "not_found", message: "Not found." } };
  }
  const nowMs = deps.nowMs ?? Date.now();
  if (typeof rawBody !== "object" || rawBody === null) {
    return { status: 400, body: { ok: false, error: "invalid_request", message: "Invalid request." } };
  }
  const body = rawBody as Record<string, unknown>;
  const extra = Object.keys(body).filter((k) => k !== "t" && k !== "outcome");
  if (extra.length > 0 || !OUTCOMES.includes(body.outcome as DemoPayOutcome)) {
    return { status: 400, body: { ok: false, error: "invalid_request", message: "Invalid request." } };
  }
  const verified = verifyBookingToken(body.t, deps.config.tokenSecret, nowMs);
  if (!verified.ok || verified.payload.booking.paymentMode !== "demo") {
    return { status: 400, body: { ok: false, error: "invalid_token", message: "This payment link is not valid." } };
  }
  const booking = verified.payload.booking;
  if (Date.parse(booking.linkExpiresAt) <= nowMs) {
    return { status: 410, body: { ok: false, error: "invalid_token", message: "This payment link has expired." } };
  }

  const outcome = body.outcome as DemoPayOutcome;
  if (outcome === "paid") {
    const proof = createDemoProof(booking.ref, "paid", null, deps.config.tokenSecret, TOKEN_TTL_HOURS * 3600, nowMs);
    return {
      status: 200,
      body: { ok: true, status: "paid", returnUrl: demoReturnUrl(deps.origin, booking.ref, body.t as string, proof) },
    };
  }
  const failureCode: DemoFailureCode = outcome === "insufficient_funds" ? "CH_INSUFFICIENT_FUNDS" : "CH_CARD_DECLINED";
  return { status: 200, body: { ok: true, status: "failed", failureCode } };
}

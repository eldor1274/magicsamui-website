// Payment status for the return page (server). Never trusts the query
// string alone: the booking token is verified, then the status comes from a
// signed demo proof (demo mode) or from Beam itself (beam-* modes).

import { getPaymentLink, listPaymentLinkCharges, mapLinkStatus } from "./beam.ts";
import type { BookingConfig } from "./config.ts";
import { verifyBookingToken, verifyDemoProof } from "./token.ts";
import type { ApiError, BookingSummary, PaymentStatus, StatusResponse } from "./types.ts";

export interface StatusParams {
  t: string | null;
  p: string | null;
  l: string | null;
}

export interface StatusDeps {
  config: BookingConfig;
  nowMs?: number;
  fetchImpl?: typeof fetch;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface StatusResult {
  status: number;
  body: StatusResponse | ApiError;
}

function ok(booking: BookingSummary, status: PaymentStatus, failureCode: string | null, nowMs: number): StatusResult {
  return {
    status: 200,
    body: {
      ok: true,
      ref: booking.ref,
      paymentMode: booking.paymentMode,
      status,
      failureCode,
      booking,
      checkedAt: new Date(nowMs).toISOString(),
    },
  };
}

function pendingOrExpired(booking: BookingSummary, nowMs: number): PaymentStatus {
  return Date.parse(booking.linkExpiresAt) <= nowMs ? "expired" : "pending";
}

export async function runStatus(params: StatusParams, deps: StatusDeps): Promise<StatusResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const { config } = deps;

  const verified = verifyBookingToken(params.t, config.tokenSecret, nowMs);
  if (!verified.ok) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "invalid_token",
        message:
          verified.reason === "expired"
            ? "This booking link has expired. Please contact us if you have paid."
            : "This booking link is not valid.",
      },
    };
  }
  const booking = verified.payload.booking;
  if (booking.paymentMode !== config.paymentMode) {
    return {
      status: 409,
      body: { ok: false, error: "invalid_token", message: "This booking was made in a different payment mode." },
    };
  }

  if (config.paymentMode === "demo") {
    if (params.p) {
      const proof = verifyDemoProof(params.p, config.tokenSecret, nowMs);
      if (proof.ok && proof.payload.ref === booking.ref) {
        return ok(booking, proof.payload.status, proof.payload.failureCode, nowMs);
      }
      return { status: 400, body: { ok: false, error: "invalid_token", message: "The payment confirmation is not valid." } };
    }
    return ok(booking, pendingOrExpired(booking, nowMs), null, nowMs);
  }

  if (!config.beam) {
    return { status: 503, body: { ok: false, error: "payment_unavailable", message: "Payment status is unavailable." } };
  }

  try {
    let paymentLinkId: string | null = null;
    if (params.l) {
      const link = verifyBookingToken(params.l, config.tokenSecret, nowMs);
      if (link.ok && link.payload.booking.ref === booking.ref) paymentLinkId = link.payload.paymentLinkId;
    }

    if (paymentLinkId) {
      const link = await getPaymentLink(config.beam, paymentLinkId, deps.fetchImpl);
      const refMatches = !link.order?.referenceId || link.order.referenceId === booking.ref;
      if (!refMatches || link.order?.netAmount !== booking.dueNowSatang || link.order?.currency !== "THB") {
        deps.log?.("beam_status_mismatch", { ref: booking.ref, paymentLinkId });
        return ok(booking, "failed", "AMOUNT_OR_REFERENCE_MISMATCH", nowMs);
      }
      return ok(booking, mapLinkStatus(link.status), null, nowMs);
    }

    // Fallback without the link id: look for a succeeded charge for this ref.
    const charges = await listPaymentLinkCharges(config.beam, booking.ref, deps.fetchImpl);
    const paid = charges.some(
      (c) => c.status === "SUCCEEDED" && c.amount === booking.dueNowSatang && c.currency === "THB" && c.referenceId === booking.ref,
    );
    return ok(booking, paid ? "paid" : pendingOrExpired(booking, nowMs), null, nowMs);
  } catch (e) {
    deps.log?.("beam_status_failed", { ref: booking.ref, message: e instanceof Error ? e.message : String(e) });
    return { status: 502, body: { ok: false, error: "upstream_error", message: "We couldn't check the payment just now." } };
  }
}

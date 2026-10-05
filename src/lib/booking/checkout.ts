// Checkout orchestration (server). Re-quotes on the server from the cart's
// identifiers only, creates the booking ref + signed token, and creates the
// Beam payment link (or the simulated demo link). No reservation is created
// and nothing is stored: this is a preview.

import { getInventory, buildOffers } from "./availability.ts";
import { createPaymentLink, buildPaymentLinkRequest, BeamApiError } from "./beam.ts";
import {
  BOOKING_WINDOW_MONTHS,
  MAX_CART_ITEMS,
  MAX_NIGHTS,
  MAX_SEARCH_ADULTS,
  MERCHANT_NAME,
  PAYMENT_LINK_TTL_MINUTES,
  PROMO_CODE,
  TOKEN_TTL_HOURS,
} from "./config.ts";
import type { BookingConfig } from "./config.ts";
import { todayInBangkok } from "./dates.ts";
import { MIN_CHARGE_SATANG, QuoteError, computeQuote, resolvePromo } from "./quote.ts";
import { createBookingToken, generateBookingRef, idempotencyKeyFor } from "./token.ts";
import type { BookingSummary, CheckoutFailure, CheckoutResponse, Quote } from "./types.ts";
import { cancelUrl, demoPayUrl, returnUrl } from "./urls.ts";
import { parseCheckoutRequest, unavailableCartSlugs } from "./validate.ts";
import type { ValidationLimits } from "./validate.ts";

export interface CheckoutDeps {
  config: BookingConfig;
  /** Allow-listed origin (see urls.ts resolveOrigin). */
  origin: string;
  nowMs?: number;
  fetchImpl?: typeof fetch;
  pickRefChar?: (max: number) => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface CheckoutResult {
  status: number;
  body: CheckoutResponse;
}

export function validationLimits(nowMs: number): ValidationLimits {
  return {
    today: todayInBangkok(new Date(nowMs)),
    maxNights: MAX_NIGHTS,
    bookingWindowMonths: BOOKING_WINDOW_MONTHS,
    maxSearchAdults: MAX_SEARCH_ADULTS,
    maxCartItems: MAX_CART_ITEMS,
  };
}

function fail(status: number, body: Omit<CheckoutFailure, "ok">): CheckoutResult {
  return { status, body: { ok: false, ...body } };
}

export async function runCheckout(rawBody: unknown, deps: CheckoutDeps): Promise<CheckoutResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const { config } = deps;
  const limits = validationLimits(nowMs);

  const parsed = parseCheckoutRequest(rawBody, limits);
  if (!parsed.ok) {
    return fail(400, { error: "invalid_request", message: "Please check your booking details.", issues: parsed.issues });
  }
  const req = parsed.value;

  const promo = resolvePromo(req.promo, config.promoPct, PROMO_CODE);
  if (promo && !promo.valid) return fail(400, { error: "promo_invalid", message: promo.message });

  const { inventory, dataSource } = await getInventory(req.checkIn, req.checkOut, config, {
    fetchImpl: deps.fetchImpl,
    onFallback: (e) => deps.log?.("cloudbeds_fallback", { error: e instanceof Error ? e.message : String(e) }),
  });
  const offers = buildOffers(inventory, 1);
  const gone = unavailableCartSlugs(req.items, offers);
  if (gone.length > 0) {
    return fail(409, {
      error: "unavailable",
      message: "Sorry - a room in your reservation was just booked by someone else. Please choose again.",
      unavailableSlugs: gone,
    });
  }

  let quote: Quote;
  try {
    quote = computeQuote(
      {
        checkIn: req.checkIn,
        checkOut: req.checkOut,
        items: req.items,
        promo: promo && promo.valid ? { code: promo.code, pct: promo.pct, label: promo.label } : null,
        pricing: { cardFeePct: config.cardFeePct, depositPct: config.depositPct },
      },
      offers,
    );
  } catch (e) {
    if (e instanceof QuoteError) {
      return fail(409, { error: "unavailable", message: "That rate is no longer available.", unavailableSlugs: [e.slug] });
    }
    throw e;
  }

  if (quote.totalSatang !== req.expectedTotalSatang) {
    return fail(409, {
      error: "price_changed",
      message: "The price for your stay has just changed. Please review the new total before paying.",
      quote,
    });
  }
  if (quote.dueNowSatang < MIN_CHARGE_SATANG) {
    return fail(400, { error: "invalid_request", message: "The amount due is too small to pay online." });
  }

  const today = limits.today;
  const ref = generateBookingRef(today, deps.pickRefChar);
  const linkExpiresAt = new Date(nowMs + PAYMENT_LINK_TTL_MINUTES * 60_000).toISOString();
  const booking: BookingSummary = {
    ref,
    paymentMode: config.paymentMode,
    checkIn: quote.checkIn,
    checkOut: quote.checkOut,
    nights: quote.nights,
    items: req.items,
    itemRoomSatang: quote.lines.map((l) => l.roomSatang),
    promoCode: quote.promo?.code ?? null,
    totalSatang: quote.totalSatang,
    cardFeeSatang: quote.cardFeeSatang,
    dueNowSatang: quote.dueNowSatang,
    createdAt: new Date(nowMs).toISOString(),
    linkExpiresAt,
  };
  const ttl = TOKEN_TTL_HOURS * 3600;
  const token = createBookingToken(booking, null, config.tokenSecret, ttl, nowMs);

  if (config.paymentMode === "demo") {
    return {
      status: 200,
      body: {
        ok: true,
        ref,
        redirectUrl: demoPayUrl(deps.origin, token),
        paymentMode: "demo",
        dataSource,
        quote,
        expiresAt: linkExpiresAt,
        linkToken: null,
      },
    };
  }

  if (!config.beam) {
    return fail(503, { error: "payment_unavailable", message: "Online payment is not available right now." });
  }

  try {
    const body = buildPaymentLinkRequest({
      ref,
      quote,
      merchantName: MERCHANT_NAME,
      redirectUrl: returnUrl(deps.origin, ref, token),
      cancelUrl: cancelUrl(deps.origin, ref, token),
      nowMs,
      ttlMinutes: PAYMENT_LINK_TTL_MINUTES,
    });
    const link = await createPaymentLink(config.beam, body, idempotencyKeyFor(ref, config.paymentMode), deps.fetchImpl);
    const linkToken = createBookingToken(booking, link.id, config.tokenSecret, ttl, nowMs);
    deps.log?.("beam_link_created", { ref, mode: config.paymentMode, paymentLinkId: link.id, amount: quote.dueNowSatang });
    return {
      status: 200,
      body: {
        ok: true,
        ref,
        redirectUrl: link.url,
        paymentMode: config.paymentMode,
        dataSource,
        quote,
        expiresAt: linkExpiresAt,
        linkToken,
      },
    };
  } catch (e) {
    deps.log?.("beam_link_failed", {
      ref,
      status: e instanceof BeamApiError ? e.status : null,
      errorCode: e instanceof BeamApiError ? e.errorCode : null,
      message: e instanceof Error ? e.message : String(e),
    });
    return fail(502, {
      error: "upstream_error",
      message: "We couldn't reach our payment provider. Nothing has been charged - please try again in a moment.",
    });
  }
}

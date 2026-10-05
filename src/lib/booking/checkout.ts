// Checkout orchestration (server). Re-quotes on the server from the cart's
// identifiers only, creates the booking ref + signed token, and creates the
// Beam payment link (or the simulated demo link). No reservation is created
// and nothing is stored: this is a preview.

import { InventoryUnavailableError, buildOffers, getCartInventory } from "./availability.ts";
import { createPaymentLink, buildPaymentLinkRequest, BeamApiError } from "./beam.ts";
import { getCatalogueRoom } from "./catalogue.ts";
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
import { createBookingToken, generateBookingRef, generateNonce, idempotencyKeyFor } from "./token.ts";
import type { BookingSummary, CheckoutFailure, CheckoutResponse, DataSource, Quote } from "./types.ts";
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
  /** Random salt for the Beam idempotency key (tests pin it). */
  nonce?: () => string;
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

const LIVE_AVAILABILITY_UNCONFIRMED = "We could not confirm live availability. Nothing has been charged - please try again in a moment.";

/**
 * Whether real money may be taken at prices from this data source. Simulated
 * data may never price a beam-live charge, and a Cloudbeds outage may never
 * be papered over with demo data once a Beam payment link would follow.
 */
export function dataSourceAllowsPayment(paymentMode: BookingConfig["paymentMode"], dataSource: DataSource): boolean {
  if (paymentMode === "demo") return true;
  if (paymentMode === "beam-live") return dataSource === "cloudbeds";
  return dataSource !== "demo-fallback"; // playground: explicit demo data is fine (test money), an outage is not
}

export async function runCheckout(rawBody: unknown, deps: CheckoutDeps): Promise<CheckoutResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const { config } = deps;
  const limits = validationLimits(nowMs);

  const parsed = parseCheckoutRequest(rawBody, limits);
  if (!parsed.ok) {
    return fail(400, {
      error: "invalid_request",
      message: "Please check your booking details.",
      issues: parsed.issues,
      ...(parsed.fixStep ? { fixStep: parsed.fixStep } : {}),
    });
  }
  const req = parsed.value;

  const promo = resolvePromo(req.promo, config.promoPct, PROMO_CODE);
  if (promo && !promo.valid) return fail(400, { error: "promo_invalid", message: promo.message });

  if (!dataSourceAllowsPayment(config.paymentMode, config.dataSource)) {
    deps.log?.("checkout_refused_data_source", { mode: config.paymentMode, dataSource: config.dataSource });
    return fail(503, { error: "payment_unavailable", message: LIVE_AVAILABILITY_UNCONFIRMED });
  }

  let inventoryResult: Awaited<ReturnType<typeof getCartInventory>>;
  try {
    inventoryResult = await getCartInventory(req.checkIn, req.checkOut, req.items, config, {
      fetchImpl: deps.fetchImpl,
      // Simulated stand-in data only while payments are simulated too.
      allowDemoFallback: config.paymentMode === "demo",
      onFallback: (e) => deps.log?.("cloudbeds_fallback", { error: e instanceof Error ? e.message : String(e) }),
      onOccupancyPricing: (note) => deps.log?.("cloudbeds_occupancy_rate_differs", { ...note }),
    });
  } catch (e) {
    if (!(e instanceof InventoryUnavailableError)) throw e;
    deps.log?.("checkout_refused_cloudbeds_down", { mode: config.paymentMode, error: e.message });
    return fail(503, { error: "payment_unavailable", message: LIVE_AVAILABILITY_UNCONFIRMED });
  }
  const { inventory, dataSource } = inventoryResult;
  if (!dataSourceAllowsPayment(config.paymentMode, dataSource)) {
    deps.log?.("checkout_refused_data_source", { mode: config.paymentMode, dataSource });
    return fail(503, { error: "payment_unavailable", message: LIVE_AVAILABILITY_UNCONFIRMED });
  }
  const offers = buildOffers(inventory, 1);
  // Two different causes, told apart so the guest gets the right advice:
  // sold (gone for these dates) vs an occupancy limit (Cloudbeds won't take
  // this many guests in that room online - fewer guests may still work).
  const overLimit = req.items
    .filter((i) => {
      const max = offers.find((o) => o.slug === i.slug)?.maxAdults;
      return max !== undefined && i.adults > max;
    })
    .map((i) => i.slug);
  const gone = [...new Set([...unavailableCartSlugs(req.items, offers), ...overLimit])];
  if (gone.length > 0) {
    const refusedForParty = new Set([...(inventoryResult.occupancyRefused ?? []), ...overLimit]);
    const occupancySlugs = gone.filter((slug) => refusedForParty.has(slug));
    let message = "Sorry - a room in your reservation was just booked by someone else. Please choose again.";
    if (occupancySlugs.length === gone.length) {
      const item = req.items.find((i) => i.slug === gone[0]);
      const name = getCatalogueRoom(gone[0])?.name ?? "This room";
      message =
        gone.length === 1 && item
          ? `${name} can't be booked online for ${item.adults} guests - try fewer guests or message us.`
          : "Some rooms can't be booked online for this many guests - try fewer guests per room or message us.";
    }
    return fail(409, {
      error: "unavailable",
      message,
      unavailableSlugs: gone,
      ...(occupancySlugs.length > 0 ? { occupancySlugs } : {}),
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

  // Both the total AND the amount actually charged must match what the guest
  // was shown (a deposit % changed by a redeploy mid-session changes only the latter).
  if (quote.totalSatang !== req.expectedTotalSatang || quote.dueNowSatang !== req.expectedDueNowSatang) {
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
    ...(req.theme ? { theme: req.theme } : {}),
  };
  const ttl = TOKEN_TTL_HOURS * 3600;
  const token = createBookingToken(booking, null, config.tokenSecret, ttl, nowMs);

  if (config.paymentMode === "demo") {
    return {
      status: 200,
      body: {
        ok: true,
        ref,
        redirectUrl: demoPayUrl(deps.origin, token, booking.theme),
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
      redirectUrl: returnUrl(deps.origin, ref, token, booking.theme),
      cancelUrl: cancelUrl(deps.origin, ref, token, booking.theme),
      nowMs,
      ttlMinutes: PAYMENT_LINK_TTL_MINUTES,
    });
    // One key per booking attempt: the salt keeps two same-day bookings whose
    // 4-character refs happen to collide from sharing a key (Beam would answer
    // 412 for the same key with a different body).
    const idempotencyKey = idempotencyKeyFor(ref, config.paymentMode, (deps.nonce ?? generateNonce)());
    const link = await createPaymentLink(config.beam, body, idempotencyKey, deps.fetchImpl);
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

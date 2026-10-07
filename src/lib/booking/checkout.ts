// Checkout orchestration (server). Re-quotes on the server from the cart's
// identifiers only (no cache), then per provider:
// - demo: signed token + the simulated payment page (nothing reserved);
// - beam: Beam payment link (preview: no reservation is created);
// - stripe: HOLD FIRST - Cloudbeds reservation, price assertion, then a
//   Stripe Checkout Session (stripeCheckout.ts).

import { InventoryUnavailableError, buildOffers, getCartInventory } from "./availability.ts";
import { createPaymentLink, buildPaymentLinkRequest, BeamApiError } from "./beam.ts";
import { POLICY_VERSION, getCatalogueRoom } from "./catalogue.ts";
import {
  BOOKING_WINDOW_MONTHS,
  MAX_CART_ITEMS,
  MAX_NIGHTS,
  MAX_SEARCH_ADULTS,
  MERCHANT_NAME,
  PAYMENT_LINK_TTL_MINUTES,
  TOKEN_TTL_HOURS,
} from "./config.ts";
import type { BookingConfig } from "./config.ts";
import { todayInBangkok } from "./dates.ts";
import { MIN_CHARGE_SATANG, QuoteError, computeQuote, resolvePromo, resolvePromoFor } from "./quote.ts";
import { createBookingToken, generateBookingRef, generateNonce, idempotencyKeyFor } from "./token.ts";
import { providerOf } from "./payments/provider.ts";
import { STRIPE_MAX_CHARGE_SATANG } from "./payments/stripe.ts";
import { noteCheckoutReadFailure, startStripeCheckout } from "./stripeCheckout.ts";
import type { StripeDeps } from "./stripeDeps.ts";
import type { BookingSummary, CheckoutFailure, CheckoutResponse, DataSource, PromoResult, Quote } from "./types.ts";
import { cancelUrl, demoPayUrl, returnUrl } from "./urls.ts";
import { parseCheckoutRequest, parseGuestInput, unavailableCartSlugs } from "./validate.ts";
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
  /** Stripe modes: Stripe client, Cloudbeds writer, KV, alerts (runtime.ts builds them). */
  stripe?: StripeDeps;
  /** Client IP (stripe: hashed per-client hold brake; never stored in clear). */
  clientIp?: string | null;
  /** Stage B staff cookie value (testAccess.ts). */
  testAccessToken?: string | null;
  /** Waits between unit-lock attempts (tests shorten it). */
  sleep?: (ms: number) => Promise<void>;
  /** Overrides how long a checkout waits for a unit another checkout holds (tests). */
  unitLockWaitMs?: number;
  /** Wall-clock deadline (`clock` ms) by which the route must answer; stripe sizes its writes to it. */
  deadlineMs?: number;
  /** Wall clock for the deadline (default Date.now; tests move it). */
  clock?: () => number;
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
export const TERMS_CHANGED =
  "Our booking terms were just updated. Nothing has been reserved or charged - please refresh the page, review the terms and tick the box again.";

/**
 * Whether real money may be taken at prices from this data source. Simulated
 * data may never price a beam-live charge, and a Cloudbeds outage may never
 * be papered over with demo data once a Beam payment link would follow.
 */
export function dataSourceAllowsPayment(paymentMode: BookingConfig["paymentMode"], dataSource: DataSource): boolean {
  if (paymentMode === "demo" || paymentMode === "stripe-mock") return true;
  if (paymentMode === "beam-live" || paymentMode === "stripe-live") return dataSource === "cloudbeds";
  return dataSource !== "demo-fallback"; // test modes: explicit demo data is fine (test money), an outage is not
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
  const provider = providerOf(config.paymentMode);

  // Stripe: the guest's details go to Cloudbeds (the hold) and Stripe (receipt).
  // Demo/Beam never read them (they stay in the browser).
  let guest = null;
  if (provider === "stripe") {
    const g = parseGuestInput((rawBody as Record<string, unknown>).guest);
    if (!g.ok) return fail(400, { error: "invalid_request", message: "Please check your details.", issues: g.issues });
    guest = g.value;
    const offPlan = req.items.find((i) => !config.ratePlans.includes(i.ratePlanId) || (!config.addonsEnabled && i.addonIds.length > 0));
    if (offPlan) {
      return fail(400, {
        error: "invalid_request",
        message: "Please choose again.",
        issues: ["Only the Standard Rate can be booked online right now (breakfast can be arranged with us after booking)."],
      });
    }
    // The terms version goes on the payment (msv_terms) and the PAID note as what the guest agreed to: it must be
    // the one their page showed. A tab opened before a terms change (or one that sent no version) is refused
    // before anything is held, and the guest reviews the new terms and ticks the box again.
    if (req.termsVersion !== POLICY_VERSION) {
      deps.log?.("checkout_refused_terms_version", { sent: req.termsVersion ?? null, current: POLICY_VERSION });
      return fail(409, { error: "terms_changed", message: TERMS_CHANGED });
    }
  }

  // Demo / Beam: the site-side % (an unknown code is refused, as before). Stripe: the guest's code
  // sells Cloudbeds' own Direct rate (direct-rate), re-quoted from Cloudbeds below like every price -
  // the browser sends only the code, never a rate. Any other code (or a Stripe page that can't apply
  // it, e.g. ?promo=DIRECT from an old ad link) is ignored, never an error.
  let promo: PromoResult | null;
  if (provider === "stripe") {
    const r = config.promo.mode === "direct-rate" ? resolvePromoFor(req.promo, config.promo, "") : null;
    promo = r?.valid ? r : null;
  } else {
    promo = resolvePromo(req.promo, config.promoPct, config.promo.code);
    if (promo && !promo.valid) return fail(400, { error: "promo_invalid", message: promo.message });
  }
  /** Cloudbeds is asked with its promo code (and its Direct rows are sold) only for a valid code on a direct-rate deployment. */
  const cloudbedsPromo = provider === "stripe" && promo?.valid ? { cloudbedsCode: config.promo.cloudbedsCode } : undefined;

  if (!dataSourceAllowsPayment(config.paymentMode, config.dataSource)) {
    deps.log?.("checkout_refused_data_source", { mode: config.paymentMode, dataSource: config.dataSource });
    return fail(503, { error: "payment_unavailable", message: LIVE_AVAILABILITY_UNCONFIRMED });
  }

  let inventoryResult: Awaited<ReturnType<typeof getCartInventory>>;
  try {
    inventoryResult = await getCartInventory(req.checkIn, req.checkOut, req.items, config, {
      fetchImpl: deps.fetchImpl,
      // Simulated stand-in data only while payments are simulated too.
      allowDemoFallback: config.paymentMode === "demo" || config.paymentMode === "stripe-mock",
      onFallback: (e) => deps.log?.("cloudbeds_fallback", { error: e instanceof Error ? e.message : String(e) }),
      onOccupancyPricing: (note) => deps.log?.("cloudbeds_occupancy_rate_differs", { ...note }),
      ...(cloudbedsPromo ? { promo: cloudbedsPromo } : {}),
    });
  } catch (e) {
    if (!(e instanceof InventoryUnavailableError)) throw e;
    deps.log?.("checkout_refused_cloudbeds_down", { mode: config.paymentMode, error: e.message });
    if (provider === "stripe" && deps.stripe) await noteCheckoutReadFailure(deps.stripe, "re-quote", e.message);
    return fail(503, { error: "payment_unavailable", message: LIVE_AVAILABILITY_UNCONFIRMED });
  }
  const { inventory, dataSource } = inventoryResult;
  if (!dataSourceAllowsPayment(config.paymentMode, dataSource)) {
    deps.log?.("checkout_refused_data_source", { mode: config.paymentMode, dataSource });
    return fail(503, { error: "payment_unavailable", message: LIVE_AVAILABILITY_UNCONFIRMED });
  }
  const offers = buildOffers(inventory, 1, config.ratePlans);
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

  if (provider === "stripe") {
    if (!deps.stripe || !guest) {
      return fail(503, { error: "payment_unavailable", message: "Online payment is not available right now. Nothing has been charged." });
    }
    // Stripe's largest single charge (8 digits). Checked BEFORE any Cloudbeds write: a long stay in a
    // large villa must never create a hold that Stripe will then refuse.
    if (quote.dueNowSatang > STRIPE_MAX_CHARGE_SATANG || quote.lines.some((l) => l.roomSatang > STRIPE_MAX_CHARGE_SATANG)) {
      deps.log?.("checkout_refused_over_max_charge", { amount: quote.dueNowSatang });
      return fail(422, {
        error: "payment_unavailable",
        message: "A stay of this size can't be paid online in one payment. Nothing has been reserved or charged - please message us on WhatsApp and we'll book it for you.",
      });
    }
    // Re-read under the unit lock just before the hold: another checkout may have taken the unit since.
    // It reads WITHOUT the code and without the automatic discounts even for a discounted cart: it only
    // tests availability, which the discounted rows can't change (a Direct or automatic row sells only next
    // to its base row), and every extra Cloudbeds read here (the rate-plan index) is one more way to refuse
    // a checkout right before the hold. The stay-rule read under the same lock (restrictions with the
    // selected discount) re-confirms the discounted row - its promo code or plan, and its base row - on
    // fresh data, and the folio read-back checks the price.
    const recheckAvailability =
      dataSource === "cloudbeds"
        ? async (): Promise<string[]> => {
            const fresh = await getCartInventory(req.checkIn, req.checkOut, req.items, config, {
              fetchImpl: deps.fetchImpl,
              allowDemoFallback: false,
              autoDiscounts: false,
            });
            if (fresh.dataSource !== "cloudbeds") throw new Error("live availability unavailable");
            return unavailableCartSlugs(req.items, buildOffers(fresh.inventory, 1, config.ratePlans));
          }
        : undefined;
    // The Direct rate is held only where the server's own re-quote put a room on it; so is an automatic
    // discount (the re-quote's inventory carries it, nothing the browser sent).
    const directPromo = quote.directRate && cloudbedsPromo ? { code: quote.directRate.code, cloudbedsCode: cloudbedsPromo.cloudbedsCode } : null;
    return startStripeCheckout(
      { checkIn: req.checkIn, checkOut: req.checkOut, items: req.items, guest, quote, inventory, dataSource, theme: req.theme, today, recheckAvailability, promo: directPromo },
      {
        deps: deps.stripe,
        origin: deps.origin,
        nowMs,
        pickRefChar: deps.pickRefChar,
        nonce: deps.nonce,
        clientIp: deps.clientIp ?? null,
        testAccessToken: deps.testAccessToken ?? null,
        sleep: deps.sleep,
        unitLockWaitMs: deps.unitLockWaitMs,
        deadlineMs: deps.deadlineMs,
        clock: deps.clock,
      },
    );
  }

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
        provider: "demo",
        holdReservationId: null,
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
        provider: "beam",
        holdReservationId: null,
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

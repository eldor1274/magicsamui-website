// Pricing. Every amount is INTEGER SATANG (1 THB = 100 satang); rounding
// happens once per derived amount, half-up, to the nearest satang.
// The same pure function runs in the browser (to show the cart) and on the
// server (authoritative re-quote at checkout) - the client never sends prices.

import { ADDONS, RATE_PLANS, getCatalogueRoom } from "./catalogue.ts";
import { eachNight, isHighSeason, isWeekendNight, nightsBetween, weekday } from "./dates.ts";
import type {
  AddonInfo,
  CartItemInput,
  IsoDate,
  NightRate,
  PricingConfig,
  PromoResult,
  Quote,
  QuoteAddonLine,
  QuoteLine,
  QuotePromo,
  RateOffer,
  RatePlanId,
  RoomOffer,
} from "./types.ts";

export const SATANG_PER_THB = 100;
/** Beam's minimum payment link amount (1.00 THB). */
export const MIN_CHARGE_SATANG = 100;

export function thbToSatang(thb: number): number {
  return Math.round(thb * SATANG_PER_THB);
}

/** Satang -> baht as a number (for analytics `value`, which is in major units). */
export function satangToBaht(satang: number): number {
  return Math.round(satang) / SATANG_PER_THB;
}

/**
 * Satang -> an exact major-unit decimal string for the Cloudbeds API
 * ("12345.67", "100.00"). The ONLY place satang become baht on the way to
 * Cloudbeds (cloudbedsWrite.ts); Stripe gets satang integers unchanged.
 */
export function satangToBahtString(satang: number): string {
  if (!Number.isInteger(satang) || satang < 0) throw new RangeError(`satang must be a non-negative integer, got ${satang}`);
  const whole = Math.floor(satang / SATANG_PER_THB);
  const frac = satang % SATANG_PER_THB;
  return `${whole}.${String(frac).padStart(2, "0")}`;
}

/**
 * A Cloudbeds v1.x money field (major-unit baht, sent as a JSON number OR a
 * string such as "0.00") -> integer satang. null when it is not a number.
 */
export function cloudbedsMoneyToSatang(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * SATANG_PER_THB) : null;
}

/** `pct` percent of an integer satang amount, rounded half-up to a satang. */
export function percentOf(amountSatang: number, pct: number): number {
  const basisPoints = Math.round(pct * 100);
  return Math.round((amountSatang * basisPoints) / 10_000);
}

/**
 * Demo nightly rate: reference price, x1.3 in high season, x1.1 on Friday and
 * Saturday nights, rounded to a whole baht per night. Integer maths only.
 */
export function demoNightlySatang(referencePriceThb: number, night: IsoDate): number {
  const season = isHighSeason(night) ? 13 : 10;
  const weekend = isWeekendNight(night) ? 11 : 10;
  const wholeThb = Math.round((referencePriceThb * season * weekend) / 100);
  return wholeThb * SATANG_PER_THB;
}

/** Extra-adult (occupancy) charge for the stay at `adults` guests; 0 when none applies. */
export function occupancyExtraSatang(adultsExtraSatang: Record<string, number> | undefined, adults: number): number {
  const v = adultsExtraSatang?.[String(adults)];
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0;
}

/** Builds the sellable rate plans for a room from its base nightly rates. */
export function buildRateOffers(
  baseNightly: NightRate[],
  adults: number,
  adultsExtraSatang: Record<string, number> = {},
  ratePlans: RatePlanId[] = ["standard", "breakfast"],
): RateOffer[] {
  return ratePlans.map((id) => RATE_PLANS[id]).map((plan) => {
    const rate: RateOffer = {
      ratePlanId: plan.id,
      ratePlanName: plan.name,
      baseNightly,
      supplementSatangPerGuestPerNight: plan.supplementSatangPerGuestPerNight,
      adultsExtraSatang,
      totalSatang: 0,
      pricedForAdults: adults,
    };
    return { ...rate, totalSatang: rateTotalForAdults(rate, adults) };
  });
}

/** Stay total for a rate at a given number of adults (what a rate row shows). */
export function rateTotalForAdults(rate: RateOffer, adults: number): number {
  const base = rate.baseNightly.reduce((sum, n) => sum + n.amountSatang, 0);
  return (
    base +
    occupancyExtraSatang(rate.adultsExtraSatang, adults) +
    rate.supplementSatangPerGuestPerNight * adults * rate.baseNightly.length
  );
}

/** Nights of the stay on which an add-on can be served. */
export function addonEligibleNights(addon: AddonInfo, checkIn: IsoDate, checkOut: IsoDate): IsoDate[] {
  return eachNight(checkIn, checkOut).filter((d) => addon.availableWeekdays.includes(weekday(d)));
}

/** Total for an add-on on one room: price x guests x eligible nights. */
export function addonTotalSatang(addon: AddonInfo, adults: number, checkIn: IsoDate, checkOut: IsoDate): number {
  return addon.priceSatangPerGuestPerNight * adults * addonEligibleNights(addon, checkIn, checkOut).length;
}

export class QuoteError extends Error {
  readonly slug: string;
  constructor(slug: string, message: string) {
    super(message);
    this.name = "QuoteError";
    this.slug = slug;
  }
}

export interface QuoteInput {
  checkIn: IsoDate;
  checkOut: IsoDate;
  items: CartItemInput[];
  /** A VALID promo only (validate the code first). */
  promo: { code: string; pct: number; label: string } | null;
  pricing: PricingConfig;
}

/**
 * Prices a cart from the offers of an availability search. Throws QuoteError
 * if an item's room or rate plan is missing from the offers. Availability is
 * NOT checked here - do that before quoting (see validateCheckout).
 */
export function computeQuote(input: QuoteInput, offers: RoomOffer[]): Quote {
  const nights = nightsBetween(input.checkIn, input.checkOut);
  const lines: QuoteLine[] = input.items.map((item) => {
    const offer = offers.find((o) => o.slug === item.slug);
    const rate = offer?.rates.find((r) => r.ratePlanId === item.ratePlanId);
    if (!offer || !rate) throw new QuoteError(item.slug, `No ${item.ratePlanId} rate for ${item.slug}`);
    if (rate.baseNightly.length !== nights) throw new QuoteError(item.slug, `Rate nights mismatch for ${item.slug}`);

    const nightly: NightRate[] = rate.baseNightly.map((n) => ({
      date: n.date,
      amountSatang: n.amountSatang + rate.supplementSatangPerGuestPerNight * item.adults,
    }));
    const occupancySatang = occupancyExtraSatang(rate.adultsExtraSatang, item.adults);
    const roomSatang = nightly.reduce((sum, n) => sum + n.amountSatang, 0) + occupancySatang;

    const addons: QuoteAddonLine[] = item.addonIds.map((id) => {
      const addon = ADDONS[id];
      const eligibleNights = addonEligibleNights(addon, input.checkIn, input.checkOut);
      return {
        addonId: id,
        name: addon.name,
        eligibleNights,
        guests: item.adults,
        amountSatang: addon.priceSatangPerGuestPerNight * item.adults * eligibleNights.length,
      };
    });
    const addonsSatang = addons.reduce((sum, a) => sum + a.amountSatang, 0);

    return {
      slug: item.slug,
      roomName: getCatalogueRoom(item.slug)?.name ?? item.slug,
      ratePlanId: item.ratePlanId,
      ratePlanName: RATE_PLANS[item.ratePlanId].name,
      adults: item.adults,
      nights,
      nightly,
      occupancyExtraSatang: occupancySatang,
      roomSatang,
      addons,
      addonsSatang,
    };
  });

  const roomsSubtotalSatang = lines.reduce((sum, l) => sum + l.roomSatang, 0);
  const addonsSubtotalSatang = lines.reduce((sum, l) => sum + l.addonsSatang, 0);

  let promo: QuotePromo | null = null;
  if (input.promo && input.promo.pct > 0) {
    promo = {
      code: input.promo.code,
      pct: input.promo.pct,
      label: input.promo.label,
      discountSatang: percentOf(roomsSubtotalSatang, input.promo.pct),
    };
  }

  const feeBaseSatang = roomsSubtotalSatang + addonsSubtotalSatang - (promo?.discountSatang ?? 0);
  const cardFeeSatang = percentOf(feeBaseSatang, input.pricing.cardFeePct);
  const totalSatang = feeBaseSatang + cardFeeSatang;
  const depositPct = input.pricing.depositPct;
  const dueNowSatang =
    depositPct >= 100 ? totalSatang : Math.min(totalSatang, Math.max(MIN_CHARGE_SATANG, percentOf(totalSatang, depositPct)));

  return {
    currency: "THB",
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    nights,
    lines,
    roomsSubtotalSatang,
    addonsSubtotalSatang,
    promo,
    feeBaseSatang,
    cardFeePct: input.pricing.cardFeePct,
    cardFeeSatang,
    totalSatang,
    depositPct,
    dueNowSatang,
    balanceSatang: totalSatang - dueNowSatang,
  };
}

/** Per-night average for a line, in satang (analytics `price`). */
export function averageNightlySatang(line: QuoteLine): number {
  return line.nights > 0 ? Math.round(line.roomSatang / line.nights) : 0;
}

/**
 * Validates a promo code. `promoPct` comes from server config (0 = promos
 * switched off, as in every Beam mode). Returns null for an empty code. Only
 * DIRECT (any case) is recognised, and only the demo hints at it.
 */
export function resolvePromo(code: string | null | undefined, promoPct: number, validCode = "DIRECT"): PromoResult | null {
  const normalized = (code ?? "").trim().toUpperCase();
  if (normalized === "") return null;
  if (normalized.length > 32 || !/^[A-Z0-9_-]+$/.test(normalized)) {
    return { code: normalized.slice(0, 32), valid: false, message: "That code doesn't look right - please check it and try again." };
  }
  if (normalized === validCode && promoPct > 0) {
    return { code: normalized, valid: true, pct: promoPct, label: `Direct booking discount (${promoPct}%)` };
  }
  const hint = promoPct > 0 ? ` Try ${validCode} for our best direct rate.` : "";
  return { code: normalized, valid: false, message: `We don't recognise the code ${normalized}.${hint}` };
}

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

/** Builds the sellable rate plans for a room from its base nightly rates. */
export function buildRateOffers(baseNightly: NightRate[], adults: number): RateOffer[] {
  const base = baseNightly.reduce((sum, n) => sum + n.amountSatang, 0);
  return [RATE_PLANS.standard, RATE_PLANS.breakfast].map((plan) => ({
    ratePlanId: plan.id,
    ratePlanName: plan.name,
    baseNightly,
    supplementSatangPerGuestPerNight: plan.supplementSatangPerGuestPerNight,
    totalSatang: base + plan.supplementSatangPerGuestPerNight * adults * baseNightly.length,
    pricedForAdults: adults,
  }));
}

/** Stay total for a rate at a given number of adults (what a rate row shows). */
export function rateTotalForAdults(rate: RateOffer, adults: number): number {
  const base = rate.baseNightly.reduce((sum, n) => sum + n.amountSatang, 0);
  return base + rate.supplementSatangPerGuestPerNight * adults * rate.baseNightly.length;
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
    const roomSatang = nightly.reduce((sum, n) => sum + n.amountSatang, 0);

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
 * Validates a promo code. `promoPct` comes from server config. Returns null
 * for an empty code. Only DIRECT (any case) is recognised in this preview.
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
  return { code: normalized, valid: false, message: `We don't recognise the code ${normalized}. Try DIRECT for our best direct rate.` };
}

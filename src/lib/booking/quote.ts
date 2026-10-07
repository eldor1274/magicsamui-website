// Pricing. Every amount is INTEGER SATANG (1 THB = 100 satang); rounding
// happens once per derived amount, half-up, to the nearest satang.
// The same pure function runs in the browser (to show the cart) and on the
// server (authoritative re-quote at checkout) - the client never sends prices.

import { ADDONS, RATE_PLANS, getCatalogueRoom } from "./catalogue.ts";
import { eachNight, isHighSeason, isWeekendNight, nightsBetween, weekday } from "./dates.ts";
import type { PromoSettings } from "./config.ts";
import type {
  AddonInfo,
  BookingItemDiscount,
  CartItemInput,
  IsoDate,
  NightRate,
  PricingConfig,
  PromoResult,
  PublicBookingConfig,
  Quote,
  QuoteAddonLine,
  QuoteAutoDiscount,
  QuoteDirectRate,
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

/**
 * Builds the sellable rate plans for a room from its base nightly rates.
 * `list` (a discounted Cloudbeds rate only - Direct or automatic): the base rate it is derived from, shown struck through.
 */
export function buildRateOffers(
  baseNightly: NightRate[],
  adults: number,
  adultsExtraSatang: Record<string, number> = {},
  ratePlans: RatePlanId[] = ["standard", "breakfast"],
  list?: RateOffer["list"],
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
      ...(list ? { list } : {}),
    };
    return { ...rate, totalSatang: rateTotalForAdults(rate, adults) };
  });
}

/**
 * The label of a discounted rate (RateOffer.list): an automatic discount's plan name, or for the Direct rate
 * "Direct rate - code X" (null without the guest's code). null when the rate has no list price.
 */
export function rateDiscountLabel(list: RateOffer["list"], directCode: string | null): string | null {
  if (!list) return null;
  if (list.kind === "auto") return list.name ?? "Special rate";
  return directCode ? `${DIRECT_RATE_LABEL} - code ${directCode}` : null;
}

/**
 * The room card's note when the guest's code is not the rate shown (RoomOffer.promoNotApplied): the room is on an
 * automatic discount (its first rate's list carries the plan's name) or on the standard rate.
 */
export function promoNotAppliedNote(code: string, firstRateList: RateOffer["list"]): string {
  const plan = firstRateList?.kind === "auto" ? rateDiscountLabel(firstRateList, null) : null;
  return plan
    ? `Code ${code} doesn't lower this room's price for these dates - our "${plan}" rate is shown.`
    : `Code ${code} doesn't apply to this room for these dates - our standard rate is shown.`;
}

/** The label of a quote line on a discounted rate (summary and payment step); null for a line at the base rate. */
export function lineDiscountLabel(line: Pick<QuoteLine, "listRoomSatang" | "discount">, quote: Pick<Quote, "directRate">): string | null {
  if (line.listRoomSatang === undefined) return null;
  if (line.discount?.kind === "auto") return line.discount.name;
  return quote.directRate?.label ?? null;
}

/** A booked line's discounted rate for the booking token (the return page): its label and the room at the base rate. */
export function bookingItemDiscount(line: QuoteLine, quote: Pick<Quote, "directRate">): BookingItemDiscount | null {
  const label = lineDiscountLabel(line, quote);
  return label === null || line.listRoomSatang === undefined ? null : { kind: line.discount?.kind ?? "direct", label, listSatang: line.listRoomSatang };
}

/** The struck-through base-rate total of a discounted rate at a given number of adults; null when the rate has no list price. */
export function listTotalForAdults(rate: Pick<RateOffer, "list" | "supplementSatangPerGuestPerNight">, adults: number): number | null {
  if (!rate.list) return null;
  const base = rate.list.baseNightly.reduce((sum, n) => sum + n.amountSatang, 0);
  return base + occupancyExtraSatang(rate.list.adultsExtraSatang, adults) + rate.supplementSatangPerGuestPerNight * adults * rate.list.baseNightly.length;
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
    if (rate.baseNightly.length !== nights || (rate.list && rate.list.baseNightly.length !== nights)) {
      throw new QuoteError(item.slug, `Rate nights mismatch for ${item.slug}`);
    }

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
    // A discounted Cloudbeds rate (Direct or automatic): the room is already priced at it; the base rate is only shown (struck through).
    const listRoomSatang = listTotalForAdults(rate, item.adults);
    const discount: QuoteLine["discount"] | null =
      listRoomSatang === null || !rate.list
        ? null
        : rate.list.kind === "auto"
          ? { kind: "auto", name: rate.list.name ?? "Special rate" }
          : { kind: "direct", name: input.promo?.label ?? DIRECT_RATE_LABEL };

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
      ...(listRoomSatang !== null ? { listRoomSatang } : {}),
      ...(discount ? { discount } : {}),
      addons,
      addonsSatang,
    };
  });

  const roomsSubtotalSatang = lines.reduce((sum, l) => sum + l.roomSatang, 0);
  const addonsSubtotalSatang = lines.reduce((sum, l) => sum + l.addonsSatang, 0);
  /** The rooms with the lines on `kind` at their base price, the others as quoted. */
  const roomsWithBaseFor = (kind: "direct" | "auto") =>
    lines.reduce((sum, l) => sum + (l.listRoomSatang !== undefined && l.discount?.kind === kind ? l.listRoomSatang : l.roomSatang), 0);
  // Labelled with the guest's code (the offers carry Direct list prices only when the server applied it).
  let directRate: QuoteDirectRate | null = null;
  if (input.promo && lines.some((l) => l.discount?.kind === "direct")) {
    const baseRoomsSatang = roomsWithBaseFor("direct");
    directRate = {
      code: input.promo.code,
      label: `${input.promo.label} - code ${input.promo.code}`,
      baseRoomsSatang,
      savingSatang: baseRoomsSatang - roomsSubtotalSatang,
    };
  }
  // Cloudbeds' automatic discount plans (no code): named by their plans.
  let autoDiscount: QuoteAutoDiscount | null = null;
  if (lines.some((l) => l.discount?.kind === "auto")) {
    const baseRoomsSatang = roomsWithBaseFor("auto");
    autoDiscount = {
      names: [...new Set(lines.flatMap((l) => (l.discount?.kind === "auto" ? [l.discount.name] : [])))],
      baseRoomsSatang,
      savingSatang: baseRoomsSatang - roomsSubtotalSatang,
    };
  }

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
    directRate,
    autoDiscount,
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

/** PromoResult.label of the Cloudbeds Direct rate (the quote adds " - code DIRECT"). */
export const DIRECT_RATE_LABEL = "Direct rate";

/**
 * Whether the booking page offers the code input and sends a typed (or ?promo=) code with its searches:
 * wherever a code can lower the price, and on a Stripe page that can't apply the Direct code (it answers
 * the code with a note linking the classic booking page instead of ignoring it). Not in Beam modes.
 */
export function promoInputOffered(config: Pick<PublicBookingConfig, "promoEnabled" | "promoMode">): boolean {
  return config.promoEnabled || config.promoMode === "classic-only";
}

/** The code the page suggests ("Use code DIRECT..."), or null where no code can lower the price. */
export function promoCodeHint(config: Pick<PublicBookingConfig, "promoEnabled" | "promoCode">): string | null {
  return config.promoEnabled ? (config.promoCode ?? "DIRECT") : null;
}

/**
 * Validates a promo code for this deployment's PromoSettings. demo (discount) and Beam (off):
 * exactly resolvePromo. direct-rate: the guest's code (trimmed, any case) is valid with pct 0 - the
 * price comes from Cloudbeds' Direct rate rows, never from a site-side %. classic-only: the code is
 * real but this page can't apply it, so the guest gets a calm note linking the classic booking page
 * (`classicPath`, where Cloudbeds applies it) instead of the code being silently ignored.
 */
export function resolvePromoFor(
  code: string | null | undefined,
  settings: Pick<PromoSettings, "mode" | "code" | "pct">,
  classicPath: string,
): PromoResult | null {
  if (settings.mode === "discount" || settings.mode === "off") return resolvePromo(code, settings.pct, settings.code);
  const normalized = (code ?? "").trim().toUpperCase();
  if (normalized === "") return null;
  if (normalized.length > 32 || !/^[A-Z0-9_-]+$/.test(normalized)) {
    return { code: normalized.slice(0, 32), valid: false, message: "That code doesn't look right - please check it and try again." };
  }
  if (normalized !== settings.code) return { code: normalized, valid: false, message: `We don't recognise the code ${normalized}.` };
  if (settings.mode === "direct-rate") return { code: normalized, valid: true, pct: 0, label: DIRECT_RATE_LABEL };
  return {
    code: normalized,
    valid: false,
    note: true,
    message: `Code ${normalized} can't be applied on this page right now - prices here are our standard rates. Our classic booking page applies it.`,
    link: { href: classicPath, text: `Book with code ${normalized} on our classic booking page` },
  };
}

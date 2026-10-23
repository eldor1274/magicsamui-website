// Pricing. Every amount is INTEGER SATANG (1 THB = 100 satang); rounding
// happens once per derived amount, half-up, to the nearest satang.
// The same pure function runs in the browser (to show the cart) and on the
// server (authoritative re-quote at checkout) - the client never sends prices.

import { ADDONS, RATE_PLANS, getCatalogueRoom } from "./catalogue.ts";
import { eachNight, isHighSeason, isWeekendNight, nightsBetween, weekday } from "./dates.ts";
import type { BeamSettings, BookingConfig, PromoSettings } from "./config.ts";
import type {
  AddonInfo,
  BookingItemDiscount,
  CartItemInput,
  IsoDate,
  NightRate,
  PayMethod,
  PricingConfig,
  PromoLookup,
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

/** One of the two payment method groups (types.ts PayMethod). */
export function isPayMethod(v: unknown): v is PayMethod {
  return v === "card_ewallet" || v === "promptpay";
}

/**
 * The payment processing fee % a quote is priced with for the guest's payment method (design S3.2), on the server: the
 * Beam checkout prices with it and passes it to buildPaymentLinkRequest as expectedFeePct, so the link's fee guard
 * follows a BEAM_PROMPTPAY_FEE_PCT override. Beam (config.beam set): card_ewallet -> config.cardFeePct
 * (BOOKING_CARD_FEE_PCT, 3 when unset); promptpay -> config.beam.promptPayFeePct (BEAM_PROMPTPAY_FEE_PCT, 0 when unset:
 * owner decision 1); no method yet -> the card/e-wallet fee (the total a Beam page shows before a method is chosen; a
 * Beam checkout without one is refused from S4.6). Stripe and the demo (config.beam null): config.cardFeePct whatever
 * is sent. It always agrees with the public feeByMethod (config.ts toPublicConfig), which only Beam answers carry, for
 * every group the page offers (payMethodOffered).
 */
export function feePctFor(
  config: Pick<BookingConfig, "cardFeePct"> & { beam: Pick<BeamSettings, "promptPayFeePct"> | null },
  payMethod: PayMethod | null | undefined,
): number {
  return config.beam !== null && payMethod === "promptpay" ? config.beam.promptPayFeePct : config.cardFeePct;
}

/**
 * Whether the checkout takes the payment method group `m` (design S3.1, round-4 amendment: the server half of the
 * BEAM_PROMPTPAY switch). Beam (config.beam set): card_ewallet always; promptpay only while config.beam.promptPay
 * (BEAM_PROMPTPAY, on unless switched off). No method (undefined or null) is never taken, so one check refuses a
 * missing and a switched-off method alike: S4.6 answers both with 400 'Please choose how to pay' (fixStep 'payment')
 * before any hold, Cloudbeds write or Beam call, and S4.3's beamCheckoutAdapter.createPage throws for a group this
 * refuses. Stripe and the demo (config.beam null) offer no choice: false for every value, and their checkout ignores
 * payMethod (validate.ts). It agrees with the public answer (pagePayMethodOffered on toPublicConfig(config)).
 */
export function payMethodOffered(config: { beam: Pick<BeamSettings, "promptPay"> | null }, m: PayMethod | null | undefined): boolean {
  if (config.beam === null) return false;
  return m === "card_ewallet" || (m === "promptpay" && config.beam.promptPay);
}

/**
 * The browser's side of payMethodOffered (design S5.2, round-4 amendment): whether a page whose public config is
 * `config` offers `m` - one of the two groups with a fee in feeByMethod (Beam only; promptpay is absent while
 * BEAM_PROMPTPAY is off). The client drops a persisted payMethod this refuses (a page loaded before the switch, a
 * reload) instead of pricing or sending it. Never true on a Stripe or demo page (no feeByMethod).
 */
export function pagePayMethodOffered(config: Pick<PublicBookingConfig, "feeByMethod">, m: unknown): m is PayMethod {
  return isPayMethod(m) && typeof config.feeByMethod?.[m] === "number";
}

/** The public fields the booking page's method choice reads (design S5.2). */
export type MethodChoiceConfig = Pick<PublicBookingConfig, "provider" | "feeByMethod">;

/**
 * Whether the booking page asks the guest how to pay (design S5.2: card or e-wallet, or Thai PromptPay QR): a Beam page
 * whose public config carries feeByMethod - the hold-first Beam modes, and a locked Beam page. Never a Stripe or demo
 * page (BOOKING_PAYMENT_PROVIDER=beam without Beam keys included: no feeByMethod), so their pricing, copy and checkout
 * requests stay exactly as before, whatever a state or a stored booking holds.
 */
export function pageOffersMethodChoice(config: MethodChoiceConfig): boolean {
  return config.provider === "beam" && typeof config.feeByMethod?.card_ewallet === "number";
}

/**
 * The guest's payment method group on this page: `m` while the page offers it (pageOffersMethodChoice and
 * pagePayMethodOffered), else null. A choice the page no longer offers (a stored PromptPay choice after BEAM_PROMPTPAY
 * was switched off, anything on a Stripe or demo page) is dropped: never priced, never sent.
 */
export function pagePayMethod(config: MethodChoiceConfig, m: unknown): PayMethod | null {
  return pageOffersMethodChoice(config) && pagePayMethodOffered(config, m) ? m : null;
}

/** The method groups the page offers, in display order (card or e-wallet, then PromptPay), with their fee %; [] off a method-choice page. */
export function pagePayMethods(config: MethodChoiceConfig): { method: PayMethod; feePct: number }[] {
  if (!pageOffersMethodChoice(config)) return [];
  const out: { method: PayMethod; feePct: number }[] = [];
  for (const method of ["card_ewallet", "promptpay"] as const) {
    const feePct = config.feeByMethod?.[method];
    if (typeof feePct === "number") out.push({ method, feePct });
  }
  return out;
}

/**
 * What the browser prices a quote with (design S5.2): on a method-choice page the fee of the chosen group
 * (feeByMethod[payMethod]) and, before a group is chosen, the card/e-wallet fee - the higher total, so a total never
 * rises once the guest chooses; everywhere else config.cardFeePct and config.depositPct exactly as before. It mirrors the
 * server's feePctFor for every group the page offers.
 */
export function pagePricing(config: MethodChoiceConfig & PricingConfig, m: unknown): PricingConfig {
  const fees = config.feeByMethod;
  if (!pageOffersMethodChoice(config) || !fees) return { cardFeePct: config.cardFeePct, depositPct: config.depositPct };
  return { cardFeePct: fees[pagePayMethod(config, m) ?? "card_ewallet"] ?? fees.card_ewallet, depositPct: config.depositPct };
}

/**
 * The checkout request's payMethod field (design S3.2 / S5.2): `{ payMethod }` on a method-choice page with an offered
 * group chosen, else nothing - a Stripe or demo request never gains the key.
 */
export function checkoutPayMethod(config: MethodChoiceConfig, m: unknown): { payMethod?: PayMethod } {
  const payMethod = pagePayMethod(config, m);
  return payMethod ? { payMethod } : {};
}

/** A quote's payment processing fee had it been priced at `pct` (quote.ts computeQuote's rounding: `pct` of feeBaseSatang). */
export function feeSatangAt(quote: Pick<Quote, "feeBaseSatang">, pct: number): number {
  return percentOf(quote.feeBaseSatang, pct);
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

/** The label of a discounted rate whose plan has no public name. */
const SPECIAL_RATE_LABEL = "Special rate";

/** The booking token's limit on a discounted rate's label (token.ts DISCOUNT_LABEL_RE). */
const MAX_DISCOUNT_LABEL_LENGTH = 80;

/**
 * A promo-code rate's label: "<name> - code <CODE>" ("Direct rate - code DIRECT", "Long term - code LONGSTAY"), at most
 * 80 characters (the booking token's limit for the return page): a long plan name is cut, never the code.
 */
export function codeRateLabel(name: string, code: string): string {
  const suffix = ` - code ${code}`;
  return `${name.slice(0, Math.max(1, MAX_DISCOUNT_LABEL_LENGTH - suffix.length)).trim()}${suffix}`;
}

/**
 * The label of a discounted rate (RateOffer.list): an automatic discount's plan name, or for a promo-code rate
 * "Direct rate - code X" (DIRECT) or "<plan name> - code X" (any other code: list.name) - null without the guest's
 * code. null when the rate has no list price.
 */
export function rateDiscountLabel(list: RateOffer["list"], directCode: string | null): string | null {
  if (!list) return null;
  if (list.kind === "auto") return list.name ?? SPECIAL_RATE_LABEL;
  return directCode ? codeRateLabel(list.name ?? DIRECT_RATE_LABEL, directCode) : null;
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

/**
 * The label of a quote line on a discounted rate (summary and payment step); null for a line at the base rate. A
 * promo-code rate: "<the line's rate name> - code X" ("Direct rate - code DIRECT"; a quote from before automatic
 * discounts, whose lines carry no rate name: quote.directRate.label).
 */
export function lineDiscountLabel(line: Pick<QuoteLine, "listRoomSatang" | "discount">, quote: Pick<Quote, "directRate">): string | null {
  if (line.listRoomSatang === undefined) return null;
  if (line.discount?.kind === "auto") return line.discount.name;
  if (!quote.directRate) return null;
  return line.discount ? codeRateLabel(line.discount.name, quote.directRate.code) : quote.directRate.label;
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
    // A discounted Cloudbeds rate (a promo code's or automatic): the room is already priced at it; the base rate is only
    // shown (struck through). A code other than DIRECT names the room's own plan (rate.list.name).
    const listRoomSatang = listTotalForAdults(rate, item.adults);
    const discount: QuoteLine["discount"] | null =
      listRoomSatang === null || !rate.list
        ? null
        : rate.list.kind === "auto"
          ? { kind: "auto", name: rate.list.name ?? SPECIAL_RATE_LABEL }
          : { kind: "direct", name: rate.list.name ?? input.promo?.label ?? DIRECT_RATE_LABEL };

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
  // Labelled with the guest's code (the offers carry a promo code's list prices only when the server applied it).
  let directRate: QuoteDirectRate | null = null;
  if (input.promo && lines.some((l) => l.discount?.kind === "direct")) {
    const baseRoomsSatang = roomsWithBaseFor("direct");
    directRate = {
      code: input.promo.code,
      label: codeRateLabel(input.promo.label, input.promo.code),
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
 * wherever a code can lower the price (DIRECT, or any promo code set up in Cloudbeds), and on a Stripe or Beam
 * page that can't apply codes (it answers a code with a note linking the classic booking page instead of
 * ignoring it). Not where no code applies (promo mode off).
 */
export function promoInputOffered(config: Pick<PublicBookingConfig, "promoEnabled" | "promoMode">): boolean {
  return config.promoEnabled || config.promoMode === "classic-only";
}

/** The code the page suggests ("Use code DIRECT..."), or null where no code can lower the price. */
export function promoCodeHint(config: Pick<PublicBookingConfig, "promoEnabled" | "promoCode">): string | null {
  return config.promoEnabled ? (config.promoCode ?? "DIRECT") : null;
}

/**
 * Validates a promo code for this deployment's PromoSettings. The demo (discount, or off with no site-side %):
 * exactly resolvePromo. direct-rate: the price comes from Cloudbeds' own rows, never from a site-side %
 * (pct 0) - the DIRECT alias (BOOKING_PROMO_CODE, trimmed, any case) is valid as "Direct rate"; any other
 * code is valid only as `lookup` (the rate-plan index read for the stay) found it: a plan the page may sell
 * carries it -> valid, labelled with that plan's public name; only plans whose names read as non-refundable
 * carry it -> a calm note pointing to the classic booking page or WhatsApp (no refund terms on this page);
 * otherwise (or without a lookup) "isn't valid for these dates". classic-only (BOOKING_DIRECT_PROMO=off, or no
 * live Cloudbeds rates): EVERY code is real as far as this page can tell, but it can't apply any, so the guest
 * gets a calm note linking the classic booking page (`classicPath`, where Cloudbeds applies it) instead of the
 * code being silently ignored.
 */
export function resolvePromoFor(
  code: string | null | undefined,
  settings: Pick<PromoSettings, "mode" | "code" | "pct">,
  classicPath: string,
  lookup: PromoLookup | null = null,
): PromoResult | null {
  if (settings.mode === "discount" || settings.mode === "off") return resolvePromo(code, settings.pct, settings.code);
  const normalized = (code ?? "").trim().toUpperCase();
  if (normalized === "") return null;
  if (normalized.length > 32 || !/^[A-Z0-9_-]+$/.test(normalized)) {
    return { code: normalized.slice(0, 32), valid: false, message: "That code doesn't look right - please check it and try again." };
  }
  const classicLink = { href: classicPath, text: `Book with code ${normalized} on our classic booking page` };
  if (settings.mode !== "direct-rate") {
    return {
      code: normalized,
      valid: false,
      note: true,
      message: `Code ${normalized} can't be applied on this page right now - prices here are our standard rates. Our classic booking page applies it.`,
      link: classicLink,
    };
  }
  if (normalized === settings.code) return { code: normalized, valid: true, pct: 0, label: DIRECT_RATE_LABEL };
  const found = lookup !== null && lookup.code.toUpperCase() === normalized ? lookup : null;
  if (found?.cloudbedsCode) return { code: normalized, valid: true, pct: 0, label: found.planName ?? SPECIAL_RATE_LABEL };
  if (found && found.refusedPlans.length > 0) {
    return {
      code: normalized,
      valid: false,
      note: true,
      message: `Code ${normalized} is for a non-refundable rate, which can't be booked on this page - our classic booking page applies it, or message us on WhatsApp and we'll book it for you.`,
      link: classicLink,
    };
  }
  return { code: normalized, valid: false, message: `Code ${normalized} isn't valid for these dates.` };
}

// Input validation for the booking API. Everything from the browser is
// untrusted: shapes, ranges, room combinations and add-on rules are all
// re-checked here before anything is priced or paid.

import { ADDONS, getCatalogueRoom, hasUnitConflict, isAddonId, isRatePlanId } from "./catalogue.ts";
import { STAY_DATE_ERROR_MESSAGES, validateStayDates } from "./dates.ts";
import { addonEligibleNights } from "./quote.ts";
import type { AddonId, CartItemInput, CheckoutRequest, IsoDate, RoomOffer, StaySearch } from "./types.ts";

export interface ValidationLimits {
  today: IsoDate;
  maxNights: number;
  bookingWindowMonths: number;
  maxSearchAdults: number;
  maxCartItems: number;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; issues: string[] };

function parseIntStrict(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v === "string" && /^\d{1,6}$/.test(v.trim())) return Number(v.trim());
  return null;
}

function parsePromoField(v: unknown, issues: string[]): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > 32) {
    issues.push("promo must be a short code");
    return undefined;
  }
  return v.trim() || undefined;
}

/** Validates search parameters (from a query string or JSON). */
export function parseSearch(
  input: { checkin?: unknown; checkout?: unknown; adults?: unknown; promo?: unknown },
  limits: ValidationLimits,
): Parsed<StaySearch> {
  const issues: string[] = [];
  const dateError = validateStayDates(input.checkin, input.checkout, limits);
  if (dateError) issues.push(STAY_DATE_ERROR_MESSAGES[dateError]);
  const adults = input.adults === undefined || input.adults === null || input.adults === "" ? 2 : parseIntStrict(input.adults);
  if (adults === null || adults < 1 || adults > limits.maxSearchAdults) {
    issues.push(`adults must be between 1 and ${limits.maxSearchAdults}`);
  }
  const promo = parsePromoField(input.promo, issues);
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: { checkIn: input.checkin as IsoDate, checkOut: input.checkout as IsoDate, adults: adults as number, promo },
  };
}

function parseItem(raw: unknown, index: number, checkIn: IsoDate | null, checkOut: IsoDate | null, issues: string[]): CartItemInput | null {
  const label = `items[${index}]`;
  if (typeof raw !== "object" || raw === null) {
    issues.push(`${label} must be an object`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  const slug = typeof r.slug === "string" ? r.slug : "";
  const room = getCatalogueRoom(slug);
  if (!room || !room.bookable) {
    issues.push(`${label}.slug is not a bookable room`);
    return null;
  }
  if (!isRatePlanId(r.ratePlanId)) {
    issues.push(`${label}.ratePlanId is invalid`);
    return null;
  }
  const adults = parseIntStrict(r.adults);
  if (adults === null || adults < 1 || adults > room.maxGuests) {
    issues.push(`${label}.adults must be between 1 and ${room.maxGuests} for ${room.shortName}`);
    return null;
  }
  const addonIds: AddonId[] = [];
  const rawAddons = r.addonIds === undefined ? [] : r.addonIds;
  if (!Array.isArray(rawAddons) || rawAddons.length > 5) {
    issues.push(`${label}.addonIds must be a short array`);
    return null;
  }
  for (const a of rawAddons) {
    if (!isAddonId(a)) {
      issues.push(`${label}.addonIds contains an unknown add-on`);
      return null;
    }
    if (addonIds.includes(a)) continue;
    const addon = ADDONS[a];
    if (!addon.ratePlans.includes(r.ratePlanId)) {
      issues.push(`${addon.name} can't be added to the ${r.ratePlanId} rate`);
      return null;
    }
    if (checkIn && checkOut && addonEligibleNights(addon, checkIn, checkOut).length === 0) {
      issues.push(`${addon.name} isn't available on any night of this stay`);
      return null;
    }
    addonIds.push(a);
  }
  return { slug, ratePlanId: r.ratePlanId, adults, addonIds };
}

/** Validates the checkout body (shape, dates, rooms, occupancy, combos, add-ons). */
export function parseCheckoutRequest(body: unknown, limits: ValidationLimits): Parsed<CheckoutRequest> {
  const issues: string[] = [];
  if (typeof body !== "object" || body === null) return { ok: false, issues: ["body must be a JSON object"] };
  const b = body as Record<string, unknown>;

  const dateError = validateStayDates(b.checkIn, b.checkOut, limits);
  if (dateError) issues.push(STAY_DATE_ERROR_MESSAGES[dateError]);
  const checkIn = dateError ? null : (b.checkIn as IsoDate);
  const checkOut = dateError ? null : (b.checkOut as IsoDate);

  const promo = parsePromoField(b.promo, issues);

  const expected = b.expectedTotalSatang;
  if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 0) {
    issues.push("expectedTotalSatang must be a non-negative integer");
  }

  const items: CartItemInput[] = [];
  if (!Array.isArray(b.items) || b.items.length === 0) {
    issues.push("items must contain at least one room");
  } else if (b.items.length > limits.maxCartItems) {
    issues.push(`at most ${limits.maxCartItems} rooms per booking`);
  } else {
    b.items.forEach((raw, i) => {
      const item = parseItem(raw, i, checkIn, checkOut, issues);
      if (item) items.push(item);
    });
    if (items.length === b.items.length && hasUnitConflict(items.map((i) => i.slug))) {
      issues.push("two rooms in this booking share the same physical space");
    }
  }

  if (issues.length > 0 || !checkIn || !checkOut) return { ok: false, issues };
  return {
    ok: true,
    value: { checkIn, checkOut, promo, items, expectedTotalSatang: expected as number },
  };
}

/** Slugs in the cart that the offers say can no longer be booked at that rate. */
export function unavailableCartSlugs(items: CartItemInput[], offers: RoomOffer[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    const offer = offers.find((o) => o.slug === item.slug);
    const hasRate = offer?.rates.some((r) => r.ratePlanId === item.ratePlanId);
    if (!offer || !offer.available || !hasRate) out.push(item.slug);
  }
  return out;
}

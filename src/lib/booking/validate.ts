// Input validation for the booking API. Everything from the browser is
// untrusted: shapes, ranges, room combinations and add-on rules are all
// re-checked here before anything is priced or paid. Issue strings are shown
// to the guest as they are, so each is a short, complete sentence.

import { ADDONS, RATE_PLANS, getCatalogueRoom, hasUnitConflict, isAddonId, isRatePlanId } from "./catalogue.ts";
import { STAY_DATE_ERROR_MESSAGES, validateStayDates } from "./dates.ts";
import { addonEligibleNights } from "./quote.ts";
import type { AddonId, CartItemInput, CheckoutRequest, IsoDate, RoomOffer, StaySearch, ThemeName } from "./types.ts";

export interface ValidationLimits {
  today: IsoDate;
  maxNights: number;
  bookingWindowMonths: number;
  maxSearchAdults: number;
  maxCartItems: number;
}

/** fixStep: where the guest can fix the problem ("addons" = an add-on no longer fits the stay). */
export type Parsed<T> = { ok: true; value: T } | { ok: false; issues: string[]; fixStep?: "addons" };

interface IssueSink {
  issues: string[];
  /** Set when an add-on is the problem (the guest fixes it on the Add-ons step). */
  addonIssue: boolean;
}

function parseIntStrict(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v === "string" && /^\d{1,6}$/.test(v.trim())) return Number(v.trim());
  return null;
}

function parsePromoField(v: unknown, issues: string[]): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > 32) {
    issues.push("The promo code is too long.");
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
    issues.push(`Guests must be between 1 and ${limits.maxSearchAdults}.`);
  }
  const promo = parsePromoField(input.promo, issues);
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: { checkIn: input.checkin as IsoDate, checkOut: input.checkout as IsoDate, adults: adults as number, promo },
  };
}

function parseItem(raw: unknown, index: number, checkIn: IsoDate | null, checkOut: IsoDate | null, sink: IssueSink): CartItemInput | null {
  const { issues } = sink;
  const label = `Room ${index + 1}`;
  if (typeof raw !== "object" || raw === null) {
    issues.push(`${label} in your reservation couldn't be read.`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  const slug = typeof r.slug === "string" ? r.slug : "";
  const room = getCatalogueRoom(slug);
  if (!room || !room.bookable) {
    issues.push(`${label} in your reservation can't be booked online.`);
    return null;
  }
  if (!isRatePlanId(r.ratePlanId)) {
    issues.push(`The rate chosen for ${room.shortName} is no longer offered.`);
    return null;
  }
  const adults = parseIntStrict(r.adults);
  if (adults === null || adults < 1 || adults > room.maxGuests) {
    issues.push(`${room.shortName} takes 1 to ${room.maxGuests} guests.`);
    return null;
  }
  const addonIds: AddonId[] = [];
  const rawAddons = r.addonIds === undefined ? [] : r.addonIds;
  if (!Array.isArray(rawAddons) || rawAddons.length > 5) {
    sink.addonIssue = true;
    issues.push(`Too many add-ons were chosen for ${room.shortName}.`);
    return null;
  }
  for (const a of rawAddons) {
    if (!isAddonId(a)) {
      sink.addonIssue = true;
      issues.push(`An add-on chosen for ${room.shortName} is no longer offered.`);
      return null;
    }
    if (addonIds.includes(a)) continue;
    const addon = ADDONS[a];
    if (!addon.ratePlans.includes(r.ratePlanId)) {
      sink.addonIssue = true;
      issues.push(`${addon.name} can't be added to the ${RATE_PLANS[r.ratePlanId]?.name ?? r.ratePlanId} rate.`);
      return null;
    }
    if (checkIn && checkOut && addonEligibleNights(addon, checkIn, checkOut).length === 0) {
      sink.addonIssue = true;
      issues.push(`${addon.name} isn't available on any night of this stay.`);
      return null;
    }
    addonIds.push(a);
  }
  return { slug, ratePlanId: r.ratePlanId, adults, addonIds };
}

/** Validates the checkout body (shape, dates, rooms, occupancy, combos, add-ons). */
export function parseCheckoutRequest(body: unknown, limits: ValidationLimits): Parsed<CheckoutRequest> {
  const sink: IssueSink = { issues: [], addonIssue: false };
  const { issues } = sink;
  if (typeof body !== "object" || body === null) return { ok: false, issues: ["The booking request couldn't be read."] };
  const b = body as Record<string, unknown>;

  const dateError = validateStayDates(b.checkIn, b.checkOut, limits);
  if (dateError) issues.push(STAY_DATE_ERROR_MESSAGES[dateError]);
  const checkIn = dateError ? null : (b.checkIn as IsoDate);
  const checkOut = dateError ? null : (b.checkOut as IsoDate);

  const promo = parsePromoField(b.promo, issues);

  const expected = b.expectedTotalSatang;
  const expectedDueNow = b.expectedDueNowSatang;
  const isAmount = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
  if (!isAmount(expected) || !isAmount(expectedDueNow)) {
    issues.push("The price you were shown couldn't be read - please refresh the page and try again.");
  }

  const items: CartItemInput[] = [];
  if (!Array.isArray(b.items) || b.items.length === 0) {
    issues.push("Your reservation has no rooms.");
  } else if (b.items.length > limits.maxCartItems) {
    issues.push(`At most ${limits.maxCartItems} rooms can be booked together online.`);
  } else {
    b.items.forEach((raw, i) => {
      const item = parseItem(raw, i, checkIn, checkOut, sink);
      if (item) items.push(item);
    });
    if (items.length === b.items.length && hasUnitConflict(items.map((i) => i.slug))) {
      issues.push("Two rooms in your reservation share the same space and can't be booked together.");
    }
  }

  // Cosmetic only (which preview theme to come back to); anything else is ignored.
  const theme: ThemeName | undefined = b.theme === "classic" || b.theme === "magic" ? b.theme : undefined;

  if (issues.length > 0 || !checkIn || !checkOut) {
    return { ok: false, issues, ...(sink.addonIssue ? { fixStep: "addons" as const } : {}) };
  }
  return {
    ok: true,
    value: {
      checkIn,
      checkOut,
      promo,
      items,
      expectedTotalSatang: expected as number,
      expectedDueNowSatang: expectedDueNow as number,
      ...(theme ? { theme } : {}),
    },
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

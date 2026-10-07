// Static booking catalogue: room types, physical units, rate plans, add-ons
// and house policies. Isomorphic and secret-free - safe to import from client
// components (e.g. for photos and descriptions) as well as the server.

import { rooms } from "../../data/rooms.ts";
import { SLUG_TO_ROOM_TYPE } from "../../data/cloudbeds.ts";
import type { AddonId, AddonInfo, CatalogueRoom, RatePlanId, RatePlanInfo, UnitId } from "./types.ts";

/**
 * Which physical units each room type occupies. Combination room types share
 * units with the suites they are made of, so two cart items may never share a
 * unit and a room type is available only when every unit is free.
 */
export const ROOM_UNITS: Record<string, UnitId[]> = {
  "honeymoon-suite": ["HM"],
  "sunrise-suite": ["SR"],
  "garden-suite": ["GS"],
  "seaview-suite": ["SVL"],
  "seaview-2br": ["SVL"],
  "tower-club-3br": ["HM", "SVL"],
  "island-view-3br": ["SVL", "SR"],
  "magic-1-villa": ["HM", "SR", "GS", "SVL"],
  "tuxedo-1br": ["TUX"],
  tuxedo: ["TUX"],
  "tuxedo-seaview-unit": ["TUXL"],
  // Not bookable online (no Cloudbeds room type): enquiry only.
  "tuxedo-3br": ["TUX", "TUXL"],
};

export const UNIT_NAMES: Record<UnitId, string> = {
  HM: "Honeymoon Suite",
  SR: "Sunrise Suite",
  GS: "Garden Suite",
  SVL: "Magic Seaview level",
  TUX: "Tuxedo villa",
  TUXL: "Tuxedo lower seaview unit",
};

/** Display order of results (mirrors the site's rooms page). */
const ORDER = [
  "honeymoon-suite",
  "sunrise-suite",
  "seaview-suite",
  "seaview-2br",
  "garden-suite",
  "tower-club-3br",
  "island-view-3br",
  "magic-1-villa",
  "tuxedo-1br",
  "tuxedo",
  "tuxedo-seaview-unit",
  "tuxedo-3br",
];

function buildCatalogue(): CatalogueRoom[] {
  const out: CatalogueRoom[] = [];
  for (const slug of ORDER) {
    const r = rooms.find((room) => room.slug === slug);
    if (!r) continue;
    const roomTypeId = SLUG_TO_ROOM_TYPE[slug] ?? null;
    out.push({
      slug: r.slug,
      name: r.name,
      shortName: r.shortName,
      cloudbedsRoomTypeId: roomTypeId,
      bookable: roomTypeId !== null,
      units: ROOM_UNITS[slug] ?? [],
      maxGuests: r.guests,
      bedrooms: r.bedrooms,
      bathrooms: r.bathrooms,
      areaSqm: r.area.sqm,
      hasPool: r.hasPool !== false,
      poolType: r.poolType ?? null,
      summary: r.summary,
      description: r.description,
      amenities: r.amenities,
      heroImage: r.heroImage,
      gallery: r.gallery.length > 0 ? r.gallery : [r.heroImage],
      referencePriceThb: r.priceThb,
    });
  }
  return out;
}

export const CATALOGUE: CatalogueRoom[] = buildCatalogue();

const BY_SLUG = new Map(CATALOGUE.map((r) => [r.slug, r]));

export function getCatalogueRoom(slug: string): CatalogueRoom | undefined {
  return BY_SLUG.get(slug);
}

export function getBookableRooms(): CatalogueRoom[] {
  return CATALOGUE.filter((r) => r.bookable);
}

export function isBookableSlug(slug: string): boolean {
  return BY_SLUG.get(slug)?.bookable === true;
}

/** Units shared by two room types (empty when they never conflict). */
export function sharedUnits(slugA: string, slugB: string): UnitId[] {
  const a = ROOM_UNITS[slugA] ?? [];
  const b = ROOM_UNITS[slugB] ?? [];
  return a.filter((u) => b.includes(u));
}

/**
 * Why `slug` cannot be added next to the slugs already in the cart, or null
 * when it can. Uses the cart room's display name in the message.
 */
export function cartConflict(slug: string, cartSlugs: string[]): { withSlug: string; message: string } | null {
  for (const other of cartSlugs) {
    if (sharedUnits(slug, other).length > 0) {
      const name = BY_SLUG.get(other)?.shortName ?? other;
      return {
        withSlug: other,
        message:
          other === slug
            ? "Already in your reservation"
            : `Shares space with ${name} in your reservation`,
      };
    }
  }
  return null;
}

/** True if any two cart slugs occupy the same physical unit. */
export function hasUnitConflict(slugs: string[]): boolean {
  const seen = new Set<UnitId>();
  for (const s of slugs) {
    for (const u of ROOM_UNITS[s] ?? []) {
      if (seen.has(u)) return true;
      seen.add(u);
    }
  }
  return false;
}

/* ------------------------------- policies ----------------------------- */

/**
 * Version of the booking terms below (house rules, deposit, check-in,
 * children, transfer, cancellation). Change it whenever what a guest agrees
 * to changes: it is carried in the Stripe session metadata (msv_terms) and
 * the "PAID via Stripe" Cloudbeds note, so a dispute can be judged against
 * the terms the guest actually saw. bookingTerms.test.ts pins a fingerprint of
 * HOUSE_POLICIES per version, so a text change without a new version fails.
 */
export const POLICY_VERSION = "2026-10-07";

/** Free transfer on arrival for stays of at least this many nights. */
export const FREE_PICKUP_MIN_NIGHTS = 2;

const CHECK_IN_TIME = "3:00 PM";
const CHECK_IN_END_TIME = "11:00 PM";
const CHECK_OUT_TIME = "11:00 AM";

/**
 * The booking terms and house rules: the one source for every place the
 * booking engine shows them (and for what the guest ticks to agree to).
 */
export const HOUSE_POLICIES = {
  checkInTime: CHECK_IN_TIME,
  /** Latest check-in; later arrivals only by arrangement. */
  checkInEndTime: CHECK_IN_END_TIME,
  checkOutTime: CHECK_OUT_TIME,
  checkIn: `Check-in ${CHECK_IN_TIME} - ${CHECK_IN_END_TIME}`,
  checkOut: `Check-out by ${CHECK_OUT_TIME}`,
  lateArrival: `Arrivals after ${CHECK_IN_END_TIME} only by arrangement - message us on WhatsApp first.`,
  /** Under the arrival-time choice and on the confirmation page. */
  arrivalHint: `Check-in is ${CHECK_IN_TIME} - ${CHECK_IN_END_TIME}. Arriving later? Message us on WhatsApp first so we can arrange it.`,
  cancellation:
    "Cancel 60 days or more before arrival: full refund. Less than 60 days before arrival: 50% of the stay is refunded. The payment processing fee is refunded only when the whole stay is refunded.",
  children:
    "Guests aged 12 and over count as adults. Children under 12 on request - please message us before booking. Children must be accompanied by an adult.",
  /** For small popovers (guest pickers). */
  childrenShort: "Ages 12 and over count as adults. Under 12 on request - message us first.",
  /** Arrival only (decision 4): "pickup", never "transfer", which reads as both ways. */
  transferTitle: "Free airport or pier pickup",
  transfer: `Free transfer on arrival from Samui Airport or a nearby pier (such as Bangrak Pier) on stays of ${FREE_PICKUP_MIN_NIGHTS} nights or more.`,
  transferShort: `On arrival at Samui Airport or a nearby pier, for stays of ${FREE_PICKUP_MIN_NIGHTS} nights or more.`,
  /** Once the stay qualifies (after booking). */
  transferHowTo: "Send us your flight or ferry and arrival time on WhatsApp and we'll meet you at Samui Airport or the pier.",
  deposit: "A damage deposit of 8,000 THB per unit is paid in cash on arrival and refunded at check-out after inspection.",
  houseRules: [
    "No pets.",
    "No parties.",
    "No smoking inside (the terrace is fine) - 2,000 THB fee.",
    "No toilet paper or sanitary items in the toilet - 2,000 THB fee.",
    "Photo ID is required at check-in.",
    "Late check-out is rarely possible: every suite is one of a kind, so there is no identical room to move the next guests to.",
    "Cleaning is included, with fresh sheets and towels every 3 days. Extra cleaning on request: 300 THB for a general clean, 500 THB for a full clean.",
    "A lost key or access card is 500 THB; damage or missing items are charged.",
  ],
  /** What the guest agrees to (the checkbox and the payment fine print). */
  agreement: "the house rules, the deposit and the booking and cancellation policy",
};

/* ----------------------------- rate plans ----------------------------- */

export const BREAKFAST_SATANG_PER_GUEST_PER_NIGHT = 100_000; // 1,000.00 THB

const BREAKFAST_IMAGE = { src: "/images/honeymoon-suite/hm-dining-sunset.jpg", alt: "Table set for a meal with a sea view" };

/** Summary of the owner's breakfast policy (rendered as plain text, never raw Markdown). */
export const BREAKFAST_POLICY = [
  {
    heading: "How it works",
    body: "Breakfast is cooked to order for everyone staying in the room. Order from the menu by 8:00 PM the evening before (at least 24 hours ahead for your first morning).",
  },
  {
    heading: "Serving times",
    body: "Breakfast is served between 07:30 and 10:30 in 30-minute slots. Pick your slot when you order.",
  },
  {
    heading: "Please be on time",
    body: "We hold your table for 15 minutes. If you need a different time, tell us the evening before and we will do our best to move your slot.",
  },
  {
    heading: "Allergies and ingredients",
    body: "Let us know about allergies or dietary needs when you order. If something isn't right, tell us at the table and we'll fix it.",
  },
];

export const RATE_PLANS: Record<RatePlanId, RatePlanInfo> = {
  standard: {
    id: "standard",
    name: "Standard Rate",
    supplementSatangPerGuestPerNight: 0,
    packageId: "0",
    shortDescription: `Room only. ${HOUSE_POLICIES.transferTitle} on stays of ${FREE_PICKUP_MIN_NIGHTS} nights or more.`,
    image: null,
    policy: [],
  },
  breakfast: {
    id: "breakfast",
    name: "Breakfast",
    supplementSatangPerGuestPerNight: BREAKFAST_SATANG_PER_GUEST_PER_NIGHT,
    packageId: "491264",
    shortDescription: "Daily cooked-to-order breakfast for every guest (1,000 THB per guest per night).",
    image: BREAKFAST_IMAGE,
    policy: BREAKFAST_POLICY,
  },
};

export const RATE_PLAN_IDS: RatePlanId[] = ["standard", "breakfast"];

export function isRatePlanId(v: unknown): v is RatePlanId {
  return v === "standard" || v === "breakfast";
}

/* ------------------------------- add-ons ------------------------------ */

export const ADDONS: Record<AddonId, AddonInfo> = {
  "breakfast-pp": {
    id: "breakfast-pp",
    name: "Breakfast per person",
    description:
      "Cooked-to-order breakfast served at your suite or villa. Available on Wednesday, Thursday and Friday nights (served the following morning).",
    chargeType: "per-guest-per-night",
    priceSatangPerGuestPerNight: BREAKFAST_SATANG_PER_GUEST_PER_NIGHT,
    availableWeekdays: [3, 4, 5],
    image: BREAKFAST_IMAGE,
    // Not offered on the Breakfast rate plan, which already includes it.
    ratePlans: ["standard"],
  },
};

export const ADDON_IDS: AddonId[] = ["breakfast-pp"];

export function isAddonId(v: unknown): v is AddonId {
  return v === "breakfast-pp";
}

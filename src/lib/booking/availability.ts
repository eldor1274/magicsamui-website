// Availability service: picks the inventory source, falls back to demo data
// when Cloudbeds fails (ONLY while payments are simulated), and turns raw
// inventory into priced offers.

import { CATALOGUE } from "./catalogue.ts";
import { cloudbedsInventory } from "./cloudbedsProvider.ts";
import { demoInventory } from "./demoProvider.ts";
import { logEvent } from "./routeUtils.ts";
import { buildRateOffers, occupancyExtraSatang } from "./quote.ts";
import type { BookingConfig } from "./config.ts";
import type { CartItemInput, DataSource, IsoDate, RatePlanId, RoomInventory, RoomOffer } from "./types.ts";

/** Search answers from Cloudbeds are reused this long (per server instance). */
export const SEARCH_CACHE_TTL_MS = 60_000;

export interface InventoryResult {
  inventory: RoomInventory[];
  dataSource: DataSource;
  /**
   * Cart checks only: rooms free for the dates (adults=1) that Cloudbeds does
   * not offer at the cart's party size - an occupancy limit, not a sale.
   */
  occupancyRefused?: string[];
}

export interface InventoryOptions {
  fetchImpl?: typeof fetch;
  onFallback?: (error: unknown) => void;
  /** Party size to ask Cloudbeds about (default 1: list every room type). */
  adults?: number;
  /**
   * When false, a Cloudbeds failure throws InventoryUnavailableError instead
   * of answering with simulated data. Must be false whenever a real Beam
   * payment could follow (any beam-* mode). Default true.
   */
  allowDemoFallback?: boolean;
  /** Search only: short per-instance cache of identical Cloudbeds answers. */
  cacheTtlMs?: number;
  /** How long a call may wait for the preview's Cloudbeds call budget (0 = refuse at once). */
  budgetWaitMs?: number;
}

/** Checkout waits this long, at most, for the Cloudbeds call budget before refusing. */
export const CHECKOUT_BUDGET_WAIT_MS = 3_000;

/** Live availability could not be confirmed and demo data is not allowed to stand in. */
export class InventoryUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Live availability unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "InventoryUnavailableError";
  }
}

export async function getInventory(
  checkIn: IsoDate,
  checkOut: IsoDate,
  config: Pick<BookingConfig, "dataSource" | "cloudbeds">,
  options: InventoryOptions = {},
): Promise<InventoryResult> {
  if (config.dataSource === "cloudbeds" && config.cloudbeds) {
    try {
      const inventory = await cloudbedsInventory(checkIn, checkOut, {
        apiKey: config.cloudbeds.apiKey,
        propertyId: config.cloudbeds.propertyId,
        adults: options.adults,
        fetchImpl: options.fetchImpl,
        cacheTtlMs: options.cacheTtlMs,
        budgetWaitMs: options.budgetWaitMs,
        baseRateOnly: config.cloudbeds.baseRateOnly === true,
        // Stripe sells the base (BAR) row only: a room type offered only on another plan is shown as unavailable.
        onNoBaseRate: (slug) => logEvent("cloudbeds_no_base_rate", { slug, checkIn, checkOut }),
      });
      return { inventory, dataSource: "cloudbeds" };
    } catch (error) {
      if (options.allowDemoFallback === false) throw new InventoryUnavailableError(error);
      options.onFallback?.(error);
      return { inventory: demoInventory(checkIn, checkOut), dataSource: "demo-fallback" };
    }
  }
  return { inventory: demoInventory(checkIn, checkOut), dataSource: "demo" };
}

/** Logged when Cloudbeds' rate at the party size differs from the adults=1 rate (open question in the docs). */
export interface OccupancyPricingNote {
  slug: string;
  adults: number;
  /** Stay total from roomRateDetailed when asked with adults=1 (what we price from). */
  base1Satang: number;
  /** Stay total from roomRateDetailed when asked with the party's adults. */
  baseNSatang: number;
  /** adultsExtraCharge for that party size from the adults=1 answer. */
  extraNSatang: number;
  /** baseN === base1 + extraN: the rate at N already includes the surcharge. */
  rateIncludesExtra: boolean;
}

function stayTotal(inv: RoomInventory): number {
  return inv.baseNightly.reduce((s, n) => s + n.amountSatang, 0);
}

/**
 * Inventory for a checkout, priced on EXACTLY the same basis as the search:
 * the adults=1 answer is the only price source (base nightly rates plus its
 * adultsExtraCharge table, as search shows them). Cloudbeds is also asked
 * once per distinct party size in the cart, but those answers are only an
 * availability gate: a room it doesn't offer at that occupancy is refused.
 * So the browser's quote and the server's re-quote can never diverge just
 * because Cloudbeds folds the occupancy surcharge into roomRateDetailed (or
 * picks another row) at a bigger party size; such differences are reported
 * through `onOccupancyPricing` so the open question gets answered from data.
 * Rooms the gate refuses are reported in `occupancyRefused` (fewer guests may
 * still work). The calls run one after another, never all at once, so one
 * big cart can't burst the shared Cloudbeds key.
 * Demo inventory does not depend on the party size, so it is read once.
 */
export async function getCartInventory(
  checkIn: IsoDate,
  checkOut: IsoDate,
  items: CartItemInput[],
  config: Pick<BookingConfig, "dataSource" | "cloudbeds">,
  options: Omit<InventoryOptions, "adults" | "cacheTtlMs"> & { onOccupancyPricing?: (note: OccupancyPricingNote) => void } = {},
): Promise<InventoryResult> {
  const { onOccupancyPricing, ...inventoryOptions } = options;
  const gateSizes = config.dataSource === "cloudbeds" ? [...new Set(items.map((i) => i.adults))].filter((a) => a !== 1).sort((a, b) => a - b) : [];
  const ask = (adults: number) =>
    getInventory(checkIn, checkOut, config, { budgetWaitMs: CHECKOUT_BUDGET_WAIT_MS, ...inventoryOptions, adults });
  const priced = await ask(1);
  const gates: InventoryResult[] = [];
  for (const adults of gateSizes) gates.push(await ask(adults));
  const gateBySize = new Map(gateSizes.map((adults, i) => [adults, gates[i]]));
  const occupancyRefused: string[] = [];
  const inventory = priced.inventory.map((inv) => {
    const item = items.find((i) => i.slug === inv.slug);
    const gate = item ? gateBySize.get(item.adults) : undefined;
    if (!item || !gate || !inv.available) return inv;
    const atSize = gate.inventory.find((x) => x.slug === inv.slug);
    if (!atSize || !atSize.available || atSize.baseNightly.length === 0) {
      occupancyRefused.push(inv.slug);
      return { ...inv, available: false, remaining: 0, baseNightly: [] };
    }
    const base1 = stayTotal(inv);
    const baseN = stayTotal(atSize);
    if (baseN !== base1) {
      const extraN = occupancyExtraSatang(inv.adultsExtraSatang, item.adults);
      onOccupancyPricing?.({
        slug: inv.slug,
        adults: item.adults,
        base1Satang: base1,
        baseNSatang: baseN,
        extraNSatang: extraN,
        rateIncludesExtra: baseN === base1 + extraN,
      });
    }
    return inv;
  });
  const dataSource: DataSource = [priced, ...gates].some((r) => r.dataSource === "demo-fallback") ? "demo-fallback" : priced.dataSource;
  return { inventory, dataSource, occupancyRefused };
}

/**
 * One offer per catalogue room (in catalogue order), including the
 * non-bookable tuxedo-3br as "not-bookable" so the UI can show an enquiry card.
 */
export function buildOffers(inventory: RoomInventory[], adults: number, ratePlans: RatePlanId[] = ["standard", "breakfast"]): RoomOffer[] {
  return CATALOGUE.map((room) => {
    if (!room.bookable) {
      const fitsParty = adults <= room.maxGuests;
      return { slug: room.slug, available: false, unavailableReason: "not-bookable", remaining: 0, fitsParty, rates: [] };
    }
    const inv = inventory.find((i) => i.slug === room.slug);
    // Cloudbeds' own limit can be lower than the site's figure: never offer more guests than it accepts.
    const maxAdults = Math.max(1, Math.min(room.maxGuests, inv?.maxGuests ?? room.maxGuests));
    const fitsParty = adults <= maxAdults;
    if (!inv || !inv.available || inv.baseNightly.length === 0) {
      return { slug: room.slug, available: false, unavailableReason: "sold-out", remaining: 0, fitsParty, maxAdults, rates: [] };
    }
    const pricedFor = Math.min(Math.max(1, adults), maxAdults);
    return {
      slug: room.slug,
      available: true,
      unavailableReason: null,
      remaining: inv.remaining,
      fitsParty,
      maxAdults,
      rates: buildRateOffers(inv.baseNightly, pricedFor, inv.adultsExtraSatang ?? {}, ratePlans),
    };
  });
}

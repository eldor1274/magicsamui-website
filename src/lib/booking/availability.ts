// Availability service: picks the inventory source, falls back to demo data
// when Cloudbeds fails, and turns raw inventory into priced offers.

import { CATALOGUE } from "./catalogue.ts";
import { cloudbedsInventory } from "./cloudbedsProvider.ts";
import { demoInventory } from "./demoProvider.ts";
import { buildRateOffers } from "./quote.ts";
import type { BookingConfig } from "./config.ts";
import type { DataSource, IsoDate, RoomInventory, RoomOffer } from "./types.ts";

export interface InventoryResult {
  inventory: RoomInventory[];
  dataSource: DataSource;
}

export interface InventoryOptions {
  fetchImpl?: typeof fetch;
  onFallback?: (error: unknown) => void;
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
        fetchImpl: options.fetchImpl,
      });
      return { inventory, dataSource: "cloudbeds" };
    } catch (error) {
      options.onFallback?.(error);
      return { inventory: demoInventory(checkIn, checkOut), dataSource: "demo-fallback" };
    }
  }
  return { inventory: demoInventory(checkIn, checkOut), dataSource: "demo" };
}

/**
 * One offer per catalogue room (in catalogue order), including the
 * non-bookable tuxedo-3br as "not-bookable" so the UI can show an enquiry card.
 */
export function buildOffers(inventory: RoomInventory[], adults: number): RoomOffer[] {
  return CATALOGUE.map((room) => {
    const fitsParty = adults <= room.maxGuests;
    if (!room.bookable) {
      return { slug: room.slug, available: false, unavailableReason: "not-bookable", remaining: 0, fitsParty, rates: [] };
    }
    const inv = inventory.find((i) => i.slug === room.slug);
    if (!inv || !inv.available || inv.baseNightly.length === 0) {
      return { slug: room.slug, available: false, unavailableReason: "sold-out", remaining: 0, fitsParty, rates: [] };
    }
    const pricedFor = Math.min(Math.max(1, adults), room.maxGuests);
    return {
      slug: room.slug,
      available: true,
      unavailableReason: null,
      remaining: inv.remaining,
      fitsParty,
      rates: buildRateOffers(inv.baseNightly, pricedFor),
    };
  });
}

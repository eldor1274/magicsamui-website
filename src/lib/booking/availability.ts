// Availability service: picks the inventory source, falls back to demo data
// when Cloudbeds fails (ONLY while payments are simulated), and turns raw
// inventory into priced offers.

import { CATALOGUE } from "./catalogue.ts";
import { cloudbedsInventory, cloudbedsRateIndex } from "./cloudbedsProvider.ts";
import type { PromoRateIndex, RatePlanIndex, TokenBucket } from "./cloudbedsProvider.ts";
import { demoInventory } from "./demoProvider.ts";
import { logEvent } from "./routeUtils.ts";
import { buildRateOffers, occupancyExtraSatang } from "./quote.ts";
import type { BookingConfig } from "./config.ts";
import type { AlertFn } from "./stripeDeps.ts";
import type { CartItemInput, DataSource, IsoDate, PromoMode, PromoResult, RateListPrice, RatePlanId, RoomInventory, RoomOffer } from "./types.ts";

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
  /** The rate-plan index used (Direct rate / automatic discounts with live Cloudbeds data), so a cart's gate reads can reuse it. */
  rateIndex?: RatePlanIndex;
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
  /** Clock for the no-base-rate error window (tests). */
  nowMs?: number;
  /**
   * Stripe search only: called with the error line `cloudbeds_no_base_rate_all`
   * (same window) so the owner is alerted (alertNoBaseRateAll). Never fails the search.
   * Without it (cart checks) neither the line nor the window is used: only a call
   * that can alert the owner may take the window.
   */
  onNoBaseRateAll?: (slugs: string[]) => void | Promise<void>;
  /**
   * The guest's code is valid on a direct-rate deployment: Cloudbeds is asked with its promo code and
   * the Direct rows are sold (cloudbedsProvider ParseOptions.promo). `rates` reuses an index already
   * read for this stay; otherwise it comes from the rate-plan index read (a failure fails the read like
   * any other). Live Cloudbeds data on a base-rate-only (Stripe) config only; ignored otherwise.
   */
  promo?: { cloudbedsCode: string; rates?: PromoRateIndex };
  /**
   * false = no automatic discounts on this read (the availability re-check under the unit lock: availability
   * only, which a discounted row can't change - it sells only next to its base row). Default: the config's
   * cloudbeds.autoDiscountPlans (Stripe with live Cloudbeds data, BOOKING_AUTO_DISCOUNTS on).
   */
  autoDiscounts?: boolean;
  /**
   * The rate-plan index already read for this stay (a cart's gate reads reuse the priced read's). Otherwise one
   * getRatePlans read (cloudbedsRateIndex) serves the Direct rate AND the automatic discounts, read at the same
   * time as availability, only when either is in play.
   */
  rateIndex?: RatePlanIndex;
  /**
   * Search only (the availability route): when the rate-plan index is read for the automatic discounts alone (no
   * valid code), it is best effort - a failed read, or no call budget left for it, logs cloudbeds_rate_index_failed
   * and the base rate is shown, as with automatic discounts off (checkout re-quotes anyway), and a cached answer is
   * served as it is. A read that was sent and failed is not sent again for that stay for RATE_PLAN_FAIL_TTL_MS (20 s):
   * searches in that time show the base rates at once, with no call and no budget token. Never for checkout (its re-quote fails closed like any other read; the stay-rule read under the
   * lock needs getRatePlans anyway) nor with a valid code (the Direct rate needs the index).
   */
  autoDiscountsBestEffort?: boolean;
  /** Call budget (default the preview budget; an injected fetch is unmetered unless one is passed too). */
  budget?: TokenBucket;
}

/** Checkout waits this long, at most, for the Cloudbeds call budget before refusing. */
export const CHECKOUT_BUDGET_WAIT_MS = 3_000;

/** At most one cloudbeds_no_base_rate_all error line per server instance in this window. */
export const NO_BASE_RATE_ERROR_WINDOW_MS = 15 * 60_000;
let lastNoBaseRateErrorMs: number | null = null;

/**
 * Stripe sells the base (BAR) row only: when Cloudbeds offered rooms but NONE
 * of them had a base row, the page shows every room sold out and no booking
 * can be made. An error-level line with its own tag, at most once per instance
 * per window, plus the search's owner alert (onNoBaseRateAll) in the same window.
 */
async function noteNoBaseRateAll(
  slugs: string[],
  checkIn: IsoDate,
  checkOut: IsoDate,
  nowMs: number,
  onAll: NonNullable<InventoryOptions["onNoBaseRateAll"]>,
): Promise<void> {
  if (lastNoBaseRateErrorMs !== null && nowMs - lastNoBaseRateErrorMs < NO_BASE_RATE_ERROR_WINDOW_MS) return;
  lastNoBaseRateErrorMs = nowMs;
  console.error(
    "[booking] cloudbeds_no_base_rate_all",
    JSON.stringify({ message: "Online search shows every room sold out: Cloudbeds returned no base-rate row", slugs, checkIn, checkOut }),
  );
  try {
    await onAll(slugs);
  } catch {
    // Best effort only: the error line above stays the signal.
  }
}

/** The owner's alert behind onNoBaseRateAll (Stripe search). No guest data: room slugs and dates only. */
export async function alertNoBaseRateAll(alert: AlertFn, slugs: string[], checkIn: IsoDate, checkOut: IsoDate): Promise<void> {
  await alert(
    "Online bookings stopped: Cloudbeds returned no base rate for any room",
    [
      `A search for ${checkIn} to ${checkOut} showed every room sold out: Cloudbeds offered ${slugs.join(", ")}, but none of them on the base (BAR) rate, the only rate the own booking page sells. Guests can't book online while this lasts.`,
      "Check in Cloudbeds that getAvailableRoomTypes still returns each room type's base rate as a non-derived row named \"default\" (scripts/cloudbeds-wi0-check.mjs section 3). Guests can still book on /booking/classic or WhatsApp.",
    ],
    { key: "no-base-rate-all", severity: "warning" },
  );
}

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
      const noBaseRate: string[] = [];
      const read = {
        apiKey: config.cloudbeds.apiKey,
        propertyId: config.cloudbeds.propertyId,
        fetchImpl: options.fetchImpl,
        cacheTtlMs: options.cacheTtlMs,
        budgetWaitMs: options.budgetWaitMs,
        ...(options.budget ? { budget: options.budget } : {}),
      };
      const baseRateOnly = config.cloudbeds.baseRateOnly === true;
      // The Direct rate (a valid code) and the automatic discount plans: Stripe (base-rate-only) configs only.
      const promo = baseRateOnly ? options.promo : undefined;
      const autoPlans = baseRateOnly && options.autoDiscounts !== false ? (config.cloudbeds.autoDiscountPlans ?? []) : [];
      // ONE getRatePlans read tells both apart (cloudbedsRateIndex), read while availability is read; reused when given.
      const needsIndex = !options.rateIndex && ((promo !== undefined && !promo.rates) || autoPlans.length > 0);
      // The index serves only the automatic discounts: a failure shows the base rate instead of failing the search
      // (and is remembered for a while, so cached searches don't re-send a failing read: RATE_PLAN_FAIL_TTL_MS).
      const bestEffort = needsIndex && options.autoDiscountsBestEffort === true && promo === undefined;
      // Started by cloudbedsInventory once availability's reads have their budget tokens; read at most once.
      const index: { loaded: Promise<RatePlanIndex> | null } = { loaded: null };
      const loadIndex = () => {
        if (!index.loaded) {
          index.loaded = cloudbedsRateIndex(checkIn, checkOut, { cloudbedsCode: promo?.cloudbedsCode ?? null, autoPlans }, { ...read, rememberFailure: bestEffort });
          // Settled by cloudbedsInventory (which awaits it); this only keeps an early failure there from leaving it unhandled.
          index.loaded.catch(() => undefined);
        }
        return index.loaded;
      };
      const given = options.rateIndex ?? (promo?.rates ? { promo: promo.rates, auto: {} } : undefined);
      const rateIndex = needsIndex ? loadIndex : given;
      const inventory = await cloudbedsInventory(checkIn, checkOut, {
        ...read,
        adults: options.adults,
        baseRateOnly,
        ...(promo ? { promo: { cloudbedsCode: promo.cloudbedsCode, ...(promo.rates ? { rates: promo.rates } : {}) } } : {}),
        ...(rateIndex ? { rateIndex } : {}),
        ...(bestEffort
          ? { onRateIndexFailed: (e: unknown) => logEvent("cloudbeds_rate_index_failed", { checkIn, checkOut, error: e instanceof Error ? e.message : String(e) }) }
          : {}),
        // Stripe sells the base (BAR) row only: a room type offered only on another plan is shown as unavailable.
        onNoBaseRate: (slug) => {
          noBaseRate.push(slug);
          logEvent("cloudbeds_no_base_rate", { slug, checkIn, checkOut });
        },
      });
      // Search only: a cart check (no alert to send, and at a gate party size "every room" may be wrong) must not take the window.
      if (options.onNoBaseRateAll && noBaseRate.length > 0 && !inventory.some((i) => i.available)) {
        await noteNoBaseRateAll(noBaseRate, checkIn, checkOut, options.nowMs ?? Date.now(), options.onNoBaseRateAll);
      }
      // The index this answer used, for a cart's gate reads (none when the best-effort read failed).
      const used = index.loaded ? await index.loaded.catch(() => undefined) : given;
      return { inventory, dataSource: "cloudbeds", ...(used ? { rateIndex: used } : {}) };
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
  options: Omit<InventoryOptions, "adults" | "cacheTtlMs" | "onNoBaseRateAll" | "autoDiscountsBestEffort"> & { onOccupancyPricing?: (note: OccupancyPricingNote) => void } = {},
): Promise<InventoryResult> {
  const { onOccupancyPricing, ...inventoryOptions } = options;
  const gateSizes = config.dataSource === "cloudbeds" ? [...new Set(items.map((i) => i.adults))].filter((a) => a !== 1).sort((a, b) => a - b) : [];
  const ask = (adults: number) =>
    getInventory(checkIn, checkOut, config, { budgetWaitMs: CHECKOUT_BUDGET_WAIT_MS, ...inventoryOptions, adults });
  const priced = await ask(1);
  const gates: InventoryResult[] = [];
  // The gates read the same Direct and automatic-discount rows (one rate-plan read per checkout, not one per party size).
  const gateOptions = priced.rateIndex ? { rateIndex: priced.rateIndex } : {};
  for (const adults of gateSizes) {
    gates.push(await getInventory(checkIn, checkOut, config, { budgetWaitMs: CHECKOUT_BUDGET_WAIT_MS, ...inventoryOptions, ...gateOptions, adults }));
  }
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
  return { inventory, dataSource, occupancyRefused, ...(priced.rateIndex ? { rateIndex: priced.rateIndex } : {}) };
}

/**
 * The search's promo verdict once the inventory is known (direct-rate only): a valid code that no
 * available room gets the Direct rate for on these dates becomes a calm note, so the page never says
 * "applied" over standard prices. When some rooms have it, the others say so on their own card
 * (RoomOffer.promoNotApplied). Rooms on an automatic discount are not "standard rates": the note says so.
 */
export function promoVerdictForInventory(promo: PromoResult | null, mode: PromoMode, inventory: RoomInventory[]): PromoResult | null {
  if (!promo?.valid || mode !== "direct-rate") return promo;
  const available = inventory.filter((i) => i.available);
  if (available.length === 0 || available.some((i) => i.discount?.kind === "direct")) return promo;
  const shown = available.some((i) => i.discount?.kind === "auto") ? "the prices shown are our best rates for them" : "the prices shown are our standard rates";
  return { code: promo.code, valid: false, note: true, message: `Code ${promo.code} doesn't apply to these dates - ${shown}.` };
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
    // A discounted Cloudbeds rate (Direct or automatic): priced at its own rows, with the base row it is derived
    // from as the list price; an automatic discount also carries its plan's name (the rate's label).
    const d = inv.discount;
    const list: RateListPrice | undefined = d
      ? { baseNightly: d.baseNightly, adultsExtraSatang: d.baseAdultsExtraSatang, kind: d.kind, ...(d.kind === "auto" ? { name: d.name } : {}) }
      : undefined;
    return {
      slug: room.slug,
      available: true,
      unavailableReason: null,
      remaining: inv.remaining,
      fitsParty,
      maxAdults,
      rates: buildRateOffers(inv.baseNightly, pricedFor, inv.adultsExtraSatang ?? {}, ratePlans, list),
      ...(inv.promoNotApplied ? { promoNotApplied: true } : {}),
    };
  });
}

// Read-only Cloudbeds inventory for the preview (existing API key, no writes).
//
// getAvailableRoomTypes is called with the party's adults (children=0 - the
// site never takes children - rooms=1, detailedRates=true):
// - search asks with adults=1 so every room type is listed (a big party may
//   book several small rooms) and reads the occupancy table
//   (adultsIncluded / adultsExtraCharge) to price any party size;
// - the checkout re-quote prices from the SAME adults=1 answer as search (so
//   the two can never disagree) and additionally asks once per distinct party
//   size in the cart, only as an availability gate: Cloudbeds itself confirms
//   each room at that occupancy (see availability.ts getCartInventory).
// Stay totals are summed from roomRateDetailed (whether roomRate is per night
// or per stay is undocumented); adultsExtraCharge is "keyed by adult count,
// value = total extra charge" and is added on top (see the docs' open
// questions). Amounts in the Cloudbeds v1.x API are major-unit THB and are
// converted to integer satang here. Errors throw; the caller decides whether
// demo data may stand in (demo payment mode only).

import { ROOM_TYPE_TO_SLUG } from "../../data/cloudbeds.ts";
import { getBookableRooms } from "./catalogue.ts";
import { eachNight } from "./dates.ts";
import { thbToSatang } from "./quote.ts";
import type { IsoDate, NightRate, RoomInventory } from "./types.ts";

// v1.3: same read endpoints as v1.2 (which /api/rates still uses); v1.3 is
// where the write side (postPayment without transactionID) lives after
// Cloudbeds removed it from v1.2 on 2025-12-01.
export const CLOUDBEDS_API_BASE = "https://api.cloudbeds.com/api/v1.3";
const TIMEOUT_MS = 8_000;
const CACHE_MAX_ENTRIES = 200;

/**
 * Token bucket: `ratePerSecond` tokens refill continuously up to `burst`.
 * Per serverless instance (in memory), like the per-IP limiters.
 */
export interface TokenBucket {
  /** Takes a token now if one is available. */
  take(nowMs?: number): boolean;
  /** Milliseconds until the next token is available (0 when one is). */
  msUntilNext(nowMs?: number): number;
}

export function createTokenBucket(ratePerSecond: number, burst: number): TokenBucket {
  let tokens = burst;
  let last: number | null = null;
  const refill = (now: number) => {
    if (last !== null) tokens = Math.min(burst, tokens + ((now - last) / 1000) * ratePerSecond);
    last = now;
  };
  return {
    take(nowMs = Date.now()) {
      refill(nowMs);
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    msUntilNext(nowMs = Date.now()) {
      refill(nowMs);
      return tokens >= 1 ? 0 : Math.ceil(((1 - tokens) / ratePerSecond) * 1000);
    },
  };
}

/**
 * The preview's own budget for Cloudbeds calls on this instance. The key's
 * limit (10 requests/second across all endpoints) is shared with /api/rates
 * and the owner's droplet cron, so the unlinked preview may use only a slice
 * of it: about 3 calls a second, with a small burst for one checkout.
 */
export const CLOUDBEDS_PREVIEW_BUDGET: TokenBucket = createTokenBucket(3, 8);

export interface CloudbedsDeps {
  apiKey: string;
  propertyId: string | null;
  /** Party size sent to Cloudbeds (default 1). */
  adults?: number;
  fetchImpl?: typeof fetch;
  /**
   * Search only: reuse an identical answer for this long (per server
   * instance) so preview traffic can't exhaust the key's shared rate limit.
   * Never set for the checkout re-quote.
   */
  cacheTtlMs?: number;
  nowMs?: number;
  /**
   * Call budget. Defaults to CLOUDBEDS_PREVIEW_BUDGET for real network calls;
   * an injected fetch (tests) is unmetered unless a budget is passed too.
   */
  budget?: TokenBucket;
  /**
   * How long to wait for a budget token (checkout: a short wait beats
   * refusing a payment). 0 (default, search) = fail at once with
   * CloudbedsBudgetError, so the caller falls back or answers 503.
   */
  budgetWaitMs?: number;
}

/** The preview's Cloudbeds call budget is used up for the moment (no request was sent). */
export class CloudbedsBudgetError extends Error {
  constructor() {
    super("Cloudbeds call budget exhausted");
    this.name = "CloudbedsBudgetError";
  }
}

/** Takes a budget token, waiting up to `maxWaitMs` for one. */
async function acquire(budget: TokenBucket, maxWaitMs: number): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    if (budget.take()) return true;
    const wait = budget.msUntilNext();
    if (Date.now() - started + wait > maxWaitMs) return false;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

export class CloudbedsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudbedsError";
  }
}

interface CbDetailedRate {
  date?: unknown;
  rate?: unknown;
}

interface CbRoom {
  roomTypeID?: unknown;
  roomsAvailable?: unknown;
  roomRateDetailed?: unknown;
  ratePlanNamePublic?: unknown;
  derivedType?: unknown;
  adultsIncluded?: unknown;
  adultsExtraCharge?: unknown;
  maxGuests?: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function nightlyFromDetailed(detailed: unknown, nights: IsoDate[]): NightRate[] | null {
  if (!Array.isArray(detailed)) return null;
  const byDate = new Map<string, number>();
  for (const row of detailed as CbDetailedRate[]) {
    const date = typeof row?.date === "string" ? row.date.slice(0, 10) : null;
    const rate = Number(row?.rate);
    if (date && Number.isFinite(rate) && rate > 0) byDate.set(date, rate);
  }
  const out: NightRate[] = [];
  for (const night of nights) {
    const rate = byDate.get(night);
    if (rate === undefined) return null;
    out.push({ date: night, amountSatang: thbToSatang(rate) });
  }
  return out;
}

/**
 * adultsExtraCharge -> { "3": satang, ... }. Cloudbeds sends [] when there is
 * no extra charge, otherwise an object keyed by adult count. Counts at or
 * below adultsIncluded never carry an extra.
 */
export function parseAdultsExtraCharge(raw: unknown, adultsIncluded: unknown): Record<string, number> {
  const table = asRecord(raw);
  if (!table) return {};
  const included = Number(adultsIncluded);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(table)) {
    const adults = Number(key);
    const amount = Number(value);
    if (!Number.isInteger(adults) || adults < 1 || adults > 50) continue;
    if (Number.isFinite(included) && adults <= included) continue;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    out[String(adults)] = thbToSatang(amount);
  }
  return out;
}

/**
 * Which row to sell when Cloudbeds returns several for one room type:
 * 2 = base rate (no plan name, not derived) - what the live site sells;
 * 1 = a non-derived plan row; 0 = a derived row (e.g. non-refundable, promo).
 * A higher tier always wins; within a tier the cheaper row wins. So a cheaper
 * derived row can never undercut the base row, whatever the row order.
 */
function rowTier(row: CbRoom): number {
  if (row.derivedType) return 0;
  return row.ratePlanNamePublic ? 1 : 2;
}

function stayTotal(nightly: NightRate[]): number {
  return nightly.reduce((s, x) => s + x.amountSatang, 0);
}

/** Pure parser for a getAvailableRoomTypes response (exported for tests). */
export function parseAvailableRoomTypes(json: unknown, checkIn: IsoDate, checkOut: IsoDate): RoomInventory[] {
  const root = asRecord(json);
  if (!root || root.success !== true) {
    throw new CloudbedsError(`getAvailableRoomTypes failed: ${String(root?.message ?? "no success flag")}`);
  }
  const nights = eachNight(checkIn, checkOut);
  const properties = Array.isArray(root.data) ? root.data : [];

  const found = new Map<string, { inventory: RoomInventory; tier: number }>();
  for (const p of properties) {
    const prop = asRecord(p);
    if (!prop) continue;
    const currency = Array.isArray(prop.propertyCurrency) ? asRecord(prop.propertyCurrency[0])?.currencyCode : undefined;
    if (currency !== undefined && currency !== "THB") {
      throw new CloudbedsError(`Unexpected property currency ${String(currency)}`);
    }
    const rows = Array.isArray(prop.propertyRooms) ? (prop.propertyRooms as CbRoom[]) : [];
    for (const row of rows) {
      const slug = ROOM_TYPE_TO_SLUG[String(row.roomTypeID ?? "")];
      if (!slug) continue;
      const remaining = Number(row.roomsAvailable);
      const nightly = nightlyFromDetailed(row.roomRateDetailed, nights);
      if (!nightly || !(remaining > 0)) continue;
      const tier = rowTier(row);
      const prev = found.get(slug);
      const better = !prev || tier > prev.tier || (tier === prev.tier && stayTotal(nightly) < stayTotal(prev.inventory.baseNightly));
      if (!better) continue;
      // Cloudbeds' own occupancy limit for the room type (may be lower than the site's rooms.ts figure).
      const maxGuests = Number(row.maxGuests);
      found.set(slug, {
        tier,
        inventory: {
          slug,
          available: true,
          remaining: Math.min(1, remaining),
          baseNightly: nightly,
          adultsExtraSatang: parseAdultsExtraCharge(row.adultsExtraCharge, row.adultsIncluded),
          ...(Number.isInteger(maxGuests) && maxGuests >= 1 && maxGuests <= 50 ? { maxGuests } : {}),
        },
      });
    }
  }

  return getBookableRooms().map(
    (room) => found.get(room.slug)?.inventory ?? { slug: room.slug, available: false, remaining: 0, baseNightly: [] },
  );
}

const searchCache = new Map<string, { expiresAt: number; inventory: RoomInventory[] }>();

export async function cloudbedsInventory(checkIn: IsoDate, checkOut: IsoDate, deps: CloudbedsDeps): Promise<RoomInventory[]> {
  const adults = Math.max(1, Math.floor(deps.adults ?? 1));
  const params = new URLSearchParams({
    startDate: checkIn,
    endDate: checkOut,
    rooms: "1",
    adults: String(adults),
    children: "0",
    detailedRates: "true",
    pageSize: "50",
  });
  if (deps.propertyId) params.set("propertyIDs", deps.propertyId);
  const url = `${CLOUDBEDS_API_BASE}/getAvailableRoomTypes?${params.toString()}`;

  const nowMs = deps.nowMs ?? Date.now();
  const ttl = deps.cacheTtlMs ?? 0;
  const cacheKey = `${deps.apiKey.slice(-6)}|${url}`;
  if (ttl > 0) {
    const hit = searchCache.get(cacheKey);
    if (hit && hit.expiresAt > nowMs) return hit.inventory;
  }

  const budget = deps.budget ?? (deps.fetchImpl ? null : CLOUDBEDS_PREVIEW_BUDGET);
  if (budget && !(await acquire(budget, deps.budgetWaitMs ?? 0))) throw new CloudbedsBudgetError();

  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(url, {
    headers: { "x-api-key": deps.apiKey, accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new CloudbedsError(`getAvailableRoomTypes HTTP ${res.status}`);
  const inventory = parseAvailableRoomTypes(await res.json(), checkIn, checkOut);

  if (ttl > 0) {
    if (searchCache.size >= CACHE_MAX_ENTRIES) {
      // Drop expired answers first, then the oldest, rather than the whole cache.
      for (const [key, entry] of searchCache) if (entry.expiresAt <= nowMs) searchCache.delete(key);
      while (searchCache.size >= CACHE_MAX_ENTRIES) {
        const oldest = searchCache.keys().next().value;
        if (oldest === undefined) break;
        searchCache.delete(oldest);
      }
    }
    searchCache.set(cacheKey, { expiresAt: nowMs + ttl, inventory });
  }
  return inventory;
}

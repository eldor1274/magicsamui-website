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
import { addDays, eachNight } from "./dates.ts";
import { thbToSatang } from "./quote.ts";
import { logEvent } from "./routeUtils.ts";
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

/**
 * One bucket for reads AND writes (cloudbedsWrite.ts) on this instance, so a
 * checkout's hold and a burst of searches can never together exceed the
 * key's 10 requests/second.
 */
export const CLOUDBEDS_BUDGET: TokenBucket = CLOUDBEDS_PREVIEW_BUDGET;

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
  /** Waits before the single retry after a 429 (tests shorten it). */
  sleep?: (ms: number) => Promise<void>;
  /** Sell only the base (BAR) row (Stripe modes); see ParseOptions. */
  baseRateOnly?: boolean;
  /** A room type had sellable rows but no base row (baseRateOnly): logged by the caller. */
  onNoBaseRate?: (slug: string) => void;
  /** Log lines for odd but harmless answers (default logEvent). */
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/** Longest Retry-After honoured before the single 429 retry of a read. */
export const READ_429_MAX_WAIT_MS = 2_000;

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

/**
 * One read call with a single retry after a 429 (Retry-After honoured up to
 * READ_429_MAX_WAIT_MS), drawing a fresh token from the same budget for the
 * retry. Reads are safe to repeat.
 */
async function readCall(url: string, init: RequestInit, deps: Pick<CloudbedsDeps, "fetchImpl" | "budgetWaitMs" | "sleep">, budget: TokenBucket | null): Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status !== 429) return res;
  const retryAfter = Number(res.headers.get("retry-after"));
  const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, READ_429_MAX_WAIT_MS) : 500;
  await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(wait);
  if (budget && !(await acquire(budget, deps.budgetWaitMs ?? 0))) throw new CloudbedsBudgetError();
  return doFetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
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
  roomRateID?: unknown;
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
 * The base (BAR) rate's public plan name: getAvailableRoomTypes sends the
 * string "default" (live, 2026-10-06), getRatePlans sends null for the same
 * rate. Absent, empty or "default" (any case, trimmed) = base.
 */
export function isBasePlanName(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  return typeof v === "string" && ["", "default"].includes(v.trim().toLowerCase());
}

/**
 * Which row to sell when Cloudbeds returns several for one room type:
 * 2 = base rate (not derived, plan name absent/""/"default") - what the live
 * site sells; 1 = a non-derived row with another plan name (e.g. "Long stay");
 * 0 = a derived row (derivedType set: Breakfast package, non-refundable, promo).
 * A higher tier always wins; within a tier the cheaper row wins. So a cheaper
 * derived row can never undercut the base row, whatever the row order.
 */
function rowTier(row: CbRoom): number {
  if (row.derivedType) return 0;
  return isBasePlanName(row.ratePlanNamePublic) ? 2 : 1;
}

function stayTotal(nightly: NightRate[]): number {
  return nightly.reduce((s, x) => s + x.amountSatang, 0);
}

export interface ParseOptions {
  /**
   * Sell ONLY the base (BAR) row (tier 2: not derived, plan name absent, ""
   * or "default") - Stripe modes, where the guest pays for the
   * "Standard Rate - Room only" under the house policy and the hold is made
   * on the row's roomRateID. A room type that comes back with only derived or
   * other-plan rows (Breakfast package, long stay, non-refundable...) is then
   * unavailable instead of being sold as another plan under the Standard label.
   */
  baseRateOnly?: boolean;
  /** Called with each room type that had sellable rows but no base row (baseRateOnly). */
  onNoBaseRate?: (slug: string) => void;
  /** Odd but harmless answers (e.g. no propertyCurrency): logged, never refused. */
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/** propertyCurrency's code: an array per the spec, a single object live (2026-10-06). */
function currencyCode(raw: unknown): unknown {
  return asRecord(Array.isArray(raw) ? raw[0] : raw)?.currencyCode;
}

/** Pure parser for a getAvailableRoomTypes response (exported for tests). */
export function parseAvailableRoomTypes(json: unknown, checkIn: IsoDate, checkOut: IsoDate, options: ParseOptions = {}): RoomInventory[] {
  const root = asRecord(json);
  if (!root || root.success !== true) {
    throw new CloudbedsError(`getAvailableRoomTypes failed: ${String(root?.message ?? "no success flag")}`);
  }
  const nights = eachNight(checkIn, checkOut);
  const properties = Array.isArray(root.data) ? root.data : [];

  const found = new Map<string, { inventory: RoomInventory; tier: number }>();
  const nonBaseOnly = new Set<string>();
  for (const p of properties) {
    const prop = asRecord(p);
    if (!prop) continue;
    const currency = currencyCode(prop.propertyCurrency);
    // Rates are read as THB: another currency refuses the answer; a missing one is only logged.
    if (currency === undefined || currency === null) options.log?.("cloudbeds_currency_missing", { propertyID: String(prop.propertyID ?? "") });
    else if (currency !== "THB") throw new CloudbedsError(`Unexpected property currency ${String(currency)}`);
    const rows = Array.isArray(prop.propertyRooms) ? (prop.propertyRooms as CbRoom[]) : [];
    for (const row of rows) {
      const slug = ROOM_TYPE_TO_SLUG[String(row.roomTypeID ?? "")];
      if (!slug) continue;
      const remaining = Number(row.roomsAvailable);
      const nightly = nightlyFromDetailed(row.roomRateDetailed, nights);
      if (!nightly || !(remaining > 0)) continue;
      const tier = rowTier(row);
      if (options.baseRateOnly && tier !== 2) {
        nonBaseOnly.add(slug);
        continue;
      }
      const prev = found.get(slug);
      const better = !prev || tier > prev.tier || (tier === prev.tier && stayTotal(nightly) < stayTotal(prev.inventory.baseNightly));
      if (!better) continue;
      // Cloudbeds' own occupancy limit for the room type (may be lower than the site's rooms.ts figure).
      const maxGuests = Number(row.maxGuests);
      const rateId = typeof row.roomRateID === "string" || typeof row.roomRateID === "number" ? String(row.roomRateID) : "";
      found.set(slug, {
        tier,
        inventory: {
          slug,
          available: true,
          remaining: Math.min(1, remaining),
          baseNightly: nightly,
          adultsExtraSatang: parseAdultsExtraCharge(row.adultsExtraCharge, row.adultsIncluded),
          ...(Number.isInteger(maxGuests) && maxGuests >= 1 && maxGuests <= 50 ? { maxGuests } : {}),
          ...(/^[A-Za-z0-9_-]{1,40}$/.test(rateId) ? { rateId } : {}),
        },
      });
    }
  }

  for (const slug of nonBaseOnly) if (!found.has(slug)) options.onNoBaseRate?.(slug);
  return getBookableRooms().map(
    (room) => found.get(room.slug)?.inventory ?? { slug: room.slug, available: false, remaining: 0, baseNightly: [] },
  );
}

/** Read headers: the key plus X-PROPERTY-ID when the property id is known (recommended by Cloudbeds). */
export function cloudbedsReadHeaders(apiKey: string, propertyId: string | null): Record<string, string> {
  return { "x-api-key": apiKey, accept: "application/json", ...(propertyId ? { "X-PROPERTY-ID": propertyId } : {}) };
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
  const cacheKey = `${deps.apiKey.slice(-6)}|${deps.baseRateOnly ? "base" : "any"}|${url}`;
  if (ttl > 0) {
    const hit = searchCache.get(cacheKey);
    if (hit && hit.expiresAt > nowMs) return hit.inventory;
  }

  const budget = deps.budget ?? (deps.fetchImpl ? null : CLOUDBEDS_PREVIEW_BUDGET);
  if (budget && !(await acquire(budget, deps.budgetWaitMs ?? 0))) throw new CloudbedsBudgetError();

  const res = await readCall(url, { headers: cloudbedsReadHeaders(deps.apiKey, deps.propertyId), cache: "no-store" }, deps, budget ?? null);
  if (!res.ok) throw new CloudbedsError(`getAvailableRoomTypes HTTP ${res.status}`);
  const inventory = parseAvailableRoomTypes(await res.json(), checkIn, checkOut, {
    baseRateOnly: deps.baseRateOnly,
    onNoBaseRate: deps.onNoBaseRate,
    log: deps.log ?? logEvent,
  });

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

/* --------------------------- restrictions ---------------------------- */

/**
 * `derived`: the row checked (the sold rateId's) is a DERIVED plan in getRatePlans. The Stripe
 * checkout refuses it whatever the rules say: Stripe modes sell the base (BAR) row only.
 */
export type RestrictionResult = (
  | { ok: true; checked: boolean }
  | { ok: false; reason: "closed_to_arrival" | "closed_to_departure" | "min_stay" | "max_stay" | "blocked" | "sold_out"; minNights?: number; maxNights?: number }
) & { derived?: true };

interface CbRateDay {
  date?: unknown;
  closedToArrival?: unknown;
  closedToDeparture?: unknown;
  blocked?: unknown;
  minLos?: unknown;
  maxLos?: unknown;
  roomsAvailable?: unknown;
}

function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

/**
 * getRatePlans' base (BAR) row: isDerived false, no derivedType, no parent
 * plan (ratePlanID null/absent) and a base plan name (null, "" or "default").
 */
function isBaseRatePlanRow(r: Record<string, unknown>): boolean {
  const notDerived = r.isDerived === false || r.isDerived === "false" || r.isDerived === 0 || r.isDerived === "0";
  return notDerived && !r.derivedType && (r.ratePlanID === null || r.ratePlanID === undefined || r.ratePlanID === "") && isBasePlanName(r.ratePlanNamePublic);
}

/**
 * Pure check of a getRatePlans (detailedRates=true) answer for one room type
 * against the stay (exported for tests). The answer is for a request filtered
 * by that roomTypeID, so rows without a roomTypeID count as that type's (the
 * spec sends it only "if not specified in request"). Picks the row with `rateId`, else
 * the base row (isBaseRatePlanRow) - never another plan's row, whose rules
 * (e.g. a promo with minLos 150) would judge the stay wrongly. Rules: arrival
 * day not closedToArrival; departure day (queried with endDate = check-out
 * + 1, so it is normally returned) not closedToDeparture - a missing
 * departure row is logged (restrictions_no_departure_row), not refused;
 * nights >= the HIGHEST minLos over the stay nights (as Cloudbeds applies it)
 * and <= the lowest maxLos above 0 (0 = no limit); every night not blocked
 * and roomsAvailable >= 1. No such row, or a row without the arrival day,
 * means the answer can't be evaluated: { ok: true, checked: false }
 * (availability itself already came from getAvailableRoomTypes). A derived
 * row is checked like any other and marked `derived`.
 */
export function evaluateRestrictions(
  json: unknown,
  roomTypeId: string,
  rateId: string | null,
  checkIn: IsoDate,
  checkOut: IsoDate,
  options: { log?: (message: string, data?: Record<string, unknown>) => void } = {},
): RestrictionResult {
  const root = asRecord(json);
  if (!root || root.success !== true) throw new CloudbedsError(`getRatePlans failed: ${String(root?.message ?? "no success flag")}`);
  const rows = (Array.isArray(root.data) ? root.data : []).map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
  // The request is filtered by roomTypeID, and the v1.3 spec returns that field only "if not specified in request":
  // a row without it is the requested type's.
  const forType = rows.filter((r) => r.roomTypeID === undefined || r.roomTypeID === null || r.roomTypeID === "" || String(r.roomTypeID) === roomTypeId);
  const row = (rateId ? forType.find((r) => String(r.rateID ?? "") === rateId) : undefined) ?? forType.find(isBaseRatePlanRow);
  if (!row) return { ok: true, checked: false };
  const result = checkStay(row, roomTypeId, checkIn, checkOut, options.log);
  return truthy(row.isDerived) ? { ...result, derived: true } : result;
}

function checkStay(
  row: Record<string, unknown>,
  roomTypeId: string,
  checkIn: IsoDate,
  checkOut: IsoDate,
  log: ((message: string, data?: Record<string, unknown>) => void) | undefined,
): RestrictionResult {
  const days = (Array.isArray(row.roomRateDetailed) ? row.roomRateDetailed : []) as CbRateDay[];
  const byDate = new Map<string, CbRateDay>();
  for (const d of days) if (typeof d?.date === "string") byDate.set(d.date.slice(0, 10), d);
  const nights = eachNight(checkIn, checkOut);
  const arrival = byDate.get(checkIn);
  // Without the arrival day's row nothing (CTA, min/max stay) can be evaluated: say so, never "checked".
  if (!arrival) return { ok: true, checked: false };
  if (truthy(arrival.closedToArrival)) return { ok: false, reason: "closed_to_arrival" };
  const departure = byDate.get(checkOut);
  if (!departure) log?.("restrictions_no_departure_row", { roomTypeId, rateId: String(row.rateID ?? ""), checkOut });
  else if (truthy(departure.closedToDeparture)) return { ok: false, reason: "closed_to_departure" };
  let minLos = 0;
  let maxLos = 0;
  for (const night of nights) {
    const d = byDate.get(night);
    const min = Number(d?.minLos);
    const max = Number(d?.maxLos);
    if (Number.isFinite(min) && min > minLos) minLos = min;
    if (Number.isFinite(max) && max > 0 && (maxLos === 0 || max < maxLos)) maxLos = max;
  }
  if (minLos > 0 && nights.length < minLos) return { ok: false, reason: "min_stay", minNights: minLos };
  if (maxLos > 0 && nights.length > maxLos) return { ok: false, reason: "max_stay", maxNights: maxLos };
  for (const night of nights) {
    const d = byDate.get(night);
    if (!d) continue;
    if (truthy(d.blocked)) return { ok: false, reason: "blocked" };
    if (d.roomsAvailable !== undefined && Number(d.roomsAvailable) < 1) return { ok: false, reason: "sold_out" };
  }
  return { ok: true, checked: true };
}

/** Live restriction check for one room type (no cache). Throws CloudbedsError / CloudbedsBudgetError. */
export async function cloudbedsRestrictions(
  roomTypeId: string,
  rateId: string | null,
  checkIn: IsoDate,
  checkOut: IsoDate,
  adults: number,
  deps: Omit<CloudbedsDeps, "adults" | "cacheTtlMs">,
): Promise<RestrictionResult> {
  const params = new URLSearchParams({
    roomTypeID: roomTypeId,
    startDate: checkIn,
    // One day past check-out, so the departure day's row (closedToDeparture) is returned too; only the
    // stay nights are checked for blocked / roomsAvailable.
    endDate: addDays(checkOut, 1),
    adults: String(Math.max(1, Math.floor(adults))),
    children: "0",
    detailedRates: "true",
  });
  if (deps.propertyId) params.set("propertyIDs", deps.propertyId);
  const budget = deps.budget ?? (deps.fetchImpl ? null : CLOUDBEDS_BUDGET);
  if (budget && !(await acquire(budget, deps.budgetWaitMs ?? 0))) throw new CloudbedsBudgetError();
  const res = await readCall(
    `${CLOUDBEDS_API_BASE}/getRatePlans?${params.toString()}`,
    { headers: cloudbedsReadHeaders(deps.apiKey, deps.propertyId), cache: "no-store" },
    deps,
    budget ?? null,
  );
  if (!res.ok) throw new CloudbedsError(`getRatePlans HTTP ${res.status}`);
  return evaluateRestrictions(await res.json(), roomTypeId, rateId, checkIn, checkOut, { log: deps.log ?? logEvent });
}

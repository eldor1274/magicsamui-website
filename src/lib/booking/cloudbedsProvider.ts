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
import type { DiscountKind, IsoDate, NightRate, RoomInventory } from "./types.ts";

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
  /**
   * The guest's code is Cloudbeds' promo `cloudbedsCode` (direct-rate): getAvailableRoomTypes is asked
   * with promoCode too, and the rows whose roomRateID is one of the room type's promo rates (`rates`, else
   * the rate-plan index's) are sold as the Direct rate next to their base row (see ParseOptions.promo).
   */
  promo?: { cloudbedsCode: string; rates?: PromoRateIndex };
  /**
   * The rate-plan index (one getRatePlans read, cloudbedsRateIndex): which rows are the Direct rate (with
   * `promo`) and which are automatic discount plans (ParseOptions.auto). A promise is awaited while
   * getAvailableRoomTypes is read, so the two reads overlap instead of adding up; a function is called only
   * once the availability reads have taken their budget tokens, so the index never takes availability's last one.
   */
  rateIndex?: RatePlanIndex | Promise<RatePlanIndex> | (() => Promise<RatePlanIndex>);
  /**
   * Search only, when the index serves only the automatic discounts (no code): it is optional. A failed index read
   * (an error, or no budget token left for it) is passed here and the answer is parsed without it - the base rate,
   * as with automatic discounts off - and a cached answer is served as it is (also when the index changed since it
   * was cached and availability can't be read again: log cloudbeds_search_revalidate_failed). Without it a failed
   * index read fails the read. The caller's optional index read remembers a failure (cloudbedsRateIndex
   * rememberFailure), so a cached answer doesn't re-send a failing read for RATE_PLAN_FAIL_TTL_MS.
   */
  onRateIndexFailed?: (error: unknown) => void;
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

/** A discounted row (Direct or automatic) of getAvailableRoomTypes, before it is matched to its base row. */
interface DiscountCandidate {
  kind: DiscountKind;
  rateId: string;
  parentRateId: string | null;
  name: string;
  nightly: NightRate[];
  remaining: number;
  adultsExtra: Record<string, number>;
  maxGuests: number | null;
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
  /**
   * The Direct rate (the answer was asked with the guest's promo code). A row whose roomRateID is one
   * of the room type's promo rates (the rate-plan index: by rateID, never by name - each room type
   * has its own Direct rateID, and getAvailableRoomTypes rows carry no promo code) is a candidate to be
   * sold INSTEAD of that room type's base row (see `auto` for how the row sold is chosen). When the
   * Direct row is not the one sold, the room is marked promoNotApplied.
   */
  promo?: { rates: PromoRateIndex };
  /**
   * Automatic discount plans (Stripe, BOOKING_AUTO_DISCOUNTS): a row whose roomRateID is one of the room
   * type's automatic discount rates (the rate-plan index: derived, no promo code, a public name starting
   * with a configured prefix, never "non-refundable") is a candidate too, with no code. Per room type the
   * CHEAPEST of the base row and its usable candidates (Direct and automatic) is sold - between candidates
   * of the same price the Direct rate, else the first in the answer. A candidate is usable when it is sellable (a unit left, a rate on every
   * night), cheaper than the base row on the stay, and derived from it (getRatePlans parentRateID, when
   * sent, is the base row's rateID). The inventory then carries the candidate's rateId and the base row
   * as `discount` (kind, plan name). A discounted row with no base row sells nothing.
   */
  auto?: { rates: AutoDiscountIndex };
}

/** Cloudbeds promo rate plans per room type: roomTypeID -> its rows (rateID, parentRateID, public name) whose promoCode is ours. */
export type PromoRateIndex = Record<string, { rateId: string; parentRateId: string | null; name?: string }[]>;

/** Automatic discount plans per room type: roomTypeID -> its eligible rows (isAutoDiscountRow). */
export type AutoDiscountIndex = Record<string, { rateId: string; parentRateId: string | null; name: string }[]>;

/** What one getRatePlans read (every room type) tells the search: the Direct rows and the automatic discount rows. */
export interface RatePlanIndex {
  promo: PromoRateIndex;
  auto: AutoDiscountIndex;
}

const RATE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function idOf(v: unknown): string | null {
  const s = typeof v === "string" || typeof v === "number" ? String(v) : "";
  return RATE_ID_RE.test(s) ? s : null;
}

/** Cloudbeds promo code `cloudbedsCode` (trimmed, any case). */
function isPromoCode(v: unknown, cloudbedsCode: string): boolean {
  return typeof v === "string" && v.trim().toLowerCase() === cloudbedsCode.trim().toLowerCase();
}

/** A getRatePlans row carrying Cloudbeds promo code `cloudbedsCode` (trimmed, any case). */
function isPromoRow(r: Record<string, unknown>, cloudbedsCode: string): boolean {
  return isPromoCode(r.promoCode, cloudbedsCode);
}

/** Any promo code at all (a plan that needs a code is never sold without it). */
function hasPromoCode(v: unknown): boolean {
  return typeof v === "string" ? v.trim() !== "" : v !== null && v !== undefined && v !== false;
}

/** A plan's whole public name: control and invisible format characters replaced by spaces, whitespace collapsed. null when there is none. */
function planNameFull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

/**
 * A plan's public name as the page shows it: the whole name (planNameFull) cut to at most 60 characters. null
 * when there is none.
 */
export function planDisplayName(v: unknown): string | null {
  return planNameFull(v)?.slice(0, 60).trim() || null;
}

/**
 * A name that reads as other refund terms than the page's policy: "non-refundable" with any separator (space,
 * underscore, dot, an ASCII or Unicode hyphen or dash, none) and its short forms ("Non-Ref", "NonRef", "NRF"),
 * "no refund(s)", "not / un-refundable", and "prepaid" / "advance purchase" (in hotel naming usually a
 * non-refundable rate). A false match only sells the base rate instead.
 */
const NON_REFUNDABLE_RE =
  /non[\s\p{Pd}−._]*ref|\bnrf\b|\bno[\s\p{Pd}−]*refunds?\b|\b(?:not|un)[\s\p{Pd}−]*refundable|\bpre[\s\p{Pd}−]*paid\b|\badvance[\s\p{Pd}−]*purchase/iu;

/**
 * A plan name the own page may sell automatically: it starts with one of `plans` (BOOKING_AUTO_DISCOUNT_PLANS,
 * case-insensitive) and never reads as non-refundable (NON_REFUNDABLE_RE: other refund terms than the page's
 * policy) - anywhere in the WHOLE name, not only in the 60 characters the page shows.
 */
export function isAutoDiscountName(name: unknown, plans: readonly string[]): boolean {
  const n = planNameFull(name);
  if (n === null || NON_REFUNDABLE_RE.test(n)) return false;
  const lower = n.toLowerCase();
  return plans.some((p) => {
    const prefix = p.trim().replace(/\s+/g, " ").toLowerCase();
    return prefix !== "" && lower.startsWith(prefix);
  });
}

/**
 * A getRatePlans row of an automatic discount plan: DERIVED (isDerived), NO promo code (promo-code plans need
 * the code; the Direct rate has its own path) and an eligible public name (isAutoDiscountName). Whether it is
 * cheaper than its base row is checked against getAvailableRoomTypes' prices (parseAvailableRoomTypes).
 */
export function isAutoDiscountRow(r: Record<string, unknown>, plans: readonly string[]): boolean {
  return truthy(r.isDerived) && !hasPromoCode(r.promoCode) && isAutoDiscountName(r.ratePlanNamePublic, plans);
}

/** One getRatePlans row as the index keeps it (a request NOT filtered by room type: every row carries its roomTypeID). */
interface RatePlanIndexRow {
  roomTypeId: string;
  rateId: string;
  parentRateId: string | null;
  raw: { isDerived: unknown; promoCode: unknown; ratePlanNamePublic: unknown };
}

function ratePlanIndexRows(json: unknown): RatePlanIndexRow[] {
  const root = asRecord(json);
  if (!root || root.success !== true) throw new CloudbedsError(`getRatePlans failed: ${String(root?.message ?? "no success flag")}`);
  const out: RatePlanIndexRow[] = [];
  for (const raw of Array.isArray(root.data) ? root.data : []) {
    const r = asRecord(raw);
    const roomTypeId = r ? idOf(r.roomTypeID) : null;
    const rateId = r ? idOf(r.rateID) : null;
    if (!r || !roomTypeId || !rateId) continue;
    out.push({ roomTypeId, rateId, parentRateId: idOf(r.parentRateID), raw: { isDerived: r.isDerived, promoCode: r.promoCode, ratePlanNamePublic: r.ratePlanNamePublic } });
  }
  return out;
}

function promoIndexOf(rows: RatePlanIndexRow[], cloudbedsCode: string): PromoRateIndex {
  const out: PromoRateIndex = {};
  for (const r of rows) {
    if (!isPromoCode(r.raw.promoCode, cloudbedsCode)) continue;
    const list = (out[r.roomTypeId] ??= []);
    const name = planDisplayName(r.raw.ratePlanNamePublic);
    if (!list.some((x) => x.rateId === r.rateId)) list.push({ rateId: r.rateId, parentRateId: r.parentRateId, ...(name !== null ? { name } : {}) });
  }
  return out;
}

function autoIndexOf(rows: RatePlanIndexRow[], plans: readonly string[]): AutoDiscountIndex {
  const out: AutoDiscountIndex = {};
  if (plans.length === 0) return out;
  for (const r of rows) {
    if (!isAutoDiscountRow(r.raw, plans)) continue;
    const list = (out[r.roomTypeId] ??= []);
    if (!list.some((x) => x.rateId === r.rateId)) list.push({ rateId: r.rateId, parentRateId: r.parentRateId, name: planDisplayName(r.raw.ratePlanNamePublic) as string });
  }
  return out;
}

/**
 * Pure parser (exported for tests): the promo rows of a getRatePlans answer asked WITHOUT a
 * roomTypeID filter (so every row carries its roomTypeID; rows without one are skipped).
 */
export function parsePromoRatePlans(json: unknown, cloudbedsCode: string): PromoRateIndex {
  return promoIndexOf(ratePlanIndexRows(json), cloudbedsCode);
}

/**
 * Pure parser (exported for tests): both indexes of one getRatePlans answer asked without a roomTypeID filter -
 * the Direct rows (promo code `cloudbedsCode`; none when null) and the automatic discount rows (`autoPlans`).
 */
export function parseRatePlanIndex(json: unknown, options: { cloudbedsCode: string | null; autoPlans: readonly string[] }): RatePlanIndex {
  const rows = ratePlanIndexRows(json);
  return { promo: options.cloudbedsCode === null ? {} : promoIndexOf(rows, options.cloudbedsCode), auto: autoIndexOf(rows, options.autoPlans) };
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
  /** Discounted rows (Direct and automatic) per slug, in answer order; matched to their base row after the loop. */
  const discounted = new Map<string, DiscountCandidate[]>();
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
      // Cloudbeds' own occupancy limit for the room type (may be lower than the site's rooms.ts figure).
      const maxGuests = Number(row.maxGuests);
      const rateId = typeof row.roomRateID === "string" || typeof row.roomRateID === "number" ? String(row.roomRateID) : "";
      const typeId = String(row.roomTypeID ?? "");
      const promoRate = options.promo?.rates[typeId]?.find((x) => x.rateId === rateId);
      const autoRate = promoRate ? undefined : options.auto?.rates[typeId]?.find((x) => x.rateId === rateId);
      if (promoRate || autoRate) {
        // A discounted row (Direct or automatic): only ever sold next to its base row (after the loop).
        if (options.baseRateOnly) nonBaseOnly.add(slug);
        const rowName = isBasePlanName(row.ratePlanNamePublic) ? null : planDisplayName(row.ratePlanNamePublic);
        const list = discounted.get(slug) ?? [];
        list.push({
          kind: autoRate ? "auto" : "direct",
          rateId,
          parentRateId: (autoRate ?? promoRate)?.parentRateId ?? null,
          name: autoRate ? autoRate.name : (promoRate?.name ?? rowName ?? "Direct booking rate"),
          nightly,
          remaining,
          adultsExtra: parseAdultsExtraCharge(row.adultsExtraCharge, row.adultsIncluded),
          maxGuests: Number.isInteger(maxGuests) && maxGuests >= 1 && maxGuests <= 50 ? maxGuests : null,
        });
        discounted.set(slug, list);
        continue;
      }
      const tier = rowTier(row);
      if (options.baseRateOnly && tier !== 2) {
        nonBaseOnly.add(slug);
        continue;
      }
      const prev = found.get(slug);
      const better = !prev || tier > prev.tier || (tier === prev.tier && stayTotal(nightly) < stayTotal(prev.inventory.baseNightly));
      if (!better) continue;
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

  if (options.promo || options.auto) {
    /** A Direct row not sold keeps its own log line (Stage B case 24 looks for it); an automatic one has its own. */
    const unused = (slug: string, c: DiscountCandidate, reason: string) =>
      options.log?.(c.kind === "direct" ? "cloudbeds_promo_row_unused" : "cloudbeds_auto_discount_row_unused", { slug, rateId: c.rateId, plan: c.name, reason });
    for (const [slug, entry] of found) {
      const base = entry.inventory;
      const baseTotal = stayTotal(base.baseNightly);
      const usable = (discounted.get(slug) ?? []).filter((c) => {
        const why =
          entry.tier !== 2 || !base.rateId
            ? "no base row"
            : c.parentRateId !== null && c.parentRateId !== base.rateId
              ? "derived from another rate"
              : stayTotal(c.nightly) >= baseTotal
                ? "not cheaper than the base rate"
                : null;
        if (why) unused(slug, c, why);
        return why === null;
      });
      // The cheapest wins; on a tie the Direct rate (the guest asked for it), then the first row in the answer.
      let best: DiscountCandidate | null = null;
      for (const c of usable) {
        const diff = best === null ? -1 : stayTotal(c.nightly) - stayTotal(best.nightly);
        if (diff < 0 || (diff === 0 && c.kind === "direct" && best?.kind !== "direct")) best = c;
      }
      for (const c of usable) if (best && c !== best) unused(slug, c, `a cheaper rate was sold (${best.name})`);
      if (!best) {
        found.set(slug, { ...entry, inventory: { ...base, ...(options.promo ? { promoNotApplied: true } : {}) } });
        continue;
      }
      const maxGuests = Math.min(base.maxGuests ?? 50, best.maxGuests ?? 50);
      found.set(slug, {
        ...entry,
        inventory: {
          slug,
          available: true,
          remaining: Math.min(base.remaining, 1, best.remaining),
          baseNightly: best.nightly,
          adultsExtraSatang: best.adultsExtra,
          ...(base.maxGuests !== undefined || best.maxGuests !== null ? { maxGuests } : {}),
          rateId: best.rateId,
          discount: {
            kind: best.kind,
            name: best.name,
            baseRateId: base.rateId as string,
            baseNightly: base.baseNightly,
            baseAdultsExtraSatang: base.adultsExtraSatang ?? {},
          },
          // The guest's code was checked, but this room is sold on an automatic discount (cheaper, or no Direct row).
          ...(options.promo && best.kind !== "direct" ? { promoNotApplied: true } : {}),
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

/**
 * A plain getAvailableRoomTypes answer plus the rows only the promo-code answer has (the Direct rows),
 * matched by property and deduplicated by roomTypeID + roomRateID. Either answer failing fails the read.
 * Exported for tests.
 */
export function mergePromoAnswer(plain: unknown, withCode: unknown, log?: (message: string, data?: Record<string, unknown>) => void): unknown {
  const base = asRecord(plain);
  const promo = asRecord(withCode);
  if (!base || base.success !== true) return plain; // the parser reports the failed answer
  if (!promo || promo.success !== true) {
    throw new CloudbedsError(`getAvailableRoomTypes (promo code) failed: ${String(promo?.message ?? "no success flag")}`);
  }
  const key = (row: unknown) => `${String(asRecord(row)?.roomTypeID ?? "")}|${String(asRecord(row)?.roomRateID ?? "")}`;
  const baseProps = (Array.isArray(base.data) ? base.data : []).map((p) => ({ ...(asRecord(p) ?? {}) }));
  let added = 0;
  for (const p of Array.isArray(promo.data) ? promo.data : []) {
    const prop = asRecord(p);
    if (!prop) continue;
    const target = baseProps.find((b) => String(b.propertyID ?? "") === String(prop.propertyID ?? "")) ?? baseProps[0];
    if (!target) continue;
    const rows = Array.isArray(target.propertyRooms) ? [...target.propertyRooms] : [];
    const seen = new Set(rows.map(key));
    for (const row of Array.isArray(prop.propertyRooms) ? prop.propertyRooms : []) {
      if (seen.has(key(row))) continue;
      seen.add(key(row));
      rows.push(row);
      added += 1;
    }
    target.propertyRooms = rows;
  }
  log?.("cloudbeds_promo_rows", { added });
  return { ...base, data: baseProps };
}

/** A cached search answer, with the rate-plan index it was parsed with (indexKey). */
const searchCache = new Map<string, { expiresAt: number; inventory: RoomInventory[]; indexKey: string }>();

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
  // The Direct rate plan is a promo-code plan: Cloudbeds returns its rows only when asked with the code,
  // and then WITHOUT the base rows (live, Stage B 2026-10-07: every room looked sold out). So a search
  // with the code asks twice - plain for the base rows, with the code for the Direct rows - and parses both.
  const promoUrl = deps.promo ? `${url}&${new URLSearchParams({ promoCode: deps.promo.cloudbedsCode }).toString()}` : null;

  const nowMs = deps.nowMs ?? Date.now();
  const ttl = deps.cacheTtlMs ?? 0;
  const cacheKey = `${deps.apiKey.slice(-6)}|${deps.baseRateOnly ? "base" : "any"}|${promoUrl ?? url}`;
  // The rows a parse treats as Direct / automatic discount: the cache key of the index part that matters.
  const discountsOf = (index: RatePlanIndex | undefined) => {
    const promoRates = deps.promo ? (deps.promo.rates ?? index?.promo ?? {}) : null;
    const autoRates = index && Object.keys(index.auto).length > 0 ? index.auto : null;
    return { promoRates, autoRates, key: JSON.stringify([promoRates, autoRates]) };
  };
  // The rate-plan index, loaded once; null = the optional index (onRateIndexFailed) could not be read.
  let indexLoad: Promise<RatePlanIndex | undefined | null> | null = null;
  const loadIndex = () =>
    (indexLoad ??= (async () => {
      try {
        return typeof deps.rateIndex === "function" ? await deps.rateIndex() : await deps.rateIndex;
      } catch (e) {
        if (!deps.onRateIndexFailed) throw e;
        deps.onRateIndexFailed(e);
        return null;
      }
    })());
  // A cached answer whose index changed, kept in case availability can't be read again (optional index only).
  let stale: RoomInventory[] | null = null;
  if (ttl > 0) {
    const hit = searchCache.get(cacheKey);
    if (hit && hit.expiresAt > nowMs) {
      // A hit counts only when it was parsed with the same index (the index is cached for the same time, so this is
      // cheap); when the optional index can't be read, the cached answer stands (a failed optional read is remembered
      // for RATE_PLAN_FAIL_TTL_MS, so hits don't re-send it while it fails - cloudbedsRateIndex rememberFailure).
      const index = await loadIndex();
      if (index === null || hit.indexKey === discountsOf(index).key) return hit.inventory;
      // The index changed (e.g. the answer was cached while the index read had no budget token): availability is read
      // again. When the index is optional and that read fails (the index read may have taken the last token), the
      // cached answer still stands - checkout re-quotes.
      if (deps.onRateIndexFailed) stale = hit.inventory;
    }
  }

  const budget = deps.budget ?? (deps.fetchImpl ? null : CLOUDBEDS_PREVIEW_BUDGET);
  const read = async (target: string): Promise<unknown> => {
    if (budget && !(await acquire(budget, deps.budgetWaitMs ?? 0))) throw new CloudbedsBudgetError();
    const res = await readCall(target, { headers: cloudbedsReadHeaders(deps.apiKey, deps.propertyId), cache: "no-store" }, deps, budget ?? null);
    if (!res.ok) throw new CloudbedsError(`getAvailableRoomTypes HTTP ${res.status}`);
    return res.json();
  };
  // The rate-plan index (getRatePlans) is read at the same time as availability, started after availability's reads
  // (in this order), so they take their budget tokens first.
  let discounts: ReturnType<typeof discountsOf>;
  let inventory: RoomInventory[];
  try {
    const [plain, withCode, index] = await Promise.all([read(url), promoUrl ? read(promoUrl) : Promise.resolve(null), loadIndex()]);
    const answer = withCode === null ? plain : mergePromoAnswer(plain, withCode, deps.log ?? logEvent);
    discounts = discountsOf(index ?? undefined);
    inventory = parseAvailableRoomTypes(answer, checkIn, checkOut, {
      baseRateOnly: deps.baseRateOnly,
      onNoBaseRate: deps.onNoBaseRate,
      log: deps.log ?? logEvent,
      ...(discounts.promoRates ? { promo: { rates: discounts.promoRates } } : {}),
      ...(discounts.autoRates ? { auto: { rates: discounts.autoRates } } : {}),
    });
  } catch (e) {
    if (stale === null) throw e;
    (deps.log ?? logEvent)("cloudbeds_search_revalidate_failed", { checkIn, checkOut, error: e instanceof Error ? e.message : String(e) });
    return stale;
  }

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
    searchCache.set(cacheKey, { expiresAt: nowMs + ttl, inventory, indexKey: discounts.key });
  }
  return inventory;
}

/** The rows of a getRatePlans answer, per stay: one read serves the Direct and the automatic-discount index alike. */
const ratePlanRowsCache = new Map<string, { expiresAt: number; rows: RatePlanIndexRow[] }>();

/** How long a failed OPTIONAL rate-plan read (rememberFailure) is not sent again for the same stay. */
export const RATE_PLAN_FAIL_TTL_MS = 20_000;
/** Failed optional rate-plan reads, per stay (same key as ratePlanRowsCache): the error message, until expiresAt. */
const ratePlanFailCache = new Map<string, { expiresAt: number; message: string }>();

/**
 * The rate-plan index for a stay: which rateIDs are Cloudbeds' promo `cloudbedsCode` rows (the Direct rate;
 * none when null) and which are automatic discount plans (`autoPlans`), per room type. ONE getRatePlans call,
 * NOT filtered by room type (every row then carries its roomTypeID). Search reuses its rows for cacheTtlMs like
 * cloudbedsInventory (a search with the code and one without share them); checkout asks fresh. Throws
 * CloudbedsError / CloudbedsBudgetError (the caller treats it like a failed availability read).
 * `rememberFailure` (search with cacheTtlMs, only when the index is optional - the automatic discounts alone): a
 * read that was sent and failed (HTTP error, 429 after its retry, success:false, network error or timeout) is
 * remembered for RATE_PLAN_FAIL_TTL_MS, and the next optional reads of that stay fail at once - no call, no budget
 * token, no wait - so cached searches don't re-send a read that is failing. A budget refusal before sending is not
 * remembered (it cost nothing); a required read (with the code, checkout) always asks, and its success clears it.
 */
export async function cloudbedsRateIndex(
  checkIn: IsoDate,
  checkOut: IsoDate,
  options: { cloudbedsCode: string | null; autoPlans: readonly string[] },
  deps: Omit<CloudbedsDeps, "adults" | "promo" | "rateIndex" | "baseRateOnly" | "onNoBaseRate"> & { rememberFailure?: boolean },
): Promise<RatePlanIndex> {
  const params = new URLSearchParams({ startDate: checkIn, endDate: checkOut });
  if (deps.propertyId) params.set("propertyIDs", deps.propertyId);
  const url = `${CLOUDBEDS_API_BASE}/getRatePlans?${params.toString()}`;
  const nowMs = deps.nowMs ?? Date.now();
  const ttl = deps.cacheTtlMs ?? 0;
  const cacheKey = `${deps.apiKey.slice(-6)}|${url}`;
  const indexOf = (rows: RatePlanIndexRow[]): RatePlanIndex => ({
    promo: options.cloudbedsCode === null ? {} : promoIndexOf(rows, options.cloudbedsCode),
    auto: autoIndexOf(rows, options.autoPlans),
  });
  if (ttl > 0) {
    const hit = ratePlanRowsCache.get(cacheKey);
    if (hit && hit.expiresAt > nowMs) return indexOf(hit.rows);
  }
  const remember = ttl > 0 && deps.rememberFailure === true;
  const failed = remember ? ratePlanFailCache.get(cacheKey) : undefined;
  if (failed && failed.expiresAt > nowMs) throw new CloudbedsError(`${failed.message} (remembered: not re-sent for ${RATE_PLAN_FAIL_TTL_MS / 1000} s)`);
  const budget = deps.budget ?? (deps.fetchImpl ? null : CLOUDBEDS_PREVIEW_BUDGET);
  if (budget && !(await acquire(budget, deps.budgetWaitMs ?? 0))) throw new CloudbedsBudgetError();
  let rows: RatePlanIndexRow[];
  try {
    const res = await readCall(url, { headers: cloudbedsReadHeaders(deps.apiKey, deps.propertyId), cache: "no-store" }, deps, budget ?? null);
    if (!res.ok) throw new CloudbedsError(`getRatePlans HTTP ${res.status}`);
    rows = ratePlanIndexRows(await res.json());
  } catch (e) {
    // Sent and failed: an optional read is not sent again for this stay for a while.
    if (remember) {
      if (ratePlanFailCache.size >= CACHE_MAX_ENTRIES) ratePlanFailCache.clear();
      ratePlanFailCache.set(cacheKey, { expiresAt: nowMs + RATE_PLAN_FAIL_TTL_MS, message: e instanceof Error ? e.message : String(e) });
    }
    throw e;
  }
  ratePlanFailCache.delete(cacheKey);
  if (ttl > 0) {
    if (ratePlanRowsCache.size >= CACHE_MAX_ENTRIES) ratePlanRowsCache.clear();
    ratePlanRowsCache.set(cacheKey, { expiresAt: nowMs + ttl, rows });
  }
  return indexOf(rows);
}

/* --------------------------- restrictions ---------------------------- */

/**
 * `derived`: the row checked (the sold rateId's) is a DERIVED plan in getRatePlans. The Stripe
 * checkout refuses it whatever the rules say: Stripe modes sell the base (BAR) row only - except
 * the discounted rate selected for this booking, which comes back as `promo` (the Direct rate) or
 * `auto` (an automatic discount), never `derived`, once getRatePlans confirms it (see
 * evaluateRestrictions' `promo`).
 */
export type RestrictionResult = (
  | { ok: true; checked: boolean }
  | { ok: false; reason: "closed_to_arrival" | "closed_to_departure" | "min_stay" | "max_stay" | "blocked" | "sold_out"; minNights?: number; maxNights?: number }
) & { derived?: true; promo?: true; auto?: true };

/**
 * The discounted rate a checkout selected for a room, and the base row it was priced next to: the Direct rate
 * (Cloudbeds' promo code; `kind` absent or "direct") or an automatic discount plan (`kind` "auto", the
 * configured plan-name prefixes, BOOKING_AUTO_DISCOUNT_PLANS).
 */
export type PromoRestrictionInput =
  | { kind?: "direct"; cloudbedsCode: string; baseRateId: string }
  | { kind: "auto"; plans: readonly string[]; baseRateId: string };

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
 *
 * `promo` (the discounted rate this checkout selected for the room): the row
 * with `rateId` must carry Cloudbeds' promo code (the Direct rate) or be an
 * automatic discount plan (kind "auto": derived, no promo code, an eligible
 * name - isAutoDiscountRow), the room type's base row must be the one it was
 * priced next to (promo.baseRateId), and its parentRateID (when sent) must be
 * that base row. Then the stay is checked against BOTH rows - the highest
 * positive minLos and the lowest positive maxLos of either, closed to arrival /
 * departure, blocked or no room left on either - and the result is marked
 * `promo` (Direct) or `auto`. Anything else is marked `derived` (refused): a
 * derived row is only ever sold as the discounted rate selected for this booking.
 */
export function evaluateRestrictions(
  json: unknown,
  roomTypeId: string,
  rateId: string | null,
  checkIn: IsoDate,
  checkOut: IsoDate,
  options: { log?: (message: string, data?: Record<string, unknown>) => void; promo?: PromoRestrictionInput | null } = {},
): RestrictionResult {
  const root = asRecord(json);
  if (!root || root.success !== true) throw new CloudbedsError(`getRatePlans failed: ${String(root?.message ?? "no success flag")}`);
  const rows = (Array.isArray(root.data) ? root.data : []).map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
  // The request is filtered by roomTypeID, and the v1.3 spec returns that field only "if not specified in request":
  // a row without it is the requested type's.
  const forType = rows.filter((r) => r.roomTypeID === undefined || r.roomTypeID === null || r.roomTypeID === "" || String(r.roomTypeID) === roomTypeId);
  if (options.promo) {
    const selected = options.promo;
    const auto = selected.kind === "auto";
    const promoRow = rateId ? forType.find((r) => String(r.rateID ?? "") === rateId) : undefined;
    const base = forType.find(isBaseRatePlanRow);
    const parent = promoRow ? idOf(promoRow.parentRateID) : null;
    const isSelectedPlan = (r: Record<string, unknown>) => (selected.kind === "auto" ? isAutoDiscountRow(r, selected.plans) : isPromoRow(r, selected.cloudbedsCode));
    const why = !promoRow
      ? "the rate is not listed"
      : !isSelectedPlan(promoRow)
        ? auto
          ? "the rate is not an automatic discount plan"
          : "the rate does not carry the promo code"
        : !base
          ? "no base row"
          : String(base.rateID ?? "") !== selected.baseRateId
            ? "the base row differs from the one priced"
            : parent !== null && parent !== selected.baseRateId
              ? "the rate is derived from another rate"
              : null;
    if (why || !promoRow || !base) {
      options.log?.(auto ? "restrictions_auto_rate_refused" : "restrictions_promo_rate_refused", { roomTypeId, rateId, reason: why });
      return { ok: true, checked: false, derived: true };
    }
    const result = checkStay([promoRow, base], roomTypeId, checkIn, checkOut, options.log);
    return auto ? { ...result, auto: true } : { ...result, promo: true };
  }
  const row = (rateId ? forType.find((r) => String(r.rateID ?? "") === rateId) : undefined) ?? forType.find(isBaseRatePlanRow);
  if (!row) return { ok: true, checked: false };
  const result = checkStay([row], roomTypeId, checkIn, checkOut, options.log);
  return truthy(row.isDerived) ? { ...result, derived: true } : result;
}

/** The stay against every row given (the sold row; for the Direct rate also its base row): the strictest rule of any row wins. */
function checkStay(
  rows: Record<string, unknown>[],
  roomTypeId: string,
  checkIn: IsoDate,
  checkOut: IsoDate,
  log: ((message: string, data?: Record<string, unknown>) => void) | undefined,
): RestrictionResult {
  const calendars = rows.map((row) => {
    const days = (Array.isArray(row.roomRateDetailed) ? row.roomRateDetailed : []) as CbRateDay[];
    const byDate = new Map<string, CbRateDay>();
    for (const d of days) if (typeof d?.date === "string") byDate.set(d.date.slice(0, 10), d);
    return { rateId: String(row.rateID ?? ""), byDate };
  });
  const nights = eachNight(checkIn, checkOut);
  // Without the arrival day's row nothing (CTA, min/max stay) can be evaluated: say so, never "checked".
  if (calendars.some((c) => !c.byDate.has(checkIn))) return { ok: true, checked: false };
  if (calendars.some((c) => truthy(c.byDate.get(checkIn)?.closedToArrival))) return { ok: false, reason: "closed_to_arrival" };
  for (const c of calendars) {
    const departure = c.byDate.get(checkOut);
    if (!departure) log?.("restrictions_no_departure_row", { roomTypeId, rateId: c.rateId, checkOut });
    else if (truthy(departure.closedToDeparture)) return { ok: false, reason: "closed_to_departure" };
  }
  let minLos = 0;
  let maxLos = 0;
  for (const c of calendars) {
    for (const night of nights) {
      const d = c.byDate.get(night);
      const min = Number(d?.minLos);
      const max = Number(d?.maxLos);
      if (Number.isFinite(min) && min > minLos) minLos = min;
      if (Number.isFinite(max) && max > 0 && (maxLos === 0 || max < maxLos)) maxLos = max;
    }
  }
  if (minLos > 0 && nights.length < minLos) return { ok: false, reason: "min_stay", minNights: minLos };
  if (maxLos > 0 && nights.length > maxLos) return { ok: false, reason: "max_stay", maxNights: maxLos };
  for (const c of calendars) {
    for (const night of nights) {
      const d = c.byDate.get(night);
      if (!d) continue;
      if (truthy(d.blocked)) return { ok: false, reason: "blocked" };
      if (d.roomsAvailable !== undefined && Number(d.roomsAvailable) < 1) return { ok: false, reason: "sold_out" };
    }
  }
  return { ok: true, checked: true };
}

/**
 * Live restriction check for one room type (no cache). `promo`: the discounted rate (Direct or automatic)
 * selected for this booking (see evaluateRestrictions). Throws CloudbedsError / CloudbedsBudgetError.
 */
export async function cloudbedsRestrictions(
  roomTypeId: string,
  rateId: string | null,
  checkIn: IsoDate,
  checkOut: IsoDate,
  adults: number,
  deps: Omit<CloudbedsDeps, "adults" | "cacheTtlMs" | "promo">,
  promo: PromoRestrictionInput | null = null,
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
  return evaluateRestrictions(await res.json(), roomTypeId, rateId, checkIn, checkOut, { log: deps.log ?? logEvent, promo });
}

// Read-only Cloudbeds inventory for the preview (existing API key, no writes).
//
// getAvailableRoomTypes is called with adults=1 so the answer is about
// INVENTORY only; party size is validated locally against each room's
// maxGuests (the site never takes children, so children=0). Stay totals are
// summed from roomRateDetailed (whether roomRate is per night or per stay is
// undocumented). Amounts in the Cloudbeds v1.x API are major-unit THB and are
// converted to integer satang here. Errors throw; the caller falls back to
// demo data and reports dataSource "demo-fallback".

import { ROOM_TYPE_TO_SLUG } from "../../data/cloudbeds.ts";
import { getBookableRooms } from "./catalogue.ts";
import { eachNight } from "./dates.ts";
import { thbToSatang } from "./quote.ts";
import type { IsoDate, NightRate, RoomInventory } from "./types.ts";

export const CLOUDBEDS_API_BASE = "https://api.cloudbeds.com/api/v1.2";
const TIMEOUT_MS = 8_000;

export interface CloudbedsDeps {
  apiKey: string;
  propertyId: string | null;
  fetchImpl?: typeof fetch;
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

/** Pure parser for a getAvailableRoomTypes response (exported for tests). */
export function parseAvailableRoomTypes(json: unknown, checkIn: IsoDate, checkOut: IsoDate): RoomInventory[] {
  const root = asRecord(json);
  if (!root || root.success !== true) {
    throw new CloudbedsError(`getAvailableRoomTypes failed: ${String(root?.message ?? "no success flag")}`);
  }
  const nights = eachNight(checkIn, checkOut);
  const properties = Array.isArray(root.data) ? root.data : [];

  const found = new Map<string, RoomInventory>();
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
      // Prefer the base (non-plan, non-derived) row; otherwise the cheapest.
      const isBase = !row.ratePlanNamePublic && !row.derivedType;
      const candidate: RoomInventory = { slug, available: true, remaining: Math.min(1, remaining), baseNightly: nightly };
      const prev = found.get(slug);
      const total = (n: NightRate[]) => n.reduce((s, x) => s + x.amountSatang, 0);
      if (!prev || isBase || total(nightly) < total(prev.baseNightly)) found.set(slug, candidate);
    }
  }

  return getBookableRooms().map(
    (room) => found.get(room.slug) ?? { slug: room.slug, available: false, remaining: 0, baseNightly: [] },
  );
}

export async function cloudbedsInventory(checkIn: IsoDate, checkOut: IsoDate, deps: CloudbedsDeps): Promise<RoomInventory[]> {
  const params = new URLSearchParams({
    startDate: checkIn,
    endDate: checkOut,
    rooms: "1",
    adults: "1",
    children: "0",
    detailedRates: "true",
    pageSize: "50",
  });
  if (deps.propertyId) params.set("propertyIDs", deps.propertyId);
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`${CLOUDBEDS_API_BASE}/getAvailableRoomTypes?${params.toString()}`, {
    headers: { "x-api-key": deps.apiKey, accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new CloudbedsError(`getAvailableRoomTypes HTTP ${res.status}`);
  return parseAvailableRoomTypes(await res.json(), checkIn, checkOut);
}

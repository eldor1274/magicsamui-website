// Cloudbeds WRITE side (WI-3), API v1.3 (postPayment only exists on v1.3
// since 2025-12-01). Server only.
//
// - Auth: x-api-key = CLOUDBEDS_API_KEY_BOOKING (a NEW key with write scopes;
//   the existing read key is left alone) + X-PROPERTY-ID.
// - POST/PUT bodies are application/x-www-form-urlencoded with bracket-indexed
//   arrays (rooms[0][roomTypeID]).
// - Every response carries `success`: it is checked as well as the HTTP status
//   (Cloudbeds answers success:false with HTTP 200).
// - X-Request-ID is logged for every call (no personal data is ever logged).
// - 10 requests/second per key: calls draw on the same token bucket as the
//   read side (cloudbedsProvider.ts CLOUDBEDS_BUDGET) and back off on 429.
// - Money: our integer satang become major-unit baht strings HERE and only
//   here (satangToBahtString); Cloudbeds amounts are parsed back to satang.
// - Non-idempotent POSTs (postReservation, postPayment) are NOT retried on a
//   network error or 5xx: the error is marked `ambiguous` and the callers
//   reconcile (fulfil re-reads the folio before paying; checkout records a
//   hold intent BEFORE postReservation and the sweeper finds orphan holds by
//   their MSV- thirdPartyIdentifier, in any non-cancelled status).

import { CLOUDBEDS_BUDGET, CLOUDBEDS_API_BASE } from "./cloudbedsProvider.ts";
import type { TokenBucket } from "./cloudbedsProvider.ts";
import { cloudbedsMoneyToSatang, satangToBahtString } from "./quote.ts";
import type { IsoDate } from "./types.ts";

const TIMEOUT_MS = 15_000;
const MAX_429_RETRIES = 3;
/** A deadline-bound call is not sent (or retried) with less than this left. */
export const MIN_CALL_MS = 1_500;

export type ReservationStatus = "not_confirmed" | "confirmed" | "canceled" | "checked_in" | "checked_out" | "no_show";

export interface HoldRoom {
  roomTypeId: string;
  /** Cloudbeds roomRateID that was priced (pins the rate); null = Cloudbeds' default. */
  rateId: string | null;
  adults: number;
}

export interface HoldGuest {
  firstName: string;
  lastName: string;
  email: string;
  /** "+66 952466011" */
  phone: string;
  /** ISO 3166-1 alpha-2 */
  country: string;
  /** guestZip (a placeholder when the guest has none) */
  zip: string;
}

export interface HoldInput {
  /** Our booking ref (MSV-...). */
  ref: string;
  /** thirdPartyIdentifier (lock.ts holdIdentifier: the ref, plus -TEST outside live). Default: the ref. */
  identifier?: string;
  checkIn: IsoDate;
  checkOut: IsoDate;
  rooms: HoldRoom[];
  guest: HoldGuest;
  /** "15:00" or null */
  estimatedArrivalTime: string | null;
  /** postReservation paymentMethod enum value. */
  paymentMethod: "cash" | "credit" | "ebanking" | "pay_pal";
  /** postReservation sourceID (config.cloudbedsSourceId); null/absent = not sent (Cloudbeds' default source). */
  sourceId?: string | null;
  /**
   * The room subtotal we quoted (satang). Never sent to the real Cloudbeds;
   * only the mock writer passes it to the in-repo fake, which prices the hold
   * at this amount unless a test overrides it.
   */
  expectedRoomsSatang: number;
}

export interface HoldResult {
  reservationId: string;
  status: ReservationStatus | string;
  /**
   * Cloudbeds' grandTotal for the hold; null when Cloudbeds answered with a
   * usable reservationID but no readable total (the caller re-reads it, and
   * cancels the hold at once if it still can't be read).
   */
  grandTotalSatang: number | null;
  /** The response's dateCreated as Cloudbeds sent it (no zone; logged to calibrate Cloudbeds' clock), or null. */
  dateCreated: string | null;
}

export interface ReservationInfo {
  reservationId: string;
  status: ReservationStatus | string;
  grandTotalSatang: number | null;
  balanceSatang: number | null;
  /**
   * What the folio shows as paid. null = UNKNOWN (never read it as 0): callers
   * that would post a payment or cancel a hold must treat null with caution.
   */
  paidSatang: number | null;
  /** balanceDetailed: the rooms, additional items (e.g. our fee line) and Cloudbeds' taxes/fees; null = unreadable. */
  subTotalSatang: number | null;
  additionalItemsSatang: number | null;
  taxesFeesSatang: number | null;
  thirdPartyIdentifier: string | null;
  /** The reservation source's name and id (e.g. "s-41" or "s-41-1"; the format is not documented), or null. */
  source: string | null;
  sourceId: string | null;
}

export interface ListedReservation {
  reservationId: string;
  status: string;
  /** "YYYY-MM-DD HH:MM:SS" as Cloudbeds returns it (property-local per the docs; not verified). */
  dateCreated: string | null;
  /**
   * Creation time in ms, read CAUTIOUSLY: dateCreatedUTC if Cloudbeds ever
   * sends it (the v1.3 getReservations schema only has dateCreated), else
   * dateCreated read as if it were UTC - the later of the two possible readings
   * (UTC vs Bangkok), so a hold never looks older than it is. Up to 7 h late
   * for a Bangkok timestamp: the sweeper relies on this only for a hold it has
   * no record or intent of (both carry an age of our own).
   * null when neither can be parsed.
   */
  createdMs: number | null;
  thirdPartyIdentifier: string | null;
}

/** Parses a Cloudbeds datetime; strings without a zone are read as UTC (see ListedReservation.createdMs). */
export function parseCloudbedsDateTime(v: string | null): number | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(v.trim());
  if (!m) return null;
  if (m[8]) {
    const ms = Date.parse(v.trim().replace(" ", "T"));
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  return Number.isFinite(ms) ? ms : null;
}

export interface CloudbedsWriter {
  /** "live" = the real API; "mock" = the in-repo fake (nothing reaches Cloudbeds). */
  readonly mode: "live" | "mock";
  createHold(input: HoldInput): Promise<HoldResult>;
  getReservation(reservationId: string): Promise<ReservationInfo>;
  /** postPayment with the custom payment method (its exact `method` value, e.g. "Stripe(website)"). Returns the Cloudbeds paymentID. */
  recordPayment(input: { reservationId: string; amountSatang: number; method: string; description: string }): Promise<{ paymentId: string | null }>;
  /**
   * postCustomItem; referenceID makes Cloudbeds refuse a duplicate. Cloudbeds
   * keeps the name/description sent with the FIRST call for an appItemID and
   * ignores them on later calls, so the item id is per mode and the text static.
   */
  addFeeItem(input: FeeItemInput): Promise<{ duplicate: boolean }>;
  /** postReservationNote */
  addNote(reservationId: string, note: string): Promise<void>;
  /** putReservation status=confirmed */
  confirm(reservationId: string, sendStatusChangeEmail: boolean): Promise<void>;
  /** putReservation status=canceled (spelled with one L) */
  cancel(reservationId: string): Promise<void>;
  /** putReservation status=not_confirmed ("Confirmation pending") */
  markPending(reservationId: string): Promise<void>;
  /**
   * getReservations created in [from, to] (sent as Bangkok time), EVERY status
   * (API bookings can come back "confirmed" or "not_confirmed" depending on the
   * property). Callers filter by thirdPartyIdentifier and do their own age check.
   */
  findHolds(fromMs: number, toMs: number): Promise<ListedReservation[]>;
  /**
   * The same writer, but every call fits before `deadlineAt` (`clock` ms): the
   * wait for a budget token, the fetch timeout and 429 retries are cut to the
   * time left, and a call with less than MIN_CALL_MS left is not sent at all
   * (a "budget" error: nothing was sent). For request paths with a hard limit.
   */
  bounded?(deadlineAt: number, clock?: () => number): CloudbedsWriter;
}

export interface FeeItemInput {
  reservationId: string;
  amountSatang: number;
  referenceId: string;
  /** Cloudbeds appItemID: one per mode (live vs test), never shared. */
  appItemId: string;
  itemSku: string;
  /** Static per appItemID (Cloudbeds reuses the first one sent). */
  name: string;
  /** Static per appItemID (no per-booking ids: they go into the payment description and the reservation note). */
  note: string;
}

export type CloudbedsWriteErrorKind = "rejected" | "http" | "network" | "rate_limited" | "budget" | "invalid_response";

export class CloudbedsWriteError extends Error {
  readonly method: string;
  readonly kind: CloudbedsWriteErrorKind;
  readonly status: number | null;
  readonly requestId: string | null;
  /** True when the request may have been processed (network error/timeout/5xx on a write). */
  readonly ambiguous: boolean;
  constructor(method: string, kind: CloudbedsWriteErrorKind, message: string, status: number | null, requestId: string | null, ambiguous: boolean) {
    super(`${method}: ${message}`);
    this.name = "CloudbedsWriteError";
    this.method = method;
    this.kind = kind;
    this.status = status;
    this.requestId = requestId;
    this.ambiguous = ambiguous;
  }
}

export interface CloudbedsWriterOptions {
  apiKey: string;
  propertyId: string;
  mode?: "live" | "mock";
  fetchImpl?: typeof fetch;
  /** Shared call budget (default CLOUDBEDS_BUDGET; pass null for an unmetered injected fetch). */
  budget?: TokenBucket | null;
  /** How long a call may wait for a budget token. */
  budgetWaitMs?: number;
  log?: (message: string, data?: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  /** Every call must fit before `at` (`clock` ms); see CloudbedsWriter.bounded. */
  deadline?: { at: number; clock: () => number };
}

type FormValue = string | number | boolean | null | undefined;
type FormInput = Record<string, FormValue | FormValue[] | Record<string, FormValue>[]>;

/**
 * Form-encodes Cloudbeds style: arrays of objects become rooms[0][roomTypeID]=..,
 * null/undefined fields are left out.
 */
export function toCloudbedsForm(input: FormInput): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item !== null && typeof item === "object") {
          for (const [k, v] of Object.entries(item)) {
            if (v !== null && v !== undefined) out.append(`${key}[${i}][${k}]`, String(v));
          }
        } else if (item !== null && item !== undefined) {
          out.append(`${key}[${i}]`, String(item));
        }
      });
      continue;
    }
    out.append(key, String(value));
  }
  return out;
}

/** Strips anything that could be personal data (emails, long digit runs) from a message before logging it. */
export function redactForLog(s: string): string {
  return s
    .replace(/[^\s@]+@[^\s@]+/g, "[email]")
    .replace(/\+?\d[\d\s-]{6,}\d/g, "[number]")
    .slice(0, 300);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * balanceDetailed is an object OR an array of objects (v1.3 schema: oneOf).
 * Sums each figure over the entries (grandTotal = subTotal + additionalItems +
 * taxesFees per the spec); a figure is null unless every entry carries it readably.
 */
export function readBalanceDetailed(v: unknown): {
  paid: number | null;
  grandTotal: number | null;
  subTotal: number | null;
  additionalItems: number | null;
  taxesFees: number | null;
} {
  const entries = Array.isArray(v) ? v.map(asRecord) : [asRecord(v)];
  if (entries.length === 0 || entries.some((e) => e === null)) return { paid: null, grandTotal: null, subTotal: null, additionalItems: null, taxesFees: null };
  const sum = (field: string): number | null => {
    let total = 0;
    for (const e of entries) {
      const n = cloudbedsMoneyToSatang((e as Record<string, unknown>)[field]);
      if (n === null) return null;
      total += n;
    }
    return total;
  };
  return { paid: sum("paid"), grandTotal: sum("grandTotal"), subTotal: sum("subTotal"), additionalItems: sum("additionalItems"), taxesFees: sum("taxesFees") };
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** "YYYY-MM-DD HH:MM:SS" in Asia/Bangkok (Cloudbeds datetimes are property-local). */
export function bangkokDateTime(ms: number): string {
  const d = new Date(ms + 7 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

const RESERVATION_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function isReservationId(v: unknown): v is string {
  return typeof v === "string" && RESERVATION_ID_RE.test(v);
}

async function takeBudget(budget: TokenBucket, maxWaitMs: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    if (budget.take()) return true;
    const wait = budget.msUntilNext();
    if (Date.now() - started + wait > maxWaitMs) return false;
    await sleep(wait);
  }
}

export function createCloudbedsWriter(options: CloudbedsWriterOptions): CloudbedsWriter {
  const mode = options.mode ?? "live";
  const base = options.baseUrl ?? CLOUDBEDS_API_BASE;
  const doFetch = options.fetchImpl ?? fetch;
  const budget = options.budget === undefined ? (options.fetchImpl ? null : CLOUDBEDS_BUDGET) : options.budget;
  const budgetWaitMs = options.budgetWaitMs ?? 10_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = options.log ?? (() => undefined);
  const deadline = options.deadline;
  /** Time left before the deadline (Infinity without one). */
  const left = () => (deadline ? deadline.at - deadline.clock() : Number.POSITIVE_INFINITY);

  async function call(
    method: string,
    verb: "GET" | "POST" | "PUT",
    params: URLSearchParams,
    extraHeaders: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const isWrite = verb !== "GET";
    for (let attempt = 0; ; attempt++) {
      if (left() < MIN_CALL_MS) {
        throw new CloudbedsWriteError(method, "budget", "no time left before the deadline (nothing sent)", null, null, false);
      }
      if (budget && !(await takeBudget(budget, Math.min(budgetWaitMs, Math.max(0, left() - MIN_CALL_MS)), sleep))) {
        throw new CloudbedsWriteError(method, "budget", "call budget exhausted (nothing sent)", null, null, false);
      }
      const remaining = left();
      if (remaining < MIN_CALL_MS) {
        throw new CloudbedsWriteError(method, "budget", "no time left before the deadline (nothing sent)", null, null, false);
      }
      const timeoutMs = Math.min(TIMEOUT_MS, Math.floor(remaining));
      const headers: Record<string, string> = {
        "x-api-key": options.apiKey,
        "X-PROPERTY-ID": options.propertyId,
        accept: "application/json",
        ...extraHeaders,
      };
      let url = `${base}/${method}`;
      let body: string | undefined;
      if (isWrite) {
        headers["content-type"] = "application/x-www-form-urlencoded";
        body = params.toString();
      } else {
        url += `?${params.toString()}`;
      }
      let res: Response;
      try {
        res = await doFetch(url, { method: verb, headers, body, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        log("cloudbeds_write_network_error", { method, error: redactForLog(e instanceof Error ? e.message : String(e)) });
        // A GET is safe to report as not processed; a write may have landed.
        throw new CloudbedsWriteError(method, "network", "network error or timeout", null, null, isWrite);
      }
      const requestId = res.headers.get("x-request-id");
      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5_000) : 500 * 2 ** attempt;
        // A 429 was not processed: retry only when the wait and the retry still fit before the deadline.
        if (left() - wait >= MIN_CALL_MS) {
          log("cloudbeds_rate_limited", { method, requestId, attempt, waitMs: wait });
          await sleep(wait);
          continue;
        }
        log("cloudbeds_rate_limited_no_time", { method, requestId, attempt });
      }
      let json: Record<string, unknown> | null = null;
      try {
        json = asRecord(await res.json());
      } catch {
        json = null;
      }
      log("cloudbeds_call", { method, status: res.status, requestId, success: json?.success === true });
      if (res.status === 429) {
        throw new CloudbedsWriteError(method, "rate_limited", "rate limited (429) after retries", 429, requestId, false);
      }
      if (!res.ok) {
        const msg = redactForLog(String(json?.message ?? `HTTP ${res.status}`));
        throw new CloudbedsWriteError(method, "http", msg, res.status, requestId, isWrite && res.status >= 500);
      }
      if (!json) throw new CloudbedsWriteError(method, "invalid_response", "response is not JSON", res.status, requestId, isWrite);
      if (json.success !== true) {
        const msg = redactForLog(String(json.message ?? "success:false"));
        throw new CloudbedsWriteError(method, "rejected", msg, res.status, requestId, false);
      }
      return json;
    }
  }

  const putStatus = async (reservationId: string, status: ReservationStatus, sendEmail: boolean) => {
    if (!isReservationId(reservationId)) throw new CloudbedsWriteError("putReservation", "invalid_response", "bad reservation id", null, null, false);
    await call(
      "putReservation",
      "PUT",
      toCloudbedsForm({ propertyID: options.propertyId, reservationID: reservationId, status, sendStatusChangeEmail: sendEmail }),
    );
  };

  return {
    mode,

    async createHold(input) {
      const form = toCloudbedsForm({
        propertyID: options.propertyId,
        startDate: input.checkIn,
        endDate: input.checkOut,
        guestFirstName: input.guest.firstName,
        guestLastName: input.guest.lastName,
        guestEmail: input.guest.email,
        guestPhone: input.guest.phone,
        guestCountry: input.guest.country,
        guestZip: input.guest.zip,
        rooms: input.rooms.map((r) => ({ roomTypeID: r.roomTypeId, quantity: 1, roomRateID: r.rateId })),
        adults: input.rooms.map((r) => ({ roomTypeID: r.roomTypeId, quantity: r.adults })),
        children: input.rooms.map((r) => ({ roomTypeID: r.roomTypeId, quantity: 0 })),
        paymentMethod: input.paymentMethod,
        sourceID: input.sourceId ?? null,
        thirdPartyIdentifier: input.identifier ?? input.ref,
        sendEmailConfirmation: false,
        estimatedArrivalTime: input.estimatedArrivalTime,
      });
      const hint: Record<string, string> = mode === "mock" ? { "x-msv-mock-expected-total": String(input.expectedRoomsSatang) } : {};
      const json = await call("postReservation", "POST", form, hint);
      const reservationId = str(json.reservationID);
      if (!isReservationId(reservationId)) {
        // success:true but no id we can use: a reservation may exist -> ambiguous (the sweeper finds it by its identifier).
        throw new CloudbedsWriteError("postReservation", "invalid_response", "missing reservationID", 200, null, true);
      }
      // A usable id without a readable total is returned as such: the caller can still cancel it right away.
      return {
        reservationId,
        status: str(json.status) ?? "unknown",
        grandTotalSatang: cloudbedsMoneyToSatang(json.grandTotal),
        dateCreated: str(json.dateCreated)?.slice(0, 40) ?? null,
      };
    },

    async getReservation(reservationId) {
      if (!isReservationId(reservationId)) throw new CloudbedsWriteError("getReservation", "invalid_response", "bad reservation id", null, null, false);
      const json = await call("getReservation", "GET", toCloudbedsForm({ propertyID: options.propertyId, reservationID: reservationId }));
      const data = asRecord(json.data) ?? {};
      const detailed = readBalanceDetailed(data.balanceDetailed);
      const grandTotalSatang = detailed.grandTotal ?? cloudbedsMoneyToSatang(data.total);
      const balanceSatang = cloudbedsMoneyToSatang(data.balance);
      return {
        reservationId: str(data.reservationID) ?? reservationId,
        status: str(data.status) ?? "unknown",
        grandTotalSatang,
        balanceSatang,
        // Unreadable "paid": derive it from total - balance when both are known, else UNKNOWN (null), never 0.
        paidSatang: detailed.paid ?? (grandTotalSatang !== null && balanceSatang !== null ? grandTotalSatang - balanceSatang : null),
        subTotalSatang: detailed.subTotal,
        additionalItemsSatang: detailed.additionalItems,
        taxesFeesSatang: detailed.taxesFees,
        thirdPartyIdentifier: str(data.thirdPartyIdentifier),
        source: str(data.source)?.slice(0, 80) ?? null,
        sourceId: str(data.sourceID)?.slice(0, 40) ?? null,
      };
    },

    async recordPayment(input) {
      const json = await call(
        "postPayment",
        "POST",
        toCloudbedsForm({
          propertyID: options.propertyId,
          reservationID: input.reservationId,
          type: input.method,
          amount: satangToBahtString(input.amountSatang),
          description: input.description.slice(0, 250),
          isDeposit: false,
        }),
      );
      // transactionID was removed from the response on 2025-12-01: rely on success + paymentID only.
      return { paymentId: str(json.paymentID) };
    },

    async addFeeItem(input) {
      const json = await call(
        "postCustomItem",
        "POST",
        toCloudbedsForm({
          propertyID: options.propertyId,
          reservationID: input.reservationId,
          referenceID: input.referenceId,
          items: [
            {
              appItemID: input.appItemId,
              itemSKU: input.itemSku,
              itemQuantity: 1,
              itemPrice: satangToBahtString(input.amountSatang),
              itemName: input.name.slice(0, 100),
              itemNote: input.note.slice(0, 250),
            },
          ],
        }),
      );
      // A duplicate referenceID is not an error: Cloudbeds answers with a notice and creates nothing.
      return { duplicate: typeof asRecord(json.data)?.notice === "string" };
    },

    async addNote(reservationId, note) {
      await call(
        "postReservationNote",
        "POST",
        toCloudbedsForm({ propertyID: options.propertyId, reservationID: reservationId, reservationNote: note.slice(0, 2000) }),
      );
    },

    confirm: (reservationId, sendEmail) => putStatus(reservationId, "confirmed", sendEmail),
    cancel: (reservationId) => putStatus(reservationId, "canceled", false),
    markPending: (reservationId) => putStatus(reservationId, "not_confirmed", false),

    bounded(deadlineAt, clock = Date.now) {
      return createCloudbedsWriter({ ...options, deadline: { at: deadlineAt, clock } });
    },

    async findHolds(fromMs, toMs) {
      const out: ListedReservation[] = [];
      for (let page = 1; page <= 5; page++) {
        const json = await call(
          "getReservations",
          "GET",
          toCloudbedsForm({
            propertyID: options.propertyId,
            resultsFrom: bangkokDateTime(fromMs),
            resultsTo: bangkokDateTime(toMs),
            pageSize: 100,
            pageNumber: page,
          }),
        );
        const rows = Array.isArray(json.data) ? json.data : [];
        for (const raw of rows) {
          const r = asRecord(raw);
          const id = str(r?.reservationID);
          if (!r || !isReservationId(id)) continue;
          const dateCreated = str(r.dateCreated);
          out.push({
            reservationId: id,
            status: str(r.status) ?? "unknown",
            dateCreated,
            createdMs: parseCloudbedsDateTime(str(r.dateCreatedUTC)) ?? parseCloudbedsDateTime(dateCreated),
            thirdPartyIdentifier: str(r.thirdPartyIdentifier),
          });
        }
        if (rows.length < 100) break;
      }
      return out;
    },
  };
}

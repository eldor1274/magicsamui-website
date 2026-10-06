// In-repo FAKE of the Cloudbeds v1.3 write endpoints the booking engine uses,
// served as a `fetch` implementation so the real cloudbedsWrite.ts runs
// against it unchanged. Used by the unit tests and by the mock writer
// (stripe-mock, and stripe-test without CLOUDBEDS_API_KEY_BOOKING) - MOCK:
// nothing reaches Cloudbeds.
//
// Like the real API it answers success:false with HTTP 200 for rejected
// requests, and can be told to fail, rate-limit or time out the next call.

import { randomInt } from "node:crypto";
import { addDays, eachNight } from "../dates.ts";

/** A sellable room type in the fake property (read side). */
export interface FakeRoomType {
  /** Nightly rate in baht. */
  rate: number;
  rateId: string;
  /** Units of this type (before holds). */
  units: number;
  minLos?: number;
  closedToArrival?: boolean;
  maxGuests?: number;
}

export interface FakeReservation {
  reservationID: string;
  status: "not_confirmed" | "confirmed" | "canceled";
  startDate: string;
  endDate: string;
  thirdPartyIdentifier: string | null;
  /** Major-unit baht, as Cloudbeds holds it. */
  grandTotal: number;
  rooms: { roomTypeID: string; roomRateID: string | null; adults: number }[];
  payments: { paymentID: string; type: string; amount: number; description: string }[];
  items: { referenceID: string | null; itemPrice: number; itemName: string }[];
  notes: string[];
  dateCreated: string;
  sendEmailConfirmation: string | null;
  /** True for placeholders created by a lenient fake for an id it never saw. */
  placeholder?: boolean;
}

export interface FakeCloudbedsOptions {
  /**
   * Prices a hold (baht). Default: the quoted room subtotal the mock writer
   * passes in the x-msv-mock-expected-total header (satang).
   */
  pricer?: (req: { rooms: FakeReservation["rooms"]; startDate: string; endDate: string; hintSatang: number | null }) => number;
  /** Status new reservations come back with (default "confirmed", like many properties). */
  createdStatus?: "confirmed" | "not_confirmed";
  /**
   * Treat unknown reservation ids as existing not_confirmed placeholders
   * (the app's mock writer on serverless, where a webhook may reach another
   * instance). Tests leave this off.
   */
  lenient?: boolean;
  /** Read side: room types keyed by roomTypeID (getAvailableRoomTypes / getRatePlans). */
  roomTypes?: Record<string, FakeRoomType>;
  /**
   * postReservation never refuses for availability (what Cloudbeds does at
   * roomsAvailable=0 is undocumented - Stage B test 10). Tests use it to prove
   * our own unit lock + re-check stop two of our checkouts double-booking.
   */
  overbook?: boolean;
  now?: () => number;
}

/**
 * - network: the request never reaches the fake (nothing happens).
 * - network_after: the fake PROCESSES the request, then the connection drops
 *   (e.g. postReservation created the reservation but we never saw the answer).
 * - network_late: the connection drops at once, but Cloudbeds commits the
 *   request LATER (when the test calls commitLate()) - e.g. a postPayment that
 *   lands after our timeout, while a retry is already reading the folio.
 * - pass: answered normally (only `effect` runs first, e.g. to move a clock).
 * - no_total: answered normally but without grandTotal (postReservation).
 * `effect` runs first (e.g. an OTA booking takes the unit just before the refusal).
 */
type Forced = {
  method: string;
  kind: "rejected" | "http500" | "rate_limit" | "network" | "network_after" | "network_late" | "pass" | "no_total";
  message?: string;
  effect?: () => void;
};

/** "YYYY-MM-DD HH:MM:SS" of an instant, shifted by `offsetHours`. */
function cbDateTime(ms: number, offsetHours: number): string {
  return new Date(ms + offsetHours * 3600_000).toISOString().slice(0, 19).replace("T", " ");
}

/** A window bound we sent as Bangkok local time -> ms. */
function bangkokToMs(v: string | null): number | null {
  if (!v) return null;
  const ms = Date.parse(`${v.replace(" ", "T")}+07:00`);
  return Number.isFinite(ms) ? ms : null;
}

function form(body: unknown): URLSearchParams {
  return new URLSearchParams(typeof body === "string" ? body : "");
}

function indexed(params: URLSearchParams, name: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const [k, v] of params) {
    const m = new RegExp(`^${name}\\[(\\d+)\\]\\[([A-Za-z]+)\\]$`).exec(k);
    if (!m) continue;
    const i = Number(m[1]);
    out[i] = out[i] ?? {};
    out[i][m[2]] = v;
  }
  return out.filter(Boolean);
}

export function createFakeCloudbeds(options: FakeCloudbedsOptions = {}) {
  const now = options.now ?? Date.now;
  const reservations = new Map<string, FakeReservation>();
  const calls: { method: string; verb: string; params: Record<string, string> }[] = [];
  const forced: Forced[] = [];
  const late: { method: string; headers: Headers; params: URLSearchParams }[] = [];
  /** getReservation answers without any payment figures (balanceDetailed/balance/total). */
  let opaqueFolio = false;
  let nextId = 7_000_000_000_000 + randomInt(1_000_000);
  let nextPayment = 1;

  const reply = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "x-request-id": `fake-${randomInt(1e9)}` } });

  const find = (id: string | null): FakeReservation | null => {
    if (!id) return null;
    const r = reservations.get(id);
    if (r) return r;
    if (!options.lenient) return null;
    const placeholder: FakeReservation = {
      reservationID: id,
      status: "not_confirmed",
      startDate: "",
      endDate: "",
      thirdPartyIdentifier: null,
      grandTotal: 0,
      rooms: [],
      payments: [],
      items: [],
      notes: [],
      dateCreated: new Date(now()).toISOString(),
      sendEmailConfirmation: null,
      placeholder: true,
    };
    reservations.set(id, placeholder);
    return placeholder;
  };

  /** Units of a type still free on every night of the stay (active reservations take one each). */
  const freeUnits = (roomTypeID: string, start: string, end: string): number => {
    const rt = options.roomTypes?.[roomTypeID];
    if (!rt) return 0;
    const nights = new Set(eachNight(start, end));
    const taken = [...reservations.values()].filter(
      (r) => r.status !== "canceled" && !r.placeholder && r.rooms.some((x) => x.roomTypeID === roomTypeID) && eachNight(r.startDate, r.endDate).some((n) => nights.has(n)),
    ).length;
    return Math.max(0, rt.units - taken);
  };

  const paidOf = (r: FakeReservation) => r.payments.reduce((s, p) => s + p.amount, 0);
  const totalOf = (r: FakeReservation) => r.grandTotal + r.items.reduce((s, i) => s + i.itemPrice, 0);
  const round2 = (n: number) => Math.round(n * 100) / 100;

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = url.pathname.split("/").pop() ?? "";
    const verb = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const params = verb === "GET" ? url.searchParams : form(init?.body);
    calls.push({ method, verb, params: Object.fromEntries(params) });

    if (!headers.get("x-api-key")) return reply({ success: false, message: "Unauthorized" }, 401);

    const f = forced.findIndex((x) => x.method === method);
    if (f >= 0) {
      const [hit] = forced.splice(f, 1);
      hit.effect?.();
      if (hit.kind === "network") throw new TypeError("fetch failed (simulated)");
      if (hit.kind === "pass") return respond(method, headers, params);
      if (hit.kind === "no_total") {
        const body = (await (await respond(method, headers, params)).json()) as Record<string, unknown>;
        delete body.grandTotal;
        return reply(body);
      }
      if (hit.kind === "network_late") {
        late.push({ method, headers, params: new URLSearchParams(params) });
        throw new TypeError("fetch failed; the request is still being processed (simulated)");
      }
      if (hit.kind === "network_after") {
        await respond(method, headers, params);
        throw new TypeError("fetch failed after the request was processed (simulated)");
      }
      if (hit.kind === "rate_limit") return reply({ success: false, message: "Too many requests" }, 429);
      if (hit.kind === "http500") return reply({ success: false, message: "Internal error" }, 500);
      return reply({ success: false, message: hit.message ?? "Rejected (simulated)" }, 200);
    }
    return respond(method, headers, params);
  }

  async function respond(method: string, headers: Headers, params: URLSearchParams): Promise<Response> {
    switch (method) {
      case "postReservation": {
        const rooms = indexed(params, "rooms");
        const adults = indexed(params, "adults");
        if (!params.get("startDate") || !params.get("endDate") || rooms.length === 0) {
          return reply({ success: false, message: "Missing required fields" });
        }
        for (const field of ["guestFirstName", "guestLastName", "guestEmail", "guestCountry", "guestZip"]) {
          if (!params.get(field)) return reply({ success: false, message: `Parameter ${field} is required` });
        }
        const resRooms = rooms.map((r) => ({
          roomTypeID: r.roomTypeID,
          roomRateID: r.roomRateID ?? null,
          adults: Number(adults.find((a) => a.roomTypeID === r.roomTypeID)?.quantity ?? 1),
        }));
        const start = params.get("startDate")!;
        const end = params.get("endDate")!;
        if (options.roomTypes && !options.overbook && resRooms.some((r) => freeUnits(r.roomTypeID, start, end) < 1)) {
          return reply({ success: false, message: "Room type is not available for the selected dates" });
        }
        const hintRaw = headers.get("x-msv-mock-expected-total");
        const hint = hintRaw === null ? NaN : Number(hintRaw);
        const nightsCount = eachNight(start, end).length;
        const grandTotal = options.pricer
          ? options.pricer({ rooms: resRooms, startDate: start, endDate: end, hintSatang: Number.isFinite(hint) ? hint : null })
          : options.roomTypes
            ? resRooms.reduce((sum, r) => sum + (options.roomTypes?.[r.roomTypeID]?.rate ?? 0) * nightsCount, 0)
            : Number.isFinite(hint)
              ? hint / 100
              : 0;
        const id = String(nextId++);
        const r: FakeReservation = {
          reservationID: id,
          status: options.createdStatus ?? "confirmed",
          startDate: params.get("startDate")!,
          endDate: params.get("endDate")!,
          thirdPartyIdentifier: params.get("thirdPartyIdentifier"),
          grandTotal: round2(grandTotal),
          rooms: resRooms,
          payments: [],
          items: [],
          notes: [],
          dateCreated: new Date(now()).toISOString(),
          sendEmailConfirmation: params.get("sendEmailConfirmation"),
        };
        reservations.set(id, r);
        return reply({
          success: true,
          reservationID: id,
          status: r.status,
          guestID: "1",
          startDate: r.startDate,
          endDate: r.endDate,
          dateCreated: cbDateTime(Date.parse(r.dateCreated), 7),
          grandTotal: r.grandTotal,
          unassigned: [],
        });
      }
      case "getReservation": {
        const r = find(params.get("reservationID"));
        if (!r) return reply({ success: false, message: "Reservation not found" });
        const total = round2(totalOf(r));
        const paid = round2(paidOf(r));
        if (opaqueFolio) {
          return reply({ success: true, data: { reservationID: r.reservationID, status: r.status, thirdPartyIdentifier: r.thirdPartyIdentifier } });
        }
        return reply({
          success: true,
          data: {
            reservationID: r.reservationID,
            status: r.status,
            thirdPartyIdentifier: r.thirdPartyIdentifier,
            total,
            balance: round2(total - paid),
            balanceDetailed: { suggestedDeposit: "0.00", subTotal: r.grandTotal, grandTotal: total, paid },
          },
        });
      }
      case "postPayment": {
        const r = find(params.get("reservationID"));
        if (!r) return reply({ success: false, message: "Reservation not found" });
        const amount = Number(params.get("amount"));
        if (!Number.isFinite(amount) || amount <= 0) return reply({ success: false, message: "Invalid amount" });
        if (!params.get("type")) return reply({ success: false, message: "Payment type is required" });
        const paymentID = `pay-${nextPayment++}`;
        r.payments.push({ paymentID, type: params.get("type")!, amount, description: params.get("description") ?? "" });
        return reply({ success: true, paymentID });
      }
      case "postCustomItem": {
        const r = find(params.get("reservationID"));
        if (!r) return reply({ success: false, message: "Reservation not found" });
        const ref = params.get("referenceID");
        if (ref && r.items.some((i) => i.referenceID === ref)) {
          return reply({ success: true, data: { notice: "Duplicate referenceID - nothing was added" } });
        }
        const [item] = indexed(params, "items");
        if (!item?.appItemID || !item.itemName || !(Number(item.itemPrice) >= 0)) return reply({ success: false, message: "Invalid item" });
        r.items.push({ referenceID: ref, itemPrice: Number(item.itemPrice) * Number(item.itemQuantity ?? 1), itemName: item.itemName });
        return reply({ success: true, data: { soldProductID: `sp-${r.items.length}`, transactionID: `tx-${r.items.length}` } });
      }
      case "postReservationNote": {
        const r = find(params.get("reservationID"));
        if (!r) return reply({ success: false, message: "Reservation not found" });
        r.notes.push(params.get("reservationNote") ?? "");
        return reply({ success: true, reservationNoteID: String(r.notes.length) });
      }
      case "putReservation": {
        const r = find(params.get("reservationID"));
        if (!r) return reply({ success: false, message: "Reservation not found" });
        const status = params.get("status");
        if (status !== "confirmed" && status !== "canceled" && status !== "not_confirmed") return reply({ success: false, message: "Invalid status" });
        if (r.status === "canceled" && status !== "canceled") return reply({ success: false, message: "Reservation is canceled" });
        r.status = status;
        return reply({ success: true });
      }
      case "getAvailableRoomTypes": {
        const start = params.get("startDate") ?? "";
        const end = params.get("endDate") ?? "";
        const nights = eachNight(start, end);
        const rooms = Object.entries(options.roomTypes ?? {})
          .filter(([id]) => freeUnits(id, start, end) > 0)
          .map(([id, rt]) => ({
            roomTypeID: id,
            roomRateID: rt.rateId,
            roomsAvailable: freeUnits(id, start, end),
            roomRate: rt.rate * nights.length,
            roomRateDetailed: nights.map((date) => ({ date, rate: rt.rate })),
            adultsIncluded: 2,
            adultsExtraCharge: [],
            maxGuests: rt.maxGuests ?? 10,
            derivedType: null,
            ratePlanNamePublic: null,
          }));
        return reply({ success: true, data: [{ propertyID: "235064", propertyCurrency: [{ currencyCode: "THB" }], propertyRooms: rooms }] });
      }
      case "getRatePlans": {
        const start = params.get("startDate") ?? "";
        const end = params.get("endDate") ?? "";
        const id = params.get("roomTypeID") ?? "";
        const rt = options.roomTypes?.[id];
        if (!rt) return reply({ success: true, data: [] });
        // Like the real API as we read it: one row per date in [startDate, endDate) - the caller asks one day past check-out.
        const days = eachNight(start, end).map((date, i) => ({
          date,
          rateBase: rt.rate,
          totalRate: rt.rate,
          roomsAvailable: freeUnits(id, date, addDays(date, 1)),
          closedToArrival: i === 0 ? rt.closedToArrival === true : false,
          closedToDeparture: false,
          blocked: false,
          minLos: rt.minLos ?? 0,
          maxLos: 0,
        }));
        return reply({ success: true, data: [{ rateID: rt.rateId, roomTypeID: id, isDerived: false, roomRateDetailed: days }] });
      }
      case "getReservations": {
        // Like the real API as we read it: the window is property-local (Bangkok) creation time.
        const status = params.get("status");
        const from = bangkokToMs(params.get("resultsFrom"));
        const to = bangkokToMs(params.get("resultsTo"));
        const rows = [...reservations.values()]
          .filter((r) => !r.placeholder && (!status || r.status === status))
          .filter((r) => {
            const created = Date.parse(r.dateCreated);
            return (from === null || created >= from) && (to === null || created <= to);
          })
          .map((r) => ({
            reservationID: r.reservationID,
            status: r.status,
            // Like the v1.3 getReservations schema: property-local dateCreated only (no dateCreatedUTC).
            dateCreated: cbDateTime(Date.parse(r.dateCreated), 7),
            thirdPartyIdentifier: r.thirdPartyIdentifier,
          }));
        return reply({ success: true, data: rows, count: rows.length, total: rows.length });
      }
      default:
        return reply({ success: false, message: `Unknown method ${method}` }, 404);
    }
  }

  return {
    fetch: handle as typeof fetch,
    reservations,
    calls,
    /** Number of calls made to one method. */
    count(method: string): number {
      return calls.filter((c) => c.method === method).length;
    },
    /** Makes the next call to `method` fail the given way (`effect` runs just before). */
    failNext(method: string, kind: Forced["kind"], message?: string, effect?: () => void) {
      forced.push({ method, kind, message, effect });
    },
    /** getReservation leaves out every payment figure (an answer whose "paid" can't be read). */
    setOpaqueFolio(on: boolean) {
      opaqueFolio = on;
    },
    /** Commits the requests that failed with "network_late" (Cloudbeds finishing them after our timeout). */
    async commitLate(): Promise<number> {
      const pending = late.splice(0, late.length);
      for (const r of pending) await respond(r.method, r.headers, r.params);
      return pending.length;
    },
    /** A reservation made elsewhere (an OTA, the front desk) that takes one unit of a room type. */
    book(roomTypeID: string, startDate: string, endDate: string, thirdPartyIdentifier: string | null = "BDC-0000"): string {
      const id = String(nextId++);
      reservations.set(id, {
        reservationID: id,
        status: "confirmed",
        startDate,
        endDate,
        thirdPartyIdentifier,
        grandTotal: 0,
        rooms: [{ roomTypeID, roomRateID: null, adults: 2 }],
        payments: [],
        items: [],
        notes: [],
        dateCreated: new Date(now()).toISOString(),
        sendEmailConfirmation: null,
      });
      return id;
    },
    /** Folio balance in baht (total incl. custom items - payments). */
    balance(id: string): number {
      const r = reservations.get(id);
      return r ? round2(totalOf(r) - paidOf(r)) : NaN;
    },
  };
}

export type FakeCloudbeds = ReturnType<typeof createFakeCloudbeds>;

/**
 * stripe-mock ONLY (runtime.ts mockWorld): BOOKING_MOCK_HOLD_PRICE_DELTA_BAHT makes the fake Cloudbeds
 * price every hold that many baht above (or below) the quoted room subtotal, so the "price changed
 * between quote and hold" path (cancel the hold, price_changed, nothing charged) can be clicked
 * through locally. Unset, empty or not a number = price holds exactly as quoted.
 */
export function mockHoldPricer(env: Record<string, string | undefined>): NonNullable<FakeCloudbedsOptions["pricer"]> {
  return ({ hintSatang }) => {
    const raw = (env.BOOKING_MOCK_HOLD_PRICE_DELTA_BAHT ?? "").trim();
    const delta = raw === "" ? 0 : Number(raw);
    return (hintSatang ?? 0) / 100 + (Number.isFinite(delta) ? delta : 0);
  };
}

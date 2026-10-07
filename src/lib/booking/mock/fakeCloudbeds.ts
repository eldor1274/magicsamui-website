// In-repo FAKE of the Cloudbeds v1.3 write endpoints the booking engine uses,
// served as a `fetch` implementation so the real cloudbedsWrite.ts runs
// against it unchanged. Used by the unit tests and by the mock writer
// (stripe-mock, and stripe-test without CLOUDBEDS_API_KEY_BOOKING) - MOCK:
// nothing reaches Cloudbeds.
//
// Like the real API it answers success:false with HTTP 200 for rejected
// requests, and can be told to fail, rate-limit or time out the next call.

import { randomInt } from "node:crypto";
import { addDays, eachNight, nightsBetween, todayInBangkok } from "../dates.ts";

/** A sellable room type in the fake property (read side). */
export interface FakeRoomType {
  /** Nightly rate in baht. */
  rate: number;
  rateId: string;
  /** Units of this type (before holds). */
  units: number;
  minLos?: number;
  /** The base plan's maxLos (getRatePlans; default 0 = no limit). */
  maxLos?: number;
  closedToArrival?: boolean;
  maxGuests?: number;
  /** roomRateID of the derived "Breakfast" row (default `${rateId}-breakfast`). */
  breakfastRateId?: string;
  /**
   * roomRateID of this room type's derived "Direct booking rate" (promo code FAKE_DIRECT_PROMO_CODE,
   * DIRECT_PCT_OF_BASE of the base rate, its own id per room type as live). Absent = no Direct plan.
   */
  directRateId?: string;
  /** The Direct plan's own minLos / closed to arrival (getRatePlans); default 0 / false. */
  directMinLos?: number;
  directClosedToArrival?: boolean;
  /**
   * Further derived plans of this room type (public discount plans like "Last minute 10% off" and "Long term
   * booking", "Non-refundable 10% discount", promo-code plans...): listed by getRatePlans, offered by
   * getAvailableRoomTypes when their own rule says so, and priced by their roomRateID at postReservation.
   * See fakeLastMinutePlan / fakeLongTermPlan / fakeNonRefundablePlan.
   */
  plans?: FakePlan[];
}

/** A derived plan of a fake room type: a percentage of its base rate. */
export interface FakePlan {
  rateId: string;
  /** ratePlanNamePublic, e.g. "Long term booking". */
  name: string;
  /** Price per night as a % of the base rate (94 = 6% off). */
  pctOfBase: number;
  /** getRatePlans promoCode (default none). A plan with a code is offered only when asked with it, unless inPlainAnswer. */
  promoCode?: string | null;
  /** getRatePlans day rows (default 0 = no limit). */
  minLos?: number;
  maxLos?: number;
  /** getAvailableRoomTypes offers the plan only for stays of at least this many nights (Long term). */
  offeredFromNights?: number;
  /** getAvailableRoomTypes offers the plan only when the arrival is at most this many days after the fake's today (Last minute). */
  offeredWithinDays?: number;
  /** Listed in the answer asked WITHOUT a promo code although it carries one (a misbehaving answer; default: only plans without a code). */
  inPlainAnswer?: boolean;
  /** getRatePlans parentRateID (default the room type's base rate). */
  parentRateId?: string | null;
  /** getRatePlans isDerived (default true). */
  isDerived?: boolean;
}

/** The live "Last minute 10% off" plan: derived, 10% off, offered by Cloudbeds only within its last-minute window before arrival. */
export function fakeLastMinutePlan(rateId: string, withinDays = 7): FakePlan {
  return { rateId, name: "Last minute 10% off", pctOfBase: 90, offeredWithinDays: withinDays };
}

/** The live "Long term booking" plan: derived, 6% off, minLos 7 / maxLos 60, offered for stays of 7+ nights. */
export function fakeLongTermPlan(rateId: string): FakePlan {
  return { rateId, name: "Long term booking", pctOfBase: 94, minLos: 7, maxLos: 60, offeredFromNights: 7 };
}

/** The live "Non-refundable 10% discount" plan: derived, 10% off, always offered (never sold automatically: other refund terms). */
export function fakeNonRefundablePlan(rateId: string): FakePlan {
  return { rateId, name: "Non-refundable 10% discount", pctOfBase: 90 };
}

/** The promo code of the owner's "Long term" plan (owner decision, 2026-10-07: behind a code, never shown automatically). */
export const FAKE_LONGSTAY_PROMO_CODE = "LONGSTAY";

/**
 * The owner's "Long term" plan behind a promo code (owner decision, 2026-10-07): derived, 26% off, minLos 7 / maxLos 60,
 * offered by getAvailableRoomTypes only when asked with its code and (like the public Long term plan) for 7+ nights.
 */
export function fakeLongStayCodePlan(rateId: string, promoCode: string = FAKE_LONGSTAY_PROMO_CODE): FakePlan {
  return { rateId, name: "Long term", pctOfBase: 74, promoCode, minLos: 7, maxLos: 60, offeredFromNights: 7 };
}

/** A plan's rate per night in baht (to the satang). */
export function fakePlanRate(rt: FakeRoomType, plan: FakePlan): number {
  return Math.round(rt.rate * plan.pctOfBase) / 100;
}

/** The live answer when a derived rate is not enabled for the reservation's source (2026-10-07, the Direct rate). */
export function rateNotForSourceMessage(rateId: string): string {
  return `Rate ${rateId} is not available for this reservation. Verify the rate is bookable for these dates and for the reservation source.`;
}

/** The live Breakfast plan: derived, fixed +2,000 THB per night on the base rate (2026-10-06). */
export const BREAKFAST_FIXED_BAHT = 2000;
/** The live "Direct booking rate": promo code "Direct", 20% off the base rate, not synced to OTAs (2026-10-06). */
export const FAKE_DIRECT_PROMO_CODE = "Direct";
export const DIRECT_PCT_OF_BASE = 80;

function breakfastRateId(rt: FakeRoomType): string {
  return rt.breakfastRateId ?? `${rt.rateId}-breakfast`;
}

/** The Direct rate per night in baht (to the satang). */
export function fakeDirectRate(rt: FakeRoomType): number {
  return Math.round(rt.rate * DIRECT_PCT_OF_BASE) / 100;
}

export interface FakeReservation {
  reservationID: string;
  status: "not_confirmed" | "confirmed" | "canceled";
  startDate: string;
  endDate: string;
  thirdPartyIdentifier: string | null;
  /** The rooms (balanceDetailed.subTotal), major-unit baht as Cloudbeds holds it. */
  subTotal: number;
  /** Taxes/fees Cloudbeds applied for the reservation's source (balanceDetailed.taxesFees), baht. */
  taxesFees: number;
  /** The sourceID sent with postReservation; null = Cloudbeds' default source. */
  sourceID: string | null;
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
   * instance), and take any postPayment type. Tests leave this off.
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
  /**
   * Exclusive % fees per reservation SOURCE, keyed by the sourceID sent ("default" when none), like a
   * property whose "Website / Booking engine" source carries the classic engine's 5% Card Charging Fee.
   * The fee is that % of each night's rate, rounded half-up to the satang, summed.
   */
  sourceFeePct?: Record<string, number>;
  /** postReservation's grandTotal leaves the source fee out; only the folio (getReservation) shows it. */
  feeOnlyOnFolio?: boolean;
  /** getPaymentMethods (the active methods); default FAKE_PAYMENT_METHODS. */
  paymentMethods?: FakePaymentMethod[];
  /** getRatePlans rows leave roomTypeID out when the request filters by it (the v1.3 spec: "if not specified in request"). */
  ratePlansWithoutRoomTypeId?: boolean;
  /**
   * postReservation prices a Direct roomRateID at the BASE rate: what the Cloudbeds Reservation FAQ says
   * (postReservation ignores rate plans and promos) - unconfirmed until Stage B; the engine must refuse it.
   */
  directPricedAtBase?: boolean;
  /**
   * getAvailableRoomTypes asked with the promo code also returns the base and Breakfast rows. Default false,
   * as live (Stage B 2026-10-07): with the code Cloudbeds returns only the promo plan's rows, so the engine
   * must ask once without the code for the base rows (cloudbedsInventory).
   */
  promoAnswerKeepsBase?: boolean;
  /**
   * getAvailableRoomTypes asked with a promo code that no plan offers for this stay (e.g. below the plan's
   * offeredFromNights) refuses it with success:false "Invalid promo code" instead of success:true with no rows.
   * Which of the two Cloudbeds answers is unconfirmed (Stage B case 28 (c)); the engine must take both.
   */
  promoRefusedWhenNotOffered?: boolean;
  /** postReservation prices the room types' further plans (FakeRoomType.plans) at the BASE rate: Cloudbeds ignoring their roomRateID. */
  plansPricedAtBase?: boolean;
  /**
   * roomRateIDs whose plan is not enabled for the reservation's source: postReservation refuses a room on one with
   * success:false and the live message (rateNotForSourceMessage), as for the Direct rate on 2026-10-07.
   */
  ratesNotForSource?: string[];
  now?: () => number;
}

export interface FakePaymentMethod {
  method: string;
  code: string;
  name: string;
}

/**
 * The live property's methods as getPaymentMethods listed them on 2026-10-06 (built-ins and the
 * property's additional methods), its custom "Stripe (website)" method, and the test method the
 * test kit uses for CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD.
 */
export const FAKE_PAYMENT_METHODS: FakePaymentMethod[] = [
  { method: "credit", code: "cards", name: "Credit Card" },
  { method: "bank_transfer", code: "ebanking", name: "Bank Transfer" },
  { method: "pay_pal", code: "pay_pal", name: "PayPal" },
  { method: "cash", code: "cash", name: "Cash" },
  { method: "check", code: "check_true", name: "Check" },
  { method: "debit", code: "check", name: "Debit Card" },
  { method: "bill", code: "bill", name: "Bill" },
  { method: "Voucher", code: "Voucher", name: "Voucher" },
  { method: "RoomChange", code: "RoomChange", name: "Room Change" },
  { method: "Permuta", code: "Permuta", name: "Exchange" },
  { method: "Paidatanotherlocation", code: "Paidatanotherlocation", name: "Paid at another location." },
  { method: "Prepago", code: "Prepago", name: "Prepaid" },
  { method: "1", code: "1", name: "With Cash On Arrival" },
  { method: "thirdparty", code: "Terceiros", name: "Third-party payment" },
  { method: "airbnb", code: "airbnb", name: "Airbnb" },
  { method: "OnsiteTerminal", code: "OnsiteTerminal", name: "Onsite Terminal" },
  { method: "Stripe(website)", code: "Stripe(website)", name: "Stripe (website)" },
  { method: "Stripe_TEST", code: "Stripe_TEST", name: "Stripe TEST" },
];

/**
 * - network: the request never reaches the fake (nothing happens).
 * - network_after: the fake PROCESSES the request, then the connection drops
 *   (e.g. postReservation created the reservation but we never saw the answer).
 * - network_late: the connection drops at once, but Cloudbeds commits the
 *   request LATER (when the test calls commitLate()) - e.g. a postPayment that
 *   lands after our timeout, while a retry is already reading the folio.
 * - pass: answered normally (only `effect` runs first, e.g. to move a clock).
 * - no_total: answered normally but without grandTotal (postReservation).
 * - http403: refused with HTTP 403 (e.g. the key lacks the scope for this call).
 * `effect` runs first (e.g. an OTA booking takes the unit just before the refusal).
 */
type Forced = {
  method: string;
  kind: "rejected" | "http500" | "http403" | "rate_limit" | "network" | "network_after" | "network_late" | "pass" | "no_total";
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
  const paymentMethods = options.paymentMethods ?? FAKE_PAYMENT_METHODS;
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
      subTotal: 0,
      taxesFees: 0,
      sourceID: null,
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
  const itemsOf = (r: FakeReservation) => r.items.reduce((s, i) => s + i.itemPrice, 0);
  /** balanceDetailed.grandTotal: rooms + additional items (our fee line) + Cloudbeds' taxes/fees. */
  const totalOf = (r: FakeReservation) => r.subTotal + itemsOf(r) + r.taxesFees;
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
      if (hit.kind === "http403") return reply({ success: false, message: "Forbidden" }, 403);
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
        // A derived rate whose plan is not enabled for the reservation's source (live: checked before availability is told).
        const notForSource = resRooms.find((r) => r.roomRateID !== null && options.ratesNotForSource?.includes(r.roomRateID));
        if (notForSource?.roomRateID) return reply({ success: false, message: rateNotForSourceMessage(notForSource.roomRateID) });
        // ASSUMPTION (live 2026-10-07: a promo plan's hold needs its roomRateID AND promoCode): a room on a further plan
        // that carries a promo code is refused unless the reservation's promoCode is that code exactly as Cloudbeds spells it.
        const codeMissing = resRooms.find((r) => {
          const plan = options.roomTypes?.[r.roomTypeID]?.plans?.find((p) => p.rateId === r.roomRateID);
          return plan?.promoCode ? params.get("promoCode") !== plan.promoCode : false;
        });
        if (codeMissing) return reply({ success: false, message: `Rate ${codeMissing.roomRateID} requires its promo code` });
        if (options.roomTypes && !options.overbook && resRooms.some((r) => freeUnits(r.roomTypeID, start, end) < 1)) {
          return reply({ success: false, message: "Room type is not available for the selected dates" });
        }
        const hintRaw = headers.get("x-msv-mock-expected-total");
        const hint = hintRaw === null ? NaN : Number(hintRaw);
        const nights = eachNight(start, end);
        const ratesKnown = !options.pricer && options.roomTypes !== undefined;
        // Priced by roomRateID, like a Cloudbeds that honours the rate sent: the Direct rate (unless
        // directPricedAtBase), a further plan (unless plansPricedAtBase), the Breakfast package, else the base rate.
        const rateFor = (r: FakeReservation["rooms"][number]): number => {
          const rt = options.roomTypes?.[r.roomTypeID];
          if (!rt) return 0;
          if (rt.directRateId && r.roomRateID === rt.directRateId) return options.directPricedAtBase ? rt.rate : fakeDirectRate(rt);
          const plan = rt.plans?.find((p) => p.rateId === r.roomRateID);
          if (plan) return options.plansPricedAtBase ? rt.rate : fakePlanRate(rt, plan);
          if (r.roomRateID === breakfastRateId(rt) && r.roomRateID !== rt.rateId) return rt.rate + BREAKFAST_FIXED_BAHT;
          return rt.rate;
        };
        const roomsTotal = options.pricer
          ? options.pricer({ rooms: resRooms, startDate: start, endDate: end, hintSatang: Number.isFinite(hint) ? hint : null })
          : ratesKnown
            ? resRooms.reduce((sum, r) => sum + rateFor(r) * nights.length, 0)
            : Number.isFinite(hint)
              ? hint / 100
              : 0;
        // Each room's price per night (satang): the property's rates, else the priced total spread evenly.
        const totalSatang = Math.round(roomsTotal * 100);
        const cells = Math.max(1, resRooms.length * nights.length);
        const nightly = resRooms.map((r, i) =>
          nights.map((_, n) => (ratesKnown ? Math.round(rateFor(r) * 100) : Math.floor(totalSatang / cells) + (i === 0 && n === 0 ? totalSatang % cells : 0))),
        );
        // Taxes/fees come with the SOURCE: a % of each night's rate, half-up to the satang (basis points keep it exact).
        const sourceID = params.get("sourceID");
        const feeBp = Math.round((options.sourceFeePct?.[sourceID ?? "default"] ?? 0) * 100);
        const feeSatang = nightly.flat().reduce((s, v) => s + Math.round((v * feeBp) / 10_000), 0);
        const id = String(nextId++);
        const r: FakeReservation = {
          reservationID: id,
          status: options.createdStatus ?? "confirmed",
          startDate: params.get("startDate")!,
          endDate: params.get("endDate")!,
          thirdPartyIdentifier: params.get("thirdPartyIdentifier"),
          subTotal: round2(roomsTotal),
          taxesFees: feeSatang / 100,
          sourceID,
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
          grandTotal: options.feeOnlyOnFolio ? r.subTotal : round2(r.subTotal + r.taxesFees),
          unassigned: resRooms.map((x, i) => ({ roomTypeID: x.roomTypeID, roomTotal: round2(nightly[i].reduce((s, v) => s + v, 0) / 100) })),
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
            // The default source's real id is unknown; "s-1" stands in for it.
            source: r.sourceID === null ? "Website / Booking engine" : `Own booking page (${r.sourceID})`,
            sourceID: r.sourceID ?? "s-1",
            total,
            balance: round2(total - paid),
            balanceDetailed: {
              suggestedDeposit: "0.00",
              subTotal: r.subTotal,
              additionalItems: round2(itemsOf(r)),
              taxesFees: r.taxesFees,
              grandTotal: total,
              paid,
            },
          },
        });
      }
      case "getPaymentMethods":
        return reply({ success: true, data: { methods: paymentMethods.map((m) => ({ ...m })) } });
      case "postPayment": {
        const r = find(params.get("reservationID"));
        if (!r) return reply({ success: false, message: "Reservation not found" });
        const amount = Number(params.get("amount"));
        if (!Number.isFinite(amount) || amount <= 0) return reply({ success: false, message: "Invalid amount" });
        const type = params.get("type");
        if (!type) return reply({ success: false, message: "Payment type is required" });
        // ASSUMPTION (undocumented; Stage B case 1 is the real proof): Cloudbeds records a payment only under
        // the exact `method` value of an ACTIVE method (case-sensitive) and refuses anything else with
        // success:false. The lenient fake (the app's mock writer, which can't know the property's methods) takes any type.
        if (!options.lenient && !paymentMethods.some((m) => m.method === type)) return reply({ success: false, message: "Invalid payment type" });
        const paymentID = `pay-${nextPayment++}`;
        r.payments.push({ paymentID, type, amount, description: params.get("description") ?? "" });
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
        // Like the live answer (2026-10-06): per room type the base (BAR) row, named "default", and a derived
        // "Breakfast" row (+2,000 THB per night, its own roomRateID); propertyCurrency is a single object.
        // Asked with a promo code, ONLY that code's rows come back (live, Stage B 2026-10-07): a room type with a Direct
        // plan gets its derived Direct row for the Direct code, a plan with another code its row for that code (no promo
        // code or plan id on the row, as live: only its roomRateID tells it apart).
        const askedCode = (params.get("promoCode") ?? "").trim().toLowerCase();
        const promoAsked = askedCode === FAKE_DIRECT_PROMO_CODE.toLowerCase();
        // Further plans, like live: a public plan when its own rule offers it for this stay (Long term: 7+ nights;
        // Last minute: an arrival inside its window before the fake's today), a promo-code plan only with its code.
        const today = todayInBangkok(new Date(now()));
        const planOffered = (plan: FakePlan, withCode: boolean): boolean => {
          const code = (plan.promoCode ?? "").trim().toLowerCase();
          if (withCode ? code !== askedCode : code !== "" && plan.inPlainAnswer !== true) return false;
          if (plan.offeredFromNights !== undefined && nights.length < plan.offeredFromNights) return false;
          if (plan.offeredWithinDays !== undefined && nightsBetween(today, start) > plan.offeredWithinDays) return false;
          return true;
        };
        if (askedCode !== "" && options.promoRefusedWhenNotOffered) {
          const offered = Object.values(options.roomTypes ?? {}).some(
            (rt) => (promoAsked && rt.directRateId !== undefined) || (rt.plans ?? []).some((p) => planOffered(p, true)),
          );
          if (!offered) return reply({ success: false, message: "Invalid promo code" });
        }
        const rooms = Object.entries(options.roomTypes ?? {})
          .filter(([id]) => freeUnits(id, start, end) > 0)
          .flatMap(([id, rt]) => {
            const row = (roomRateID: string, rate: number, ratePlanNamePublic: string, derivedType: string | null) => ({
              roomTypeID: id,
              roomRateID,
              roomsAvailable: freeUnits(id, start, end),
              roomRate: rate * nights.length,
              roomRateDetailed: nights.map((date) => ({ date, rate })),
              adultsIncluded: 2,
              adultsExtraCharge: [],
              maxGuests: rt.maxGuests ?? 10,
              derivedType,
              ratePlanNamePublic,
            });
            const direct = promoAsked && rt.directRateId ? [row(rt.directRateId, fakeDirectRate(rt), "Direct booking rate", "percentage")] : [];
            const plans = (rt.plans ?? []).filter((p) => planOffered(p, askedCode !== "")).map((p) => row(p.rateId, fakePlanRate(rt, p), p.name, "percentage"));
            if (askedCode !== "" && options.promoAnswerKeepsBase !== true) return [...direct, ...plans];
            return [row(rt.rateId, rt.rate, "default", null), row(breakfastRateId(rt), rt.rate + BREAKFAST_FIXED_BAHT, "Breakfast", "fixed"), ...direct, ...plans];
          });
        return reply({
          success: true,
          data: [{ propertyID: "235064", propertyCurrency: { currencyCode: "THB", currencySymbol: "฿", currencyPosition: "before" }, propertyRooms: rooms }],
        });
      }
      case "getRatePlans": {
        const start = params.get("startDate") ?? "";
        const end = params.get("endDate") ?? "";
        const filter = params.get("roomTypeID");
        // Filtered by one room type (the restriction check), or every room type (the rate-plan index: Direct and automatic discounts).
        const ids = filter === null ? Object.keys(options.roomTypes ?? {}) : options.roomTypes?.[filter] ? [filter] : [];
        const rowsFor = (id: string, rt: FakeRoomType) => {
          // Like the real API as we read it: one row per date in [startDate, endDate) - the caller asks one day past check-out.
          const days = (rate: number, minLos: number, closedToArrival: boolean, maxLos = 0, extra: Record<string, unknown> = {}) =>
            eachNight(start, end).map((date, i) => ({
              date,
              rateBase: rate,
              totalRate: rate,
              roomsAvailable: freeUnits(id, date, addDays(date, 1)),
              closedToArrival: i === 0 ? closedToArrival : false,
              closedToDeparture: false,
              blocked: false,
              minLos,
              maxLos,
              ...extra,
            }));
          // The spec sends roomTypeID only "if not specified in request".
          const typeOf = options.ratePlansWithoutRoomTypeId && filter !== null ? {} : { roomTypeID: id };
          const baseDays = days(rt.rate, rt.minLos ?? 0, rt.closedToArrival === true, rt.maxLos ?? 0);
          // Further plans: listed whatever their window or minimum stay (live: Long term minLos 7 came back for 3 nights).
          const planRows = (rt.plans ?? []).map((p, i) => ({
            rateID: p.rateId,
            ...typeOf,
            isDerived: p.isDerived ?? true,
            ratePlanID: `fake-plan-${i}`,
            ratePlanNamePublic: p.name,
            promoCode: p.promoCode ?? null,
            derivedType: "percentage",
            derivedValue: p.pctOfBase - 100,
            parentRateID: p.parentRateId === undefined ? rt.rateId : p.parentRateId,
            roomRateDetailed: days(fakePlanRate(rt, p), p.minLos ?? 0, false, p.maxLos ?? 0, {
              cutOff: 0,
              lastMinuteBooking: p.offeredWithinDays ?? 0,
            }),
          }));
          // The derived rows first, so the restriction check must pick its row by rateID, not by order. The base row has
          // no plan name here (live: null), unlike in getAvailableRoomTypes. Only the Direct row (and a promo-code plan) carries a promo code.
          return [
            { rateID: breakfastRateId(rt), ...typeOf, isDerived: true, ratePlanID: "fake-plan-breakfast", ratePlanNamePublic: "Breakfast", promoCode: null, parentRateID: rt.rateId, roomRateDetailed: days(rt.rate + BREAKFAST_FIXED_BAHT, rt.minLos ?? 0, rt.closedToArrival === true) },
            ...(rt.directRateId
              ? [
                  {
                    rateID: rt.directRateId,
                    ...typeOf,
                    isDerived: true,
                    ratePlanID: "fake-plan-direct",
                    ratePlanNamePublic: "Direct booking rate",
                    promoCode: FAKE_DIRECT_PROMO_CODE,
                    derivedType: "percentage",
                    derivedValue: DIRECT_PCT_OF_BASE - 100,
                    parentRateID: rt.rateId,
                    roomRateDetailed: days(fakeDirectRate(rt), rt.directMinLos ?? 0, rt.directClosedToArrival === true),
                  },
                ]
              : []),
            ...planRows,
            { rateID: rt.rateId, ...typeOf, isDerived: false, ratePlanID: null, ratePlanNamePublic: null, promoCode: null, parentRateID: null, roomRateDetailed: baseDays },
          ];
        };
        return reply({ success: true, data: ids.flatMap((id) => rowsFor(id, (options.roomTypes ?? {})[id])) });
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
        subTotal: 0,
        taxesFees: 0,
        sourceID: null,
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

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CloudbedsBudgetError,
  CloudbedsError,
  cloudbedsInventory,
  createTokenBucket,
  evaluateRestrictions,
  isBasePlanName,
  parseAdultsExtraCharge,
  parseAvailableRoomTypes,
} from "./cloudbedsProvider.ts";

const RESPONSE = {
  success: true,
  data: [
    {
      propertyID: "235064",
      propertyCurrency: [{ currencyCode: "THB", currencySymbol: "฿" }],
      propertyRooms: [
        {
          roomTypeID: "462960",
          roomsAvailable: 1,
          roomRate: 18750,
          roomRateDetailed: [
            { date: "2026-10-28", rate: 6250 },
            { date: "2026-10-29", rate: 6250 },
            { date: "2026-10-30", rate: 6250.5 },
          ],
        },
        {
          roomTypeID: "501423",
          roomsAvailable: 0,
          roomRateDetailed: [
            { date: "2026-10-28", rate: 1 },
            { date: "2026-10-29", rate: 1 },
            { date: "2026-10-30", rate: 1 },
          ],
        },
        { roomTypeID: "999999", roomsAvailable: 1, roomRateDetailed: [] },
        { roomTypeID: "462961", roomsAvailable: 1, roomRateDetailed: [{ date: "2026-10-28", rate: 3000 }] },
      ],
    },
  ],
};

test("parses getAvailableRoomTypes into satang nightly inventory", () => {
  const inv = parseAvailableRoomTypes(RESPONSE, "2026-10-28", "2026-10-31");
  assert.equal(inv.length, 11);
  const sunrise = inv.find((r) => r.slug === "sunrise-suite");
  assert.equal(sunrise?.available, true);
  assert.deepEqual(
    sunrise?.baseNightly.map((n) => n.amountSatang),
    [625_000, 625_000, 625_050],
  );
  // roomsAvailable 0, missing nights, unknown and absent room types -> unavailable
  assert.equal(inv.find((r) => r.slug === "island-view-3br")?.available, false);
  assert.equal(inv.find((r) => r.slug === "garden-suite")?.available, false);
  assert.equal(inv.find((r) => r.slug === "honeymoon-suite")?.available, false);
});

test("rejects success:false and non-THB properties", () => {
  assert.throws(() => parseAvailableRoomTypes({ success: false, message: "bad key" }, "2026-10-28", "2026-10-31"), CloudbedsError);
  const usd = { success: true, data: [{ propertyCurrency: [{ currencyCode: "USD" }], propertyRooms: [] }] };
  assert.throws(() => parseAvailableRoomTypes(usd, "2026-10-28", "2026-10-31"), CloudbedsError);
});

test("queries with the party's adults (default 1), children=0, detailedRates, no-store", async () => {
  let calledUrl = "";
  let init: RequestInit | undefined;
  const fakeFetch = (async (url: string, i: RequestInit) => {
    calledUrl = url;
    init = i;
    return new Response(JSON.stringify(RESPONSE), { status: 200 });
  }) as unknown as typeof fetch;
  await cloudbedsInventory("2026-10-28", "2026-10-31", { apiKey: "cbat_x", propertyId: null, fetchImpl: fakeFetch });
  const u = new URL(calledUrl);
  assert.equal(u.pathname, "/api/v1.3/getAvailableRoomTypes");
  assert.equal(u.searchParams.get("adults"), "1");
  assert.equal(u.searchParams.get("children"), "0");
  assert.equal(u.searchParams.get("rooms"), "1");
  assert.equal(u.searchParams.get("detailedRates"), "true");
  assert.equal(init?.cache, "no-store");
  await cloudbedsInventory("2026-10-28", "2026-10-31", { apiKey: "cbat_x", propertyId: null, adults: 4, fetchImpl: fakeFetch });
  assert.equal(new URL(calledUrl).searchParams.get("adults"), "4");
  assert.equal((init?.headers as Record<string, string>)["x-api-key"], "cbat_x");
});

function rowsFor(rows: Record<string, unknown>[]) {
  return { success: true, data: [{ propertyCurrency: [{ currencyCode: "THB" }], propertyRooms: rows }] };
}
const NIGHTS = ["2026-10-28", "2026-10-29"];
const hmRow = (rate: number, extra: Record<string, unknown> = {}) => ({
  roomTypeID: "462958",
  roomsAvailable: 1,
  roomRateDetailed: NIGHTS.map((date) => ({ date, rate })),
  ...extra,
});

test("the base row wins over cheaper derived or plan rows, in any order", () => {
  const base = hmRow(1000);
  const derived = hmRow(700, { ratePlanNamePublic: "Non-refundable", derivedType: "percentage" });
  const plan = hmRow(800, { ratePlanNamePublic: "Long stay" });
  for (const rows of [[base, derived, plan], [derived, plan, base], [plan, base, derived]]) {
    const hm = parseAvailableRoomTypes(rowsFor(rows), "2026-10-28", "2026-10-30").find((r) => r.slug === "honeymoon-suite");
    assert.deepEqual(hm?.baseNightly.map((n) => n.amountSatang), [100_000, 100_000], JSON.stringify(rows.map((r) => r.roomRateDetailed[0].rate)));
  }
  // No base row: a non-derived plan row beats a cheaper derived one.
  const hm = parseAvailableRoomTypes(rowsFor([derived, plan]), "2026-10-28", "2026-10-30").find((r) => r.slug === "honeymoon-suite");
  assert.deepEqual(hm?.baseNightly.map((n) => n.amountSatang), [80_000, 80_000]);
});

test("adultsExtraCharge becomes a satang stay-extra table above adultsIncluded", () => {
  assert.deepEqual(parseAdultsExtraCharge([], 2), {});
  assert.deepEqual(parseAdultsExtraCharge({ "2": 100, "3": 1500, "4": "3000.5", x: 9, "5": -1 }, 2), { "3": 150_000, "4": 300_050 });
  const inv = parseAvailableRoomTypes(rowsFor([hmRow(1000, { adultsIncluded: 1, adultsExtraCharge: { "2": 500 } })]), "2026-10-28", "2026-10-30");
  assert.deepEqual(inv.find((r) => r.slug === "honeymoon-suite")?.adultsExtraSatang, { "2": 50_000 });
});

test("the preview's Cloudbeds budget refills at its rate and refuses without calling Cloudbeds", async () => {
  const bucket = createTokenBucket(3, 2);
  assert.equal(bucket.take(0), true);
  assert.equal(bucket.take(0), true);
  assert.equal(bucket.take(0), false);
  assert.equal(bucket.msUntilNext(0), 334);
  assert.equal(bucket.take(340), true);
  assert.equal(bucket.take(340), false);

  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify(RESPONSE), { status: 200 });
  }) as unknown as typeof fetch;
  const empty = createTokenBucket(0.001, 1);
  empty.take();
  await assert.rejects(
    cloudbedsInventory("2027-02-05", "2027-02-08", { apiKey: "cbat_budget", propertyId: null, fetchImpl: fakeFetch, budget: empty }),
    CloudbedsBudgetError,
  );
  assert.equal(calls, 0);
});

test("Cloudbeds maxGuests is kept so offers never exceed what Cloudbeds accepts", () => {
  const json = {
    success: true,
    data: [
      {
        propertyCurrency: [{ currencyCode: "THB" }],
        propertyRooms: [
          {
            roomTypeID: "462964",
            roomsAvailable: 1,
            maxGuests: 3,
            roomRateDetailed: [
              { date: "2026-10-28", rate: 9000 },
              { date: "2026-10-29", rate: 9000 },
            ],
          },
        ],
      },
    ],
  };
  const inv = parseAvailableRoomTypes(json, "2026-10-28", "2026-10-30");
  assert.equal(inv.find((r) => r.slug === "seaview-2br")?.maxGuests, 3);
});

test("search answers are cached briefly; uncached calls always refetch", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify(RESPONSE), { status: 200 });
  }) as unknown as typeof fetch;
  const deps = { apiKey: "cbat_cache", propertyId: null, fetchImpl: fakeFetch, nowMs: 1_000 };
  await cloudbedsInventory("2027-01-05", "2027-01-08", { ...deps, cacheTtlMs: 60_000 });
  await cloudbedsInventory("2027-01-05", "2027-01-08", { ...deps, cacheTtlMs: 60_000 });
  assert.equal(calls, 1);
  await cloudbedsInventory("2027-01-05", "2027-01-08", deps);
  assert.equal(calls, 2);
  await cloudbedsInventory("2027-01-05", "2027-01-08", { ...deps, cacheTtlMs: 60_000, nowMs: 70_000 });
  assert.equal(calls, 3);
});

/* -------------------- live-shaped answers (WI-0, 2026-10-06) -------------------- */

// Copied from the owner's read-only getAvailableRoomTypes run (honeymoon, 2026-12-05 -> 12-08, 3 nights):
// the base (BAR) row is named "default" (not empty), the Breakfast package is a derived row, and
// propertyCurrency is a single object (the spec says an array).
const LIVE_NIGHTS = ["2026-12-05", "2026-12-06", "2026-12-07"];
const liveRow = (roomRateID: string, rate: number, ratePlanNamePublic: string, derivedType: string | null) => ({
  roomTypeID: "462958",
  roomRateID,
  roomsAvailable: 1,
  roomRate: rate * LIVE_NIGHTS.length,
  roomRateDetailed: LIVE_NIGHTS.map((date) => ({ date, rate })),
  adultsIncluded: 2,
  adultsExtraCharge: [],
  maxGuests: 2,
  derivedType,
  ratePlanNamePublic,
});
const LIVE_BASE = liveRow("1375281", 13000, "default", null);
const LIVE_BREAKFAST = liveRow("3237112", 15000, "Breakfast", "fixed");
const LIVE_CURRENCY = { currencyCode: "THB", currencySymbol: "฿", currencyPosition: "before" };
const liveAnswer = (rows: unknown[], propertyCurrency: unknown = LIVE_CURRENCY) => ({
  success: true,
  data: [{ propertyID: "235064", propertyCurrency, propertyRooms: rows }],
});

test("live shape: the base row named \"default\" is sold with base rate only (Stripe), never the Breakfast row", () => {
  for (const baseRateOnly of [true, false]) {
    for (const rows of [[LIVE_BASE, LIVE_BREAKFAST], [LIVE_BREAKFAST, LIVE_BASE]]) {
      const noBase: string[] = [];
      const hm = parseAvailableRoomTypes(liveAnswer(rows), "2026-12-05", "2026-12-08", { baseRateOnly, onNoBaseRate: (s) => noBase.push(s) }).find(
        (r) => r.slug === "honeymoon-suite",
      );
      assert.equal(hm?.available, true, `baseRateOnly=${baseRateOnly}`);
      assert.equal(hm?.rateId, "1375281");
      assert.equal(hm?.baseNightly.reduce((s, n) => s + n.amountSatang, 0), 3_900_000);
      assert.deepEqual(noBase, []);
    }
  }
});

test("base plan names: absent, empty or \"default\" in any case; any other name is a plan of its own", () => {
  for (const name of [null, undefined, "", "  ", "default", "Default", " default ", "DEFAULT"]) assert.equal(isBasePlanName(name), true, JSON.stringify(name));
  for (const name of ["Long stay", "Breakfast", "defaults", 0, {}]) assert.equal(isBasePlanName(name), false, JSON.stringify(name));
  const sell = (rows: unknown[]) => {
    const noBase: string[] = [];
    const hm = parseAvailableRoomTypes(liveAnswer(rows), "2026-12-05", "2026-12-08", { baseRateOnly: true, onNoBaseRate: (s) => noBase.push(s) }).find(
      (r) => r.slug === "honeymoon-suite",
    );
    return { rateId: hm?.available ? hm.rateId : null, noBase };
  };
  assert.deepEqual(sell([liveRow("b1", 13000, " Default ", null)]), { rateId: "b1", noBase: [] });
  // "Long stay" stays a named plan (tier 1): never sold as the Standard Rate.
  assert.deepEqual(sell([liveRow("ls", 12000, "Long stay", null), LIVE_BREAKFAST]), { rateId: null, noBase: ["honeymoon-suite"] });
});

test("propertyCurrency: an object or an array; THB parses, another currency throws, a missing one is only logged", () => {
  const available = (cur: unknown) =>
    parseAvailableRoomTypes(liveAnswer([LIVE_BASE], cur), "2026-12-05", "2026-12-08").find((r) => r.slug === "honeymoon-suite")?.available;
  assert.equal(available({ currencyCode: "THB" }), true);
  assert.equal(available([{ currencyCode: "THB" }]), true);
  assert.throws(() => available({ currencyCode: "USD", currencySymbol: "$" }), /Unexpected property currency USD/);
  assert.throws(() => available([{ currencyCode: "USD" }]), CloudbedsError);
  const logs: string[] = [];
  const noCurrency = { success: true, data: [{ propertyID: "235064", propertyRooms: [LIVE_BASE] }] };
  const inv = parseAvailableRoomTypes(noCurrency, "2026-12-05", "2026-12-08", { log: (m) => logs.push(m) });
  assert.equal(inv.find((r) => r.slug === "honeymoon-suite")?.available, true);
  assert.deepEqual(logs, ["cloudbeds_currency_missing"]);
});

/* ------------------------------ restrictions ------------------------------ */

const STAY_DAYS = ["2027-01-01", "2027-01-02", "2027-01-03", "2027-01-04"]; // 3 nights + the departure day
const rateDay = (date: string, extra: Record<string, unknown> = {}) => ({
  date,
  closedToArrival: false,
  closedToDeparture: false,
  blocked: false,
  minLos: 1,
  maxLos: 31,
  roomsAvailable: 1,
  ...extra,
});
const days = (patch: Record<string, Record<string, unknown>> = {}) => STAY_DAYS.map((d) => rateDay(d, patch[d]));
const planRow = (rateID: string, extra: Record<string, unknown> = {}, roomRateDetailed: unknown[] = days()) => ({
  rateID,
  roomTypeID: "462958",
  isDerived: false,
  ratePlanID: null,
  ratePlanNamePublic: null,
  roomRateDetailed,
  ...extra,
});
const plans = (...rows: unknown[]) => ({ success: true, data: rows });
const evaluate = (json: unknown, rateId: string | null, log?: (m: string, d?: Record<string, unknown>) => void) =>
  evaluateRestrictions(json, "462958", rateId, "2027-01-01", "2027-01-04", { log });

test("restrictions: the highest minimum stay and the lowest maximum stay over the stay nights apply (0 = no limit)", () => {
  const withDays = (patch: Record<string, Record<string, unknown>>) => plans(planRow("1375281", {}, days(patch)));
  // Cloudbeds applies the highest MinLOS of the whole stay, not just the arrival day's.
  assert.deepEqual(evaluate(withDays({ "2027-01-02": { minLos: 4 } }), "1375281"), { ok: false, reason: "min_stay", minNights: 4 });
  assert.deepEqual(evaluate(withDays({ "2027-01-01": { maxLos: 0 }, "2027-01-02": { maxLos: 5 }, "2027-01-03": { maxLos: 2 } }), "1375281"), {
    ok: false,
    reason: "max_stay",
    maxNights: 2,
  });
  // The departure day is not a stay night: its minLos does not count.
  assert.deepEqual(evaluate(withDays({ "2027-01-04": { minLos: 7 } }), "1375281"), { ok: true, checked: true });
  const noLimits = { minLos: 0, maxLos: 0 };
  assert.deepEqual(evaluate(withDays({ "2027-01-01": noLimits, "2027-01-02": noLimits, "2027-01-03": { minLos: 3, maxLos: 0 } }), "1375281"), {
    ok: true,
    checked: true,
  });
});

test("restrictions: never judged by another plan's row; the base row stands in for an unlisted rate id", () => {
  // Live: getRatePlans also lists promo / long-stay plans whatever their minLos.
  const sabai = planRow("4000001", { isDerived: true, ratePlanID: "p1", ratePlanNamePublic: "SabaiTravel2026" }, STAY_DAYS.map((d) => rateDay(d, { minLos: 150 })));
  const longTerm = planRow("4000002", { isDerived: true, ratePlanID: "p2", ratePlanNamePublic: "Long term" }, STAY_DAYS.map((d) => rateDay(d, { minLos: 7 })));
  assert.deepEqual(evaluate(plans(sabai, longTerm), "1375281"), { ok: true, checked: false });
  assert.deepEqual(evaluate(plans(sabai, longTerm), null), { ok: true, checked: false });
  // A non-derived plan with a name of its own, or with a parent plan, is not the base row either.
  const longStay = planRow("x", { ratePlanNamePublic: "Long stay" }, STAY_DAYS.map((d) => rateDay(d, { minLos: 7 })));
  assert.deepEqual(evaluate(plans(longStay), null), { ok: true, checked: false });
  assert.deepEqual(evaluate(plans(planRow("y", { ratePlanID: "p3" })), null), { ok: true, checked: false });
  // Only an explicit "not derived" (false, "false", 0, "0") makes the base row: a row without isDerived never judges the stay.
  const minStay150 = STAY_DAYS.map((d) => rateDay(d, { minLos: 150 }));
  const noIsDerived = Object.fromEntries(Object.entries(planRow("z", {}, minStay150)).filter(([k]) => k !== "isDerived"));
  for (const row of [noIsDerived, planRow("z", { isDerived: undefined }, minStay150), planRow("z", { isDerived: null }, minStay150)]) {
    assert.deepEqual(evaluate(plans(row), null), { ok: true, checked: false }, JSON.stringify(row.isDerived));
  }
  for (const isDerived of ["false", 0, "0"]) {
    assert.deepEqual(evaluate(plans(planRow("1375281", { isDerived }, days({ "2027-01-01": { closedToArrival: true } }))), null), { ok: false, reason: "closed_to_arrival" }, JSON.stringify(isDerived));
  }
  // The base row (name null or "default", isDerived false, no ratePlanID) is used when the rate id is not listed.
  const base = planRow("1375281", {}, days({ "2027-01-01": { closedToArrival: true } }));
  assert.deepEqual(evaluate(plans(sabai, base), "missing"), { ok: false, reason: "closed_to_arrival" });
  assert.deepEqual(evaluate(plans(sabai, { ...base, ratePlanNamePublic: "default" }), null), { ok: false, reason: "closed_to_arrival" });
});

test("restrictions: a missing departure-day row is logged once, not refused; a derived row is marked", () => {
  const logs: { m: string; d?: Record<string, unknown> }[] = [];
  const noDeparture = plans(planRow("1375281", {}, days().slice(0, 3)));
  assert.deepEqual(
    evaluate(noDeparture, "1375281", (m, d) => logs.push({ m, d })),
    { ok: true, checked: true },
  );
  assert.deepEqual(logs, [{ m: "restrictions_no_departure_row", d: { roomTypeId: "462958", rateId: "1375281", checkOut: "2027-01-04" } }]);
  // The sold rate id's row is a derived plan: checked like any other, and marked (Stripe refuses it).
  const breakfast = planRow("3237112", { isDerived: true, ratePlanID: "p9", ratePlanNamePublic: "Breakfast" });
  assert.deepEqual(evaluate(plans(breakfast, planRow("1375281")), "3237112"), { ok: true, checked: true, derived: true });
  assert.deepEqual(evaluate(plans(breakfast, planRow("1375281")), "1375281"), { ok: true, checked: true });
  const breakfastClosed = planRow("3237112", { isDerived: true }, days({ "2027-01-01": { closedToArrival: true } }));
  assert.deepEqual(evaluate(plans(breakfastClosed), "3237112"), { ok: false, reason: "closed_to_arrival", derived: true });
});

test("restrictions: rows without a roomTypeID are the requested type's (getRatePlans sends it only when the request is not filtered by it)", () => {
  const withoutType = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== "roomTypeID"));
  const minStay5 = days({ "2027-01-01": { minLos: 5 } });
  // The base row: its stay rules are enforced, by the sold rate id or as the base row.
  assert.deepEqual(evaluate(plans(withoutType(planRow("1375281", {}, minStay5))), "1375281"), { ok: false, reason: "min_stay", minNights: 5 });
  assert.deepEqual(evaluate(plans(withoutType(planRow("1375281", {}, minStay5))), null), { ok: false, reason: "min_stay", minNights: 5 });
  assert.deepEqual(evaluate(plans(planRow("1375281", { roomTypeID: null }, minStay5)), "1375281"), { ok: false, reason: "min_stay", minNights: 5 });
  // The sold rate id's row is derived: marked, so Stripe refuses it.
  const breakfast = withoutType(planRow("3237112", { isDerived: true, ratePlanID: "p9", ratePlanNamePublic: "Breakfast" }));
  assert.deepEqual(evaluate(plans(breakfast, withoutType(planRow("1375281"))), "3237112"), { ok: true, checked: true, derived: true });
  // Another room type's row is still never used.
  assert.deepEqual(evaluate(plans(planRow("1375281", { roomTypeID: "462960" }, minStay5)), "1375281"), { ok: true, checked: false });
});

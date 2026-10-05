import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CloudbedsBudgetError,
  CloudbedsError,
  cloudbedsInventory,
  createTokenBucket,
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

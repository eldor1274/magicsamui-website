import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudbedsError, cloudbedsInventory, parseAvailableRoomTypes } from "./cloudbedsProvider.ts";

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

test("queries inventory only (adults=1, children=0, detailedRates) with no-store", async () => {
  let calledUrl = "";
  let init: RequestInit | undefined;
  const fakeFetch = (async (url: string, i: RequestInit) => {
    calledUrl = url;
    init = i;
    return new Response(JSON.stringify(RESPONSE), { status: 200 });
  }) as unknown as typeof fetch;
  await cloudbedsInventory("2026-10-28", "2026-10-31", { apiKey: "cbat_x", propertyId: null, fetchImpl: fakeFetch });
  const u = new URL(calledUrl);
  assert.equal(u.pathname, "/api/v1.2/getAvailableRoomTypes");
  assert.equal(u.searchParams.get("adults"), "1");
  assert.equal(u.searchParams.get("children"), "0");
  assert.equal(u.searchParams.get("rooms"), "1");
  assert.equal(u.searchParams.get("detailedRates"), "true");
  assert.equal(init?.cache, "no-store");
  assert.equal((init?.headers as Record<string, string>)["x-api-key"], "cbat_x");
});

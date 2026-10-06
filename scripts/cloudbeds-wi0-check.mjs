#!/usr/bin/env node
// WI-0: READ-ONLY Cloudbeds verification for the own booking engine.
// Makes GET requests only - it never creates, changes or cancels anything.
//
// Usage (PowerShell):
//   $env:CLOUDBEDS_API_KEY_BOOKING="cbat_..."; $env:CLOUDBEDS_PROPERTY_ID="235064"; node scripts/cloudbeds-wi0-check.mjs
// Usage (bash):
//   CLOUDBEDS_API_KEY_BOOKING=cbat_... CLOUDBEDS_PROPERTY_ID=235064 node scripts/cloudbeds-wi0-check.mjs [checkin] [nights]
//
// Falls back to CLOUDBEDS_API_KEY (the existing read key) when the booking key
// is not set; some checks then fail with a scope error, which is itself an
// answer (that key lacks the scope). Paste the output into
// docs/booking-engine.md "WI-0 results". The key is never printed.

const BASE = "https://api.cloudbeds.com/api/v1.3";
const key = process.env.CLOUDBEDS_API_KEY_BOOKING || process.env.CLOUDBEDS_API_KEY || "";
const propertyId = process.env.CLOUDBEDS_PROPERTY_ID || "";
if (!key) {
  console.error("Set CLOUDBEDS_API_KEY_BOOKING (or CLOUDBEDS_API_KEY).");
  process.exit(1);
}

// Room types the site sells (src/data/cloudbeds.ts) - tuxedo-3br has no id yet.
const SITE_ROOM_TYPES = {
  462958: "honeymoon-suite",
  462960: "sunrise-suite",
  462961: "garden-suite",
  462962: "seaview-suite",
  462964: "seaview-2br",
  575061: "tower-club-3br",
  501425: "magic-1-villa",
  464009: "tuxedo",
  501423: "island-view-3br",
  501424: "tuxedo-1br",
  681024: "tuxedo-seaview-unit",
};

function isoPlus(days, from = new Date()) {
  const d = new Date(from.getTime() + 7 * 3600_000 + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

const checkIn = process.argv[2] || isoPlus(60);
const nights = Number(process.argv[3] || 3);
const checkOut = isoPlus(nights, new Date(`${checkIn}T00:00:00Z`)).slice(0, 10);

async function get(method, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== ""));
  const res = await fetch(`${BASE}/${method}?${q}`, {
    headers: { "x-api-key": key, ...(propertyId ? { "X-PROPERTY-ID": propertyId } : {}), accept: "application/json" },
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // not JSON
  }
  return { status: res.status, requestId: res.headers.get("x-request-id"), json };
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function excerpt(v, max = 1500) {
  const s = JSON.stringify(v, null, 2) ?? "null";
  return s.length > max ? `${s.slice(0, max)}\n... (${s.length - max} more chars)` : s;
}

section("1. Property id and currency (getHotelDetails)");
const hotel = await get("getHotelDetails", { propertyID: propertyId });
console.log(`HTTP ${hotel.status} success=${hotel.json?.success} request=${hotel.requestId}`);
console.log(excerpt({ propertyID: hotel.json?.data?.propertyID, propertyCurrency: hotel.json?.data?.propertyCurrency, propertyPolicy: hotel.json?.data?.propertyPolicy }));
console.log(`-> propertyID matches 235064: ${String(hotel.json?.data?.propertyID) === "235064"}`);

section("2. Room types incl. the missing tuxedo-3br id (getRoomTypes)");
const types = await get("getRoomTypes", { propertyIDs: propertyId, pageSize: 100 });
console.log(`HTTP ${types.status} success=${types.json?.success}`);
for (const t of types.json?.data ?? []) {
  const mapped = SITE_ROOM_TYPES[t.roomTypeID] ?? "NOT MAPPED ON THE SITE";
  console.log(`  ${t.roomTypeID}  maxGuests=${t.maxGuests}  ${t.roomTypeName}  -> ${mapped}`);
}

section(`3. roomRate per night or per stay? (getAvailableRoomTypes ${checkIn} -> ${checkOut}, ${nights} nights, adults=2)`);
const avail = await get("getAvailableRoomTypes", {
  propertyIDs: propertyId,
  startDate: checkIn,
  endDate: checkOut,
  rooms: 1,
  adults: 2,
  children: 0,
  detailedRates: "true",
  pageSize: 50,
});
console.log(`HTTP ${avail.status} success=${avail.json?.success}`);
for (const prop of avail.json?.data ?? []) {
  console.log(`  currency: ${excerpt(prop.propertyCurrency, 200)}`);
  for (const r of prop.propertyRooms ?? []) {
    const sum = (r.roomRateDetailed ?? []).reduce((s, x) => s + Number(x.rate), 0);
    const verdict = Math.abs(sum - Number(r.roomRate)) < 0.01 ? "roomRate = STAY total" : Math.abs(sum / nights - Number(r.roomRate)) < 0.01 ? "roomRate = PER NIGHT" : "neither (check)";
    console.log(
      `  ${r.roomTypeID} ${SITE_ROOM_TYPES[r.roomTypeID] ?? "?"}: roomRate=${r.roomRate} sum(detailed)=${sum} -> ${verdict}; roomRateID=${r.roomRateID} available=${r.roomsAvailable} plan=${r.ratePlanNamePublic ?? "-"} derived=${r.derivedType ?? "-"}`,
    );
  }
}

section("4. Are rates tax-inclusive? (getTaxesAndFees)");
const taxes = await get("getTaxesAndFees", { propertyID: propertyId });
console.log(`HTTP ${taxes.status} success=${taxes.json?.success} ${taxes.json?.success === false ? taxes.json?.message : ""}`);
for (const t of taxes.json?.data ?? []) {
  console.log(`  ${t.type} "${t.name}" amount=${t.amount} ${t.amountType} ${t.inclusiveOrExclusive} availableFor=${excerpt(t.availableFor, 120)}`);
}
console.log("-> any 'exclusive' tax/fee means postReservation grandTotal will exceed the quote: the price assert would refuse every booking.");

section("5. Combo shared inventory (honeymoon vs tower-club-3br vs magic-1-villa availability on the same dates)");
const combos = ["462958", "575061", "501425", "462964", "501423", "464009", "501424", "681024"];
const byId = new Map((avail.json?.data?.[0]?.propertyRooms ?? []).map((r) => [String(r.roomTypeID), r.roomsAvailable]));
for (const id of combos) console.log(`  ${id} ${SITE_ROOM_TYPES[id]}: ${byId.has(id) ? `available ${byId.get(id)}` : "not offered"}`);
console.log("-> confirm in Cloudbeds (Settings > Accommodation types) that combination types share the physical rooms (Stage B test 9 proves it).");

section("6. Payment methods and gateway (getPaymentMethods, needs read:payment)");
const pm = await get("getPaymentMethods", { propertyID: propertyId });
console.log(`HTTP ${pm.status} success=${pm.json?.success} ${pm.json?.success === false ? pm.json?.message : ""}`);
console.log(excerpt({ methods: (pm.json?.data?.methods ?? []).map((m) => ({ method: m.method, code: m.code, name: m.name })), gateway: pm.json?.data?.gateway }));
console.log('-> the custom "Stripe" method code here is CLOUDBEDS_STRIPE_PAYMENT_METHOD (default "stripe").');

section("7. Restrictions sample (getRatePlans honeymoon, detailedRates)");
const plans = await get("getRatePlans", { propertyIDs: propertyId, roomTypeID: "462958", startDate: checkIn, endDate: checkOut, adults: 2, children: 0, detailedRates: "true" });
console.log(`HTTP ${plans.status} success=${plans.json?.success}`);
for (const p of plans.json?.data ?? []) {
  console.log(`  rateID=${p.rateID} derived=${p.isDerived} plan=${p.ratePlanNamePublic ?? "-"} promo=${p.promoCode ?? "-"}`);
  for (const d of p.roomRateDetailed ?? []) {
    console.log(`    ${d.date} rate=${d.totalRate ?? d.rateBase} avail=${d.roomsAvailable} CTA=${d.closedToArrival} CTD=${d.closedToDeparture} minLos=${d.minLos} maxLos=${d.maxLos} blocked=${d.blocked}`);
  }
}

section("8. Sweeper: getReservations window semantics and fields (last 3 days, no status filter)");
// The sweeper sends resultsFrom/resultsTo as Bangkok-local "YYYY-MM-DD HH:MM:SS" and reads
// dateCreated/dateCreatedUTC + thirdPartyIdentifier. This shows how Cloudbeds really answers.
const bkk = (ms) => new Date(ms + 7 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
const nowMs = Date.now();
const from = bkk(nowMs - 3 * 86_400_000);
const to = bkk(nowMs);
const list = await get("getReservations", { propertyID: propertyId, resultsFrom: from, resultsTo: to, pageSize: 20, pageNumber: 1 });
console.log(`HTTP ${list.status} success=${list.json?.success} sent resultsFrom="${from}" resultsTo="${to}" (Bangkok)`);
for (const r of (list.json?.data ?? []).slice(0, 10)) {
  // Ids, statuses and timestamps only - no guest data is printed.
  console.log(
    `  ${r.reservationID} status=${r.status} dateCreated="${r.dateCreated ?? "-"}" dateCreatedUTC="${r.dateCreatedUTC ?? "-"}" thirdPartyIdentifier=${r.thirdPartyIdentifier === undefined ? "NOT RETURNED" : JSON.stringify(r.thirdPartyIdentifier)}`,
  );
}
console.log(
  "-> check: (a) every dateCreated falls inside the window as Bangkok time (if rows up to 7 h newer/older appear, the window is read as UTC);\n" +
    "   (b) dateCreated vs dateCreatedUTC differ by 7 h (property-local) ; (c) thirdPartyIdentifier is returned (the sweeper needs it to find orphan holds).",
);

console.log("\nDone. Nothing was written to Cloudbeds.");

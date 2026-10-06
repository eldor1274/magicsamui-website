#!/usr/bin/env node
// WI-0: READ-ONLY Cloudbeds verification for the own booking engine.
// Makes GET requests only - it never creates, changes or cancels anything.
// The request helper refuses anything that is not a Cloudbeds "get..." endpoint
// sent as HTTP GET without a body.
//
// Usage (PowerShell):
//   $env:CLOUDBEDS_API_KEY_BOOKING="cbat_..."; $env:CLOUDBEDS_PROPERTY_ID="235064"; node scripts/cloudbeds-wi0-check.mjs
// Usage (bash):
//   CLOUDBEDS_API_KEY_BOOKING=cbat_... CLOUDBEDS_PROPERTY_ID=235064 node scripts/cloudbeds-wi0-check.mjs [checkin] [nights]
//
// Optional, checked when set in the shell (not secrets, printed as typed):
//   CLOUDBEDS_STRIPE_PAYMENT_METHOD, CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD (section 6), CLOUDBEDS_SOURCE_ID (section 4b).
//
// Falls back to CLOUDBEDS_API_KEY (the existing read key) when the booking key
// is not set; some checks then fail with a scope error, which is itself an
// answer (that key lacks the scope). Paste the output into
// docs/booking-engine.md "WI-0 results". The key is never printed, and neither
// is any guest data (names, emails, phones, addresses).

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

function isoPlusMonths(months, iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10);
}

/** The stay nights: check-in inclusive, check-out exclusive. */
function nightsFrom(start, count) {
  return Array.from({ length: count }, (_, i) => isoPlus(i, new Date(`${start}T00:00:00Z`)));
}

const checkIn = process.argv[2] || isoPlus(60);
const nights = Number(process.argv[3] || 3);
const checkOut = isoPlus(nights, new Date(`${checkIn}T00:00:00Z`)).slice(0, 10);
const stayNights = nightsFrom(checkIn, nights);

async function get(method, params = {}) {
  // Read-only guard: Cloudbeds read endpoints are all named get..., and nothing
  // but a body-less GET ever leaves this helper. Redirects are refused so the key
  // header is never forwarded to another host.
  if (!/^get[A-Z][A-Za-z]*$/.test(method)) throw new Error(`read-only guard: refusing "${method}"`);
  const q = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => [k, String(v)]),
  );
  let res;
  try {
    res = await fetch(`${BASE}/${method}?${q}`, {
      method: "GET",
      redirect: "error",
      headers: { "x-api-key": key, ...(propertyId ? { "X-PROPERTY-ID": propertyId } : {}), accept: "application/json" },
    });
  } catch (e) {
    return { status: 0, requestId: null, json: null, error: String(e?.message ?? e) };
  }
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

function httpLine(res, extra = "", indent = "") {
  const msg = res.json?.success === false ? ` message=${JSON.stringify(res.json?.message ?? null)}` : "";
  const err = res.error ? ` network error: ${res.error}` : "";
  console.log(`${indent}HTTP ${res.status} success=${res.json?.success}${msg}${err}${extra}`);
}

/** Prints a clear note when Cloudbeds does not accept a (documented) request. */
function noteIfRefused(res, what, indent = "  ") {
  if (res.json?.success !== true) console.log(`${indent}NOTE: Cloudbeds did not accept ${what} (see the HTTP line above).`);
}

const j = (v) => JSON.stringify(v ?? null);
const rowsOf = (res) => (Array.isArray(res.json?.data) ? res.json.data : []);
const slugOf = (id) => SITE_ROOM_TYPES[String(id)] ?? "?";
const truthy = (v) => v === true || v === 1 || v === "1" || v === "true";

/** getAvailableRoomTypes base (BAR) row: not derived, public name "default" or empty (live 2026-10-06: "default"). */
function isBaseAvailRow(r) {
  return !r.derivedType && ["", "default"].includes(String(r.ratePlanNamePublic ?? "").trim().toLowerCase());
}

function firstBaseRow(res) {
  for (const prop of rowsOf(res)) for (const r of prop.propertyRooms ?? []) if (isBaseAvailRow(r)) return r;
  return null;
}

/** getRatePlans base row: the documented fields first (isDerived false, ratePlanID null), then name, then any non-derived. */
function basePlanOf(plans) {
  const plain = plans.filter((p) => !truthy(p.isDerived) && !p.derivedType);
  return (
    plain.find((p) => p.ratePlanID === null || p.ratePlanID === undefined || p.ratePlanID === "") ??
    plain.find((p) => !p.ratePlanNamePublic) ??
    plain[0] ??
    null
  );
}

section("1. Property id, currency and policy (getHotelDetails)");
const hotel = await get("getHotelDetails", { propertyID: propertyId });
httpLine(hotel, ` request=${hotel.requestId}`);
const hotelData = hotel.json?.data ?? {};
const policy = hotelData.propertyPolicy && typeof hotelData.propertyPolicy === "object" ? hotelData.propertyPolicy : {};
const { propertyTermsAndConditions: terms, ...policyRest } = policy;
console.log(JSON.stringify({ propertyID: hotelData.propertyID, propertyCurrency: hotelData.propertyCurrency, propertyPolicy: policyRest }, null, 2));
console.log(`-> propertyID matches 235064: ${String(hotelData.propertyID) === "235064"}`);
console.log(`-> propertyFullPaymentBeforeCheckin: ${j(policy.propertyFullPaymentBeforeCheckin)}`);
const tzFields = findKeys(hotelData, /time.?zone|^tz$/i);
console.log(
  tzFields.length
    ? `-> timezone field(s): ${tzFields.map(([p, v]) => `${p}=${j(v)}`).join("; ")}`
    : "-> timezone: no timezone field in the response (v1.3 documents none).",
);
const termsText = htmlToText(terms);
console.log("-> propertyTermsAndConditions (full text, HTML removed):");
console.log(termsText ? termsText.replace(/^/gm, "   ") : "   (empty)");

section("2. Room types incl. the missing tuxedo-3br id (getRoomTypes)");
const types = await get("getRoomTypes", { propertyIDs: propertyId, pageSize: 100 });
console.log(`HTTP ${types.status} success=${types.json?.success}`);
for (const t of types.json?.data ?? []) {
  const mapped = SITE_ROOM_TYPES[t.roomTypeID] ?? "NOT MAPPED ON THE SITE";
  console.log(`  ${t.roomTypeID}  maxGuests=${t.maxGuests}  ${t.roomTypeName}  -> ${mapped}`);
}

section(`3. roomRate per night or per stay? (getAvailableRoomTypes ${checkIn} -> ${checkOut}, ${nights} nights, adults=2)`);
const availParams = (adults) => ({
  propertyIDs: propertyId,
  startDate: checkIn,
  endDate: checkOut,
  rooms: 1,
  adults,
  children: 0,
  detailedRates: "true",
  pageSize: 50,
});
const avail = await get("getAvailableRoomTypes", availParams(2));
console.log(`HTTP ${avail.status} success=${avail.json?.success}`);
for (const prop of rowsOf(avail)) {
  const pc = prop.propertyCurrency;
  const shape = Array.isArray(pc) ? "an ARRAY (as the spec says)" : pc && typeof pc === "object" ? "an OBJECT (the spec says array)" : `missing (${typeof pc})`;
  console.log(`  propertyCurrency is ${shape}: ${j(pc)}`);
  for (const r of prop.propertyRooms ?? []) {
    const detailed = Array.isArray(r.roomRateDetailed) ? r.roomRateDetailed : [];
    const sum = detailed.reduce((s, x) => s + Number(x.rate), 0);
    const verdict = Math.abs(sum - Number(r.roomRate)) < 0.01 ? "roomRate = STAY total" : Math.abs(sum / nights - Number(r.roomRate)) < 0.01 ? "roomRate = PER NIGHT" : "neither (check)";
    console.log(
      `  ${r.roomTypeID} ${slugOf(r.roomTypeID)}: roomRate=${r.roomRate} sum(detailed)=${sum} -> ${verdict}; roomRateID=${r.roomRateID} available=${r.roomsAvailable} ratePlanNamePublic=${j(r.ratePlanNamePublic)} derivedType=${j(r.derivedType)}${isBaseAvailRow(r) ? " [BASE row]" : ""}`,
    );
    const outside = detailed.filter((x) => !stayNights.includes(String(x.date)));
    const missing = stayNights.filter((d) => !detailed.some((x) => String(x.date) === d));
    const flags = [
      outside.length ? `ROW(S) OUTSIDE THE STAY: ${outside.map((x) => `${x.date}${String(x.date) === checkOut ? " (departure day)" : ""}`).join(", ")}` : "",
      missing.length ? `MISSING NIGHTS: ${missing.join(", ")}` : "",
    ].filter(Boolean);
    console.log(`      dates: ${detailed.map((x) => `${x.date}=${x.rate}`).join(" ") || "(none)"}${flags.length ? `  <- ${flags.join("; ")}` : ""}`);
  }
}

console.log("  adults=1 (the engine prices from this answer):");
const avail1 = await get("getAvailableRoomTypes", availParams(1));
httpLine(avail1, "", "  ");
const rate2 = new Map();
for (const prop of rowsOf(avail)) for (const r of prop.propertyRooms ?? []) rate2.set(`${r.roomTypeID}|${r.roomRateID}`, r.roomRate);
const seen1 = new Set();
for (const prop of rowsOf(avail1)) {
  for (const r of prop.propertyRooms ?? []) {
    const k = `${r.roomTypeID}|${r.roomRateID}`;
    seen1.add(k);
    const cmp = !rate2.has(k) ? "  <- not in the adults=2 answer" : Number(rate2.get(k)) !== Number(r.roomRate) ? `  <- adults=2 roomRate was ${rate2.get(k)}` : "";
    console.log(
      `    ${r.roomTypeID} ${slugOf(r.roomTypeID)} roomRateID=${r.roomRateID} plan=${j(r.ratePlanNamePublic)} derived=${j(r.derivedType)} roomRate=${r.roomRate} available=${r.roomsAvailable}${isBaseAvailRow(r) ? " [BASE]" : ""}${cmp}`,
    );
  }
}
const only2 = [...rate2.keys()].filter((k) => !seen1.has(k));
if (only2.length) console.log(`    offered at adults=2 but not at adults=1: ${only2.join(", ")}`);

section("4. Are rates tax-inclusive? (getTaxesAndFees, includeDeleted + includeExpired)");
const taxes = await get("getTaxesAndFees", { propertyID: propertyId, includeDeleted: "true", includeExpired: "true" });
console.log(`HTTP ${taxes.status} success=${taxes.json?.success} ${taxes.json?.success === false ? taxes.json?.message : ""}`);
noteIfRefused(taxes, "getTaxesAndFees with includeDeleted=true&includeExpired=true (documented parameters)");
// Stage B only books 12+ months ahead, so a fee limited to some dates could be
// absent there and present on near-term live dates (or the reverse).
const farCheckIn = isoPlusMonths(13, isoPlus(0));
const farNights = nightsFrom(farCheckIn, nights);
console.log(`  date check: the section-3 stay (${checkIn}, ${nights} nights) vs the same stay from ${farCheckIn} (13 months from today, like Stage B)`);
for (const t of rowsOf(taxes)) {
  const idText = t.type === "tax" ? `taxID=${j(t.taxID)}` : `feeID=${j(t.feeID ?? t.taxID)}`;
  console.log(
    `  ${t.type} ${idText} "${t.name}" code=${j(t.code)} amount=${t.amount} ${t.amountType} ${t.inclusiveOrExclusive} availableFor=${j(t.availableFor)} isDeleted=${j(t.isDeleted)} expiredAt=${j(t.expiredAt)}${t.childId ? ` childId=${j(t.childId)}` : ""}`,
  );
  console.log(`      roomTypes: ${roomTypesText(t.roomTypes)}`);
  console.log(`      dateRanges: ${Array.isArray(t.dateRanges) && t.dateRanges.length ? t.dateRanges.map((x) => j(x)).join("; ") : "all dates"}`);
  console.log(`      lengthOfStaySettings: ${t.lengthOfStaySettings ? j(t.lengthOfStaySettings) : "none"}`);
  const near = [...new Set(stayNights.map((d) => feeOnNight(t, d)))].join(" | ");
  const far = [...new Set(farNights.map((d) => feeOnNight(t, d)))].join(" | ");
  console.log(near === far ? `      same on both stays: ${near}` : `      DIVERGES: section-3 stay -> ${near}; ${farCheckIn} stay -> ${far} (a Stage B pass does not prove near-term dates)`);
}
console.log("-> an 'exclusive' tax/fee raises postReservation's grandTotal above the quote only if it is applied to the SOURCE the hold gets (4b); then the price assert refuses every booking.");

section("4b. Taxes and fees per reservation source (getSources, needs read:reservation)");
const sources = await get("getSources", { propertyIDs: propertyId });
httpLine(sources);
noteIfRefused(sources, "getSources?propertyIDs=... (the documented parameter)");
// Live (2026-10-06) getSources nests its rows one level deeper than the other endpoints (an array inside
// `data`), so walk down to the objects that carry a sourceID instead of reading `data` as the row list.
const sourceRowsIn = (v) => (Array.isArray(v) ? v.flatMap(sourceRowsIn) : v && typeof v === "object" ? ("sourceID" in v ? [v] : Object.values(v).flatMap(sourceRowsIn)) : []);
const sourceRows = sourceRowsIn(sources.json?.data);
const baseRow3 = firstBaseRow(avail);
const primaryRows = sourceRows.filter((s) => !truthy(s.isThirdParty));
const website = primaryRows.find((s) => /booking engine/i.test(String(s.sourceName ?? ""))) ?? primaryRows.find((s) => /website/i.test(String(s.sourceName ?? ""))) ?? null;
for (const s of sourceRows) {
  console.log(
    `  sourceID=${j(s.sourceID)} "${s.sourceName}" ${truthy(s.isThirdParty) ? "third-party" : "PRIMARY"} ${truthy(s.status) ? "active" : "INACTIVE"} paymentCollect=${j(s.paymentCollect)} commission=${j(s.commission)}${s === website ? "  <- WEBSITE / BOOKING ENGINE" : ""}`,
  );
  console.log(`      taxes: ${taxFeeList(s.taxes)}   fees: ${taxFeeList(s.fees)}`);
}
if (website) {
  console.log(
    `-> "${website.sourceName}" (${website.sourceID}): API holds without sourceID get this source (Cloudbeds Reservation FAQ); exclusive % on it = ${exclusivePct(website)}%; predicted hold total for the section-3 stay = ${predictedTotal(website)}`,
  );
  const fixed = exclusiveFixed(website);
  if (fixed.length) console.log(`   plus exclusive FIXED amounts ${fixed.join(", ")} (per night or per stay is not documented)`);
} else {
  console.log("-> no primary source named Website / Booking engine found.");
}
const candidates = sourceRows.filter((s) => !truthy(s.isThirdParty) && truthy(s.status) && !hasExclusive(s));
for (const c of candidates) {
  console.log(`-> "${c.sourceName}" (${c.sourceID}): candidate for CLOUDBEDS_SOURCE_ID (send s-${idCore(c.sourceID)}; the first Stage B hold settles whether -1 is needed)`);
}
if (!candidates.length) console.log("-> no active primary source without exclusive taxes/fees.");
const envSourceId = String(process.env.CLOUDBEDS_SOURCE_ID ?? "").trim();
if (!envSourceId) {
  console.log("-> CLOUDBEDS_SOURCE_ID is not set in this shell.");
} else {
  const shape = /^ss-/i.test(envSourceId) ? "  <- a third-party (ss-) id: use a PRIMARY source" : /^s-\d{1,12}(-1)?$/.test(envSourceId) ? "" : "  <- expected s-N or s-N-1";
  const row = primaryRows.find((s) => idCore(s.sourceID) === idCore(envSourceId));
  console.log(
    row
      ? `-> CLOUDBEDS_SOURCE_ID=${j(envSourceId)}: "${row.sourceName}" (${row.sourceID}) ${truthy(row.status) ? "active" : "INACTIVE"}; exclusive % = ${exclusivePct(row)}%; predicted hold total = ${predictedTotal(row)}${shape}`
      : `-> CLOUDBEDS_SOURCE_ID=${j(envSourceId)}: NOT FOUND among the primary sources above${shape}`,
  );
}

section("4c. Cloudbeds' own checkout calculation (getRoomsFeesAndTaxes, needs read:room) - informational only");
if (!baseRow3) {
  console.log("  skipped: section 3 returned no base row.");
} else {
  const rft = await get("getRoomsFeesAndTaxes", {
    propertyID: propertyId,
    startDate: checkIn,
    endDate: checkOut,
    roomsTotal: baseRow3.roomRate,
    roomsCount: 1,
    adultsPerRoom: 2,
    childrenPerRoom: 0,
  });
  httpLine(rft);
  const d = rft.json?.data ?? {};
  console.log(`  ${baseRow3.roomTypeID} ${slugOf(baseRow3.roomTypeID)} roomsTotal=${baseRow3.roomRate}, ${checkIn} -> ${checkOut}, 1 room, 2 adults`);
  console.log(`  fees: ${Array.isArray(d.fees) && d.fees.length ? d.fees.map((f) => `${f.feeName} ${f.feeValue} (totalFees ${f.totalFees})`).join("; ") : "none"}`);
  console.log(`  taxes: ${Array.isArray(d.taxes) && d.taxes.length ? d.taxes.map((f) => `${f.feeName} ${f.feeValue} (totalTaxes ${f.totalTaxes})`).join("; ") : "none"}`);
  console.log(`  roomsTotalWithoutTaxes=${d.roomsTotalWithoutTaxes} grandTotal=${d.grandTotal}`);
  console.log("-> informational only: this endpoint has no source parameter, so it cannot say what a hold under a given source gets (4b does).");
}

section("5. Combo shared inventory and base rows (all 11 room types on the section-3 dates, adults=2; 'available' = the base row Stripe modes sell)");
// As the engine in Stripe modes (parseAvailableRoomTypes, baseRateOnly): a type is sellable only on its BASE row
// (isBaseAvailRow) with roomsAvailable > 0 and a rate above 0 on every stay night. A Breakfast, Non-refundable or
// other named plan's row never makes a type available on the own page.
const unsellableWhy = (r) => {
  const detailed = Array.isArray(r.roomRateDetailed) ? r.roomRateDetailed : [];
  const rated = stayNights.every((n) => detailed.some((x) => String(x?.date ?? "").slice(0, 10) === n && Number(x.rate) > 0));
  return [Number(r.roomsAvailable) > 0 ? "" : `roomsAvailable ${j(r.roomsAvailable)}`, rated ? "" : "no rate above 0 on every stay night"].filter(Boolean).join(", ");
};
const baseById = new Map(); // sellable base rows: type id -> highest roomsAvailable
const baseUnsellable = new Map(); // type id -> why its base row(s) are skipped
const nonBase = new Map(); // type id -> { labels, sellable }: rows of other plans (not sold on the own page)
for (const prop of rowsOf(avail)) {
  for (const r of prop.propertyRooms ?? []) {
    const id = String(r.roomTypeID);
    const why = unsellableWhy(r);
    if (isBaseAvailRow(r)) {
      if (!why) baseById.set(id, Math.max(baseById.get(id) ?? 0, Number(r.roomsAvailable)));
      else baseUnsellable.set(id, (baseUnsellable.get(id) ?? new Set()).add(why));
      continue;
    }
    const entry = nonBase.get(id) ?? { labels: new Set(), sellable: false };
    entry.labels.add(`${j(r.ratePlanNamePublic)}${r.derivedType ? ` (derived ${r.derivedType})` : ""}`);
    if (!why) entry.sellable = true;
    nonBase.set(id, entry);
  }
}
if (avail.json?.success !== true) console.log("  skipped: section 3's getAvailableRoomTypes failed, so 'not offered' would mean nothing.");
for (const id of avail.json?.success === true ? Object.keys(SITE_ROOM_TYPES) : []) {
  if (baseById.has(id)) {
    console.log(`  ${id} ${SITE_ROOM_TYPES[id]}: available ${baseById.get(id)} (base row)`);
    continue;
  }
  // Not sellable on the own page: say what came back instead (if anything), then tell "unit taken" from
  // "restricted" from "no rate" with the base plan's day rows.
  const baseWhy = baseUnsellable.get(id);
  const other = nonBase.get(id);
  const seen = [
    baseWhy ? `base row not sellable (${[...baseWhy].join("; ")})` : "",
    other
      ? `${baseWhy ? "also returned on" : "offered only on"} a non-base plan (${[...other.labels].join(", ")}) - NOT sellable on the own page (Stripe sells the base rate only; our search shows it unavailable${other.sellable ? " and logs cloudbeds_no_base_rate" : ""})`
      : "",
  ].filter(Boolean);
  const head = `  ${id} ${SITE_ROOM_TYPES[id]}: ${seen.length ? seen.join("; ") : "not offered"}`;
  const rp = await get("getRatePlans", { propertyIDs: propertyId, roomTypeID: id, startDate: checkIn, endDate: checkOut, adults: 2, children: 0, detailedRates: "true" });
  // As the engine: the request filters by roomTypeID and the spec returns it only "if not specified in request",
  // so a row without one (absent, null or "") is the requested type's.
  const plans = rowsOf(rp).filter((p) => p.roomTypeID === undefined || p.roomTypeID === null || p.roomTypeID === "" || String(p.roomTypeID) === id);
  const base = basePlanOf(plans);
  if (rp.json?.success !== true) {
    console.log(`${head}; getRatePlans HTTP ${rp.status} message=${j(rp.json?.message)}`);
    continue;
  }
  if (!base) {
    console.log(`${head} -> NO RATE (getRatePlans returned ${plans.length ? "only derived/package plans" : "no plan"} for this type)`);
    continue;
  }
  console.log(`${head}; base plan rateID=${base.rateID} isDerived=${j(base.isDerived)} ratePlanID=${j(base.ratePlanID)}:`);
  const days = Array.isArray(base.roomRateDetailed) ? base.roomRateDetailed : [];
  for (const d of days) console.log(`      ${d.date} roomsAvailable=${d.roomsAvailable} blocked=${d.blocked} minLos=${d.minLos} maxLos=${d.maxLos} closedToArrival=${d.closedToArrival}`);
  const reasons = [];
  const stayDays = stayNights.map((n) => days.find((d) => String(d.date) === n));
  if (stayDays.some((d) => !d)) reasons.push(`no rate on ${stayNights.filter((n, i) => !stayDays[i]).join(", ")}`);
  const taken = stayDays.filter((d) => d && Number(d.roomsAvailable) < 1);
  if (taken.length) reasons.push(`unit taken (roomsAvailable 0 on ${taken.map((d) => d.date).join(", ")})`);
  if (stayDays.some((d) => d && truthy(d.blocked))) reasons.push("restricted (blocked)");
  if (truthy(stayDays[0]?.closedToArrival)) reasons.push("restricted (closed to arrival)");
  // As the engine (checkStay) and Cloudbeds apply them: the highest minLos and the lowest maxLos above 0 over the stay nights.
  let minLos = { n: 0, date: null };
  let maxLos = { n: 0, date: null };
  for (const d of stayDays) {
    const min = Number(d?.minLos);
    const max = Number(d?.maxLos);
    if (Number.isFinite(min) && min > minLos.n) minLos = { n: min, date: d.date };
    if (Number.isFinite(max) && max > 0 && (maxLos.n === 0 || max < maxLos.n)) maxLos = { n: max, date: d.date };
  }
  if (minLos.n > nights) reasons.push(`restricted (minLos ${minLos.n} from ${minLos.date})`);
  if (maxLos.n > 0 && maxLos.n < nights) reasons.push(`restricted (maxLos ${maxLos.n} from ${maxLos.date})`);
  console.log(`      => ${reasons.length ? reasons.join("; ") : "open per getRatePlans: not explained (is the type sold to the booking engine/API? occupancy?)"}`);
}
console.log(
  "-> confirm in Cloudbeds (Settings > Property > Accommodations > Split Inventory) that combination types are virtual and linked to the physical rooms (section 10 reads the links; Stage B tests 10 and 11 (combination case) prove it).",
);

section("6. Payment methods and gateway (getPaymentMethods lang=en, needs read:payment)");
const pm = await get("getPaymentMethods", { propertyID: propertyId, lang: "en" });
console.log(`HTTP ${pm.status} success=${pm.json?.success} ${pm.json?.success === false ? pm.json?.message : ""}`);
const methods = Array.isArray(pm.json?.data?.methods) ? pm.json.data.methods : [];
console.log(`  ${methods.length} methods (method | code | name):`);
for (const m of methods) console.log(`  ${m.method} | ${m.code} | ${m.name}`);
const gateway = pm.json?.data?.gateway;
console.log(`  gateway: ${gateway && typeof gateway === "object" ? `name=${j(gateway.name)} currency=${j(gateway.currency)}` : j(gateway)}`);
const stripeLike = methods.filter((m) => [m.method, m.code, m.name].some((v) => /stripe/i.test(String(v ?? ""))));
console.log(`  methods mentioning "stripe": ${stripeLike.length ? stripeLike.map((m) => `${m.method} | ${m.code} | ${m.name}`).join("; ") : "none"}`);
for (const name of ["CLOUDBEDS_STRIPE_PAYMENT_METHOD", "CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD"]) {
  const raw = process.env[name];
  if (raw === undefined) {
    console.log(`  ${name}: not set in this shell, nothing to check (set it to the value Vercel has).`);
  } else if (name === "CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD" && !raw.trim()) {
    console.log(`  ${name}=${j(raw)}: empty, so the engine uses CLOUDBEDS_STRIPE_PAYMENT_METHOD.`);
  } else {
    console.log(`  ${name}=${j(raw)}: ${methodVerdict(raw, methods)}`);
  }
}
console.log("-> CLOUDBEDS_STRIPE_PAYMENT_METHOD must be the EXACT `method` value of the custom Stripe row above (case and punctuation kept).");

section("7. Restrictions sample (getRatePlans honeymoon, detailedRates)");
const planParams = (endDate) => ({ propertyIDs: propertyId, roomTypeID: "462958", startDate: checkIn, endDate, adults: 2, children: 0, detailedRates: "true" });
const plans = await get("getRatePlans", planParams(checkOut));
console.log(`HTTP ${plans.status} success=${plans.json?.success} (endDate = check-out ${checkOut})`);
for (const p of rowsOf(plans)) {
  console.log(`  rateID=${p.rateID} roomTypeID=${j(p.roomTypeID)} ratePlanID=${j(p.ratePlanID)} isDerived=${j(p.isDerived)} plan=${j(p.ratePlanNamePublic)} promo=${p.promoCode ?? "-"}`);
  for (const d of p.roomRateDetailed ?? []) {
    console.log(
      `    ${d.date} rate=${d.totalRate ?? d.rateBase} avail=${d.roomsAvailable} CTA=${d.closedToArrival} CTD=${d.closedToDeparture} minLos=${d.minLos} maxLos=${d.maxLos} blocked=${d.blocked} cutOff=${j(d.cutOff)} lastMinuteBooking=${j(d.lastMinuteBooking)}`,
    );
  }
}
// The engine asks one day past check-out so the departure day's closed-to-departure can be read.
const dayAfterCheckOut = isoPlus(1, new Date(`${checkOut}T00:00:00Z`));
const plansPlus1 = await get("getRatePlans", planParams(dayAfterCheckOut));
console.log(`HTTP ${plansPlus1.status} success=${plansPlus1.json?.success} (endDate = check-out + 1 = ${dayAfterCheckOut}, as the engine asks)`);
for (const p of rowsOf(plansPlus1)) {
  const days = Array.isArray(p.roomRateDetailed) ? p.roomRateDetailed : [];
  const dep = days.find((d) => String(d.date) === checkOut);
  console.log(
    `  rateID=${p.rateID} roomTypeID=${j(p.roomTypeID)} ratePlanID=${j(p.ratePlanID)}: ${days.length} day rows; departure-day row ${checkOut}: ${dep ? `present, closedToDeparture=${j(dep.closedToDeparture)} roomsAvailable=${j(dep.roomsAvailable)}` : "MISSING (closed-to-departure cannot be enforced)"}`,
  );
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

section("9. Website / Booking engine reservations: source and taxes/fees on the folio (getReservations sourceId, last 60 days)");
if (!website) {
  console.log("  skipped: no Website / Booking engine source found in 4b.");
} else {
  const core = idCore(website.sourceID);
  const from60 = bkk(nowMs - 60 * 86_400_000);
  let picked = [];
  let pickedWith = null;
  for (const sourceId of [`s-${core}`, `s-${core}-1`]) {
    const res = await get("getReservations", { propertyID: propertyId, sourceId, resultsFrom: from60, resultsTo: to, pageSize: 100, pageNumber: 1 });
    const data = rowsOf(res);
    const counts = {};
    for (const r of data) counts[String(r.sourceID ?? "?")] = (counts[String(r.sourceID ?? "?")] ?? 0) + 1;
    httpLine(res, ` sourceId=${sourceId}: ${data.length} rows (total ${j(res.json?.total)}); sourceIDs in the rows: ${j(counts)}`, "  ");
    noteIfRefused(res, `getReservations sourceId=${sourceId}`, "    ");
    const own = data.filter((r) => r.sourceID === undefined || idCore(r.sourceID) === core);
    if (own.length < data.length) console.log("    NOTE: rows from other sources came back - Cloudbeds looks to ignore this sourceId value.");
    if (!picked.length && own.length) {
      picked = own.slice(0, 3);
      pickedWith = sourceId;
    }
  }
  console.log(pickedWith ? `-> sourceId=${pickedWith} returns Website rows (from ${from60} Bangkok).` : "-> neither sourceId form returned Website rows in the last 60 days.");
  for (const r of picked) {
    // Only ids, status, source and money - no guest fields.
    const one = await get("getReservation", { propertyID: propertyId, reservationID: r.reservationID });
    const d = one.json?.data ?? {};
    if (one.json?.success !== true) {
      httpLine(one, ` getReservation ${r.reservationID}`, "  ");
      continue;
    }
    const parts = Array.isArray(d.balanceDetailed) ? d.balanceDetailed : d.balanceDetailed ? [d.balanceDetailed] : [];
    const money = parts
      .map((b) => {
        const pct = Number(b.subTotal) > 0 ? ` (taxesFees = ${((Number(b.taxesFees) / Number(b.subTotal)) * 100).toFixed(2)}% of subTotal)` : "";
        return `subTotal=${b.subTotal} additionalItems=${b.additionalItems} taxesFees=${b.taxesFees} grandTotal=${b.grandTotal} paid=${b.paid}${pct}`;
      })
      .join(" | ");
    console.log(`  ${d.reservationID ?? r.reservationID} status=${d.status} source=${j(d.source)} sourceID=${j(d.sourceID)} ${money || "balanceDetailed missing"}`);
  }
}

section("10. Split Inventory links (getRooms includeRoomRelations=1, needs read:room, all pages)");
const rooms = [];
const roomIds = new Set();
const ROOMS_PAGE = 20;
let roomsPages = 0;
let roomsTotal = null;
for (let page = 1; page <= 25; page++) {
  const res = await get("getRooms", { propertyIDs: propertyId, includeRoomRelations: 1, pageNumber: page, pageSize: ROOMS_PAGE });
  if (page === 1) {
    httpLine(res);
    noteIfRefused(res, "getRooms?includeRoomRelations=1 (the documented parameter)");
  }
  if (res.json?.success !== true) {
    if (page > 1) httpLine(res, ` (page ${page})`, "  ");
    break;
  }
  roomsPages = page;
  roomsTotal = res.json?.total ?? roomsTotal;
  const data = Array.isArray(res.json?.data) ? res.json.data : res.json?.data ? [res.json.data] : [];
  const batch = data.flatMap((p) => (Array.isArray(p.rooms) ? p.rooms : []));
  const fresh = batch.filter((r) => !roomIds.has(String(r.roomID)));
  for (const r of fresh) {
    roomIds.add(String(r.roomID));
    rooms.push(r);
  }
  if (batch.length < ROOMS_PAGE || !fresh.length) break;
}
console.log(`  read ${rooms.length} rooms over ${roomsPages} page(s) (total reported: ${j(roomsTotal)})`);
const typeInfo = new Map();
for (const r of rooms) {
  const id = String(r.roomTypeID);
  const qty = Array.isArray(r.linkedRoomTypeQty) ? r.linkedRoomTypeQty : [];
  const linked = [...(Array.isArray(r.linkedRoomTypeIDs) ? r.linkedRoomTypeIDs : []), ...qty.map((q) => q?.roomTypeId)].filter((x) => x !== null && x !== undefined).map(String);
  console.log(
    `  ${id} ${slugOf(id)} room=${j(r.roomName)} isVirtual=${j(r.isVirtual)} linkedRoomTypeIDs=${j(r.linkedRoomTypeIDs)} qty=${qty.length ? qty.map((q) => `${q?.roomTypeId}x${q?.roomQty}`).join(",") : "-"}`,
  );
  const info = typeInfo.get(id) ?? { virtual: false, links: new Set() };
  if (truthy(r.isVirtual)) info.virtual = true;
  for (const l of linked) info.links.add(l);
  typeInfo.set(id, info);
}
const HM = ["462958"];
const SR = ["462960"];
const GS = ["462961"];
const SVL = ["462964", "462962"];
const COMBOS = [
  ["575061", [["Honeymoon", HM], ["Seaview level", SVL]]],
  ["501423", [["Seaview level", SVL], ["Sunrise", SR]]],
  ["501425", [["Honeymoon", HM], ["Sunrise", SR], ["Garden", GS], ["Seaview level", SVL]]],
];
// Links can be nested (a combination linked to Seaview 2BR, itself linked to Seaview 1BR). The walk only goes DOWN:
// it follows a linked type only when that type is virtual and not a combination, so links listed back on the
// physical end (or on a shared virtual type) never climb into another combination and fake a MATCH.
const COMBO_IDS = new Set(COMBOS.map(([id]) => id));
const reach = (id, seen = new Set()) => {
  for (const l of typeInfo.get(id)?.links ?? []) {
    if (seen.has(l)) continue;
    seen.add(l);
    if (typeInfo.get(l)?.virtual && !COMBO_IDS.has(l)) reach(l, seen);
  }
  return seen;
};
console.log(
  rooms.length
    ? "  Expected combinations (only virtual types carry links; physical types never link back):"
    : "  no rooms read: links not checked.",
);
for (const [id, parts] of rooms.length ? COMBOS : []) {
  const info = typeInfo.get(id);
  if (!info) {
    console.log(`    ${id} ${slugOf(id)}: no rooms returned for this type`);
    continue;
  }
  const all = reach(id);
  const checks = parts.map(([label, ids]) => {
    const hit = ids.filter((x) => all.has(x));
    return hit.length ? `${label} MATCH (${hit.join("+")})` : `${label} MISSING LINK (${ids.join(" or ")})`;
  });
  const expected = new Set(parts.flatMap(([, ids]) => ids));
  const extra = [...info.links].filter((l) => !expected.has(l) && SITE_ROOM_TYPES[l]);
  console.log(
    `    ${id} ${slugOf(id)} (${info.virtual ? "virtual" : "NOT VIRTUAL - Cloudbeds can only link a virtual type"}): ${checks.join("; ")}${extra.length ? `; also linked to ${extra.map((l) => `${l} ${slugOf(l)}`).join(", ")} (over-blocks only, information)` : ""}`,
  );
}
const PAIRS = [["Seaview 1BR/2BR", "462962", "462964"], ["Tuxedo 1BR/2BR", "501424", "464009"]];
for (const [label, a, b] of rooms.length ? PAIRS : []) {
  const ab = Boolean(typeInfo.get(a)?.virtual) && reach(a).has(b);
  const ba = Boolean(typeInfo.get(b)?.virtual) && reach(b).has(a);
  const verdict = ab && ba ? "BOTH DIRECTIONS (Cloudbeds 'circular logic', unsupported) - report to Cloudbeds support" : ab ? `MATCH (${a} virtual -> ${b})` : ba ? `MATCH (${b} virtual -> ${a})` : "MISSING LINK (neither is a virtual type linked to the other)";
  console.log(`    ${label} ${a} / ${b}: ${verdict}`);
}
const unknownLinks = [...new Set([...typeInfo.values()].flatMap((i) => [...i.links]))].filter((l) => !SITE_ROOM_TYPES[l]);
if (unknownLinks.length) console.log(`    linked room type ids not on the site: ${unknownLinks.join(", ")} (information)`);
const physicalWithLinks = [...typeInfo.entries()].filter(([, i]) => !i.virtual && i.links.size).map(([id]) => `${id} ${slugOf(id)}`);
if (physicalWithLinks.length) {
  console.log(`    physical (non-virtual) types carrying links: ${physicalWithLinks.join(", ")} (unexpected, information; the verdicts above only follow links down from the virtual types)`);
}
console.log("-> report first: do not add, remove or reverse Split Inventory links without Cloudbeds support (links go one way, virtual -> physical).");

console.log("\nDone. Nothing was written to Cloudbeds.");

// --- helpers (function declarations are hoisted) ---

function findKeys(obj, re, path = "", out = [], depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 4) return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (re.test(k)) out.push([p, v]);
    else findKeys(v, re, p, out, depth + 1);
  }
  return out;
}

function htmlToText(html) {
  if (typeof html !== "string" || !html.trim()) return "";
  const named = {
    nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ndash: "-", mdash: "-", hellip: "...", bull: "*", middot: "*",
    rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', laquo: "\u00ab", raquo: "\u00bb", deg: "\u00b0", times: "x", euro: "\u20ac", pound: "\u00a3",
    copy: "(c)", reg: "(R)", trade: "(TM)",
  };
  const cp = (n) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "?");
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|table)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => cp(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m)
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function roomTypesText(list) {
  if (!Array.isArray(list) || !list.length) return "all";
  const ids = list.map((x) => String(x && typeof x === "object" ? x.roomTypeID : x));
  const notOn = Object.keys(SITE_ROOM_TYPES).filter((id) => !ids.includes(id));
  return `${ids.map((id) => `${id} ${slugOf(id)}`).join(", ")}${notOn.length ? `  <- DIVERGES by room type: not on ${notOn.join(", ")} (a Stage B hold on one type does not prove another)` : ""}`;
}

/** ISO 8601 range "YYYY-MM-DD/YYYY-MM-DD", open "YYYY-MM-DD/" or yearly "--MM-DD/--MM-DD" (end read as inclusive). */
function inRange(range, date) {
  const m = /^(\d{4}-\d{2}-\d{2}|--\d{2}-\d{2})\/\s*(\d{4}-\d{2}-\d{2}|--\d{2}-\d{2})?$/.exec(String(range ?? "").trim());
  if (!m) return null;
  const [, start, end] = m;
  if (start.startsWith("--") !== (end ?? start).startsWith("--")) return null;
  if (start.startsWith("--")) {
    const md = date.slice(5);
    const a = start.slice(2);
    const b = end?.slice(2);
    if (!b) return md >= a;
    return a <= b ? md >= a && md <= b : md >= a || md <= b;
  }
  return date >= start && (!end || date <= end);
}

/** What a tax/fee row does on one night: deleted, expired, all dates, or which dateRanges match. */
function feeOnNight(t, date) {
  if (truthy(t.isDeleted)) return "deleted";
  const exp = typeof t.expiredAt === "string" ? t.expiredAt.slice(0, 10) : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(exp) && date >= exp) return "expired";
  const ranges = Array.isArray(t.dateRanges) ? t.dateRanges : [];
  if (!ranges.length) return "all dates";
  const hits = [];
  for (const r of ranges) {
    const hit = inRange(r?.range, date);
    if (hit === null) return `unreadable range ${j(r?.range)} (check by hand)`;
    if (hit) hits.push(`range ${r.range} amount=${r.amount}`);
  }
  return hits.length ? hits.join(" + ") : "outside every dateRange";
}

function taxFeeList(list) {
  return Array.isArray(list) && list.length ? list.map((x) => `${x.name} ${x.amount} ${x.amountType} ${x.type}`).join("; ") : "none";
}

function exclusiveItems(s) {
  return [...(Array.isArray(s.taxes) ? s.taxes : []), ...(Array.isArray(s.fees) ? s.fees : [])].filter((x) => String(x?.type).toLowerCase() === "exclusive");
}

function hasExclusive(s) {
  return exclusiveItems(s).length > 0;
}

function exclusivePct(s) {
  return exclusiveItems(s)
    .filter((x) => String(x.amountType).toLowerCase() === "percentage")
    .reduce((sum, x) => sum + Number(x.amount || 0), 0);
}

function exclusiveFixed(s) {
  return exclusiveItems(s)
    .filter((x) => String(x.amountType).toLowerCase() !== "percentage")
    .map((x) => `${x.name} ${x.amount}`);
}

function predictedTotal(s) {
  if (!baseRow3) return "n/a (section 3 returned no base row)";
  const pct = exclusivePct(s);
  const total = Number(baseRow3.roomRate) * (1 + pct / 100);
  return `${total.toFixed(2)} (${baseRow3.roomTypeID} ${slugOf(baseRow3.roomTypeID)} roomRate ${baseRow3.roomRate} + ${pct}%; the price assert accepts only ${baseRow3.roomRate})`;
}

/** "s-41", "s-41-1" and "41" all name primary source 41. */
function idCore(v) {
  return String(v ?? "").trim().replace(/^s-/i, "").replace(/-1$/, "");
}

function methodVerdict(raw, list) {
  const v = String(raw).trim();
  const problem = !v
    ? "empty"
    : /\s/.test(v)
      ? "contains whitespace"
      : /[\p{Cc}\p{Cf}]/u.test(v)
        ? "contains control or invisible characters"
        : [...v].length > 64
          ? `longer than 64 (${[...v].length})`
          : null;
  if (problem) return `INVALID FOR THE ENGINE (${problem})`;
  const builtIn = ["credit", "cards", "cash", "bank_transfer", "ebanking", "pay_pal", "debit", "check", "check_true", "bill"];
  if (builtIn.includes(v.toLowerCase())) return `BUILT-IN NOT ALLOWED ("${v}" is a Cloudbeds built-in method; use the custom Stripe method)`;
  if (!list.length) return "not checked (getPaymentMethods returned no methods)";
  const row = (m) => `${m.method} | ${m.code} | ${m.name}${m.method !== m.code ? `  <- method != code ("${m.method}" vs "${m.code}"; the engine sends method)` : ""}`;
  const exact = list.find((m) => m.method === v);
  if (exact) return `EXACT (${row(exact)})`;
  const squash = (x) => String(x ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const near = list.filter((m) => [m.method, m.code, m.name].some((x) => squash(x) && squash(x) === squash(v)));
  if (near.length) return `NEAR, not exact - candidates: ${near.map(row).join("; ")} (copy the exact method value)`;
  return "NOT FOUND (no active method with this value)";
}

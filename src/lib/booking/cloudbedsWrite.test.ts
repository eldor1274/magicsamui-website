import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudbedsWriteError, bangkokDateTime, createCloudbedsWriter, parseCloudbedsDateTime, redactForLog, toCloudbedsForm } from "./cloudbedsWrite.ts";
import { feeItemFor } from "./fulfil.ts";
import { createTokenBucket, evaluateRestrictions } from "./cloudbedsProvider.ts";
import { createFakeCloudbeds, mockHoldPricer } from "./mock/fakeCloudbeds.ts";
import { cloudbedsMoneyToSatang, satangToBahtString } from "./quote.ts";

type Call = { url: string; init: RequestInit };

/** A fetch that records calls and answers from a queue. */
function scripted(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no scripted response left");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const ok = (body: unknown, headers: Record<string, string> = {}) => Response.json(body, { status: 200, headers: { "x-request-id": "req-1", ...headers } });

function writer(fetchImpl: typeof fetch, logs: unknown[] = []) {
  return createCloudbedsWriter({ apiKey: "cbat_w", propertyId: "235064", fetchImpl, budget: null, sleep: async () => undefined, log: (m, d) => logs.push({ m, d }) });
}

const HOLD = {
  ref: "MSV-20261005-7F3K",
  checkIn: "2027-11-10",
  checkOut: "2027-11-13",
  rooms: [
    { roomTypeId: "462958", rateId: "r-1", adults: 2 },
    { roomTypeId: "462961", rateId: null, adults: 1 },
  ],
  guest: { firstName: "Jane", lastName: "Doe", email: "jane@example.com", phone: "+44 7700900000", country: "GB", zip: "SW1A1AA" },
  estimatedArrivalTime: "15:00",
  paymentMethod: "credit" as const,
  expectedRoomsSatang: 0,
};

test("form encoding: bracket-indexed arrays, nulls left out", () => {
  const f = toCloudbedsForm({ a: "1", skip: null, rooms: [{ roomTypeID: "9", roomRateID: null, quantity: 1 }], list: ["x", "y"] });
  assert.equal(f.get("rooms[0][roomTypeID]"), "9");
  assert.equal(f.has("rooms[0][roomRateID]"), false);
  assert.equal(f.get("list[1]"), "y");
  assert.equal(f.has("skip"), false);
  assert.match(f.toString(), /rooms%5B0%5D%5BroomTypeID%5D=9/);
});

test("postReservation: v1.3, form body, auth + property headers, the exact fields of the hold", async () => {
  const { calls, fetchImpl } = scripted([ok({ success: true, reservationID: "6954439751495", status: "confirmed", grandTotal: 36000 })]);
  const hold = await writer(fetchImpl).createHold(HOLD);
  assert.deepEqual(hold, { reservationId: "6954439751495", status: "confirmed", grandTotalSatang: 3_600_000 });
  const [c] = calls;
  assert.equal(c.url, "https://api.cloudbeds.com/api/v1.3/postReservation");
  assert.equal(c.init.method, "POST");
  const h = new Headers(c.init.headers);
  assert.equal(h.get("x-api-key"), "cbat_w");
  assert.equal(h.get("x-property-id"), "235064");
  assert.equal(h.get("content-type"), "application/x-www-form-urlencoded");
  assert.equal(h.has("x-msv-mock-expected-total"), false, "the mock hint never reaches the real API");
  const body = new URLSearchParams(String(c.init.body));
  assert.equal(body.get("thirdPartyIdentifier"), HOLD.ref);
  assert.equal(body.get("sendEmailConfirmation"), "false");
  assert.equal(body.get("rooms[0][roomRateID]"), "r-1");
  assert.equal(body.has("rooms[1][roomRateID]"), false);
  assert.equal(body.get("adults[1][quantity]"), "1");
  assert.equal(body.get("children[0][quantity]"), "0");
  assert.equal(body.get("guestZip"), "SW1A1AA");
  assert.equal(body.get("paymentMethod"), "credit");
  assert.equal(body.get("estimatedArrivalTime"), "15:00");
});

test("success:false with HTTP 200 is an error (rejected, not ambiguous) and the message is logged without PII", async () => {
  const logs: unknown[] = [];
  const { fetchImpl } = scripted([ok({ success: false, message: "Guest jane@example.com +44 7700 900000 is invalid" })]);
  await assert.rejects(writer(fetchImpl, logs).createHold(HOLD), (e: unknown) => {
    assert.ok(e instanceof CloudbedsWriteError);
    assert.equal(e.kind, "rejected");
    assert.equal(e.ambiguous, false);
    assert.equal(e.requestId, "req-1");
    assert.equal(e.message.includes("jane@example.com"), false);
    assert.equal(e.message.includes("7700"), false);
    return true;
  });
  assert.equal(JSON.stringify(logs).includes("jane@"), false);
  assert.match(JSON.stringify(logs), /req-1/, "X-Request-ID is logged");
});

test("a write that may have landed is ambiguous (network error, 5xx, success without an id); a GET network error is not", async () => {
  const net = scripted([new TypeError("fetch failed")]);
  await assert.rejects(writer(net.fetchImpl).recordPayment({ reservationId: "1", amountSatang: 100, method: "stripe", description: "x" }), (e: unknown) => e instanceof CloudbedsWriteError && e.ambiguous && e.kind === "network");
  const five = scripted([Response.json({ success: false }, { status: 502 })]);
  await assert.rejects(writer(five.fetchImpl).createHold(HOLD), (e: unknown) => e instanceof CloudbedsWriteError && e.ambiguous && e.kind === "http");
  const noId = scripted([ok({ success: true, grandTotal: 1 })]);
  await assert.rejects(writer(noId.fetchImpl).createHold(HOLD), (e: unknown) => e instanceof CloudbedsWriteError && e.ambiguous);
  const getNet = scripted([new TypeError("fetch failed")]);
  await assert.rejects(writer(getNet.fetchImpl).getReservation("1"), (e: unknown) => e instanceof CloudbedsWriteError && !e.ambiguous);
  // Non-JSON 200 on a write: ambiguous.
  const html = scripted([new Response("<html>", { status: 200 })]);
  await assert.rejects(writer(html.fetchImpl).cancel("1"), (e: unknown) => e instanceof CloudbedsWriteError && e.kind === "invalid_response");
});

test("429: backs off (Retry-After honoured) and retries, then gives up as rate_limited (never ambiguous)", async () => {
  const sleeps: number[] = [];
  const s = scripted([new Response("", { status: 429, headers: { "retry-after": "2" } }), ok({ success: true, paymentID: "p1" })]);
  const w = createCloudbedsWriter({ apiKey: "k", propertyId: "1", fetchImpl: s.fetchImpl, budget: null, sleep: async (ms) => void sleeps.push(ms) });
  assert.deepEqual(await w.recordPayment({ reservationId: "1", amountSatang: 100, method: "stripe", description: "x" }), { paymentId: "p1" });
  assert.deepEqual(sleeps, [2000]);
  const always = scripted(Array.from({ length: 5 }, () => new Response("", { status: 429 })));
  const w2 = createCloudbedsWriter({ apiKey: "k", propertyId: "1", fetchImpl: always.fetchImpl, budget: null, sleep: async () => undefined });
  await assert.rejects(w2.cancel("1"), (e: unknown) => e instanceof CloudbedsWriteError && e.kind === "rate_limited" && !e.ambiguous);
  assert.equal(always.calls.length, 4, "1 try + 3 retries");
});

test("shared call budget: an exhausted bucket refuses before sending anything", async () => {
  const s = scripted([ok({ success: true })]);
  const bucket = createTokenBucket(1, 1);
  bucket.take();
  const w = createCloudbedsWriter({ apiKey: "k", propertyId: "1", fetchImpl: s.fetchImpl, budget: bucket, budgetWaitMs: 0, sleep: async () => undefined });
  await assert.rejects(w.confirm("1", false), (e: unknown) => e instanceof CloudbedsWriteError && e.kind === "budget");
  assert.equal(s.calls.length, 0);
});

test("satang <-> baht ONLY at the Cloudbeds boundary: exact strings out, numbers or strings in", async () => {
  assert.equal(satangToBahtString(2_835_000), "28350.00");
  assert.equal(satangToBahtString(30_003), "300.03");
  assert.equal(satangToBahtString(5), "0.05");
  assert.equal(satangToBahtString(0), "0.00");
  assert.throws(() => satangToBahtString(1.5), RangeError);
  assert.throws(() => satangToBahtString(-1), RangeError);
  assert.equal(cloudbedsMoneyToSatang(241.8), 24_180);
  assert.equal(cloudbedsMoneyToSatang("0.00"), 0);
  assert.equal(cloudbedsMoneyToSatang("1,234.56"), 123_456);
  assert.equal(cloudbedsMoneyToSatang(4500.5 * 3), 1_350_150, "float noise is rounded away");
  assert.equal(cloudbedsMoneyToSatang(null), null);
  assert.equal(cloudbedsMoneyToSatang("abc"), null);

  const s = scripted([ok({ success: true, paymentID: "p" }), ok({ success: true, data: { soldProductID: "1" } })]);
  const w = writer(s.fetchImpl);
  await w.recordPayment({ reservationId: "42", amountSatang: 2_835_000, method: "stripe", description: "Stripe pi_1" });
  await w.addFeeItem({ reservationId: "42", amountSatang: 135_000, referenceId: "MSV-x-fee", ...feeItemFor("stripe-live") });
  const pay = new URLSearchParams(String(s.calls[0].init.body));
  assert.equal(pay.get("amount"), "28350.00");
  assert.equal(pay.get("type"), "stripe");
  assert.equal(pay.get("isDeposit"), "false");
  const item = new URLSearchParams(String(s.calls[1].init.body));
  assert.equal(item.get("items[0][itemPrice]"), "1350.00");
  assert.equal(item.get("referenceID"), "MSV-x-fee");
  assert.equal(item.get("items[0][appItemID]"), "msv-payment-processing-fee");
  assert.equal(item.get("items[0][itemSKU]"), "MSV-PAYMENT-FEE");
  assert.equal(item.get("items[0][itemName]"), "Payment processing fee");
});

test("getReservation parses numbers and strings; postCustomItem duplicate notice is not an error", async () => {
  const s = scripted([
    ok({ success: true, data: { reservationID: "42", status: "not_confirmed", balance: "28,350.00", thirdPartyIdentifier: "MSV-1", balanceDetailed: { grandTotal: 28350, paid: "0.00" } } }),
    ok({ success: true, data: { notice: "duplicate" } }),
  ]);
  const w = writer(s.fetchImpl);
  assert.deepEqual(await w.getReservation("42"), {
    reservationId: "42",
    status: "not_confirmed",
    grandTotalSatang: 2_835_000,
    balanceSatang: 2_835_000,
    paidSatang: 0,
    thirdPartyIdentifier: "MSV-1",
  });
  assert.match(s.calls[0].url, /getReservation\?propertyID=235064&reservationID=42$/);
  assert.deepEqual(await w.addFeeItem({ reservationId: "42", amountSatang: 1, referenceId: "r", ...feeItemFor("stripe-test") }), { duplicate: true });
  await assert.rejects(w.getReservation("../etc"), CloudbedsWriteError);
});

test("status changes use putReservation with the right spelling and email flag", async () => {
  const s = scripted([ok({ success: true }), ok({ success: true }), ok({ success: true })]);
  const w = writer(s.fetchImpl);
  await w.confirm("42", true);
  await w.cancel("42");
  await w.markPending("42");
  const bodies = s.calls.map((c) => new URLSearchParams(String(c.init.body)));
  assert.deepEqual(bodies.map((b) => b.get("status")), ["confirmed", "canceled", "not_confirmed"]);
  assert.deepEqual(bodies.map((b) => b.get("sendStatusChangeEmail")), ["true", "false", "false"]);
  assert.ok(s.calls.every((c) => c.init.method === "PUT"));
});

test("findHolds: every status in a Bangkok-time window, paged; creation time read cautiously", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    reservationID: String(1000 + i),
    status: i === 1 ? "confirmed" : "not_confirmed",
    dateCreated: "2026-10-05 09:00:00",
    thirdPartyIdentifier: i === 0 ? "MSV-20261005-ABCD" : null,
  }));
  const s = scripted([ok({ success: true, data: page1 }), ok({ success: true, data: [{ reservationID: "9", status: "canceled", dateCreated: "2026-10-05 09:00:00", dateCreatedUTC: "2026-10-05 02:00:00" }] })]);
  const holds = await writer(s.fetchImpl).findHolds(Date.parse("2026-10-03T03:00:00Z"), Date.parse("2026-10-05T02:20:00Z"));
  assert.equal(holds.length, 101);
  assert.equal(holds[0].thirdPartyIdentifier, "MSV-20261005-ABCD");
  assert.equal(holds[1].status, "confirmed", "confirmed API bookings are listed too");
  const q = new URL(s.calls[0].url).searchParams;
  assert.equal(q.get("status"), null, "no status filter: holds can be confirmed or not_confirmed");
  assert.equal(q.get("resultsFrom"), "2026-10-03 10:00:00");
  assert.equal(q.get("resultsTo"), "2026-10-05 09:20:00");
  assert.equal(new URL(s.calls[1].url).searchParams.get("pageNumber"), "2");
  assert.equal(bangkokDateTime(Date.parse("2026-12-31T20:30:00Z")), "2027-01-01 03:30:00");
  // Without a zone the LATER reading (as if UTC) is used, so a hold never looks older than it is.
  assert.equal(holds[0].createdMs, Date.parse("2026-10-05T09:00:00Z"));
  // dateCreatedUTC wins when present.
  assert.equal(holds[100].createdMs, Date.parse("2026-10-05T02:00:00Z"));
  assert.equal(parseCloudbedsDateTime("2026-10-05T02:00:00.000Z"), Date.parse("2026-10-05T02:00:00Z"));
  assert.equal(parseCloudbedsDateTime("2026-10-05"), null);
  assert.equal(parseCloudbedsDateTime(null), null);
});

test("redaction keeps logs free of emails and phone numbers", () => {
  assert.equal(redactForLog("bad email a.b@c.co and +66 95 246 6011"), "bad email [email] and [number]");
});

test("the fake Cloudbeds behaves like the API: auth, success:false with 200, availability drops with a hold", async () => {
  const fake = createFakeCloudbeds({ roomTypes: { "462958": { rate: 9000, rateId: "r", units: 1 } } });
  const w = createCloudbedsWriter({ apiKey: "k", propertyId: "1", fetchImpl: fake.fetch, budget: null });
  const hold = await w.createHold({ ...HOLD, rooms: [{ roomTypeId: "462958", rateId: "r", adults: 2 }] });
  assert.equal(hold.grandTotalSatang, 2_700_000);
  await assert.rejects(w.createHold({ ...HOLD, rooms: [{ roomTypeId: "462958", rateId: "r", adults: 2 }] }), (e: unknown) => e instanceof CloudbedsWriteError && e.kind === "rejected");
  const noKey = await fake.fetch("https://api.cloudbeds.com/api/v1.3/getReservation?reservationID=1");
  assert.equal(noKey.status, 401);
});

test("restrictions: closed to arrival, min/max stay, blocked, sold out; unknown room type can't be evaluated", () => {
  const day = (date: string, extra: Record<string, unknown> = {}) => ({ date, closedToArrival: false, closedToDeparture: false, blocked: false, minLos: 0, maxLos: 0, roomsAvailable: 1, ...extra });
  const answer = (days: unknown[], extra: Record<string, unknown> = {}) => ({ success: true, data: [{ rateID: "r1", roomTypeID: "1", isDerived: false, roomRateDetailed: days, ...extra }] });
  const nights = ["2027-01-01", "2027-01-02", "2027-01-03"];
  const ev = (days: unknown[]) => evaluateRestrictions(answer(days), "1", "r1", "2027-01-01", "2027-01-04");
  assert.deepEqual(ev(nights.map((d) => day(d))), { ok: true, checked: true });
  assert.deepEqual(ev([day(nights[0], { closedToArrival: true }), day(nights[1]), day(nights[2])]), { ok: false, reason: "closed_to_arrival" });
  assert.deepEqual(ev([...nights.map((d) => day(d)), day("2027-01-04", { closedToDeparture: "1" })]), { ok: false, reason: "closed_to_departure" });
  assert.deepEqual(ev([day(nights[0], { minLos: 4 }), day(nights[1]), day(nights[2])]), { ok: false, reason: "min_stay", minNights: 4 });
  assert.deepEqual(ev([day(nights[0], { maxLos: 2 }), day(nights[1]), day(nights[2])]), { ok: false, reason: "max_stay", maxNights: 2 });
  assert.deepEqual(ev([day(nights[0]), day(nights[1], { blocked: true }), day(nights[2])]), { ok: false, reason: "blocked" });
  assert.deepEqual(ev([day(nights[0]), day(nights[1]), day(nights[2], { roomsAvailable: 0 })]), { ok: false, reason: "sold_out" });
  assert.deepEqual(evaluateRestrictions({ success: true, data: [] }, "1", null, "2027-01-01", "2027-01-04"), { ok: true, checked: false });
  assert.throws(() => evaluateRestrictions({ success: false, message: "nope" }, "1", null, "2027-01-01", "2027-01-04"));
});

test("stripe-mock price drift knob: holds priced off the quote only when BOOKING_MOCK_HOLD_PRICE_DELTA_BAHT is set", async () => {
  const hold = { ...HOLD, expectedRoomsSatang: 3_600_000 };
  const priced = async (env: Record<string, string | undefined>) => {
    const fake = createFakeCloudbeds({ lenient: true, pricer: mockHoldPricer(env) });
    const w = createCloudbedsWriter({ apiKey: "mock", propertyId: "0", mode: "mock", fetchImpl: fake.fetch, budget: null, log: () => undefined });
    return (await w.createHold(hold)).grandTotalSatang;
  };
  assert.equal(await priced({}), 3_600_000);
  assert.equal(await priced({ BOOKING_MOCK_HOLD_PRICE_DELTA_BAHT: "" }), 3_600_000);
  assert.equal(await priced({ BOOKING_MOCK_HOLD_PRICE_DELTA_BAHT: "nonsense" }), 3_600_000);
  assert.equal(await priced({ BOOKING_MOCK_HOLD_PRICE_DELTA_BAHT: "500" }), 3_650_000);
  assert.equal(await priced({ BOOKING_MOCK_HOLD_PRICE_DELTA_BAHT: "-0.5" }), 3_599_950);
});

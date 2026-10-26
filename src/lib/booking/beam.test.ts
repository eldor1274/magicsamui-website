import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BeamApiError,
  basicAuthHeader,
  buildPaymentLinkRequest,
  createPaymentLink,
  mapLinkStatus,
  verifyBeamSignature,
} from "./beam.ts";
import {
  BEAM_MAX_CHARGE_SATANG,
  beamErrorInfo,
  beamHostedHost,
  beamLinkSettings,
  disablePaymentLink,
  getPaymentLink,
  getRefund,
  isBeamHostedPageUrl,
  isBeamLinkId,
  isBeamNotFound,
  listLinkChargesSince,
  listPaymentLinkCharges,
  parseBeamCharge,
  parseBeamRefund,
  parseBeamTime,
} from "./beam.ts";
import type { BeamMethodGroup } from "./beam.ts";
import { BEAM_LIVE_BASE, BEAM_PLAYGROUND_BASE } from "./config.ts";
import { percentOf } from "./quote.ts";
import type { Quote } from "./types.ts";

// Beam's published test vector: https://docs.beamcheckout.com/webhook-authentication.md
const VECTOR_KEY = "KOFELguf5L1ltuDlkDHGUkPPnQhrgYYijTR4Fqh7APc=";
const VECTOR_SIGNATURE = "1XzWtJHZ9Y1tmjkA/XZUIn1ZHrUQp1d0Ms0oDQfJBto=";
const VECTOR_BODY =
  '{"chargeId":"ch_30GtUweMWec7r2hHIsV5xxQeJKp","merchantId":"m_2sHxsByPwESKYM4nMwdEBdhubPS","referenceId":"order#10001","status":"SUCCEEDED","currency":"THB","amount":3000000,"source":"PAYMENT_LINK","sourceId":"57Iot6c11o","transactionTime":"2025-07-23T10:16:12Z","paymentMethod":{"paymentMethodType":"CARD","card":{"last4":"1111","brand":"VISA"},"cardInstallments":null,"cardNetworkToken":null,"qrPromptPay":null,"alipay":null,"weChatPay":null,"trueMoney":null,"linePay":null,"shopeePay":null,"bangkokBankApp":null,"kPlus":null,"scbEasy":null,"krungsriApp":null},"failureCode":"","customer":{"primaryPhone":{"countryCode":"+66","number":"0958051075"},"email":"","deliveryAddress":{"contactName":"","phone":{"countryCode":"","number":""},"address":{"streetAddress":"","city":"","country":"","postCode":""}}},"createdAt":"2025-07-23T10:15:56.102401Z","updatedAt":"2025-07-23T10:16:17.418991Z"}';

test("webhook HMAC matches Beam's published test vector", () => {
  assert.equal(verifyBeamSignature(VECTOR_BODY, VECTOR_SIGNATURE, VECTOR_KEY), true);
  assert.equal(verifyBeamSignature(new TextEncoder().encode(VECTOR_BODY), VECTOR_SIGNATURE, VECTOR_KEY), true);
});

test("webhook HMAC rejects re-serialised bodies, raw-string keys and bad headers", () => {
  const pretty = JSON.stringify(JSON.parse(VECTOR_BODY), null, 2);
  assert.equal(verifyBeamSignature(pretty, VECTOR_SIGNATURE, VECTOR_KEY), false);
  assert.equal(verifyBeamSignature(VECTOR_BODY, VECTOR_SIGNATURE, Buffer.from(VECTOR_KEY).toString("base64")), false);
  assert.equal(verifyBeamSignature(VECTOR_BODY, null, VECTOR_KEY), false);
  assert.equal(verifyBeamSignature(VECTOR_BODY, "AAAA", VECTOR_KEY), false);
  assert.equal(verifyBeamSignature(`${VECTOR_BODY} `, VECTOR_SIGNATURE, VECTOR_KEY), false);
});

const quote: Quote = {
  currency: "THB",
  checkIn: "2026-10-28",
  checkOut: "2026-10-31",
  nights: 3,
  lines: [
    {
      slug: "sunrise-suite",
      roomName: "Sunrise Suite",
      ratePlanId: "standard",
      ratePlanName: "Standard Rate",
      adults: 2,
      nights: 3,
      nightly: [],
      occupancyExtraSatang: 0,
      roomSatang: 1_395_000,
      addons: [],
      addonsSatang: 0,
    },
  ],
  roomsSubtotalSatang: 1_395_000,
  addonsSubtotalSatang: 0,
  promo: null,
  feeBaseSatang: 1_395_000,
  cardFeePct: 5,
  cardFeeSatang: 69_750,
  totalSatang: 1_464_750,
  depositPct: 100,
  dueNowSatang: 1_464_750,
  balanceSatang: 0,
};

const NOW = Date.parse("2026-10-05T03:00:00Z");

function linkInput(q: Quote = quote) {
  return {
    ref: "MSV-20261005-7F3K",
    quote: q,
    merchantName: "Magic Suites & Villas",
    redirectUrl: "https://magicsamui.com/booking-preview/return?ref=MSV-20261005-7F3K&t=x",
    cancelUrl: "https://magicsamui.com/booking-preview?resume=payment&ref=MSV-20261005-7F3K&t=x",
    nowMs: NOW,
    ttlMinutes: 30,
  };
}

test("payment link body: satang integer from the server quote, card + PromptPay only", () => {
  const body = buildPaymentLinkRequest(linkInput());
  assert.equal(body.order.currency, "THB");
  assert.equal(body.order.netAmount, 1_464_750);
  assert.equal(Number.isInteger(body.order.netAmount), true);
  assert.equal(body.order.referenceId, "MSV-20261005-7F3K");
  assert.deepEqual(body.linkSettings, { card: { isEnabled: true }, qrPromptPay: { isEnabled: true } });
  assert.equal(body.collectPhoneNumber, false);
  assert.equal(body.collectDeliveryAddress, false);
  assert.equal(body.expiresAt, "2026-10-05T03:30:00.000Z");
  assert.ok(body.order.description.length <= 500);
  assert.ok(body.order.internalNote.length <= 500);
  assert.equal(body.order.orderItems[0].price, body.order.netAmount);
  assert.match(body.redirectUrl, /ref=MSV-20261005-7F3K/);
  assert.match(body.cancelUrl, /ref=MSV-20261005-7F3K/);
});

test("payment link charges the deposit when deposit < 100%", () => {
  const body = buildPaymentLinkRequest(linkInput({ ...quote, depositPct: 30, dueNowSatang: 439_425, balanceSatang: 1_025_325 }));
  assert.equal(body.order.netAmount, 439_425);
  assert.match(body.order.description, /deposit/);
});

test("payment link refuses amounts below 1.00 THB or fractional satang", () => {
  assert.throws(() => buildPaymentLinkRequest(linkInput({ ...quote, dueNowSatang: 99 })), RangeError);
  assert.throws(() => buildPaymentLinkRequest(linkInput({ ...quote, dueNowSatang: 1000.5 })), RangeError);
});

test("createPaymentLink sends Basic auth + idempotency key and validates the hosted URL", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: "rGtqz6DafS", url: "https://playground-pay.beamcheckout.com/m1/rGtqz6DafS" }), {
      status: 201,
    });
  }) as unknown as typeof fetch;
  const creds = { apiBase: "https://playground.api.beamcheckout.com", merchantId: "m1", apiKey: "k1" };
  const body = buildPaymentLinkRequest(linkInput());
  const res = await createPaymentLink(creds, body, "idem-1", fakeFetch);
  assert.deepEqual(res, { id: "rGtqz6DafS", url: "https://playground-pay.beamcheckout.com/m1/rGtqz6DafS" });
  assert.equal(calls[0].url, "https://playground.api.beamcheckout.com/api/v1/payment-links");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, basicAuthHeader("m1", "k1"));
  assert.equal(headers.authorization, `Basic ${Buffer.from("m1:k1").toString("base64")}`);
  assert.equal(headers["x-beam-idempotency-key"], "idem-1");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), body);
});

test("createPaymentLink retries once with the same key on 5xx, not on 4xx", async () => {
  let n = 0;
  const keys: string[] = [];
  const flaky = (async (_url: string, init: RequestInit) => {
    n++;
    keys.push((init.headers as Record<string, string>)["x-beam-idempotency-key"]);
    if (n === 1) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify({ id: "a", url: "https://pay.beamcheckout.com/m/a" }), { status: 201 });
  }) as unknown as typeof fetch;
  const creds = { apiBase: "https://api.beamcheckout.com", merchantId: "m", apiKey: "k" };
  await createPaymentLink(creds, buildPaymentLinkRequest(linkInput()), "same-key", flaky);
  assert.deepEqual(keys, ["same-key", "same-key"]);

  let m = 0;
  const bad = (async () => {
    m++;
    return new Response(JSON.stringify({ error: { errorCode: "API_VALIDATION_ERROR", errorMessage: "bad" } }), { status: 400 });
  }) as unknown as typeof fetch;
  await assert.rejects(createPaymentLink(creds, buildPaymentLinkRequest(linkInput()), "k", bad), (e: unknown) => {
    return e instanceof BeamApiError && e.errorCode === "API_VALIDATION_ERROR";
  });
  assert.equal(m, 1);
});

test("createPaymentLink rejects a non-Beam redirect URL", async () => {
  const evil = (async () =>
    new Response(JSON.stringify({ id: "a", url: "https://evil.example.com/pay" }), { status: 201 })) as unknown as typeof fetch;
  const creds = { apiBase: "https://playground.api.beamcheckout.com", merchantId: "m", apiKey: "k" };
  await assert.rejects(createPaymentLink(creds, buildPaymentLinkRequest(linkInput()), "k", evil), BeamApiError);
});

test("payment link status mapping", () => {
  assert.equal(mapLinkStatus("PAID"), "paid");
  assert.equal(mapLinkStatus("ACTIVE"), "pending");
  assert.equal(mapLinkStatus("EXPIRED"), "expired");
  assert.equal(mapLinkStatus("DISABLED"), "cancelled");
  assert.equal(mapLinkStatus("REFUNDED"), "refunded");
  assert.equal(mapLinkStatus("VOIDED"), "refunded");
});

/* ---------------- S2.1: the completed Beam client ---------------- */

const PG_CREDS = { apiBase: BEAM_PLAYGROUND_BASE, merchantId: "m1", apiKey: "k1" };
const LIVE_CREDS = { apiBase: BEAM_LIVE_BASE, merchantId: "m1", apiKey: "k1" };

interface Call {
  url: string;
  init: RequestInit;
}
type Step = Response | Error | ((url: string) => Response);

/** A fetch that answers from a script, one step per call, and records every call. */
function scripted(...steps: Step[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = steps.shift();
    if (next === undefined) throw new Error(`unexpected call ${url}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(url) : next;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const beamError = (status: number, errorCode: string, errorMessage = "x") =>
  json({ code: status, message: "error", error: { errorCode, errorMessage } }, status);

/** No real waiting; records the jitter. */
function seams(random = 0.5) {
  const sleeps: number[] = [];
  return {
    sleeps,
    opts: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      random: () => random,
    },
  };
}

// Two rooms on a 3% card/e-wallet fee: 1,395,000 + 1,005,000 + 72,000 = 2,472,000 satang.
const twoRooms: Quote = {
  ...quote,
  lines: [quote.lines[0], { ...quote.lines[0], slug: "garden-suite", roomName: "Garden Suite", adults: 1, roomSatang: 1_005_000 }],
  roomsSubtotalSatang: 2_400_000,
  feeBaseSatang: 2_400_000,
  cardFeePct: 3,
  cardFeeSatang: 72_000,
  totalSatang: 2_472_000,
  dueNowSatang: 2_472_000,
};
const twoRoomsPromptPay: Quote = { ...twoRooms, cardFeePct: 0, cardFeeSatang: 0, totalSatang: 2_400_000, dueNowSatang: 2_400_000 };
const NOTE = "msv1|m=beam-playground|r=MSV-20261005-7F3K|s=abcdefghijklmnopqrstuvwxyz0";
/** The fee each group must carry under the owner's decision 1 (feePctFor in S3.2): cards and e-wallets 3%, PromptPay none. */
const GROUP_FEE_PCT: Record<BeamMethodGroup, number> = { card_ewallet: 3, promptpay: 0 };

function groupInput(q: Quote, group: BeamMethodGroup, ewallets = true, log?: (m: string, d?: Record<string, unknown>) => void) {
  return { ...linkInput(q), group, ewallets, internalNote: NOTE, log, expectedFeePct: GROUP_FEE_PCT[group] };
}

test("legacy body (no group) is byte-identical to the preview's body before S2.1", () => {
  assert.equal(
    JSON.stringify(buildPaymentLinkRequest(linkInput())),
    '{"order":{"currency":"THB","netAmount":1464750,"description":"Magic Suites & Villas - Sunrise Suite, Oct 28, 2026 - Oct 31, 2026 (3 nights, 2 guests)","referenceId":"MSV-20261005-7F3K","internalNote":"ref=MSV-20261005-7F3K; rooms=sunrise-suite:standard:2; total=1464750; fee=69750; due=1464750; promo=-","orderItems":[{"itemName":"Booking MSV-20261005-7F3K: Sunrise Suite","description":"Oct 28, 2026 - Oct 31, 2026, 3 nights","price":1464750,"quantity":1,"sku":"MSV-20261005-7F3K"}]},"linkSettings":{"card":{"isEnabled":true},"qrPromptPay":{"isEnabled":true}},"collectPhoneNumber":false,"collectDeliveryAddress":false,"redirectUrl":"https://magicsamui.com/booking-preview/return?ref=MSV-20261005-7F3K&t=x","cancelUrl":"https://magicsamui.com/booking-preview?resume=payment&ref=MSV-20261005-7F3K&t=x","expiresAt":"2026-10-05T03:30:00.000Z"}',
  );
  assert.equal(
    JSON.stringify(buildPaymentLinkRequest(linkInput({ ...quote, depositPct: 30, dueNowSatang: 439_425, balanceSatang: 1_025_325 }))),
    '{"order":{"currency":"THB","netAmount":439425,"description":"Magic Suites & Villas - Sunrise Suite, Oct 28, 2026 - Oct 31, 2026 (3 nights, 2 guests) - deposit","referenceId":"MSV-20261005-7F3K","internalNote":"ref=MSV-20261005-7F3K; rooms=sunrise-suite:standard:2; total=1464750; fee=69750; due=439425; promo=-","orderItems":[{"itemName":"Booking MSV-20261005-7F3K: Sunrise Suite","description":"Oct 28, 2026 - Oct 31, 2026, 3 nights, 30% deposit","price":439425,"quantity":1,"sku":"MSV-20261005-7F3K"}]},"linkSettings":{"card":{"isEnabled":true},"qrPromptPay":{"isEnabled":true}},"collectPhoneNumber":false,"collectDeliveryAddress":false,"redirectUrl":"https://magicsamui.com/booking-preview/return?ref=MSV-20261005-7F3K&t=x","cancelUrl":"https://magicsamui.com/booking-preview?resume=payment&ref=MSV-20261005-7F3K&t=x","expiresAt":"2026-10-05T03:30:00.000Z"}',
  );
});

test("card_ewallet link carries only card + eWallets; promptpay only the QR", () => {
  const card = buildPaymentLinkRequest(groupInput(twoRooms, "card_ewallet"));
  assert.deepEqual(card.linkSettings, { card: { isEnabled: true }, eWallets: { isEnabled: true } });
  assert.deepEqual(Object.keys(card.linkSettings), ["card", "eWallets"]);
  const cardOnly = buildPaymentLinkRequest(groupInput(twoRooms, "card_ewallet", false));
  assert.deepEqual(cardOnly.linkSettings, { card: { isEnabled: true }, eWallets: { isEnabled: false } });
  const qr = buildPaymentLinkRequest(groupInput(twoRoomsPromptPay, "promptpay", true));
  assert.deepEqual(qr.linkSettings, { qrPromptPay: { isEnabled: true } });
  assert.deepEqual(Object.keys(qr.linkSettings), ["qrPromptPay"]);
  assert.deepEqual(beamLinkSettings("promptpay", false), { qrPromptPay: { isEnabled: true } });
  assert.throws(() => beamLinkSettings("wallet_only" as BeamMethodGroup, true), RangeError);
  for (const body of [card, qr]) {
    assert.equal(body.collectPhoneNumber, false);
    assert.equal(body.collectDeliveryAddress, false);
    assert.equal(body.order.currency, "THB");
    assert.equal(body.order.referenceId, "MSV-20261005-7F3K");
    assert.equal(body.order.internalNote, NOTE, "the caller's signed note is sent verbatim");
    assert.equal(body.expiresAt, "2026-10-05T03:30:00.000Z");
    assert.match(body.redirectUrl, /ref=MSV-20261005-7F3K/);
    assert.match(body.cancelUrl, /ref=MSV-20261005-7F3K/);
  }
  assert.equal(card.order.netAmount, 2_472_000);
  assert.equal(qr.order.netAmount, 2_400_000);
});

/** A one-room quote whose fee base is `feeBase` satang, priced at `pct` (consistent fee fields, paid in full). */
function quoteOf(feeBase: number, pct: number): Quote {
  const fee = percentOf(feeBase, pct);
  const line = { ...quote.lines[0], roomSatang: feeBase };
  return { ...quote, lines: [line], roomsSubtotalSatang: feeBase, feeBaseSatang: feeBase, cardFeePct: pct, cardFeeSatang: fee, totalSatang: feeBase + fee, dueNowSatang: feeBase + fee };
}

test("group link: the note is never clipped and the amount is capped at BEAM_MAX_CHARGE_SATANG (Beam's THB 200,000.00 per transaction, the fee included)", () => {
  assert.equal(BEAM_MAX_CHARGE_SATANG, 20_000_000, "Beam's written answer of 26 Oct 2026: THB 200,000 per transaction");
  const long = { ...groupInput(twoRooms, "card_ewallet"), internalNote: "n".repeat(501) };
  assert.throws(() => buildPaymentLinkRequest(long), RangeError);
  const exact = { ...groupInput(twoRooms, "card_ewallet"), internalNote: "n".repeat(500) };
  assert.equal(buildPaymentLinkRequest(exact).order.internalNote.length, 500);
  assert.throws(() => buildPaymentLinkRequest(groupInput({ ...twoRooms, dueNowSatang: 99 }, "promptpay")), RangeError);

  const tooMuch = (e: unknown) => e instanceof RangeError && e.message === "Beam netAmount must be at most 20000000 satang";
  // PromptPay (no fee): THB 199,999.99 and exactly THB 200,000.00 are sent; THB 200,000.01 never reaches Beam.
  for (const due of [19_999_999, 20_000_000]) assert.equal(buildPaymentLinkRequest(groupInput(quoteOf(due, 0), "promptpay")).order.netAmount, due);
  assert.throws(() => buildPaymentLinkRequest(groupInput(quoteOf(20_000_001, 0), "promptpay")), tooMuch);
  // Card or e-wallet: the fee-inclusive amount is what counts. 194,174.75 + 3% = 199,999.99; 194,174.77 + 3% = 200,000.01.
  const under = quoteOf(19_417_475, 3);
  const over = quoteOf(19_417_477, 3);
  assert.equal(under.dueNowSatang, 19_999_999);
  assert.equal(over.dueNowSatang, 20_000_001);
  assert.equal(buildPaymentLinkRequest(groupInput(under, "card_ewallet")).order.netAmount, 19_999_999);
  assert.throws(() => buildPaymentLinkRequest(groupInput(over, "card_ewallet")), tooMuch);
  // A fee base within the limit whose 3% fee takes it over: refused (the same stay by PromptPay is sent).
  assert.throws(() => buildPaymentLinkRequest(groupInput(quoteOf(19_500_000, 3), "card_ewallet")), tooMuch);
  assert.equal(buildPaymentLinkRequest(groupInput(quoteOf(19_500_000, 0), "promptpay")).order.netAmount, 19_500_000);
  // The legacy body (no group) is capped too.
  assert.throws(() => buildPaymentLinkRequest(linkInput(quoteOf(20_000_001, 5))), tooMuch);
});

test("group link: the quote's fee must be the fee of the link's method group (owner decision 1), else RangeError", () => {
  // A PromptPay link built from the card quote would charge the 3% fee on the fee-free method...
  assert.throws(
    () => buildPaymentLinkRequest(groupInput(twoRooms, "promptpay")),
    (e: unknown) => e instanceof RangeError && e.message === "Beam promptpay link: the quote's fee is 3% (72000 satang), not the 0% (0 satang) this method group must carry",
  );
  // ...and a card_ewallet link built from the fee-free quote would lose the owner's 3%.
  assert.throws(
    () => buildPaymentLinkRequest(groupInput(twoRoomsPromptPay, "card_ewallet")),
    (e: unknown) => e instanceof RangeError && e.message === "Beam card_ewallet link: the quote's fee is 0% (0 satang), not the 3% (72000 satang) this method group must carry",
  );
  // A fee amount that is not the group's % of the fee base, or a total that carries a fee the fee fields hide.
  assert.throws(() => buildPaymentLinkRequest(groupInput({ ...twoRoomsPromptPay, cardFeeSatang: 72_000 }, "promptpay")), RangeError);
  assert.throws(() => buildPaymentLinkRequest(groupInput({ ...twoRoomsPromptPay, totalSatang: 2_472_000, dueNowSatang: 2_472_000 }, "promptpay")), RangeError);
  assert.throws(() => buildPaymentLinkRequest(groupInput({ ...twoRooms, cardFeeSatang: 0, totalSatang: 2_400_000, dueNowSatang: 2_400_000 }, "card_ewallet")), RangeError);
  assert.throws(() => buildPaymentLinkRequest(groupInput({ ...twoRooms, cardFeeSatang: 71_999, totalSatang: 2_471_999, dueNowSatang: 2_471_999 }, "card_ewallet")), RangeError);
  // The amount is right but the quote's percent is not (it would label the line 'Payment processing fee (4%)').
  const wrongPct: Quote = { ...twoRooms, cardFeePct: 4, cardFeeSatang: percentOf(twoRooms.feeBaseSatang, 3) };
  assert.equal(wrongPct.cardFeeSatang, 72_000);
  assert.equal(wrongPct.totalSatang, wrongPct.feeBaseSatang + wrongPct.cardFeeSatang);
  assert.throws(
    () => buildPaymentLinkRequest(groupInput(wrongPct, "card_ewallet")),
    (e: unknown) => e instanceof RangeError && e.message === "Beam card_ewallet link: the quote's fee is 4% (72000 satang), not the 3% (72000 satang) this method group must carry",
  );

  // The owner's override BEAM_PROMPTPAY_FEE_PCT=3 (S3.2): the expected fee follows it, so a 3% PromptPay link
  // is built with its fee line, and the fee-free quote is then the wrong one.
  const overridden = buildPaymentLinkRequest({ ...groupInput(twoRooms, "promptpay"), expectedFeePct: 3 });
  assert.deepEqual(overridden.linkSettings, { qrPromptPay: { isEnabled: true } });
  assert.equal(overridden.order.netAmount, 2_472_000);
  assert.deepEqual(overridden.order.orderItems.at(-1), { itemName: "Payment processing fee (3%)", price: 72_000, quantity: 1 });
  assert.throws(() => buildPaymentLinkRequest({ ...groupInput(twoRoomsPromptPay, "promptpay"), expectedFeePct: 3 }), RangeError);
  // A card fee configured at 0% (BOOKING_CARD_FEE_PCT=0): the fee-free quote is then right for card_ewallet.
  assert.equal(buildPaymentLinkRequest({ ...groupInput(twoRoomsPromptPay, "card_ewallet"), expectedFeePct: 0 }).order.netAmount, 2_400_000);
  // A fractional % follows quote.ts's own rounding (percentOf).
  const pct25: Quote = { ...twoRooms, cardFeePct: 2.5, cardFeeSatang: 60_000, totalSatang: 2_460_000, dueNowSatang: 2_460_000 };
  assert.equal(buildPaymentLinkRequest({ ...groupInput(pct25, "card_ewallet"), expectedFeePct: 2.5 }).order.netAmount, 2_460_000);
  // A deposit charges part of a consistent total.
  const deposit: Quote = { ...twoRooms, depositPct: 30, dueNowSatang: 741_600, balanceSatang: 1_730_400 };
  assert.equal(buildPaymentLinkRequest(groupInput(deposit, "card_ewallet")).order.netAmount, 741_600);

  for (const bad of [Number.NaN, -1, 101, Number.POSITIVE_INFINITY, "3", undefined]) {
    assert.throws(() => buildPaymentLinkRequest({ ...groupInput(twoRooms, "card_ewallet"), expectedFeePct: bad as number }), RangeError, String(bad));
  }
  // The preview's legacy body (no group) is not affected.
  assert.equal(buildPaymentLinkRequest(linkInput()).order.netAmount, 1_464_750);
});

test("order items: one per room line plus the fee line, adding up to netAmount exactly", () => {
  const logs: string[] = [];
  const body = buildPaymentLinkRequest(groupInput(twoRooms, "card_ewallet", true, (m) => logs.push(m)));
  assert.deepEqual(
    body.order.orderItems.map((i) => [i.itemName, i.price, i.quantity]),
    [
      ["Sunrise Suite", 1_395_000, 1],
      ["Garden Suite", 1_005_000, 1],
      ["Payment processing fee (3%)", 72_000, 1],
    ],
  );
  assert.equal(
    body.order.orderItems.reduce((s, i) => s + i.price * i.quantity, 0),
    body.order.netAmount,
  );
  assert.equal(body.order.orderItems[0].description, "Oct 28, 2026 - Oct 31, 2026, 3 nights, 2 guests, Standard Rate");
  assert.equal(body.order.orderItems[1].description, "Oct 28, 2026 - Oct 31, 2026, 3 nights, 1 guest, Standard Rate");
  assert.deepEqual(logs, []);

  // PromptPay without a fee: no fee line at all.
  const qr = buildPaymentLinkRequest(groupInput(twoRoomsPromptPay, "promptpay"));
  assert.deepEqual(
    qr.order.orderItems.map((i) => [i.itemName, i.price]),
    [
      ["Sunrise Suite", 1_395_000],
      ["Garden Suite", 1_005_000],
    ],
  );
  assert.ok(qr.order.orderItems.every((i) => !/fee/i.test(i.itemName)));
});

test("order items that would not add up fall back to one item for the whole amount (beam_items_fallback)", () => {
  // A site-side promo is deducted below the rooms, so the room lines are above netAmount.
  const promo: Quote = {
    ...twoRooms,
    promo: { code: "SUMMER", pct: 10, label: "Summer", discountSatang: 240_000 },
    feeBaseSatang: 2_160_000,
    cardFeeSatang: 64_800,
    totalSatang: 2_224_800,
    dueNowSatang: 2_224_800,
  };
  const logs: { m: string; d?: Record<string, unknown> }[] = [];
  const body = buildPaymentLinkRequest(groupInput(promo, "card_ewallet", true, (m, d) => logs.push({ m, d })));
  assert.deepEqual(body.order.orderItems, [
    {
      itemName: "Booking MSV-20261005-7F3K: Sunrise Suite + Garden Suite",
      description: "Oct 28, 2026 - Oct 31, 2026, 3 nights",
      price: 2_224_800,
      quantity: 1,
      sku: "MSV-20261005-7F3K",
    },
  ]);
  assert.deepEqual(logs, [{ m: "beam_items_fallback", d: { ref: "MSV-20261005-7F3K", netAmount: 2_224_800, itemsSatang: 2_464_800, items: 3 } }]);
  assert.equal(body.order.netAmount, 2_224_800);
});

test("hosted page host follows the API base; any other base is refused before a request", async () => {
  assert.equal(beamHostedHost(BEAM_LIVE_BASE), "pay.beamcheckout.com");
  assert.equal(beamHostedHost(BEAM_PLAYGROUND_BASE), "playground-pay.beamcheckout.com");
  assert.equal(beamHostedHost("https://api.beamcheckout.com.evil.io"), null);
  assert.equal(isBeamHostedPageUrl("https://pay.beamcheckout.com/m1/a", BEAM_LIVE_BASE), true);
  assert.equal(isBeamHostedPageUrl("https://playground-pay.beamcheckout.com/m1/a", BEAM_LIVE_BASE), false);
  assert.equal(isBeamHostedPageUrl("https://pay.beamcheckout.com/m1/a", BEAM_PLAYGROUND_BASE), false);
  assert.equal(isBeamHostedPageUrl("http://pay.beamcheckout.com/m1/a", BEAM_LIVE_BASE), false);
  assert.equal(isBeamHostedPageUrl("https://pay.beamcheckout.com:8443/m1/a", BEAM_LIVE_BASE), false);
  assert.equal(isBeamHostedPageUrl("https://u:p@pay.beamcheckout.com/m1/a", BEAM_LIVE_BASE), false);
  assert.equal(isBeamHostedPageUrl("not a url", BEAM_LIVE_BASE), false);

  const body = buildPaymentLinkRequest(linkInput());
  const isHost = (e: unknown) => e instanceof BeamApiError && e.errorCode === "UNEXPECTED_HOST";
  // The playground host is refused on the live base, and the reverse; never retried.
  const live = scripted(json({ id: "a", url: "https://playground-pay.beamcheckout.com/m1/a" }, 201));
  await assert.rejects(createPaymentLink(LIVE_CREDS, body, "k", live.fetchImpl), isHost);
  assert.equal(live.calls.length, 1);
  const pg = scripted(json({ id: "a", url: "https://pay.beamcheckout.com/m1/a" }, 201));
  await assert.rejects(createPaymentLink(PG_CREDS, body, "k", pg.fetchImpl), isHost);
  assert.equal(pg.calls.length, 1);
  const ok = scripted(json({ id: "a", url: "https://pay.beamcheckout.com/m1/a" }, 201));
  assert.deepEqual(await createPaymentLink(LIVE_CREDS, body, "k", ok.fetchImpl), { id: "a", url: "https://pay.beamcheckout.com/m1/a" });

  // Credentials never go to another base.
  const evil = { ...LIVE_CREDS, apiBase: "https://api.beamcheckout.com.evil.io" };
  const none = scripted();
  await assert.rejects(createPaymentLink(evil, body, "k", none.fetchImpl), isHost);
  await assert.rejects(getPaymentLink(evil, "pl_1", none.fetchImpl), isHost);
  await assert.rejects(listPaymentLinkCharges(evil, { sourceId: "pl_1" }, none.fetchImpl), isHost);
  await assert.rejects(listLinkChargesSince(evil, { sinceMs: NOW }, none.fetchImpl), isHost);
  await assert.rejects(disablePaymentLink(evil, "pl_1", "k", none.fetchImpl), isHost);
  await assert.rejects(getRefund(evil, "re_1", none.fetchImpl), isHost);
  assert.equal(none.calls.length, 0);
});

test("disablePaymentLink: PATCH with the idempotency key; 202 disabled, a refusal on the link's state not_open, faults and 404/401/429/5xx throw", async () => {
  const ok = scripted(new Response(JSON.stringify({ code: 202, message: "accepted" }), { status: 202 }));
  assert.equal(await disablePaymentLink(PG_CREDS, "pl_1", "msv-bd-pl_1-n1", ok.fetchImpl), "disabled");
  assert.equal(ok.calls[0].url, "https://playground.api.beamcheckout.com/api/v1/payment-links/pl_1/disable");
  assert.equal(ok.calls[0].init.method, "PATCH");
  const headers = ok.calls[0].init.headers as Record<string, string>;
  assert.equal(headers["x-beam-idempotency-key"], "msv-bd-pl_1-n1");
  assert.equal(headers.authorization, basicAuthHeader("m1", "k1"));

  // Beam refuses because of the link's state: OPERATION_NOT_ALLOWED_ERROR / REQUEST_CONFLICT_ERROR on any
  // 4xx, or a 409/422 whose code is not a configuration fault (none, CHARGE_PENDING, a new code).
  const notOpen: [number, string | null][] = [
    [403, "OPERATION_NOT_ALLOWED_ERROR"],
    [409, "REQUEST_CONFLICT_ERROR"],
    [409, "OPERATION_NOT_ALLOWED_ERROR"],
    [422, "REQUEST_CONFLICT_ERROR"],
    [400, "OPERATION_NOT_ALLOWED_ERROR"],
    [409, null],
    [422, "SOME_NEW_CODE"],
    [422, "CHARGE_PENDING"],
  ];
  for (const [status, code] of notOpen) {
    const f = scripted(code === null ? json({ code: status, message: "conflict" }, status) : beamError(status, code));
    assert.equal(await disablePaymentLink(PG_CREDS, "pl_1", "k", f.fetchImpl), "not_open", `HTTP ${status} ${code}`);
    assert.equal(f.calls.length, 1);
  }

  // A configuration fault is never read as "already closed": it throws, so the caller alerts.
  const faults: [number, string | null][] = [
    [400, "API_VALIDATION_ERROR"],
    [400, "INVALID_JSON_ERROR"],
    [400, null],
    [403, "NO_PERMISSION_ERROR"],
    [403, null],
    [412, "IDEMPOTENCY_KEY_ERROR"],
    [422, "MERCHANT_STATUS_INVALID_ERROR"],
    [409, "IDEMPOTENCY_KEY_ERROR"],
    [410, "SOME_NEW_CODE"],
    [302, null],
  ];
  for (const [status, code] of faults) {
    const f = scripted(code === null ? new Response("<html>nope</html>", { status }) : beamError(status, code));
    await assert.rejects(
      disablePaymentLink(PG_CREDS, "pl_1", "k", f.fetchImpl),
      (e: unknown) => e instanceof BeamApiError && e.status === status && e.errorCode === code,
      `HTTP ${status} ${code}`,
    );
    assert.equal(f.calls.length, 1, "never retried");
  }

  const missing = scripted(beamError(404, "NOT_FOUND_ERROR"));
  await assert.rejects(disablePaymentLink(PG_CREDS, "pl_1", "k", missing.fetchImpl), (e: unknown) => isBeamNotFound(e));
  assert.equal(isBeamNotFound(new BeamApiError(410, null, "gone")), false);

  for (const status of [401, 429, 500, 503]) {
    let limited = 0;
    const f = scripted(beamError(status, status === 401 ? "INVALID_CREDENTIALS_ERROR" : "X"));
    await assert.rejects(
      disablePaymentLink(PG_CREDS, "pl_1", "k", f.fetchImpl, { onRateLimited: () => limited++ }),
      (e: unknown) => e instanceof BeamApiError && e.status === status,
    );
    assert.equal(f.calls.length, 1, "disable is never retried with the same key");
    assert.equal(limited, status === 429 ? 1 : 0);
  }

  const down = scripted(new TypeError("fetch failed"));
  await assert.rejects(disablePaymentLink(PG_CREDS, "pl_1", "k", down.fetchImpl), TypeError);

  const none = scripted();
  await assert.rejects(disablePaymentLink(PG_CREDS, "../pl_1", "k", none.fetchImpl), BeamApiError);
  await assert.rejects(disablePaymentLink(PG_CREDS, "pl_1", "", none.fetchImpl), RangeError);
  await assert.rejects(disablePaymentLink(PG_CREDS, "pl_1", "k".repeat(256), none.fetchImpl), RangeError);
  await assert.rejects(disablePaymentLink(PG_CREDS, "pl_1", "k", none.fetchImpl, { budgetMs: 0 }), BeamApiError);
  assert.equal(none.calls.length, 0);
});

function charge(id: string, createdAt: string) {
  return { chargeId: id, status: "SUCCEEDED", amount: 100_000, currency: "THB", source: "PAYMENT_LINK", sourceId: `pl_${id}`, createdAt };
}
const fullPage = (prefix: string, createdAt: string) => Array.from({ length: 100 }, (_, i) => charge(`${prefix}${i}`, createdAt));

test("charge scan: unfiltered PAYMENT_LINK pages of 100, stopping at the first charge older than sinceMs (offset-aware)", async () => {
  const sinceMs = Date.parse("2026-10-05T00:00:00Z");
  // 07:00+07:00 is 00:00Z (inside the window); 06:59:59+07:00 is 23:59:59Z the day before (outside).
  const page1 = [
    ...Array.from({ length: 30 }, (_, i) => charge(`b${i}`, "2026-10-05T07:00:00+07:00")),
    charge("old", "2026-10-05T06:59:59+07:00"),
    charge("older", "2026-10-04T01:00:00Z"),
  ];
  const f = scripted(json({ data: fullPage("a", "2026-10-05T10:00:00+07:00"), totalCount: 500 }), json({ data: page1, totalCount: 500 }));
  const scan = await listLinkChargesSince(PG_CREDS, { sinceMs }, f.fetchImpl);
  assert.equal(scan.complete, true);
  assert.equal(scan.charges.length, 130);
  assert.ok(!scan.charges.some((c) => c.chargeId === "old" || c.chargeId === "older"));
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, "https://playground.api.beamcheckout.com/api/v1/charges?source_in=PAYMENT_LINK&limit=100&offset=0");
  assert.equal(f.calls[1].url, "https://playground.api.beamcheckout.com/api/v1/charges?source_in=PAYMENT_LINK&limit=100&offset=100");

  // The end of the list completes the scan; a charge shifted onto the next page is counted once.
  const shifted = scripted(
    json({ data: fullPage("c", "2026-10-05T10:00:00+07:00") }),
    json({ data: [charge("c99", "2026-10-05T10:00:00+07:00"), charge("d1", "2026-10-05T09:00:00+07:00")] }),
  );
  const end = await listLinkChargesSince(PG_CREDS, { sinceMs }, shifted.fetchImpl);
  assert.equal(end.complete, true);
  assert.equal(end.charges.length, 101);
  assert.equal(end.charges.filter((c) => c.chargeId === "c99").length, 1);

  // An empty list is complete; a charge without a readable createdAt is kept and the scan goes on.
  assert.deepEqual(await listLinkChargesSince(PG_CREDS, { sinceMs }, scripted(json({ data: [], totalCount: 0 })).fetchImpl), {
    charges: [],
    complete: true,
  });
  const noTime = await listLinkChargesSince(PG_CREDS, { sinceMs }, scripted(json({ data: [charge("n1", "2026-10-05T10:00:00")] })).fetchImpl);
  assert.deepEqual(
    noTime.charges.map((c) => c.chargeId),
    ["n1"],
  );
});

test("charge scan: a charge shifted onto the next page keeps its freshest copy, at its first position (a SUCCEEDED copy wins)", async () => {
  const sinceMs = Date.parse("2026-10-05T00:00:00Z");
  const at = (id: string, status: string, updatedAt: string | undefined, failureCode = "") => ({
    ...charge(id, "2026-10-05T10:00:00+07:00"),
    status,
    failureCode,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  });
  const filler = Array.from({ length: 99 }, (_, i) => at(`x${i}`, "FAILED", "2026-10-05T10:01:00+07:00"));
  const scan = async (first: Record<string, unknown>, later: Record<string, unknown>) => {
    const f = scripted(json({ data: [...filler, first] }), json({ data: [later, at("y1", "FAILED", undefined)] }));
    const result = await listLinkChargesSince(PG_CREDS, { sinceMs }, f.fetchImpl);
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.charges.map((c) => c.chargeId),
      [...filler.map((c) => c.chargeId), "x99", "y1"],
      "each charge once, at the position it was first read",
    );
    return result.charges[99];
  };

  // PENDING on page 1, SUCCEEDED by the time page 2 is read: the success is kept (it used to be dropped).
  let kept = await scan(at("x99", "PENDING", "2026-10-05T10:00:00+07:00"), at("x99", "SUCCEEDED", "2026-10-05T10:02:00+07:00"));
  assert.equal(kept.status, "SUCCEEDED");
  assert.equal(kept.updatedAt, "2026-10-05T10:02:00+07:00");
  // A SUCCEEDED copy is never replaced by a copy in another state, whatever its time says.
  kept = await scan(at("x99", "SUCCEEDED", "2026-10-05T10:02:00+07:00"), at("x99", "PENDING", "2026-10-05T10:09:00+07:00"));
  assert.equal(kept.status, "SUCCEEDED");
  // Two copies in the same state: the later updatedAt wins; on a tie or without readable times, the later read.
  kept = await scan(at("x99", "FAILED", "2026-10-05T10:05:00+07:00", "first"), at("x99", "FAILED", "2026-10-05T10:01:00+07:00", "later"));
  assert.equal(kept.failureCode, "first");
  kept = await scan(at("x99", "FAILED", "2026-10-05T10:01:00+07:00", "first"), at("x99", "FAILED", "2026-10-05T03:05:00Z", "later"));
  assert.equal(kept.failureCode, "later", "offset-aware: 03:05Z is after 10:01+07:00");
  kept = await scan(at("x99", "FAILED", "2026-10-05T10:01:00+07:00", "first"), at("x99", "FAILED", "2026-10-05T10:01:00+07:00", "later"));
  assert.equal(kept.failureCode, "later");
  kept = await scan(at("x99", "PENDING", undefined, "first"), at("x99", "PENDING", "2026-10-05T10:01:00", "later"));
  assert.equal(kept.failureCode, "later");
});

test("charge scan stops at maxPages and at the budget with complete=false; a later page's failure keeps what was read", async () => {
  const sinceMs = Date.parse("2026-10-01T00:00:00Z");
  const pages = scripted(...[0, 1, 2, 3].map((p) => json({ data: fullPage(`p${p}-`, "2026-10-05T10:00:00+07:00"), totalCount: 10_000 })));
  const capped = await listLinkChargesSince(PG_CREDS, { sinceMs, maxPages: 3 }, pages.fetchImpl);
  assert.equal(capped.complete, false);
  assert.equal(capped.charges.length, 300);
  assert.equal(pages.calls.length, 3);
  await assert.rejects(listLinkChargesSince(PG_CREDS, { sinceMs, maxPages: 0 }, pages.fetchImpl), RangeError);
  await assert.rejects(listLinkChargesSince(PG_CREDS, { sinceMs: Number.NaN }, pages.fetchImpl), RangeError);

  // The default is 10 pages.
  const ten = scripted(...Array.from({ length: 11 }, (_, p) => json({ data: fullPage(`q${p}-`, "2026-10-05T10:00:00+07:00") })));
  const deep = await listLinkChargesSince(PG_CREDS, { sinceMs }, ten.fetchImpl);
  assert.equal(deep.complete, false);
  assert.equal(ten.calls.length, 10);

  // The budget covers the whole scan: each page costs 600 ms here, the budget is 2,500 ms and a
  // page is only started with at least 1,000 ms left.
  let clock = 0;
  const slow = (async () => {
    clock += 600;
    return json({ data: fullPage(`s${clock}-`, "2026-10-05T10:00:00+07:00") });
  }) as unknown as typeof fetch;
  const budgeted = await listLinkChargesSince(PG_CREDS, { sinceMs }, slow, { budgetMs: 2_500, now: () => clock });
  assert.equal(budgeted.complete, false);
  assert.equal(budgeted.charges.length, 300);
  assert.equal(clock, 1_800, "three pages; the fourth would not fit the remaining 700 ms");

  // Page 2 fails twice (the read retry): pages before it are kept.
  const { opts } = seams();
  const broken = scripted(json({ data: fullPage("e", "2026-10-05T10:00:00+07:00") }), beamError(503, "X"), beamError(503, "X"));
  const partial = await listLinkChargesSince(PG_CREDS, { sinceMs }, broken.fetchImpl, opts);
  assert.equal(partial.complete, false);
  assert.equal(partial.charges.length, 100);
  assert.equal(partial.error?.status, 503);
  assert.equal(broken.calls.length, 3);

  // The first page's refusal throws (e.g. Beam does not allow the unfiltered list).
  const refused = scripted(beamError(400, "API_VALIDATION_ERROR"));
  await assert.rejects(
    listLinkChargesSince(PG_CREDS, { sinceMs }, refused.fetchImpl, opts),
    (e: unknown) => e instanceof BeamApiError && e.status === 400,
  );
  assert.equal(refused.calls.length, 1);
});

test("reads retry once on 429 (calling onRateLimited), 5xx and network errors, with 100-400 ms jitter", async () => {
  const link = { paymentLinkId: "pl_1", status: "ACTIVE", order: { netAmount: 100_000, currency: "THB" }, feeType: "TRANSACTION_FEE" };
  let limited = 0;
  const s = seams(0.5);
  const f = scripted(beamError(429, "TOO_MANY_REQUESTS_ERROR"), json(link));
  const got = await getPaymentLink(PG_CREDS, "pl_1", f.fetchImpl, { ...s.opts, onRateLimited: () => limited++ });
  assert.equal(got.status, "ACTIVE");
  assert.equal(f.calls.length, 2);
  assert.equal(limited, 1);
  assert.equal(s.sleeps.length, 1);
  assert.ok(s.sleeps[0] >= 100 && s.sleeps[0] <= 400, `jitter ${s.sleeps[0]}`);
  const low = seams(0);
  await getPaymentLink(PG_CREDS, "pl_1", scripted(new TypeError("fetch failed"), json(link)).fetchImpl, low.opts);
  assert.deepEqual(low.sleeps, [100]);
  const high = seams(0.999999);
  await getPaymentLink(PG_CREDS, "pl_1", scripted(beamError(502, "X"), json(link)).fetchImpl, high.opts);
  assert.deepEqual(high.sleeps, [400]);

  // Twice 429: both counted, then the error.
  let twice = 0;
  const both = scripted(beamError(429, "TOO_MANY_REQUESTS_ERROR"), beamError(429, "TOO_MANY_REQUESTS_ERROR"));
  await assert.rejects(
    listPaymentLinkCharges(PG_CREDS, { sourceId: "pl_1" }, both.fetchImpl, { ...seams().opts, onRateLimited: () => twice++ }),
    (e: unknown) => e instanceof BeamApiError && e.status === 429,
  );
  assert.equal(both.calls.length, 2);
  assert.equal(twice, 2);

  // A throwing counter never breaks the read.
  const thrower = scripted(beamError(429, "TOO_MANY_REQUESTS_ERROR"), json(link));
  const read = await getPaymentLink(PG_CREDS, "pl_1", thrower.fetchImpl, {
    ...seams().opts,
    onRateLimited: () => {
      throw new Error("counter down");
    },
  });
  assert.equal(read.paymentLinkId, "pl_1");

  // 4xx is not retried; 404 is recognisable.
  const missing = scripted(beamError(404, "NOT_FOUND_ERROR"));
  await assert.rejects(getPaymentLink(PG_CREDS, "pl_1", missing.fetchImpl, seams().opts), (e: unknown) => isBeamNotFound(e));
  assert.equal(missing.calls.length, 1);

  // No retry when the caller's budget can't fit it: the first attempt used 1,200 of 1,500 ms.
  let clock = 0;
  const late = (async () => {
    clock += 1_200;
    return beamError(503, "X");
  }) as unknown as typeof fetch;
  const lateSeams = seams();
  await assert.rejects(getPaymentLink(PG_CREDS, "pl_1", late, { ...lateSeams.opts, budgetMs: 1_500, now: () => clock }), BeamApiError);
  assert.equal(clock, 1_200, "one attempt only");
  assert.deepEqual(lateSeams.sleeps, []);
  // A spent budget makes no call at all.
  const spent = scripted();
  await assert.rejects(
    getPaymentLink(PG_CREDS, "pl_1", spent.fetchImpl, { budgetMs: 0 }),
    (e: unknown) => e instanceof BeamApiError && e.errorCode === "BUDGET_EXHAUSTED",
  );
  assert.equal(spent.calls.length, 0);
});

test("createPaymentLink: onRateLimited on 429, and no same-key retry once the budget can't fit it", async () => {
  let limited = 0;
  const f = scripted(beamError(429, "TOO_MANY_REQUESTS_ERROR"), json({ id: "a", url: "https://playground-pay.beamcheckout.com/m1/a" }, 201));
  await createPaymentLink(PG_CREDS, buildPaymentLinkRequest(linkInput()), "same", f.fetchImpl, { onRateLimited: () => limited++ });
  assert.equal(limited, 1);
  assert.deepEqual(
    f.calls.map((c) => (c.init.headers as Record<string, string>)["x-beam-idempotency-key"]),
    ["same", "same"],
  );

  let clock = 0;
  let n = 0;
  const slow = (async () => {
    n++;
    clock += 4_500;
    return beamError(503, "X");
  }) as unknown as typeof fetch;
  await assert.rejects(
    createPaymentLink(PG_CREDS, buildPaymentLinkRequest(linkInput()), "k", slow, { budgetMs: 5_000, now: () => clock }),
    (e: unknown) => e instanceof BeamApiError && e.status === 503,
  );
  assert.equal(n, 1);
});

test("createPaymentLink: the 429/5xx/network retry waits 100-400 ms of jitter first, same key and body, only while the budget fits it", async () => {
  const created = { id: "a", url: "https://playground-pay.beamcheckout.com/m1/a" };
  const body = buildPaymentLinkRequest(linkInput());
  for (const first of [beamError(429, "TOO_MANY_REQUESTS_ERROR"), beamError(503, "X"), new TypeError("fetch failed")]) {
    const s = seams(0.5);
    let limited = 0;
    const f = scripted(first, json(created, 201));
    assert.deepEqual(await createPaymentLink(PG_CREDS, body, "same-key", f.fetchImpl, { ...s.opts, onRateLimited: () => limited++ }), created);
    assert.equal(s.sleeps.length, 1, "one wait, before the retry");
    assert.ok(s.sleeps[0] >= 100 && s.sleeps[0] <= 400, `jitter ${s.sleeps[0]}`);
    assert.deepEqual(
      f.calls.map((c) => (c.init.headers as Record<string, string>)["x-beam-idempotency-key"]),
      ["same-key", "same-key"],
    );
    assert.equal(f.calls[1].init.body, f.calls[0].init.body, "the same body");
    assert.equal(limited, first instanceof Response && first.status === 429 ? 1 : 0);
  }
  const low = seams(0);
  await createPaymentLink(PG_CREDS, body, "k", scripted(beamError(502, "X"), json(created, 201)).fetchImpl, low.opts);
  assert.deepEqual(low.sleeps, [100]);
  const high = seams(0.999999);
  await createPaymentLink(PG_CREDS, body, "k", scripted(beamError(502, "X"), json(created, 201)).fetchImpl, high.opts);
  assert.deepEqual(high.sleeps, [400]);

  // A 4xx is neither retried nor waited for.
  const no = seams();
  const bad = scripted(beamError(400, "API_VALIDATION_ERROR"));
  await assert.rejects(createPaymentLink(PG_CREDS, body, "k", bad.fetchImpl, no.opts), BeamApiError);
  assert.deepEqual(no.sleeps, []);
  assert.equal(bad.calls.length, 1);

  // The budget must still hold the jitter plus a 1,000 ms attempt: the first attempt used 3,500 of 5,000 ms,
  // so a 400 ms wait leaves 1,100 (retry) ...
  let clock = 0;
  const answers = [beamError(503, "X"), json(created, 201)];
  const timed = (async () => {
    clock += 3_500;
    return answers.shift();
  }) as unknown as typeof fetch;
  const fits = seams(0.999999);
  assert.deepEqual(await createPaymentLink(PG_CREDS, body, "k-fit", timed, { ...fits.opts, budgetMs: 5_000, now: () => clock }), created);
  assert.deepEqual(fits.sleeps, [400]);
  // ... while after 3,700 ms it would leave 900: no wait and no retry.
  clock = 0;
  let n = 0;
  const slower = (async () => {
    n++;
    clock += 3_700;
    return beamError(429, "TOO_MANY_REQUESTS_ERROR");
  }) as unknown as typeof fetch;
  const tight = seams(0.999999);
  await assert.rejects(
    createPaymentLink(PG_CREDS, body, "k-tight", slower, { ...tight.opts, budgetMs: 5_000, now: () => clock }),
    (e: unknown) => e instanceof BeamApiError && e.status === 429,
  );
  assert.equal(n, 1);
  assert.deepEqual(tight.sleeps, []);
});

test("an unknown errorCode is kept as an open string; beamErrorInfo carries no PII", async () => {
  const f = scripted(beamError(422, "CHARGE_PENDING", "a charge is still pending"));
  const err = await getPaymentLink(PG_CREDS, "pl_1", f.fetchImpl, seams().opts).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof BeamApiError);
  assert.equal(err.errorCode, "CHARGE_PENDING");
  assert.equal(f.calls.length, 1, "422 is not retried");
  assert.deepEqual(beamErrorInfo(err), { status: 422, errorCode: "CHARGE_PENDING", message: "Beam HTTP 422: a charge is still pending" });

  const nonJson = scripted(new Response("<html>bad request</html>", { status: 400 }));
  await assert.rejects(getPaymentLink(PG_CREDS, "pl_1", nonJson.fetchImpl), (e: unknown) => e instanceof BeamApiError && e.errorCode === null);

  const leaky = new BeamApiError(
    400,
    "API_VALIDATION_ERROR",
    "Beam HTTP 400: guest jane.doe@example.com, phone +66 95 805 1075, card 4111111111111111, redirect https://magicsamui.com/booking-preview/return?ref=MSV-1&t=secret-token",
  );
  const info = beamErrorInfo(leaky);
  assert.equal(info.status, 400);
  assert.equal(info.errorCode, "API_VALIDATION_ERROR");
  for (const secret of ["jane.doe", "@", "805", "4111", "secret-token", "t="]) {
    assert.ok(!info.message.includes(secret), `${secret} in ${info.message}`);
  }
  assert.match(info.message, /^Beam HTTP 400: /);
  assert.deepEqual(beamErrorInfo(new TypeError("fetch failed")), { status: null, errorCode: "NETWORK_ERROR", message: "TypeError: fetch failed" });
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  assert.equal(beamErrorInfo(timeout).errorCode, "TIMEOUT");
  assert.deepEqual(beamErrorInfo("boom"), { status: null, errorCode: null, message: "Beam request failed" });
});

test("timestamps are parsed only with Z or an offset (+07:00 from GET answers)", () => {
  assert.equal(parseBeamTime("2026-10-05T10:30:00+07:00"), Date.parse("2026-10-05T03:30:00Z"));
  assert.equal(parseBeamTime("2026-10-05T10:30:00.123456+07:00"), Date.parse("2026-10-05T03:30:00.123Z"));
  assert.equal(parseBeamTime("2026-10-05T10:30:00+0700"), Date.parse("2026-10-05T03:30:00Z"));
  assert.equal(parseBeamTime("2025-07-23T10:15:56.102401Z"), Date.parse("2025-07-23T10:15:56.102Z"));
  assert.equal(parseBeamTime(" 2026-10-05T03:30:00Z "), Date.parse("2026-10-05T03:30:00Z"));
  for (const bad of ["2026-10-05T10:30:00", "2026-10-05", "", "yesterday", "2026-13-45T99:99:99Z", null, undefined, 1_791_171_000_000]) {
    assert.equal(parseBeamTime(bad), null, String(bad));
  }
});

test("charges are reduced to the fields we use: no customer block, no card last4, card brand/country only", async () => {
  const webhookCharge = JSON.parse(VECTOR_BODY) as Record<string, unknown>;
  const f = scripted(json({ data: [webhookCharge, "junk", null], totalCount: 1 }));
  const charges = await listPaymentLinkCharges(PG_CREDS, { sourceId: "57Iot6c11o" }, f.fetchImpl);
  assert.equal(f.calls[0].url, "https://playground.api.beamcheckout.com/api/v1/charges?source_in=PAYMENT_LINK&limit=100&sourceId=57Iot6c11o");
  assert.deepEqual(charges, [
    {
      chargeId: "ch_30GtUweMWec7r2hHIsV5xxQeJKp",
      status: "SUCCEEDED",
      amount: 3_000_000,
      currency: "THB",
      merchantId: "m_2sHxsByPwESKYM4nMwdEBdhubPS",
      referenceId: "order#10001",
      source: "PAYMENT_LINK",
      sourceId: "57Iot6c11o",
      failureCode: "",
      transactionTime: "2025-07-23T10:16:12Z",
      createdAt: "2025-07-23T10:15:56.102401Z",
      updatedAt: "2025-07-23T10:16:17.418991Z",
      paymentMethod: { paymentMethodType: "CARD", card: { brand: "VISA" } },
    },
  ]);
  assert.ok(!JSON.stringify(charges).includes("0958051075"));
  assert.ok(!JSON.stringify(charges).includes("last4"), "the card's last four digits never leave the client");
  assert.ok(!JSON.stringify(charges).includes("1111"));
  assert.deepEqual(parseBeamCharge({ chargeId: "ch_1", paymentMethod: { paymentMethodType: "CARD", card: { brand: "JCB", last4: "0005", countryAlpha2: "JP" } } })?.paymentMethod, {
    paymentMethodType: "CARD",
    card: { brand: "JCB", countryAlpha2: "JP" },
  });
  assert.deepEqual(parseBeamCharge(webhookCharge), charges[0]);
  assert.equal(parseBeamCharge([]), null);

  // A malformed list is an error, never "no charges".
  const malformed = scripted(json({ items: [] }));
  await assert.rejects(
    listPaymentLinkCharges(PG_CREDS, { sourceId: "pl_1" }, malformed.fetchImpl),
    (e: unknown) => e instanceof BeamApiError && e.errorCode === "INVALID_RESPONSE",
  );
  const byRef = scripted(json({ data: [] }));
  assert.deepEqual(await listPaymentLinkCharges(PG_CREDS, { referenceId: "MSV-20261005-7F3K" }, byRef.fetchImpl), []);
  assert.match(byRef.calls[0].url, /limit=100&referenceId=MSV-20261005-7F3K$/);
});

test("getPaymentLink reads the full link (note, items, settings, fee type) and refuses an answer for another link", async () => {
  const link = {
    paymentLinkId: "pl_1",
    merchantId: "m1",
    url: "https://pay.beamcheckout.com/m1/pl_1",
    status: "EXPIRED",
    order: {
      netAmount: 2_472_000,
      currency: "THB",
      referenceId: "MSV-20261005-7F3K",
      internalNote: NOTE,
      orderItems: [{ itemName: "Sunrise Suite", price: 2_472_000, quantity: 1 }],
    },
    linkSettings: { card: { isEnabled: true }, eWallets: { isEnabled: true } },
    redirectUrl: "https://magicsamui.com/booking-preview/return?ref=MSV-20261005-7F3K&t=x",
    cancelUrl: "https://magicsamui.com/booking-preview?resume=payment&ref=MSV-20261005-7F3K&t=x",
    expiresAt: "2026-10-05T10:30:00+07:00",
    feeType: "TRANSACTION_FEE",
    collectPhoneNumber: false,
  };
  const f = scripted(json(link));
  const got = await getPaymentLink(LIVE_CREDS, "pl_1", f.fetchImpl);
  assert.equal(f.calls[0].url, "https://api.beamcheckout.com/api/v1/payment-links/pl_1");
  assert.equal(got.order.internalNote, NOTE);
  assert.deepEqual(got.order.orderItems, [{ itemName: "Sunrise Suite", price: 2_472_000, quantity: 1 }]);
  assert.deepEqual(got.linkSettings, { card: { isEnabled: true }, eWallets: { isEnabled: true } });
  assert.equal(got.feeType, "TRANSACTION_FEE");
  assert.equal(got.merchantId, "m1");
  assert.equal(parseBeamTime(got.expiresAt), Date.parse("2026-10-05T03:30:00Z"));
  const other = scripted(json({ ...link, paymentLinkId: "pl_2" }));
  await assert.rejects(
    getPaymentLink(LIVE_CREDS, "pl_1", other.fetchImpl),
    (e: unknown) => e instanceof BeamApiError && e.errorCode === "INVALID_RESPONSE",
  );
  const notJson = scripted(new Response("not json", { status: 200 }));
  await assert.rejects(
    getPaymentLink(LIVE_CREDS, "pl_1", notJson.fetchImpl),
    (e: unknown) => e instanceof BeamApiError && e.errorCode === "INVALID_RESPONSE",
  );
  assert.equal(notJson.calls.length, 1);
  assert.equal(isBeamLinkId("pl_1"), true);
  assert.equal(isBeamLinkId("rGtqz6DafS"), true);
  assert.equal(isBeamLinkId("../x"), false);
  assert.equal(isBeamLinkId("a".repeat(65)), false);
  assert.equal(isBeamLinkId(42), false);
});

test("getRefund reads one refund's real status and drops the free-text reason", async () => {
  const f = scripted(
    json({
      refundId: "re_1",
      chargeId: "ch_1",
      merchantId: "m1",
      referenceId: "MSV-20261005-7F3K",
      amount: 1_236_000,
      currency: "THB",
      status: "FAILED",
      failureCode: "RE_PROCESSING_FAILED",
      refundReason: "Guest Jane Doe cancelled, call +66958051075",
      createdAt: "2026-10-06T09:00:00+07:00",
      updatedAt: "2026-10-06T09:01:00+07:00",
    }),
  );
  const refund = await getRefund(PG_CREDS, "re_1", f.fetchImpl);
  assert.equal(f.calls[0].url, "https://playground.api.beamcheckout.com/api/v1/refunds/re_1");
  assert.deepEqual(refund, {
    refundId: "re_1",
    chargeId: "ch_1",
    amount: 1_236_000,
    currency: "THB",
    status: "FAILED",
    merchantId: "m1",
    referenceId: "MSV-20261005-7F3K",
    failureCode: "RE_PROCESSING_FAILED",
    createdAt: "2026-10-06T09:00:00+07:00",
  });
  const other = scripted(json({ refundId: "re_2", status: "SUCCEEDED" }));
  await assert.rejects(getRefund(PG_CREDS, "re_1", other.fetchImpl), (e: unknown) => e instanceof BeamApiError && e.errorCode === "INVALID_RESPONSE");
  const none = scripted();
  await assert.rejects(getRefund(PG_CREDS, "re/../1", none.fetchImpl), BeamApiError);
  assert.equal(none.calls.length, 0);
  assert.equal(parseBeamRefund({ chargeId: "ch_1" }), null);
});

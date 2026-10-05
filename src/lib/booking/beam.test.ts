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

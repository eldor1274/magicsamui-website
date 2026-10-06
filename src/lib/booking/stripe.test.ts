import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeStripe, stripeSignatureHeader } from "./mock/fakeStripe.ts";
import {
  buildCheckoutSessionParams,
  createStripeClient,
  isSessionId,
  isSignatureError,
  isStripeCheckoutUrl,
  parseSessionMeta,
  sessionMetadata,
  sessionPaymentState,
  verifyStripeWebhook,
} from "./payments/stripe.ts";
import { computeQuote } from "./quote.ts";
import type { Quote, RoomOffer } from "./types.ts";

const SECRET = "whsec_unit_0123456789abcdef";
const NOW = Date.parse("2026-10-05T03:00:00Z");

function quote(feePct = 5): Quote {
  const offers: RoomOffer[] = [
    {
      slug: "garden-suite",
      available: true,
      unavailableReason: null,
      remaining: 1,
      fitsParty: true,
      rates: [
        {
          ratePlanId: "standard",
          ratePlanName: "Standard Rate",
          baseNightly: [
            { date: "2027-11-10", amountSatang: 300_000 },
            { date: "2027-11-11", amountSatang: 300_050 },
          ],
          supplementSatangPerGuestPerNight: 0,
          adultsExtraSatang: {},
          totalSatang: 600_050,
          pricedForAdults: 2,
        },
      ],
    },
  ];
  return computeQuote(
    { checkIn: "2027-11-10", checkOut: "2027-11-12", items: [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }], promo: null, pricing: { cardFeePct: feePct, depositPct: 100 } },
    offers,
  );
}

const INPUT = {
  ref: "MSV-20261005-7F3K",
  reservationId: "6954439751495",
  customerEmail: "guest@example.com",
  successUrl: "https://magicsamui.com/booking-preview/return?ref=MSV-20261005-7F3K&t=x&session_id={CHECKOUT_SESSION_ID}",
  cancelUrl: "https://magicsamui.com/booking-preview?resume=payment",
  nowMs: NOW,
  ttlMinutes: 30,
  allowedPaymentMethodTypes: ["card", "promptpay"],
  merchantName: "Magic Suites & Villas",
  mode: "stripe-test",
};

test("session params: THB satang 1:1, rooms + fee lines add up to the charge, metadata without PII", () => {
  const q = quote();
  const p = buildCheckoutSessionParams({ ...INPUT, quote: q });
  assert.equal(p.mode, "payment");
  assert.equal(p.submit_type, "book");
  assert.equal(p.locale, "auto");
  // Always the THB price the guest was shown: Adaptive Pricing pinned off, whatever the Dashboard default.
  assert.deepEqual(p.adaptive_pricing, { enabled: false });
  assert.equal(p.client_reference_id, INPUT.ref);
  assert.equal(p.customer_email, "guest@example.com");
  assert.deepEqual(p.allowed_payment_method_types, ["card", "promptpay"]);
  const amounts = p.line_items!.map((li) => li.price_data!.unit_amount);
  assert.deepEqual(amounts, [600_050, 30_003]); // 5% of 6,000.50 THB = 300.0250 -> 300.03 THB
  assert.ok(p.line_items!.every((li) => li.price_data!.currency === "thb"));
  assert.equal(amounts.reduce((a, b) => a! + b!, 0), q.totalSatang);
  assert.equal(p.expires_at, Math.floor(NOW / 1000) + 31 * 60);
  assert.equal(p.metadata!.msv_total_satang, String(q.totalSatang));
  assert.deepEqual(p.payment_intent_data!.metadata, p.metadata);
  assert.equal(JSON.stringify(p.metadata).includes("guest@"), false);
  // Without a fee there is no fee line.
  const nofee = buildCheckoutSessionParams({ ...INPUT, quote: quote(0) });
  assert.equal(nofee.line_items!.length, 1);
  // Dynamic payment methods: no filter sent.
  assert.equal("allowed_payment_method_types" in buildCheckoutSessionParams({ ...INPUT, quote: q, allowedPaymentMethodTypes: null }), false);
});

test("session params refuse anything Stripe bookings don't support", () => {
  const q = quote();
  assert.throws(() => buildCheckoutSessionParams({ ...INPUT, quote: { ...q, dueNowSatang: q.totalSatang - 100 } }), RangeError);
  assert.throws(() => buildCheckoutSessionParams({ ...INPUT, quote: q, successUrl: "https://magicsamui.com/booking-preview/return" }), RangeError);
  assert.throws(() => buildCheckoutSessionParams({ ...INPUT, quote: { ...q, promo: { code: "DIRECT", pct: 10, label: "x", discountSatang: 1 } } }), RangeError);
  // Above Stripe's 8-digit maximum (THB 999,999.99).
  const big = { ...q, lines: [{ ...q.lines[0], roomSatang: 100_000_000 }], roomsSubtotalSatang: 100_000_000, cardFeeSatang: 0, totalSatang: 100_000_000, dueNowSatang: 100_000_000 };
  assert.throws(() => buildCheckoutSessionParams({ ...INPUT, quote: big }), /maximum charge/);
});

test("metadata round-trips; foreign or tampered sessions are not ours", () => {
  const md = sessionMetadata({ ref: INPUT.ref, reservationId: "123", roomsSatang: 1000, feeSatang: 50, totalSatang: 1050, checkIn: "2027-11-10", checkOut: "2027-11-12", mode: "stripe-test" });
  assert.deepEqual(parseSessionMeta({ metadata: md, client_reference_id: INPUT.ref })?.totalSatang, 1050);
  assert.equal(parseSessionMeta({ metadata: md, client_reference_id: "other" }), null);
  assert.equal(parseSessionMeta({ metadata: {}, client_reference_id: null }), null);
  assert.equal(parseSessionMeta({ metadata: { ...md, msv_total_satang: "9999" }, client_reference_id: INPUT.ref }), null, "rooms + fee must equal total");
});

test("session state mapping", () => {
  const base = { payment_intent: null } as const;
  assert.equal(sessionPaymentState({ ...base, status: "open", payment_status: "unpaid" }), "open");
  assert.equal(sessionPaymentState({ ...base, status: "expired", payment_status: "unpaid" }), "expired");
  assert.equal(sessionPaymentState({ ...base, status: "complete", payment_status: "paid" }), "paid");
  assert.equal(sessionPaymentState({ ...base, status: "complete", payment_status: "unpaid" }), "processing");
  const failedPi = { id: "pi_1", status: "requires_payment_method" } as never;
  assert.equal(sessionPaymentState({ status: "complete", payment_status: "unpaid", payment_intent: failedPi }), "failed");
});

test("webhook signature: valid passes; tampered body, wrong secret, old timestamp and missing header are rejected", () => {
  const payload = JSON.stringify({ id: "evt_1", object: "event", type: "checkout.session.completed", data: { object: { id: "cs_test_x" } } });
  const t = Math.floor(NOW / 1000);
  const header = stripeSignatureHeader(payload, SECRET, t);
  assert.equal(verifyStripeWebhook(payload, header, SECRET, NOW).id, "evt_1");
  assert.equal(verifyStripeWebhook(new TextEncoder().encode(payload), header, SECRET, NOW).id, "evt_1", "raw bytes work too");

  const reject = (fn: () => unknown, label: string) =>
    assert.throws(fn, (e: unknown) => isSignatureError(e), label);
  reject(() => verifyStripeWebhook(payload.replace("evt_1", "evt_2"), header, SECRET, NOW), "tampered body");
  reject(() => verifyStripeWebhook(payload + " ", header, SECRET, NOW), "re-serialised body");
  reject(() => verifyStripeWebhook(payload, header, "whsec_other_0123456789", NOW), "wrong secret");
  reject(() => verifyStripeWebhook(payload, header, SECRET, NOW + 301_000), "older than 5 minutes");
  reject(() => verifyStripeWebhook(payload, stripeSignatureHeader(payload, SECRET, t - 600), SECRET, NOW), "old timestamp");
  reject(() => verifyStripeWebhook(payload, null, SECRET, NOW), "missing header");
  reject(() => verifyStripeWebhook(payload, `t=${t},v1=${"0".repeat(64)}`, SECRET, NOW), "forged signature");
  // Within tolerance is fine.
  assert.equal(verifyStripeWebhook(payload, header, SECRET, NOW + 299_000).id, "evt_1");
});

test("the real SDK works against the fake: create (idempotent), retrieve with expansion, expire, list", async () => {
  const fake = createFakeStripe({ webhookSecret: SECRET, now: () => NOW });
  const stripe = createStripeClient("sk_test_unit0123456789", { fetchImpl: fake.fetch });
  const params = buildCheckoutSessionParams({ ...INPUT, quote: quote() });
  const a = await stripe.checkout.sessions.create(params, { idempotencyKey: "k1" });
  const b = await stripe.checkout.sessions.create(params, { idempotencyKey: "k1" });
  assert.equal(a.id, b.id, "same idempotency key -> same session");
  assert.ok(isSessionId(a.id));
  assert.equal(a.amount_total, quote().totalSatang);
  const sent = fake.calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
  assert.equal((sent.metadata as Record<string, string>).msv_ref, INPUT.ref);
  fake.complete(a.id);
  const r = await stripe.checkout.sessions.retrieve(a.id, { expand: ["payment_intent"] });
  assert.equal(sessionPaymentState(r), "paid");
  assert.equal(typeof r.payment_intent === "object" && r.payment_intent?.status, "succeeded");
  const c = await stripe.checkout.sessions.create(params, { idempotencyKey: "k2" });
  await stripe.checkout.sessions.expire(c.id);
  await assert.rejects(stripe.checkout.sessions.expire(c.id), "an expired session can't be expired again");
  const listed = [];
  for await (const s of stripe.checkout.sessions.list({ created: { gte: Math.floor(NOW / 1000) - 60 }, limit: 1 })) listed.push(s.id);
  assert.equal(listed.length, 2, "auto-pagination walks every page");
  // Stripe rejects an expiry under 30 minutes.
  await assert.rejects(stripe.checkout.sessions.create({ ...params, expires_at: Math.floor(NOW / 1000) + 600 }));
});

test("redirect allow-list: checkout.stripe.com only (plus our own mock page in stripe-mock)", () => {
  assert.equal(isStripeCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_abc"), true);
  assert.equal(isStripeCheckoutUrl("http://checkout.stripe.com/c/pay/cs_test_abc"), false);
  assert.equal(isStripeCheckoutUrl("https://checkout.stripe.com.evil.io/c/pay"), false);
  assert.equal(isStripeCheckoutUrl("http://localhost:3000/booking-preview/stripe-mock?session_id=x"), false);
  assert.equal(isStripeCheckoutUrl("http://localhost:3000/booking-preview/stripe-mock?session_id=x", "http://localhost:3000"), true);
  assert.equal(isStripeCheckoutUrl(null), false);
});

test("client redirect allow-list (apiClient) and server guest validation", async () => {
  const { isAllowedPaymentRedirect } = await import("./apiClient.ts");
  const here = "https://magicsamui.com/booking-preview";
  assert.equal(isAllowedPaymentRedirect("https://checkout.stripe.com/c/pay/cs_live_x", here), true);
  assert.equal(isAllowedPaymentRedirect("https://pay.beamcheckout.com/x", here), true);
  assert.equal(isAllowedPaymentRedirect("/booking-preview/stripe-mock?session_id=x", here), true);
  assert.equal(isAllowedPaymentRedirect("http://checkout.stripe.com/x", here), false);
  assert.equal(isAllowedPaymentRedirect("https://evil.example/x", here), false);

  const { parseGuestInput } = await import("./validate.ts");
  const { cloudbedsArrivalTime, internationalPhone } = await import("./guest.ts");
  const good = { firstName: " Zoë ", lastName: "O'Brien-Smith", country: "gb", email: "z@example.co.uk", dialCode: "+44", phone: "7700 900000", postcode: "", arrivalTime: "late", specialRequests: "", agreedToPolicy: true, extra: "ignored" };
  const ok = parseGuestInput(good);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.firstName, "Zoë");
    assert.equal(ok.value.country, "GB");
    assert.equal("extra" in ok.value, false);
    assert.equal(internationalPhone(ok.value), "+44 7700900000");
    assert.equal(cloudbedsArrivalTime(ok.value.arrivalTime), null);
  }
  assert.equal(cloudbedsArrivalTime("9:00"), "09:00");
  for (const bad of [
    { ...good, email: "nope" },
    { ...good, agreedToPolicy: false },
    { ...good, firstName: "" },
    { ...good, firstName: "<script>" },
    { ...good, postcode: "<>" },
    { ...good, arrivalTime: "03:00" },
    { ...good, phone: "12" },
    null,
    "string",
  ]) {
    const r = parseGuestInput(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    // Issue strings never echo what was typed.
    if (!r.ok) assert.equal(r.issues.join(" ").includes("<script>"), false);
  }
});

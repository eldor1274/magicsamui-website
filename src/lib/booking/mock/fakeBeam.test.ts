// Self-test of the in-repo fake Beam (S2.2): the REAL beam.ts client runs
// against it, so these tests also pin that the fake speaks the client's
// language (Basic auth, idempotency, status codes, Bangkok timestamps).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BeamApiError,
  basicAuthHeader,
  buildPaymentLinkRequest,
  createPaymentLink,
  disablePaymentLink,
  getPaymentLink,
  getRefund,
  isBeamHostedPageUrl,
  isBeamLinkId,
  isBeamNotFound,
  listLinkChargesSince,
  listPaymentLinkCharges,
  parseBeamCharge,
  parseBeamTime,
  verifyBeamSignature,
} from "../beam.ts";
import type { BeamCreatePaymentLinkRequest, BeamMethodGroup } from "../beam.ts";
import { BEAM_LIVE_BASE, BEAM_PLAYGROUND_BASE } from "../config.ts";
import type { Quote, QuoteLine } from "../types.ts";
import { FAKE_BEAM_LINK_ID_PATTERN, bangkokTime, beamSignature, createFakeBeam, fakeBeamLinkId } from "./fakeBeam.ts";
import type { FakeBeam, FakeBeamBase, FakeBeamOptions } from "./fakeBeam.ts";

type J = Record<string, unknown>;

const T0 = Date.parse("2026-10-22T03:00:00Z");
const REF = "MSV-20261022-7F3K";
const NOTE = "msv1|m=beam-playground|r=MSV-20261022-7F3K|s=abcdefghijklmnopqrstuvwxyz0";
/** No real waiting in the client's read retry. */
const FAST = { sleep: async () => undefined, random: () => 0 };

// Two rooms on the 3% card/e-wallet fee (2,472,000 satang); PromptPay without a fee (2,400,000).
const line: QuoteLine = {
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
};
const cardQuote: Quote = {
  currency: "THB",
  checkIn: "2026-11-10",
  checkOut: "2026-11-13",
  nights: 3,
  lines: [line, { ...line, slug: "garden-suite", roomName: "Garden Suite", adults: 1, roomSatang: 1_005_000 }],
  roomsSubtotalSatang: 2_400_000,
  addonsSubtotalSatang: 0,
  promo: null,
  feeBaseSatang: 2_400_000,
  cardFeePct: 3,
  cardFeeSatang: 72_000,
  totalSatang: 2_472_000,
  depositPct: 100,
  dueNowSatang: 2_472_000,
  balanceSatang: 0,
};
const promptPayQuote: Quote = { ...cardQuote, cardFeePct: 0, cardFeeSatang: 0, totalSatang: 2_400_000, dueNowSatang: 2_400_000 };

function linkBody(nowMs: number, group: BeamMethodGroup = "card_ewallet", ref = REF): BeamCreatePaymentLinkRequest {
  return buildPaymentLinkRequest({
    ref,
    quote: group === "promptpay" ? promptPayQuote : cardQuote,
    merchantName: "Magic Suites & Villas",
    redirectUrl: `https://magicsamui.com/booking/return?ref=${ref}&t=x`,
    cancelUrl: `https://magicsamui.com/booking?resume=payment&ref=${ref}&t=x`,
    nowMs,
    ttlMinutes: 30,
    group,
    ewallets: true,
    internalNote: NOTE,
  });
}

function setup(extra: FakeBeamOptions = {}) {
  let t = T0;
  const fake = createFakeBeam({ now: () => t, ...extra });
  return {
    fake,
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

let keySeq = 0;
async function newLink(fake: FakeBeam, nowMs: number, group: BeamMethodGroup = "card_ewallet", ref = REF): Promise<string> {
  const res = await createPaymentLink(fake.creds, linkBody(nowMs, group, ref), `msv-cl-test-${++keySeq}`, fake.fetch);
  return res.id;
}

/** A request straight to the fake, without the client's checks. */
async function raw(
  fake: FakeBeam,
  method: string,
  path: string,
  opts: { body?: unknown; key?: string; auth?: string | null; base?: string } = {},
): Promise<{ status: number; json: J }> {
  const headers: Record<string, string> = { accept: "application/json" };
  const auth = opts.auth === undefined ? basicAuthHeader(fake.creds.merchantId, fake.creds.apiKey) : opts.auth;
  if (auth !== null) headers.authorization = auth;
  if (opts.key !== undefined) headers["x-beam-idempotency-key"] = opts.key;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  const res = await fake.fetch(`${opts.base ?? fake.apiBase}${path}`, { method, headers, body });
  return { status: res.status, json: (await res.json()) as J };
}

const errorCodeOf = (j: J) => (j.error as J | undefined)?.errorCode;

function rejectsWith(status: number, errorCode: string | null) {
  return (e: unknown) => e instanceof BeamApiError && e.status === status && e.errorCode === errorCode;
}

test("the real client creates a link: Beam's id format, the base's own hosted host, and GET reads it back", async () => {
  for (const base of ["playground", "live"] as FakeBeamBase[]) {
    const { fake } = setup({ base });
    const apiBase = base === "live" ? BEAM_LIVE_BASE : BEAM_PLAYGROUND_BASE;
    assert.equal(fake.creds.apiBase, apiBase);
    const body = linkBody(T0);
    const res = await createPaymentLink(fake.creds, body, "msv-cl-1", fake.fetch);
    assert.match(res.id, FAKE_BEAM_LINK_ID_PATTERN);
    assert.equal(isBeamLinkId(res.id), true);
    const host = base === "live" ? "pay.beamcheckout.com" : "playground-pay.beamcheckout.com";
    assert.equal(res.url, `https://${host}/${fake.merchantId}/${res.id}`);
    assert.equal(isBeamHostedPageUrl(res.url, apiBase), true);
    assert.equal(isBeamHostedPageUrl(res.url, base === "live" ? BEAM_PLAYGROUND_BASE : BEAM_LIVE_BASE), false);

    const link = await getPaymentLink(fake.creds, res.id, fake.fetch, FAST);
    assert.equal(link.paymentLinkId, res.id);
    assert.equal(link.merchantId, fake.merchantId);
    assert.equal(link.status, "ACTIVE");
    assert.equal(link.order.netAmount, 2_472_000);
    assert.equal(link.order.currency, "THB");
    assert.equal(link.order.referenceId, REF);
    assert.equal(link.order.internalNote, NOTE);
    assert.deepEqual(link.order.orderItems, body.order.orderItems);
    assert.deepEqual(link.linkSettings, { card: { isEnabled: true }, eWallets: { isEnabled: true } });
    assert.equal(link.redirectUrl, body.redirectUrl);
    assert.equal(link.cancelUrl, body.cancelUrl);
    assert.equal(link.feeType, "TRANSACTION_FEE");
    assert.match(String(link.expiresAt), /\+07:00$/, "GET answers carry Bangkok times");
    assert.equal(parseBeamTime(link.expiresAt), T0 + 30 * 60_000);

    assert.deepEqual(
      fake.calls.map((c) => [c.method, c.path, c.idempotencyKey, c.status]),
      [
        ["POST", "/api/v1/payment-links", "msv-cl-1", 201],
        ["GET", `/api/v1/payment-links/${res.id}`, null, 200],
      ],
    );
    assert.deepEqual(fake.calls[0].body, body);
    assert.equal(JSON.stringify(fake.calls).includes(fake.creds.apiKey), false, "the call log never holds the credentials");
  }
  assert.match(fakeBeamLinkId(), FAKE_BEAM_LINK_ID_PATTERN);
  assert.equal(FAKE_BEAM_LINK_ID_PATTERN.test("rGtqz6DafS"), true, "the format of Beam's documented examples");
});

test("401 INVALID_CREDENTIALS_ERROR without Basic auth, with a wrong key, and on the other environment's base", async () => {
  const { fake } = setup();
  const id = await newLink(fake, T0);
  const none = await raw(fake, "GET", `/api/v1/payment-links/${id}`, { auth: null });
  assert.equal(none.status, 401);
  assert.equal(errorCodeOf(none.json), "INVALID_CREDENTIALS_ERROR");
  const bearer = await raw(fake, "GET", `/api/v1/payment-links/${id}`, { auth: `Bearer ${fake.creds.apiKey}` });
  assert.equal(bearer.status, 401);

  await assert.rejects(
    getPaymentLink({ ...fake.creds, apiKey: "wrong" }, id, fake.fetch, FAST),
    rejectsWith(401, "INVALID_CREDENTIALS_ERROR"),
  );
  await assert.rejects(
    getPaymentLink({ ...fake.creds, merchantId: "m_other" }, id, fake.fetch, FAST),
    rejectsWith(401, "INVALID_CREDENTIALS_ERROR"),
  );
  // Playground keys mean nothing on production (and the reverse).
  await assert.rejects(
    getPaymentLink({ ...fake.creds, apiBase: BEAM_LIVE_BASE }, id, fake.fetch, FAST),
    rejectsWith(401, "INVALID_CREDENTIALS_ERROR"),
  );
  // Nothing else answers.
  await assert.rejects(fake.fetch("https://example.com/api/v1/charges"), TypeError);
});

test("idempotency: the same key and body give the same link; another body under that key is 412; keys last 12 hours", async () => {
  const { fake, advance } = setup();
  const body = linkBody(T0);
  const a = await createPaymentLink(fake.creds, body, "msv-cl-same", fake.fetch);
  const b = await createPaymentLink(fake.creds, body, "msv-cl-same", fake.fetch);
  assert.deepEqual(b, a);
  assert.equal(fake.links.size, 1);

  await assert.rejects(
    createPaymentLink(fake.creds, linkBody(T0, "promptpay"), "msv-cl-same", fake.fetch),
    rejectsWith(412, "IDEMPOTENCY_KEY_ERROR"),
  );
  assert.equal(fake.links.size, 1);
  assert.equal(fake.count(/^POST /), 3, "a 412 is not retried");

  // Without a key every create is a new link.
  const plain = { order: { currency: "THB", netAmount: 100 } };
  const n1 = await raw(fake, "POST", "/api/v1/payment-links", { body: plain });
  const n2 = await raw(fake, "POST", "/api/v1/payment-links", { body: plain });
  assert.notEqual(n1.json.id, n2.json.id);

  const k1 = await raw(fake, "POST", "/api/v1/payment-links", { body: plain, key: "k-12h" });
  advance(12 * 3_600_000 - 1);
  const k2 = await raw(fake, "POST", "/api/v1/payment-links", { body: plain, key: "k-12h" });
  assert.equal(k2.json.id, k1.json.id);
  advance(1);
  const k3 = await raw(fake, "POST", "/api/v1/payment-links", { body: plain, key: "k-12h" });
  assert.equal(k3.status, 201);
  assert.notEqual(k3.json.id, k1.json.id, "after 12 hours the key is a new request");
});

test("create validates THB, an integer netAmount of at least 100, field lengths and a future expiresAt", async () => {
  const { fake } = setup();
  const ok = { order: { currency: "THB", netAmount: 100 } };
  const cases: [unknown, number, string][] = [
    [{ order: { currency: "USD", netAmount: 100 } }, 400, "API_VALIDATION_ERROR"],
    [{ order: { currency: "THB", netAmount: 99 } }, 400, "API_VALIDATION_ERROR"],
    [{ order: { currency: "THB", netAmount: 100.5 } }, 400, "API_VALIDATION_ERROR"],
    [{ order: { currency: "THB", netAmount: "100" } }, 400, "API_VALIDATION_ERROR"],
    [{ order: { currency: "THB", netAmount: 100, internalNote: "n".repeat(501) } }, 400, "API_VALIDATION_ERROR"],
    [{ order: { currency: "THB", netAmount: 100, referenceId: "r".repeat(101) } }, 400, "API_VALIDATION_ERROR"],
    [{ order: { currency: "THB", netAmount: 100, orderItems: [{ itemName: "x", price: 1.5 }] } }, 400, "API_VALIDATION_ERROR"],
    [{ ...ok, expiresAt: new Date(T0).toISOString() }, 400, "API_VALIDATION_ERROR"],
    [{ ...ok, expiresAt: "tomorrow" }, 400, "API_VALIDATION_ERROR"],
    [{ ...ok, linkSettings: { card: { isEnabled: "yes" } } }, 400, "API_VALIDATION_ERROR"],
    [{ ...ok, feeType: "SERVICE_FEE" }, 403, "NO_PERMISSION_ERROR"],
    [{ currency: "THB", netAmount: 100 }, 400, "API_VALIDATION_ERROR"],
    ["{not json", 400, "INVALID_JSON_ERROR"],
  ];
  for (const [body, status, code] of cases) {
    const res = await raw(fake, "POST", "/api/v1/payment-links", { body });
    assert.equal(res.status, status, JSON.stringify(body));
    assert.equal(errorCodeOf(res.json), code, JSON.stringify(body));
  }
  assert.equal(fake.links.size, 0);
  assert.equal((await raw(fake, "POST", "/api/v1/payment-links", { body: ok })).status, 201);
  const never = fake.link([...fake.links.keys()][0]);
  assert.equal(never.expiresAtMs, null, "no expiresAt: the link never expires");
  assert.equal(never.collectPhoneNumber, true, "Beam's default");
  assert.equal(never.linkSettings, null, "no linkSettings: the account defaults");

  // Through the client: a stale body is a 4xx, which is never retried.
  await assert.rejects(
    createPaymentLink(fake.creds, linkBody(T0 - 31 * 60_000), "msv-cl-stale", fake.fetch),
    rejectsWith(400, "API_VALIDATION_ERROR"),
  );
  assert.equal(fake.calls.filter((c) => c.idempotencyKey === "msv-cl-stale").length, 1);
});

test("a link expires on its own at expiresAt; it can no longer be paid", async () => {
  const { fake, advance } = setup();
  const id = await newLink(fake, T0);
  advance(30 * 60_000 - 1);
  assert.equal((await getPaymentLink(fake.creds, id, fake.fetch, FAST)).status, "ACTIVE");
  advance(1);
  assert.equal((await getPaymentLink(fake.creds, id, fake.fetch, FAST)).status, "EXPIRED");
  assert.equal(fake.link(id).closedMs, T0 + 30 * 60_000);
  assert.throws(() => fake.pay(id), /EXPIRED/);
  assert.throws(() => fake.payPending(id), /EXPIRED/);
  assert.equal(fake.expire(id).status, "EXPIRED", "expire() on an expired link is a no-op");

  // expire() brings the expiry forward to now.
  const early = await newLink(fake, T0 + 30 * 60_000);
  advance(5 * 60_000);
  const l = fake.expire(early);
  assert.equal(l.status, "EXPIRED");
  assert.equal(l.expiresAtMs, T0 + 35 * 60_000);
  assert.equal(parseBeamTime((await getPaymentLink(fake.creds, early, fake.fetch, FAST)).expiresAt), T0 + 35 * 60_000);
});

test("disable works only while ACTIVE: 202 -> 'disabled', otherwise 409 OPERATION_NOT_ALLOWED_ERROR -> 'not_open'; unknown -> 404", async () => {
  const { fake, advance } = setup();
  const id = await newLink(fake, T0);
  assert.equal(await disablePaymentLink(fake.creds, id, "msv-bd-1", fake.fetch), "disabled");
  assert.equal((await getPaymentLink(fake.creds, id, fake.fetch, FAST)).status, "DISABLED");
  const patch = fake.calls.find((c) => c.method === "PATCH");
  assert.equal(patch?.path, `/api/v1/payment-links/${id}/disable`);
  assert.equal(patch?.idempotencyKey, "msv-bd-1");
  assert.equal(patch?.status, 202);

  assert.equal(await disablePaymentLink(fake.creds, id, "msv-bd-2", fake.fetch), "not_open");
  assert.equal(fake.calls.at(-1)?.status, 409);
  const again = await raw(fake, "PATCH", `/api/v1/payment-links/${id}/disable`, { key: "msv-bd-3" });
  assert.equal(errorCodeOf(again.json), "OPERATION_NOT_ALLOWED_ERROR");

  const paid = await newLink(fake, T0);
  fake.pay(paid);
  assert.equal(await disablePaymentLink(fake.creds, paid, "msv-bd-4", fake.fetch), "not_open");
  assert.equal(fake.link(paid).status, "PAID");

  const expired = await newLink(fake, T0);
  advance(30 * 60_000);
  assert.equal(await disablePaymentLink(fake.creds, expired, "msv-bd-5", fake.fetch), "not_open");
  assert.equal(fake.link(expired).status, "EXPIRED");

  await assert.rejects(disablePaymentLink(fake.creds, "AAAAAAAAAA", "msv-bd-6", fake.fetch), isBeamNotFound);
  await assert.rejects(getPaymentLink(fake.creds, "AAAAAAAAAA", fake.fetch, FAST), isBeamNotFound);

  // The answer for a closed link is UNVERIFIED with Beam: it can be set; any other 4xx is still 'not_open'.
  const other = setup({ disableNotActive: { status: 422, errorCode: "REQUEST_CONFLICT_ERROR" } });
  const l2 = await newLink(other.fake, T0);
  other.fake.disable(l2);
  assert.equal(await disablePaymentLink(other.fake.creds, l2, "msv-bd-7", other.fake.fetch), "not_open");
  assert.equal(other.fake.calls.at(-1)?.status, 422);
});

test("charges: by sourceId, by referenceId or unfiltered, newest first, with limit, offset and totalCount", async () => {
  const { fake, advance } = setup();
  const a = await newLink(fake, T0, "card_ewallet", "MSV-A");
  const b = await newLink(fake, T0, "promptpay", "MSV-B");
  const declined = fake.decline(a, "CARD", "CH_INSUFFICIENT_FUNDS");
  advance(1_000);
  const pendingB = fake.payPending(b, "QR_PROMPT_PAY");
  advance(1_000);
  const paidA = fake.pay(a, "ALIPAY");

  const ofA = await listPaymentLinkCharges(fake.creds, { sourceId: a }, fake.fetch, FAST);
  assert.deepEqual(
    ofA.map((c) => [c.chargeId, c.status, c.paymentMethod?.paymentMethodType, c.failureCode]),
    [
      [paidA.chargeId, "SUCCEEDED", "ALIPAY", ""],
      [declined.chargeId, "FAILED", "CARD", "CH_INSUFFICIENT_FUNDS"],
    ],
  );
  assert.ok(ofA.every((c) => c.source === "PAYMENT_LINK" && c.sourceId === a && c.amount === 2_472_000 && c.currency === "THB"));
  assert.equal(parseBeamTime(ofA[0].createdAt), T0 + 2_000);
  assert.equal(parseBeamTime(ofA[0].transactionTime), T0 + 2_000);
  assert.equal(ofA[1].paymentMethod?.card?.brand, "VISA");
  assert.equal(ofA[0].paymentMethod?.card, undefined, "an e-wallet charge has no card block");

  const ofB = await listPaymentLinkCharges(fake.creds, { referenceId: "MSV-B" }, fake.fetch, FAST);
  assert.deepEqual(
    ofB.map((c) => [c.chargeId, c.status, c.amount]),
    [[pendingB.chargeId, "PENDING", 2_400_000]],
  );
  assert.equal(ofB[0].transactionTime, undefined, "a PENDING charge has no transaction time");

  const page = await raw(fake, "GET", "/api/v1/charges?source_in=PAYMENT_LINK&limit=2&offset=1");
  assert.equal(page.status, 200);
  assert.equal(page.json.totalCount, 3);
  assert.deepEqual(
    (page.json.data as J[]).map((c) => c.chargeId),
    [pendingB.chargeId, declined.chargeId],
  );
  assert.equal((await raw(fake, "GET", "/api/v1/charges?source_in=API")).json.totalCount, 0);
  assert.equal((await raw(fake, "GET", "/api/v1/charges?limit=101")).status, 400);
  assert.equal((await raw(fake, "GET", "/api/v1/charges?limit=0")).status, 400);
  assert.equal((await raw(fake, "GET", "/api/v1/charges?offset=-1")).status, 400);
  assert.equal((await raw(fake, "GET", "/api/v1/charges?source_in=NOPE")).status, 400);
  assert.equal(fake.calls.find((c) => c.path === "/api/v1/charges")?.query.source_in, "PAYMENT_LINK");

  // A fake whose charges don't copy the referenceId: that lookup finds nothing (it proves nothing).
  const bare = setup({ copyReferenceIdToCharges: false });
  const c = await newLink(bare.fake, T0, "card_ewallet", "MSV-C");
  bare.fake.pay(c);
  assert.deepEqual(await listPaymentLinkCharges(bare.fake.creds, { referenceId: "MSV-C" }, bare.fake.fetch, FAST), []);
  assert.equal((await listPaymentLinkCharges(bare.fake.creds, { sourceId: c }, bare.fake.fetch, FAST)).length, 1);
});

test("the unfiltered scan pages by 100 newest first and stops at sinceMs or maxPages", async () => {
  const { fake, advance } = setup();
  const id = await newLink(fake, T0);
  for (let i = 1; i <= 150; i++) {
    advance(1_000);
    fake.decline(id);
  }
  const all = await listLinkChargesSince(fake.creds, { sinceMs: T0 }, fake.fetch, FAST);
  assert.equal(all.complete, true);
  assert.equal(all.charges.length, 150);
  assert.equal(parseBeamTime(all.charges[0].createdAt), T0 + 150_000);
  assert.equal(parseBeamTime(all.charges[149].createdAt), T0 + 1_000);
  assert.deepEqual(
    fake.calls.filter((c) => c.path === "/api/v1/charges").map((c) => [c.query.offset, c.query.limit]),
    [
      ["0", "100"],
      ["100", "100"],
    ],
  );

  const recent = await listLinkChargesSince(fake.creds, { sinceMs: T0 + 101_000 }, fake.fetch, FAST);
  assert.equal(recent.complete, true);
  assert.equal(recent.charges.length, 50, "stopped at the first charge older than sinceMs");

  const capped = await listLinkChargesSince(fake.creds, { sinceMs: T0, maxPages: 1 }, fake.fetch, FAST);
  assert.equal(capped.complete, false);
  assert.equal(capped.charges.length, 100);
});

test("payPending -> succeed turns an ACTIVE link PAID; failCharge leaves it ACTIVE for a retry; methods follow linkSettings", async () => {
  const { fake } = setup();
  const qr = await newLink(fake, T0, "promptpay");
  const first = fake.payPending(qr);
  assert.equal(first.status, "PENDING");
  assert.equal(fake.failCharge(first.chargeId, "CH_PROCESSING_FAILED").status, "FAILED");
  assert.equal(fake.link(qr).status, "ACTIVE");
  const second = fake.payPending(qr);
  assert.equal(fake.succeed(second.chargeId).status, "SUCCEEDED");
  assert.equal(fake.link(qr).status, "PAID");
  assert.equal(fake.transactions.get(second.chargeId)?.transactionType, "PAYMENT");
  assert.equal(fake.transactions.has(first.chargeId), false, "a failed charge moves no money");
  assert.throws(() => fake.succeed(second.chargeId), /not PENDING/);
  assert.throws(() => fake.failCharge(first.chargeId), /not PENDING/);

  // card_ewallet offers cards and e-wallets only; promptpay only the QR.
  const card = await newLink(fake, T0, "card_ewallet");
  assert.throws(() => fake.pay(card, "QR_PROMPT_PAY"), /does not offer QR_PROMPT_PAY/);
  assert.throws(() => fake.pay(card, "KRUNGSRI_APP"), /does not offer/);
  assert.throws(() => fake.pay(card, "BITCOIN"), /unknown payment method/);
  const qr2 = await newLink(fake, T0, "promptpay");
  assert.throws(() => fake.pay(qr2, "CARD"), /does not offer CARD/);
  assert.throws(() => fake.payPending(qr2, "TRUE_MONEY"), /does not offer/);
  for (const wallet of ["ALIPAY", "SHOPEE_PAY", "LINE_PAY", "TRUE_MONEY", "WECHAT_PAY"]) {
    const l = await newLink(fake, T0, "card_ewallet");
    assert.equal(fake.payPending(l, wallet).paymentMethodType, wallet);
  }
  assert.equal(fake.pay(card, "CARD", { amount: 2_400_000 }).amount, 2_400_000, "a wrong-amount charge can be simulated");
});

test("payAfterClose: a late SUCCEEDED charge on a DISABLED or EXPIRED link, which keeps its status", async () => {
  const { fake, advance, now } = setup();
  const id = await newLink(fake, T0, "promptpay");
  const pending = fake.payPending(id);
  advance(60_000);
  assert.equal(await disablePaymentLink(fake.creds, id, "msv-bd-late", fake.fetch), "disabled");
  advance(60_000);
  const late = fake.payAfterClose(id);
  assert.equal(late.chargeId, pending.chargeId, "the attempt that was pending at the close succeeds");
  const link = await getPaymentLink(fake.creds, id, fake.fetch, FAST);
  assert.equal(link.status, "DISABLED");
  const listed = await listPaymentLinkCharges(fake.creds, { sourceId: id }, fake.fetch, FAST);
  assert.deepEqual(
    listed.map((c) => [c.chargeId, c.status]),
    [[pending.chargeId, "SUCCEEDED"]],
  );
  assert.equal(parseBeamTime(listed[0].transactionTime), T0 + 120_000);

  const expired = await newLink(fake, T0 + 120_000, "card_ewallet");
  advance(30 * 60_000);
  const c = fake.payAfterClose(expired, "CARD");
  assert.equal(c.status, "SUCCEEDED");
  assert.ok(c.createdMs < (fake.link(expired).closedMs ?? 0), "begun while the link was still open");
  assert.equal(fake.link(expired).status, "EXPIRED");

  const open = await newLink(fake, now());
  assert.throws(() => fake.payAfterClose(open), /EXPIRED or DISABLED/);
});

test("secondCharge gives two SUCCEEDED charges on one link; markPaidWithoutCharge is PAID with no listed charge until revealCharges", async () => {
  const { fake, advance } = setup();
  const id = await newLink(fake, T0);
  assert.throws(() => fake.secondCharge(id), /has none/);
  const first = fake.pay(id, "CARD");
  advance(1_000);
  const second = fake.secondCharge(id, "ALIPAY");
  const listed = await listPaymentLinkCharges(fake.creds, { sourceId: id }, fake.fetch, FAST);
  assert.deepEqual(
    listed.map((c) => [c.chargeId, c.status]),
    [
      [second.chargeId, "SUCCEEDED"],
      [first.chargeId, "SUCCEEDED"],
    ],
  );
  assert.equal(fake.link(id).status, "PAID");

  const lag = await newLink(fake, T0 + 1_000);
  const hidden = fake.markPaidWithoutCharge(lag);
  assert.equal((await getPaymentLink(fake.creds, lag, fake.fetch, FAST)).status, "PAID");
  assert.deepEqual(await listPaymentLinkCharges(fake.creds, { sourceId: lag }, fake.fetch, FAST), []);
  assert.equal(fake.revealCharges(lag), 1);
  assert.deepEqual(
    (await listPaymentLinkCharges(fake.creds, { sourceId: lag }, fake.fetch, FAST)).map((c) => c.chargeId),
    [hidden.chargeId],
  );
});

test("refund: the link turns REFUNDED, the charge stays SUCCEEDED and getRefund reads it; partial only on CARD", async () => {
  const { fake, advance } = setup();
  const id = await newLink(fake, T0);
  const charge = fake.pay(id, "CARD");
  advance(60_000);
  const refundId = fake.refund(charge.chargeId);
  assert.match(refundId, /^re_[A-Za-z0-9]{27}$/);
  const refund = await getRefund(fake.creds, refundId, fake.fetch, FAST);
  assert.deepEqual(
    [refund.refundId, refund.chargeId, refund.status, refund.amount, refund.currency, refund.referenceId],
    [refundId, charge.chargeId, "SUCCEEDED", 2_472_000, "THB", REF],
  );
  assert.equal("refundReason" in refund, false, "the free-text reason never leaves the client");
  assert.equal((await getPaymentLink(fake.creds, id, fake.fetch, FAST)).status, "REFUNDED");
  const [after] = await listPaymentLinkCharges(fake.creds, { sourceId: id }, fake.fetch, FAST);
  assert.equal(after.status, "SUCCEEDED");
  assert.equal(fake.transactions.get(refundId)?.transactionType, "REFUND");
  assert.throws(() => fake.refund(charge.chargeId), /refundable 0/);
  await assert.rejects(getRefund(fake.creds, "re_missing", fake.fetch, FAST), isBeamNotFound);

  // Partial: CARD only (the 50% cancellation refund of a card payment).
  const card = await newLink(fake, T0 + 60_000);
  const cc = fake.pay(card, "CARD");
  const half = fake.refund(cc.chargeId, 1_236_000);
  assert.equal(fake.refundRecord(half).amount, 1_236_000);
  const rest = fake.refund(cc.chargeId);
  assert.equal(fake.refundRecord(rest).amount, 1_236_000, "the rest of the charge");
  assert.equal(fake.link(card).status, "REFUNDED");

  const wallet = await newLink(fake, T0 + 60_000);
  const alipay = fake.pay(wallet, "ALIPAY");
  assert.throws(() => fake.refund(alipay.chargeId, 1_000), /only possible on CARD/);
  const linePay = await newLink(fake, T0 + 60_000);
  assert.throws(() => fake.refund(fake.pay(linePay, "LINE_PAY").chargeId), /cannot be refunded through Beam/);
  const qr = await newLink(fake, T0 + 60_000, "promptpay");
  const qrCharge = fake.payPending(qr);
  assert.throws(() => fake.refund(qrCharge.chargeId), /only a SUCCEEDED charge/);

  // A refund that starts PENDING and fails leaves the link PAID; asVoid turns it VOIDED.
  const p = fake.refund(alipay.chargeId, undefined, { status: "PENDING" });
  assert.throws(() => fake.refund(alipay.chargeId), /REFUND_PENDING/);
  assert.equal(fake.settleRefund(p, "FAILED").failureCode, "RE_PROCESSING_FAILED");
  assert.equal(fake.link(wallet).status, "PAID");
  fake.refund(alipay.chargeId, undefined, { asVoid: true });
  assert.equal(fake.link(wallet).status, "VOIDED");
});

test("signedEvent: X-Beam-Signature verifies over the raw body, fails with a wrong key, and the event header can mislead", async () => {
  const { fake } = setup();
  const id = await newLink(fake, T0);
  const charge = fake.pay(id, "CARD");
  const ev = fake.signedEvent("charge.succeeded", charge.chargeId);
  assert.equal(ev.headers["x-beam-event"], "charge.succeeded");
  assert.equal(verifyBeamSignature(ev.raw, ev.headers["x-beam-signature"], fake.hmacKeyB64), true);
  assert.equal(verifyBeamSignature(new TextEncoder().encode(ev.raw), ev.headers["x-beam-signature"], fake.hmacKeyB64), true);
  assert.equal(verifyBeamSignature(ev.raw, ev.headers["x-beam-signature"], Buffer.alloc(32, 7).toString("base64")), false);
  assert.equal(verifyBeamSignature(JSON.stringify(JSON.parse(ev.raw), null, 2), ev.headers["x-beam-signature"], fake.hmacKeyB64), false);
  assert.equal(ev.headers["x-beam-signature"], beamSignature(ev.raw, fake.hmacKeyB64));

  // The body is the GET object, customer block included; the client's parser drops it.
  const body = JSON.parse(ev.raw) as J;
  assert.equal(body.chargeId, charge.chargeId);
  assert.equal(body.sourceId, id);
  assert.ok(body.customer, "Beam sends the payer's details");
  const parsed = parseBeamCharge(body);
  assert.equal(parsed?.status, "SUCCEEDED");
  assert.equal(parsed !== null && "customer" in parsed, false);

  const paid = JSON.parse(fake.signedEvent("payment_link.paid", id).raw) as J;
  assert.equal(paid.status, "PAID");
  assert.equal((paid.order as J).internalNote, NOTE);
  assert.equal("chargeId" in paid, false, "payment_link.paid carries no charge id");

  // Money review 6: a refund.failed body replayed under the header refund.succeeded still verifies.
  const failedRefund = fake.refund(charge.chargeId, undefined, { status: "FAILED" });
  const forged = fake.signedEvent("refund.failed", failedRefund, { header: "refund.succeeded" });
  assert.equal(forged.headers["x-beam-event"], "refund.succeeded");
  assert.equal((JSON.parse(forged.raw) as J).status, "FAILED");
  assert.equal(verifyBeamSignature(forged.raw, forged.headers["x-beam-signature"], fake.hmacKeyB64), true);

  // Signed with another key: our key refuses it.
  const other = fake.signedEvent("charge.succeeded", charge.chargeId, { hmacKeyB64: Buffer.alloc(32, 9).toString("base64") });
  assert.equal(verifyBeamSignature(other.raw, other.headers["x-beam-signature"], fake.hmacKeyB64), false);

  // Bodies match the resource's state.
  const qr = await newLink(fake, T0, "promptpay");
  const pending = fake.payPending(qr);
  assert.throws(() => fake.signedEvent("charge.succeeded", pending.chargeId), /PENDING/);
  assert.throws(() => fake.signedEvent("payment_link.paid", qr), /ACTIVE/);
  fake.failCharge(pending.chargeId, "CH_PROCESSING_FAILED");
  assert.equal((JSON.parse(fake.signedEvent("charge.failed", pending.chargeId).raw) as J).failureCode, "CH_PROCESSING_FAILED");

  const txn = JSON.parse(fake.signedEvent("transaction.created", charge.chargeId).raw) as J;
  assert.deepEqual(
    [txn.transactionType, txn.grossAmount, txn.sourceId, txn.chargeSource],
    ["PAYMENT", 2_472_000, id, "PAYMENT_LINK"],
  );
  assert.equal(txn.netAmount, (txn.grossAmount as number) - (txn.feeAmount as number) - (txn.vatAmount as number));
});

test("chargeback records a CHARGEBACK transaction and leaves the charge and the link as they are", async () => {
  const { fake } = setup();
  const id = await newLink(fake, T0);
  const charge = fake.pay(id);
  const txnId = fake.chargeback(charge.chargeId);
  assert.match(txnId, /^cb_[A-Za-z0-9]{27}$/);
  const txn = JSON.parse(fake.signedEvent("transaction.created", txnId).raw) as J;
  assert.deepEqual([txn.transactionId, txn.transactionType, txn.grossAmount, txn.sourceId], [txnId, "CHARGEBACK", 2_472_000, id]);
  assert.equal(fake.charge(charge.chargeId).status, "SUCCEEDED");
  assert.equal(fake.link(id).status, "PAID");
  const qr = await newLink(fake, T0, "promptpay");
  assert.throws(() => fake.chargeback(fake.payPending(qr).chargeId), /only a SUCCEEDED charge/);
});

test("replayErrorsForKey: a cached 5xx is replayed for the same idempotency key (gap review 15); a fresh key gets through", async () => {
  const { fake } = setup();
  const id = await newLink(fake, T0);
  fake.replayErrorsForKey();
  fake.failNext(/^PATCH \/api\/v1\/payment-links\/[^/]+\/disable$/, 503);
  await assert.rejects(disablePaymentLink(fake.creds, id, "msv-bd-k1", fake.fetch), rejectsWith(503, null));
  await assert.rejects(disablePaymentLink(fake.creds, id, "msv-bd-k1", fake.fetch), rejectsWith(503, null), "replayed from the cache");
  assert.equal(fake.link(id).status, "ACTIVE", "the replayed answer did nothing");
  assert.equal(await disablePaymentLink(fake.creds, id, "msv-bd-k2", fake.fetch), "disabled");
  // A cached 409 is replayed too.
  assert.equal(await disablePaymentLink(fake.creds, id, "msv-bd-k3", fake.fetch), "not_open");
  assert.equal(await disablePaymentLink(fake.creds, id, "msv-bd-k3", fake.fetch), "not_open");

  // Off (the default): a failed answer is not cached, so the same key is processed again.
  fake.replayErrorsForKey(false);
  const id2 = await newLink(fake, T0);
  fake.failNext(/disable$/, 503, null);
  await assert.rejects(disablePaymentLink(fake.creds, id2, "msv-bd-k4", fake.fetch), rejectsWith(503, null));
  assert.equal(await disablePaymentLink(fake.creds, id2, "msv-bd-k4", fake.fetch), "disabled");
  // ...and a success is replayed: the same key after the link closed still answers 202.
  assert.equal(await disablePaymentLink(fake.creds, id2, "msv-bd-k4", fake.fetch), "disabled");
  assert.deepEqual(
    fake.calls.filter((c) => c.idempotencyKey === "msv-bd-k4").map((c) => c.status),
    [503, 202, 202],
  );
});

test("failNext afterProcessing: the create is processed but its answer fails; the client's same-key retry gets the same link", async () => {
  const { fake } = setup();
  const body = linkBody(T0);
  fake.failNext(/^POST \/api\/v1\/payment-links$/, 502, null, { afterProcessing: true });
  const a = await createPaymentLink(fake.creds, body, "msv-cl-amb", fake.fetch);
  assert.equal(fake.links.size, 1);
  assert.equal(fake.links.get(a.id)?.status, "ACTIVE");
  assert.deepEqual(
    fake.calls.map((c) => c.status),
    [502, 201],
  );

  // A network error after processing (status 0): the fetch rejects, the retry finds the link.
  fake.failNext(/^POST /, 0, null, { afterProcessing: true });
  const b = await createPaymentLink(fake.creds, linkBody(T0, "promptpay"), "msv-cl-net", fake.fetch);
  assert.equal(fake.links.size, 2);
  assert.deepEqual(
    fake.calls.filter((c) => c.idempotencyKey === "msv-cl-net").map((c) => c.status),
    [0, 201],
  );
  assert.equal(fake.links.get(b.id)?.order.netAmount, 2_400_000);

  // Before processing (the default): nothing was created, so the retry creates the one link.
  fake.failNext(/^POST /, 500, "INTERNAL_ERROR");
  await createPaymentLink(fake.creds, linkBody(T0, "promptpay", "MSV-X"), "msv-cl-pre", fake.fetch);
  assert.equal(fake.links.size, 3);

  // With replayed errors the retry gets the cached 502, although the link exists.
  fake.replayErrorsForKey();
  fake.failNext(/^POST /, 502, null, { afterProcessing: true });
  await assert.rejects(createPaymentLink(fake.creds, linkBody(T0, "promptpay", "MSV-Y"), "msv-cl-rep", fake.fetch), rejectsWith(502, null));
  assert.equal(fake.links.size, 4);

  // A non-JSON 200 is a Beam-side fault for the client.
  const id = [...fake.links.keys()][0];
  fake.failNext(/^GET \/api\/v1\/payment-links\//, 200, null, { body: "<html>maintenance</html>" });
  await assert.rejects(getPaymentLink(fake.creds, id, fake.fetch, FAST), rejectsWith(200, "INVALID_RESPONSE"));
});

test("rateLimitNext: 429 TOO_MANY_REQUESTS_ERROR, which the client's reads retry once and count", async () => {
  const { fake } = setup();
  const id = await newLink(fake, T0);
  let limited = 0;
  const opts = { ...FAST, onRateLimited: () => limited++ };
  fake.rateLimitNext(1);
  assert.equal((await getPaymentLink(fake.creds, id, fake.fetch, opts)).status, "ACTIVE");
  assert.equal(limited, 1);
  fake.rateLimitNext(2);
  await assert.rejects(getPaymentLink(fake.creds, id, fake.fetch, opts), rejectsWith(429, "TOO_MANY_REQUESTS_ERROR"));
  assert.equal(limited, 3);
  // Only the matching path is limited.
  fake.rateLimitNext(1, /^PATCH /);
  assert.equal((await getPaymentLink(fake.creds, id, fake.fetch, opts)).status, "ACTIVE");
  await assert.rejects(disablePaymentLink(fake.creds, id, "msv-bd-rl", fake.fetch, opts), rejectsWith(429, "TOO_MANY_REQUESTS_ERROR"));
  assert.equal(limited, 4);
  assert.deepEqual(
    fake.calls.slice(1).map((c) => c.status),
    [429, 200, 429, 429, 200, 429],
  );
});

test("unfilteredListUnsupported: the unfiltered scan answers 400; lookups by link or reference still work", async () => {
  const { fake } = setup();
  const id = await newLink(fake, T0);
  fake.pay(id);
  assert.equal((await listLinkChargesSince(fake.creds, { sinceMs: T0 }, fake.fetch, FAST)).charges.length, 1);
  fake.unfilteredListUnsupported();
  await assert.rejects(listLinkChargesSince(fake.creds, { sinceMs: T0 }, fake.fetch, FAST), rejectsWith(400, "API_VALIDATION_ERROR"));
  assert.equal((await listPaymentLinkCharges(fake.creds, { sourceId: id }, fake.fetch, FAST)).length, 1);
  assert.equal((await listPaymentLinkCharges(fake.creds, { referenceId: REF }, fake.fetch, FAST)).length, 1);
  fake.unfilteredListUnsupported(false);
  assert.equal((await listLinkChargesSince(fake.creds, { sinceMs: T0 }, fake.fetch, FAST)).complete, true);
});

test("Bangkok timestamps round-trip through the client's offset-aware parser; the client keeps no customer data", async () => {
  assert.equal(bangkokTime(T0), "2026-10-22T10:00:00.000+07:00");
  assert.equal(parseBeamTime(bangkokTime(T0)), T0);
  const { fake } = setup();
  const id = await newLink(fake, T0);
  fake.pay(id, "CARD", { card: { brand: "MASTERCARD", last4: "4444", countryAlpha2: "GB" } });
  const rawList = await raw(fake, "GET", `/api/v1/charges?source_in=PAYMENT_LINK&sourceId=${id}`);
  const rawCharge = (rawList.json.data as J[])[0];
  assert.ok(rawCharge.customer);
  assert.match(String(rawCharge.createdAt), /\+07:00$/);
  const [charge] = await listPaymentLinkCharges(fake.creds, { sourceId: id }, fake.fetch, FAST);
  assert.equal("customer" in charge, false);
  assert.deepEqual(charge.paymentMethod, { paymentMethodType: "CARD", card: { brand: "MASTERCARD", last4: "4444", countryAlpha2: "GB" } });
  assert.equal(parseBeamTime(charge.createdAt), T0);
  assert.equal(parseBeamTime(charge.updatedAt), T0);
});

// In-repo FAKE of the Beam Checkout API v1 surface the booking engine uses,
// served as a `fetch` implementation so the real beam.ts runs against it
// unchanged: createPaymentLink(fake.creds, body, key, fake.fetch).
//
// MOCK - nothing leaves this process. Used by the unit tests (and later by the
// optional local beam-mock mode). Endpoints, as documented (OpenAPI 1.25.0):
//   POST  /api/v1/payment-links              create; x-beam-idempotency-key honoured; 201 {id, url}
//   GET   /api/v1/payment-links/:id          read; ACTIVE -> EXPIRED automatically at expiresAt (+ expiryLagMs)
//   PATCH /api/v1/payment-links/:id/disable  only while ACTIVE (202), else 403 OPERATION_NOT_ALLOWED_ERROR
//   GET   /api/v1/charges                    by sourceId, by referenceId or unfiltered; newest first; limit/offset
//   GET   /api/v1/refunds/:id                read
// Every call needs Basic base64(merchantId:apiKey) on the fake's own base
// (playground or live); anything else is 401 INVALID_CREDENTIALS_ERROR.
//
// Controls simulate the guest and Lighthouse: pay, payPending, decline,
// succeed, failCharge, expire, disable, payAfterClose, secondCharge,
// markPaidWithoutCharge (+ revealCharges), refund (+ settleRefund) and
// chargeback. Faults: failNext, rateLimitNext, replayErrorsForKey and
// unfilteredListUnsupported. signedEvent builds a webhook body plus the
// X-Beam-Signature header exactly as Beam signs it, optionally under a
// misleading X-Beam-Event header (Beam signs only the body).
//
// Where Beam's behaviour is UNVERIFIED the fake picks one answer and says so:
// - disabling a link that is not ACTIVE answers 403 OPERATION_NOT_ALLOWED_ERROR,
//   the spec's code for an operation the resource's state forbids
//   (options.disableNotActive changes it);
// - an ACTIVE link turns EXPIRED exactly at its expiresAt (options.expiryLagMs
//   keeps it ACTIVE that much longer, as a lagging Beam would; Infinity: never
//   on its own);
// - a charge that succeeds after its link EXPIRED or was DISABLED leaves the
//   link EXPIRED / DISABLED (it does not turn PAID);
// - any SUCCEEDED refund moves the link to REFUNDED (VOIDED for a void), also
//   a partial (50%) card refund and a refund of just one of several SUCCEEDED
//   charges (options.refundLinkStatus 'all_charges_fully_refunded' moves it
//   only once every SUCCEEDED charge of the link is refunded in full);
// - failed answers are NOT replayed for a reused idempotency key unless
//   replayErrorsForKey() is on (gap review 15);
// - the unfiltered charge list is supported unless unfilteredListUnsupported();
// - charges copy the link's order.referenceId (Beam's examples do);
// - a CHARGEBACK transaction id is 'cb_' + 27 base62 characters.
//
// Id formats follow Beam's documented examples: payment links are 10 base62
// characters (rGtqz6DafS, HFF4n25LYl, 57Iot6c11o), charges 'ch_' + 27, refunds
// 're_' + 27. GET answers carry Bangkok times (+07:00), as Beam's do.

import { createHmac, randomBytes, randomInt } from "node:crypto";
import { BEAM_LIVE_BASE, BEAM_PLAYGROUND_BASE } from "../config.ts";
import type { BeamCredentials } from "../config.ts";
import type {
  BeamCardDetails,
  BeamChargeStatus,
  BeamLinkSettings,
  BeamOrderItem,
  BeamPaymentLinkStatus,
  BeamRefundStatus,
} from "../beam.ts";

export type FakeBeamBase = "playground" | "live";

export type FakeBeamRefundLinkStatus = "any_refund" | "all_charges_fully_refunded";

/** Card details as Beam SENDS them, last four digits included (the client's parser drops them). */
export interface FakeBeamCardDetails extends BeamCardDetails {
  last4?: string;
}

export interface FakeBeamOptions {
  now?: () => number;
  merchantId?: string;
  apiKey?: string;
  /** The Lighthouse webhook HMAC key, base64 (default: 32 random bytes). */
  hmacKeyB64?: string;
  /** Which Beam environment this fake is (default playground). */
  base?: FakeBeamBase;
  /** Charges copy the link's order.referenceId (default true; Beam's examples do, the docs don't promise it). */
  copyReferenceIdToCharges?: boolean;
  /** The answer to disabling a link that is not ACTIVE (UNVERIFIED with Beam). Default 403 OPERATION_NOT_ALLOWED_ERROR. */
  disableNotActive?: { status: number; errorCode: string };
  /**
   * How long past its expiresAt an ACTIVE link stays ACTIVE before the fake expires it on its own (UNVERIFIED
   * with Beam). Default 0; Infinity: only expire() closes it. Lets a test run "ACTIVE past expiresAt + skew ->
   * needsDisable -> PATCH disable -> re-read" on one clock.
   */
  expiryLagMs?: number;
  /**
   * When a SUCCEEDED refund moves its link to REFUNDED (VOIDED for a void), UNVERIFIED with Beam (our open
   * questions): 'any_refund' (default) on every refund, partial or of one charge among several;
   * 'all_charges_fully_refunded' only once every SUCCEEDED charge of the link is refunded in full.
   */
  refundLinkStatus?: FakeBeamRefundLinkStatus;
  /** Builds a new link's hosted-page URL (default https://{the base's pay host}/{merchantId}/{id}): a seam for a wrong host. */
  hostedPageUrl?: (link: { id: string; merchantId: string }) => string;
}

export interface FakeBeamLink {
  paymentLinkId: string;
  merchantId: string;
  url: string;
  status: BeamPaymentLinkStatus;
  order: {
    netAmount: number;
    currency: string;
    description: string | null;
    referenceId: string | null;
    internalNote: string | null;
    orderItems: BeamOrderItem[];
  };
  /** null = not sent: the account defaults apply (every method allowed here). */
  linkSettings: BeamLinkSettings | null;
  collectPhoneNumber: boolean;
  collectDeliveryAddress: boolean;
  redirectUrl: string | null;
  cancelUrl: string | null;
  /** null = never expires. */
  expiresAtMs: number | null;
  feeType: string;
  createdMs: number;
  /** When the link left ACTIVE (PAID, EXPIRED or DISABLED). */
  closedMs: number | null;
}

export interface FakeBeamCharge {
  chargeId: string;
  merchantId: string;
  referenceId: string;
  status: BeamChargeStatus;
  amount: number;
  currency: string;
  /** Always PAYMENT_LINK here. */
  source: "PAYMENT_LINK";
  sourceId: string;
  paymentMethodType: string;
  card: FakeBeamCardDetails | null;
  /** "" unless FAILED. */
  failureCode: string;
  createdMs: number;
  updatedMs: number;
  /** When it turned SUCCEEDED or FAILED. */
  transactionMs: number | null;
  /** false while the charge list lags behind the link (markPaidWithoutCharge). */
  listed: boolean;
  /** Creation order, to break createdAt ties (newest first). */
  seq: number;
}

export interface FakeBeamRefund {
  refundId: string;
  chargeId: string;
  merchantId: string;
  referenceId: string;
  amount: number;
  currency: string;
  status: BeamRefundStatus;
  failureCode: string;
  createdMs: number;
  updatedMs: number;
  transactionMs: number | null;
  /** Settles as a VOID (the link turns VOIDED) instead of a REFUND. */
  asVoid: boolean;
}

export type FakeBeamTransactionType = "PAYMENT" | "REFUND" | "VOID" | "CHARGEBACK";

export interface FakeBeamTransaction {
  transactionId: string;
  transactionType: FakeBeamTransactionType;
  chargeId: string;
  merchantId: string;
  referenceId: string;
  sourceId: string;
  currency: string;
  grossAmount: number;
  /** Illustrative only (2% on payments, 0 otherwise); nothing in the engine may rely on the fake's fee. */
  feeAmount: number;
  vatAmount: number;
  netAmount: number;
  createdMs: number;
}

/** One request the fake received. The Authorization header is never recorded. */
export interface FakeBeamCall {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  /** The parsed JSON body, the raw text when it is not JSON, or null without a body. */
  body: unknown;
  idempotencyKey: string | null;
  /** The HTTP status answered; 0 when the request failed as a network error. */
  status: number;
}

export type FakeBeamEventKind =
  | "charge.succeeded"
  | "charge.failed"
  | "payment_link.paid"
  | "refund.succeeded"
  | "refund.failed"
  | "transaction.created";

export interface FakeBeamSignedEvent {
  /** The exact raw body, as Beam would POST it. */
  raw: string;
  headers: { "x-beam-signature": string; "x-beam-event": string };
}

export interface FakeChargeOptions {
  /** Defaults to the link's netAmount (set it to simulate a wrong-amount charge). */
  amount?: number;
  currency?: string;
  /** Card details for CARD / CARD_INSTALLMENTS (default VISA 1111, TH). */
  card?: FakeBeamCardDetails;
}

export interface FailNextOptions {
  /** The request is processed first (the link is created or disabled) and only the answer fails: an ambiguous outcome. */
  afterProcessing?: boolean;
  message?: string;
  /** A raw body to answer instead of Beam's JSON error body (e.g. a non-JSON 200). */
  body?: string;
}

/** Beam's documented payment link id format: 10 base62 characters. */
export const FAKE_BEAM_LINK_ID_PATTERN = /^[A-Za-z0-9]{10}$/;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const IDEMPOTENCY_TTL_MS = 12 * 3_600_000;
const BANGKOK_OFFSET_MS = 7 * 3_600_000;
/** Beam's default page size is undocumented; the client always sends limit=100. */
const DEFAULT_LIMIT = 20;
const CHARGE_SOURCES = ["PAYMENT_LINK", "STORE_LINK", "QR_PROMPT_PAY_LINK", "API", "BOLT"];
const DEFAULT_CARD: FakeBeamCardDetails = { brand: "VISA", last4: "1111", countryAlpha2: "TH" };
/** Methods Beam can refund through its API; partial refunds only on CARD. */
const REFUNDABLE_METHODS = new Set(["CARD", "CARD_INSTALLMENTS", "QR_PROMPT_PAY", "ALIPAY", "WECHAT_PAY"]);

/** The linkSettings group each payment method type belongs to. */
const GROUP_OF_METHOD: Record<string, keyof BeamLinkSettings> = {
  CARD: "card",
  CARD_INSTALLMENTS: "cardInstallments",
  QR_PROMPT_PAY: "qrPromptPay",
  ALIPAY: "eWallets",
  WECHAT_PAY: "eWallets",
  LINE_PAY: "eWallets",
  TRUE_MONEY: "eWallets",
  SHOPEE_PAY: "eWallets",
  KRUNGTHAI_NEXT: "mobileBanking",
  KRUNGSRI_APP: "mobileBanking",
  SCB_EASY: "mobileBanking",
  BANGKOK_BANK_APP: "mobileBanking",
  KPLUS: "mobileBanking",
  MAKE: "mobileBanking",
};
const LINK_GROUPS: (keyof BeamLinkSettings)[] = ["card", "cardInstallments", "qrPromptPay", "eWallets", "mobileBanking", "buyNowPayLater"];

const API_BASES: Record<FakeBeamBase, string> = { playground: BEAM_PLAYGROUND_BASE, live: BEAM_LIVE_BASE };
const HOSTED_HOSTS: Record<FakeBeamBase, string> = { playground: "playground-pay.beamcheckout.com", live: "pay.beamcheckout.com" };

function base62(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += BASE62[randomInt(62)];
  return s;
}

/** A payment link id in Beam's documented format (10 base62 characters). */
export function fakeBeamLinkId(): string {
  return base62(10);
}

/** Epoch ms as Beam's GET answers carry it: ISO with the Bangkok offset (+07:00). */
export function bangkokTime(ms: number): string {
  return `${new Date(ms + BANGKOK_OFFSET_MS).toISOString().slice(0, -1)}+07:00`;
}

/** X-Beam-Signature for a raw body: base64(HMAC-SHA256(base64decode(key), body)). */
export function beamSignature(raw: string, hmacKeyB64: string): string {
  return createHmac("sha256", Buffer.from(hmacKeyB64, "base64")).update(Buffer.from(raw, "utf8")).digest("base64");
}

type Json = Record<string, unknown>;

interface Answer {
  status: number;
  /** JSON text, or a raw body; null = no HTTP answer (a network error). */
  body: string | null;
}

interface StoredAnswer extends Answer {
  fingerprint: string;
  expiresMs: number;
}

interface ForcedFailure {
  pattern: RegExp;
  status: number;
  errorCode: string | null;
  afterProcessing: boolean;
  message: string;
  body: string | null;
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errorAnswer(status: number, errorCode: string | null, message: string): Answer {
  const body: Json = { code: status, message };
  if (errorCode !== null) body.error = { errorCode, errorMessage: message };
  return { status, body: JSON.stringify(body) };
}

function jsonAnswer(status: number, body: unknown): Answer {
  return { status, body: JSON.stringify(body) };
}

const validation = (message: string) => errorAnswer(400, "API_VALIDATION_ERROR", message);
const notFound = () => errorAnswer(404, "NOT_FOUND_ERROR", "not found");

function toResponse(a: Answer): Response {
  if (a.body === null) throw new TypeError("fetch failed (fake Beam: simulated network error)");
  return new Response(a.body, { status: a.status, headers: { "content-type": "application/json" } });
}

function queryRecord(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = all.length === 1 ? all[0] : all;
  }
  return out;
}

function optionalString(o: Json, key: string, max: number): string | null | Answer {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return validation(`${key} must be a string`);
  if (v.length > max) return validation(`${key} must be at most ${max} characters`);
  return v;
}

function isAnswer(v: unknown): v is Answer {
  return isObject(v) && typeof v.status === "number" && "body" in v;
}

export function createFakeBeam(options: FakeBeamOptions = {}) {
  const now = options.now ?? Date.now;
  const env: FakeBeamBase = options.base ?? "playground";
  const apiBase = API_BASES[env];
  const otherBase = API_BASES[env === "live" ? "playground" : "live"];
  const merchantId = options.merchantId ?? "m_FakeBeamMerchant0000000000";
  const apiKey = options.apiKey ?? "fake-beam-api-key";
  const hmacKeyB64 = options.hmacKeyB64 ?? randomBytes(32).toString("base64");
  const copyReferenceId = options.copyReferenceIdToCharges !== false;
  const disableNotActive = options.disableNotActive ?? { status: 403, errorCode: "OPERATION_NOT_ALLOWED_ERROR" };
  const expiryLagMs = options.expiryLagMs ?? 0;
  if (typeof expiryLagMs !== "number" || Number.isNaN(expiryLagMs) || expiryLagMs < 0) {
    throw new RangeError("fake beam: expiryLagMs must be a number >= 0 (Infinity: never expire on its own)");
  }
  const refundLinkStatus: FakeBeamRefundLinkStatus = options.refundLinkStatus ?? "any_refund";
  if (refundLinkStatus !== "any_refund" && refundLinkStatus !== "all_charges_fully_refunded") {
    throw new RangeError(`fake beam: unknown refundLinkStatus ${String(refundLinkStatus)}`);
  }
  const hostedPageUrl =
    options.hostedPageUrl ?? ((l: { id: string; merchantId: string }) => `https://${HOSTED_HOSTS[env]}/${l.merchantId}/${l.id}`);

  const links = new Map<string, FakeBeamLink>();
  const charges = new Map<string, FakeBeamCharge>();
  const refunds = new Map<string, FakeBeamRefund>();
  const transactions = new Map<string, FakeBeamTransaction>();
  const idempotency = new Map<string, StoredAnswer>();
  const calls: FakeBeamCall[] = [];
  const failures: ForcedFailure[] = [];
  const rateLimits: { pattern: RegExp | null }[] = [];
  let replayErrors = false;
  let unfilteredUnsupported = false;
  let seq = 0;

  const creds: BeamCredentials = { apiBase, merchantId, apiKey };

  /* ---------------- state helpers ---------------- */

  /** Beam moves an ACTIVE link to EXPIRED once expiresAt (plus the configured lag) has passed. */
  function tick(l: FakeBeamLink): void {
    if (l.status === "ACTIVE" && l.expiresAtMs !== null && now() >= l.expiresAtMs + expiryLagMs) {
      l.status = "EXPIRED";
      l.closedMs = l.expiresAtMs + expiryLagMs;
    }
  }

  function uniqueId(make: () => string, taken: Map<string, unknown>): string {
    for (;;) {
      const id = make();
      if (!taken.has(id)) return id;
    }
  }

  function mustLink(id: string): FakeBeamLink {
    const l = links.get(id);
    if (!l) throw new Error(`fake beam: no payment link ${id}`);
    tick(l);
    return l;
  }

  function mustCharge(id: string): FakeBeamCharge {
    const c = charges.get(id);
    if (!c) throw new Error(`fake beam: no charge ${id}`);
    return c;
  }

  function mustBeActive(l: FakeBeamLink, what: string): void {
    if (l.status !== "ACTIVE") throw new Error(`fake beam: cannot ${what} link ${l.paymentLinkId}: it is ${l.status}`);
  }

  function checkMethod(l: FakeBeamLink, method: string): void {
    const group = GROUP_OF_METHOD[method];
    if (!group) throw new Error(`fake beam: unknown payment method ${method}`);
    if (l.linkSettings === null) return; // account defaults
    if (l.linkSettings[group]?.isEnabled !== true) {
      throw new Error(`fake beam: link ${l.paymentLinkId} does not offer ${method} (${group} is off)`);
    }
  }

  function linkCharges(linkId: string): FakeBeamCharge[] {
    return [...charges.values()].filter((c) => c.sourceId === linkId).sort((a, b) => a.seq - b.seq);
  }

  function newCharge(l: FakeBeamLink, status: BeamChargeStatus, method: string, opts: FakeChargeOptions = {}): FakeBeamCharge {
    const t = now();
    const isCard = method === "CARD" || method === "CARD_INSTALLMENTS";
    const c: FakeBeamCharge = {
      chargeId: uniqueId(() => `ch_${base62(27)}`, charges),
      merchantId,
      referenceId: copyReferenceId ? l.order.referenceId ?? "" : "",
      status,
      amount: opts.amount ?? l.order.netAmount,
      currency: opts.currency ?? l.order.currency,
      source: "PAYMENT_LINK",
      sourceId: l.paymentLinkId,
      paymentMethodType: method,
      card: isCard ? { ...(opts.card ?? DEFAULT_CARD) } : null,
      failureCode: "",
      createdMs: t,
      updatedMs: t,
      transactionMs: status === "PENDING" ? null : t,
      listed: true,
      seq: ++seq,
    };
    charges.set(c.chargeId, c);
    if (status === "SUCCEEDED") recordPayment(c);
    return c;
  }

  function recordPayment(c: FakeBeamCharge): void {
    const fee = Math.round(c.amount * 0.02);
    const vat = Math.round(fee * 0.07);
    addTransaction(c.chargeId, "PAYMENT", c, c.amount, fee, vat);
  }

  function addTransaction(
    id: string,
    type: FakeBeamTransactionType,
    c: FakeBeamCharge,
    gross: number,
    fee = 0,
    vat = 0,
  ): FakeBeamTransaction {
    const t: FakeBeamTransaction = {
      transactionId: id,
      transactionType: type,
      chargeId: c.chargeId,
      merchantId,
      referenceId: c.referenceId,
      sourceId: c.sourceId,
      currency: c.currency,
      grossAmount: gross,
      feeAmount: fee,
      vatAmount: vat,
      netAmount: gross - fee - vat,
      createdMs: now(),
    };
    transactions.set(id, t);
    return t;
  }

  function markPaid(l: FakeBeamLink): void {
    l.status = "PAID";
    l.closedMs = now();
  }

  function settle(c: FakeBeamCharge, status: "SUCCEEDED" | "FAILED", failureCode = ""): void {
    c.status = status;
    c.failureCode = status === "FAILED" ? failureCode : "";
    c.updatedMs = now();
    c.transactionMs = now();
    if (status === "SUCCEEDED") recordPayment(c);
  }

  function refundRecord(id: string): FakeBeamRefund {
    const r = refunds.get(id);
    if (!r) throw new Error(`fake beam: no refund ${id}`);
    return r;
  }

  function settleRefund(refundId: string, status: "SUCCEEDED" | "FAILED", failureCode = "RE_PROCESSING_FAILED"): FakeBeamRefund {
    const r = refundRecord(refundId);
    if (r.status !== "PENDING") throw new Error(`fake beam: refund ${refundId} is ${r.status}, not PENDING`);
    r.status = status;
    r.failureCode = status === "FAILED" ? failureCode : "";
    r.updatedMs = now();
    r.transactionMs = now();
    if (status === "SUCCEEDED") {
      const c = mustCharge(r.chargeId);
      addTransaction(r.refundId, r.asVoid ? "VOID" : "REFUND", c, r.amount);
      const l = mustLink(c.sourceId);
      if (refundLinkStatus === "any_refund" || allChargesFullyRefunded(l.paymentLinkId)) {
        l.status = r.asVoid ? "VOIDED" : "REFUNDED";
      }
    }
    return r;
  }

  /** Every SUCCEEDED charge of the link is refunded in full by SUCCEEDED refunds. */
  function allChargesFullyRefunded(linkId: string): boolean {
    return linkCharges(linkId)
      .filter((c) => c.status === "SUCCEEDED")
      .every((c) => refundedSatang(c.chargeId) >= c.amount);
  }

  function refundedSatang(chargeId: string): number {
    let sum = 0;
    for (const r of refunds.values()) if (r.chargeId === chargeId && r.status === "SUCCEEDED") sum += r.amount;
    return sum;
  }

  /* ---------------- views (as Beam's GET and webhook bodies) ---------------- */

  function linkView(l: FakeBeamLink): Json {
    const view: Json = {
      paymentLinkId: l.paymentLinkId,
      merchantId: l.merchantId,
      url: l.url,
      status: l.status,
      order: {
        netAmount: l.order.netAmount,
        currency: l.order.currency,
        description: l.order.description ?? "",
        referenceId: l.order.referenceId ?? "",
        internalNote: l.order.internalNote ?? "",
        orderItems: l.order.orderItems.map((i) => ({ ...i })),
      },
      collectDeliveryAddress: l.collectDeliveryAddress,
      collectPhoneNumber: l.collectPhoneNumber,
      expiresAt: l.expiresAtMs === null ? null : bangkokTime(l.expiresAtMs),
      feeType: l.feeType,
    };
    if (l.linkSettings !== null) view.linkSettings = structuredClone(l.linkSettings);
    if (l.redirectUrl !== null) view.redirectUrl = l.redirectUrl;
    if (l.cancelUrl !== null) view.cancelUrl = l.cancelUrl;
    return view;
  }

  function chargeView(c: FakeBeamCharge): Json {
    return {
      chargeId: c.chargeId,
      merchantId: c.merchantId,
      referenceId: c.referenceId,
      status: c.status,
      currency: c.currency,
      amount: c.amount,
      source: c.source,
      sourceId: c.sourceId,
      transactionTime: c.transactionMs === null ? null : bangkokTime(c.transactionMs),
      paymentMethod: {
        paymentMethodType: c.paymentMethodType,
        card: c.card ? { ...c.card } : null,
        cardInstallments: null,
        qrPromptPay: null,
        alipay: null,
        weChatPay: null,
        trueMoney: null,
        linePay: null,
        shopeePay: null,
      },
      failureCode: c.failureCode,
      // Beam sends the payer's details; the client must drop them (beam.ts parseBeamCharge).
      customer: {
        primaryPhone: { countryCode: "+66", number: "0812345678" },
        email: "guest@example.com",
        deliveryAddress: null,
      },
      createdAt: bangkokTime(c.createdMs),
      updatedAt: bangkokTime(c.updatedMs),
    };
  }

  function refundView(r: FakeBeamRefund): Json {
    return {
      refundId: r.refundId,
      chargeId: r.chargeId,
      merchantId: r.merchantId,
      referenceId: r.referenceId,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      failureCode: r.failureCode,
      refundReason: "Refund requested by guest@example.com",
      transactionTime: r.transactionMs === null ? null : bangkokTime(r.transactionMs),
      createdAt: bangkokTime(r.createdMs),
      updatedAt: bangkokTime(r.updatedMs),
    };
  }

  function transactionView(t: FakeBeamTransaction): Json {
    return {
      transactionId: t.transactionId,
      transactionType: t.transactionType,
      merchantId: t.merchantId,
      referenceId: t.referenceId,
      chargeSource: "PAYMENT_LINK",
      sourceId: t.sourceId,
      currency: t.currency,
      grossAmount: t.grossAmount,
      feeAmount: t.feeAmount,
      vatAmount: t.vatAmount,
      netAmount: t.netAmount,
      feeStrategy: "RATE",
      transactionTime: bangkokTime(t.createdMs),
      createdAt: bangkokTime(t.createdMs),
    };
  }

  /* ---------------- endpoints ---------------- */

  function createLink(rawBody: string): Answer {
    let j: unknown;
    try {
      j = JSON.parse(rawBody);
    } catch {
      return errorAnswer(400, "INVALID_JSON_ERROR", "invalid json");
    }
    if (!isObject(j) || !isObject(j.order)) return validation("order is required");
    const o = j.order;
    if (o.currency !== "THB") return validation("order.currency must be THB");
    if (typeof o.netAmount !== "number" || !Number.isInteger(o.netAmount) || o.netAmount < 100) {
      return validation("order.netAmount must be an integer of at least 100");
    }
    const description = optionalString(o, "description", 500);
    const internalNote = optionalString(o, "internalNote", 500);
    const referenceId = optionalString(o, "referenceId", 100);
    for (const v of [description, internalNote, referenceId]) if (isAnswer(v)) return v;

    const orderItems: BeamOrderItem[] = [];
    if (o.orderItems !== undefined && o.orderItems !== null) {
      if (!Array.isArray(o.orderItems)) return validation("order.orderItems must be an array");
      for (const raw of o.orderItems) {
        if (!isObject(raw) || typeof raw.price !== "number" || !Number.isInteger(raw.price) || raw.price < 0) {
          return validation("orderItems[].price must be a non-negative integer");
        }
        const quantity = raw.quantity ?? 1;
        if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1) {
          return validation("orderItems[].quantity must be an integer of at least 1");
        }
        const itemName = optionalString(raw, "itemName", 255);
        const itemDescription = optionalString(raw, "description", 511);
        const sku = optionalString(raw, "sku", 255);
        for (const v of [itemName, itemDescription, sku]) if (isAnswer(v)) return v;
        const item: BeamOrderItem = { itemName: (itemName as string | null) ?? "", price: raw.price, quantity };
        if (itemDescription !== null) item.description = itemDescription as string;
        if (sku !== null) item.sku = sku as string;
        orderItems.push(item);
      }
    }

    let linkSettings: BeamLinkSettings | null = null;
    if (j.linkSettings !== undefined && j.linkSettings !== null) {
      if (!isObject(j.linkSettings)) return validation("linkSettings must be an object");
      linkSettings = {};
      for (const group of LINK_GROUPS) {
        const g = j.linkSettings[group];
        if (g === undefined || g === null) continue;
        if (!isObject(g) || typeof g.isEnabled !== "boolean") return validation(`linkSettings.${group}.isEnabled must be a boolean`);
        linkSettings[group] = { isEnabled: g.isEnabled };
      }
    }

    let expiresAtMs: number | null = null;
    if (j.expiresAt !== undefined && j.expiresAt !== null) {
      const ms = typeof j.expiresAt === "string" ? Date.parse(j.expiresAt) : Number.NaN;
      if (!Number.isFinite(ms)) return validation("expiresAt must be a date-time");
      if (ms <= now()) return validation("expiresAt must be in the future");
      expiresAtMs = ms;
    }
    for (const key of ["redirectUrl", "cancelUrl"]) {
      if (j[key] !== undefined && j[key] !== null && typeof j[key] !== "string") return validation(`${key} must be a string`);
    }
    for (const key of ["collectPhoneNumber", "collectDeliveryAddress"]) {
      if (j[key] !== undefined && typeof j[key] !== "boolean") return validation(`${key} must be a boolean`);
    }
    const feeType = j.feeType ?? "TRANSACTION_FEE";
    if (feeType === "SERVICE_FEE") return errorAnswer(403, "NO_PERMISSION_ERROR", "SERVICE_FEE needs Beam's approval");
    if (feeType !== "TRANSACTION_FEE") return validation("feeType must be TRANSACTION_FEE or SERVICE_FEE");

    const id = uniqueId(fakeBeamLinkId, links);
    const link: FakeBeamLink = {
      paymentLinkId: id,
      merchantId,
      url: hostedPageUrl({ id, merchantId }),
      status: "ACTIVE",
      order: {
        netAmount: o.netAmount,
        currency: "THB",
        description: description as string | null,
        referenceId: referenceId as string | null,
        internalNote: internalNote as string | null,
        orderItems,
      },
      linkSettings,
      collectPhoneNumber: j.collectPhoneNumber !== false,
      collectDeliveryAddress: j.collectDeliveryAddress === true,
      redirectUrl: typeof j.redirectUrl === "string" ? j.redirectUrl : null,
      cancelUrl: typeof j.cancelUrl === "string" ? j.cancelUrl : null,
      expiresAtMs,
      feeType,
      createdMs: now(),
      closedMs: null,
    };
    links.set(id, link);
    return jsonAnswer(201, { id, url: link.url });
  }

  function getLinkAnswer(id: string): Answer {
    const l = links.get(id);
    if (!l) return notFound();
    tick(l);
    return jsonAnswer(200, linkView(l));
  }

  function disableAnswer(id: string): Answer {
    const l = links.get(id);
    if (!l) return notFound();
    tick(l);
    if (l.status !== "ACTIVE") {
      return errorAnswer(disableNotActive.status, disableNotActive.errorCode, `payment link is ${l.status}, only an ACTIVE link can be disabled`);
    }
    l.status = "DISABLED";
    l.closedMs = now();
    return jsonAnswer(202, { code: 202, message: "accepted" });
  }

  function listChargesAnswer(q: URLSearchParams): Answer {
    const limitRaw = q.get("limit");
    const offsetRaw = q.get("offset");
    const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw);
    const offset = offsetRaw === null ? 0 : Number(offsetRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return validation("limit must be between 1 and 100");
    if (!Number.isInteger(offset) || offset < 0) return validation("offset must be at least 0");
    const sources = q.getAll("source_in").flatMap((s) => s.split(",")).filter((s) => s !== "");
    if (sources.some((s) => !CHARGE_SOURCES.includes(s))) return validation("source_in has an unknown source");
    const sourceId = q.get("sourceId");
    const referenceId = q.get("referenceId");
    if (sourceId === null && referenceId === null && unfilteredUnsupported) {
      return validation("sourceId or referenceId is required");
    }
    const all = [...charges.values()]
      .filter(
        (c) =>
          c.listed &&
          (sources.length === 0 || sources.includes(c.source)) &&
          (sourceId === null || c.sourceId === sourceId) &&
          (referenceId === null || c.referenceId === referenceId),
      )
      .sort((a, b) => b.createdMs - a.createdMs || b.seq - a.seq);
    return jsonAnswer(200, { data: all.slice(offset, offset + limit).map(chargeView), totalCount: all.length });
  }

  function getRefundAnswer(id: string): Answer {
    const r = refunds.get(id);
    return r ? jsonAnswer(200, refundView(r)) : notFound();
  }

  type Endpoint = { process: (rawBody: string, q: URLSearchParams) => Answer; write: boolean };

  function endpointOf(method: string, path: string): Endpoint | null {
    if (method === "POST" && path === "/api/v1/payment-links") return { process: (raw) => createLink(raw), write: true };
    let m = /^\/api\/v1\/payment-links\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      const id = decodeURIComponent(m[1]);
      return { process: () => getLinkAnswer(id), write: false };
    }
    m = /^\/api\/v1\/payment-links\/([^/]+)\/disable$/.exec(path);
    if (method === "PATCH" && m) {
      const id = decodeURIComponent(m[1]);
      return { process: () => disableAnswer(id), write: true };
    }
    if (method === "GET" && path === "/api/v1/charges") return { process: (_raw, q) => listChargesAnswer(q), write: false };
    m = /^\/api\/v1\/refunds\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      const id = decodeURIComponent(m[1]);
      return { process: () => getRefundAnswer(id), write: false };
    }
    return null;
  }

  function authorized(header: string | null): boolean {
    const m = /^Basic\s+(\S+)$/i.exec(header ?? "");
    if (!m) return false;
    const decoded = Buffer.from(m[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return colon > 0 && decoded.slice(0, colon) === merchantId && decoded.slice(colon + 1) === apiKey;
  }

  function takeFirst<T extends { pattern: RegExp | null }>(queue: T[], target: string): T | null {
    const i = queue.findIndex((f) => f.pattern === null || f.pattern.test(target));
    return i >= 0 ? queue.splice(i, 1)[0] : null;
  }

  function forcedAnswer(f: ForcedFailure): Answer {
    if (f.status === 0) return { status: 0, body: null };
    if (f.body !== null) return { status: f.status, body: f.body };
    return errorAnswer(f.status, f.errorCode, f.message);
  }

  function route(method: string, path: string, q: URLSearchParams, rawBody: string, headers: Headers): Answer {
    if (!authorized(headers.get("authorization"))) {
      return errorAnswer(401, "INVALID_CREDENTIALS_ERROR", "invalid authentication credentials; authentication failed");
    }
    const target = `${method} ${path}`;
    if (takeFirst(rateLimits, target)) return errorAnswer(429, "TOO_MANY_REQUESTS_ERROR", "too many requests");
    const endpoint = endpointOf(method, path);
    if (!endpoint) return notFound();

    // Idempotency: POST and PATCH only, keys kept 12 hours, keyed on the exact request.
    const key = endpoint.write ? headers.get("x-beam-idempotency-key") : null;
    const fingerprint = `${target}\n${rawBody}`;
    if (key !== null) {
      if (key.length < 1 || key.length > 255) return validation("x-beam-idempotency-key must be 1-255 characters");
      for (const [k, s] of idempotency) if (s.expiresMs <= now()) idempotency.delete(k);
      const stored = idempotency.get(key);
      if (stored) {
        if (stored.fingerprint !== fingerprint) {
          return errorAnswer(412, "IDEMPOTENCY_KEY_ERROR", "the idempotency key was already used with a different payload");
        }
        return { status: stored.status, body: stored.body };
      }
    }
    const store = (a: Answer) => {
      if (key !== null && a.body !== null) idempotency.set(key, { ...a, fingerprint, expiresMs: now() + IDEMPOTENCY_TTL_MS });
    };

    const forced = takeFirst(failures, target);
    if (forced && !forced.afterProcessing) {
      const a = forcedAnswer(forced);
      if (replayErrors) store(a);
      return a;
    }
    const answer = endpoint.process(rawBody, q);
    if (answer.status < 300 || replayErrors) store(answer);
    if (forced) {
      // Processed, but the answer is lost or fails: an ambiguous outcome.
      const a = forcedAnswer(forced);
      if (replayErrors) store(a);
      return a;
    }
    return answer;
  }

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : null;
    const url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input);
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers);
    let rawBody = "";
    if (typeof init?.body === "string") rawBody = init.body;
    else if (init?.body instanceof Uint8Array) rawBody = new TextDecoder().decode(init.body);
    else if (init?.body !== undefined && init.body !== null) throw new TypeError("fake beam: unsupported request body type");
    else if (request && method !== "GET" && method !== "HEAD") rawBody = await request.text();

    let body: unknown = null;
    if (rawBody !== "") {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const call: FakeBeamCall = {
      method,
      path: url.pathname,
      query: queryRecord(url.searchParams),
      body,
      idempotencyKey: headers.get("x-beam-idempotency-key"),
      status: 0,
    };
    calls.push(call);

    let answer: Answer;
    if (url.origin === apiBase) {
      answer = route(method, url.pathname, url.searchParams, rawBody, headers);
    } else if (url.origin === otherBase) {
      // Playground and production are isolated: these keys are unknown there.
      answer = errorAnswer(401, "INVALID_CREDENTIALS_ERROR", "invalid authentication credentials; authentication failed");
    } else {
      throw new TypeError(`fetch failed (fake Beam: unknown host ${url.host})`);
    }
    call.status = answer.body === null ? 0 : answer.status;
    return toResponse(answer);
  }

  /* ---------------- controls ---------------- */

  return {
    fetch: handle as typeof fetch,
    /** Credentials for the real client: this fake's API base, merchant id and API key. */
    creds,
    apiBase,
    merchantId,
    hmacKeyB64,
    calls,
    links,
    charges,
    refunds,
    transactions,

    /** Calls whose "METHOD /path" matches. */
    count(pattern: RegExp): number {
      return calls.filter((c) => pattern.test(`${c.method} ${c.path}`)).length;
    },
    /** The link as it is now (auto-expiry applied). */
    link(id: string): FakeBeamLink {
      return mustLink(id);
    },
    charge(id: string): FakeBeamCharge {
      return mustCharge(id);
    },
    /** Every charge of a link, listed or not, oldest first. */
    chargesOf(linkId: string): FakeBeamCharge[] {
      return linkCharges(linkId);
    },
    refundRecord,

    /** The guest pays: a SUCCEEDED charge and the link turns PAID. */
    pay(id: string, method = "CARD", opts: FakeChargeOptions = {}): FakeBeamCharge {
      const l = mustLink(id);
      mustBeActive(l, "pay");
      checkMethod(l, method);
      const c = newCharge(l, "SUCCEEDED", method, opts);
      markPaid(l);
      return c;
    },
    /** An attempt that waits for confirmation (a PromptPay QR on screen, 3DS, an e-wallet app): PENDING, the link stays ACTIVE. */
    payPending(id: string, method = "QR_PROMPT_PAY", opts: FakeChargeOptions = {}): FakeBeamCharge {
      const l = mustLink(id);
      mustBeActive(l, "pay");
      checkMethod(l, method);
      return newCharge(l, "PENDING", method, opts);
    },
    /** A declined attempt: a FAILED charge; the link stays ACTIVE so the guest can retry. */
    decline(id: string, method = "CARD", failureCode = "CH_CARD_DECLINED"): FakeBeamCharge {
      const l = mustLink(id);
      mustBeActive(l, "pay");
      checkMethod(l, method);
      const c = newCharge(l, "FAILED", method);
      c.failureCode = failureCode;
      return c;
    },
    /**
     * A PENDING charge succeeds. An ACTIVE link turns PAID; a link that is
     * already EXPIRED or DISABLED stays so (a late success, UNVERIFIED with Beam).
     */
    succeed(chargeId: string): FakeBeamCharge {
      const c = mustCharge(chargeId);
      if (c.status !== "PENDING") throw new Error(`fake beam: charge ${chargeId} is ${c.status}, not PENDING`);
      const l = mustLink(c.sourceId);
      settle(c, "SUCCEEDED");
      if (l.status === "ACTIVE") markPaid(l);
      return c;
    },
    /** A PENDING charge fails; the link is untouched. */
    failCharge(chargeId: string, failureCode = "CH_PROCESSING_FAILED"): FakeBeamCharge {
      const c = mustCharge(chargeId);
      if (c.status !== "PENDING") throw new Error(`fake beam: charge ${chargeId} is ${c.status}, not PENDING`);
      settle(c, "FAILED", failureCode);
      return c;
    },
    /** The link reaches its expiry now (expiresAt moves to now): ACTIVE -> EXPIRED. */
    expire(id: string): FakeBeamLink {
      const l = mustLink(id);
      if (l.status === "EXPIRED") return l;
      mustBeActive(l, "expire");
      l.expiresAtMs = Math.min(l.expiresAtMs ?? now(), now());
      l.status = "EXPIRED";
      l.closedMs = now();
      return l;
    },
    /** Disabled in Lighthouse (the API's PATCH does the same): ACTIVE -> DISABLED. */
    disable(id: string): FakeBeamLink {
      const l = mustLink(id);
      if (l.status === "DISABLED") return l;
      mustBeActive(l, "disable");
      l.status = "DISABLED";
      l.closedMs = now();
      return l;
    },
    /**
     * A late success on an EXPIRED or DISABLED link: its oldest PENDING charge
     * succeeds, or else a charge begun just before the link closed succeeds now.
     * The link keeps its status.
     */
    payAfterClose(id: string, method = "QR_PROMPT_PAY", opts: FakeChargeOptions = {}): FakeBeamCharge {
      const l = mustLink(id);
      if (l.status !== "EXPIRED" && l.status !== "DISABLED") {
        throw new Error(`fake beam: payAfterClose needs an EXPIRED or DISABLED link; ${id} is ${l.status}`);
      }
      const pending = linkCharges(id).find((c) => c.status === "PENDING");
      if (pending) {
        settle(pending, "SUCCEEDED");
        return pending;
      }
      checkMethod(l, method);
      const c = newCharge(l, "PENDING", method, opts);
      c.createdMs = Math.min(now(), (l.closedMs ?? now()) - 1_000);
      settle(c, "SUCCEEDED");
      return c;
    },
    /** A second SUCCEEDED charge on a link that already has one (a duplicate payment). */
    secondCharge(id: string, method = "CARD", opts: FakeChargeOptions = {}): FakeBeamCharge {
      const l = mustLink(id);
      if (!linkCharges(id).some((c) => c.status === "SUCCEEDED")) {
        throw new Error(`fake beam: secondCharge needs a link with a SUCCEEDED charge; ${id} has none`);
      }
      checkMethod(l, method);
      return newCharge(l, "SUCCEEDED", method, opts);
    },
    /** The link turns PAID but its SUCCEEDED charge is not in the charge list yet (list lag) until revealCharges(). */
    markPaidWithoutCharge(id: string, method = "CARD", opts: FakeChargeOptions = {}): FakeBeamCharge {
      const l = mustLink(id);
      mustBeActive(l, "pay");
      checkMethod(l, method);
      const c = newCharge(l, "SUCCEEDED", method, opts);
      c.listed = false;
      markPaid(l);
      return c;
    },
    /** The charge list catches up: hidden charges of the link (or of every link) are listed. Returns how many. */
    revealCharges(id?: string): number {
      let n = 0;
      for (const c of charges.values()) {
        if (!c.listed && (id === undefined || c.sourceId === id)) {
          c.listed = true;
          n++;
        }
      }
      return n;
    },
    /**
     * A refund of a SUCCEEDED charge (as from Lighthouse). The amount defaults
     * to what is still refundable; partial refunds only on CARD, and only the
     * methods Beam can refund. SUCCEEDED (the default) moves the link to
     * REFUNDED (VOIDED with asVoid) as options.refundLinkStatus says; the
     * charge stays SUCCEEDED. Returns the refundId.
     */
    refund(
      chargeId: string,
      amount?: number,
      opts: { status?: BeamRefundStatus; failureCode?: string; asVoid?: boolean } = {},
    ): string {
      const c = mustCharge(chargeId);
      if (c.status !== "SUCCEEDED") throw new Error(`fake beam: charge ${chargeId} is ${c.status}; only a SUCCEEDED charge is refunded`);
      if (!REFUNDABLE_METHODS.has(c.paymentMethodType)) {
        throw new Error(`fake beam: ${c.paymentMethodType} charges cannot be refunded through Beam`);
      }
      const theirs = [...refunds.values()].filter((r) => r.chargeId === chargeId);
      if (theirs.some((r) => r.status === "PENDING")) throw new Error(`fake beam: REFUND_PENDING on charge ${chargeId}`);
      const refundable = c.amount - theirs.filter((r) => r.status === "SUCCEEDED").reduce((s, r) => s + r.amount, 0);
      const value = amount === undefined || amount === 0 ? refundable : amount;
      if (!Number.isInteger(value) || value < 1 || value > refundable) {
        throw new Error(`fake beam: refund of ${value} is not within the refundable ${refundable}`);
      }
      if (value < c.amount && c.paymentMethodType !== "CARD") {
        throw new Error(`fake beam: partial refunds are only possible on CARD, not ${c.paymentMethodType}`);
      }
      const t = now();
      const r: FakeBeamRefund = {
        refundId: uniqueId(() => `re_${base62(27)}`, refunds),
        chargeId,
        merchantId,
        referenceId: c.referenceId,
        amount: value,
        currency: c.currency,
        status: "PENDING",
        failureCode: "",
        createdMs: t,
        updatedMs: t,
        transactionMs: null,
        asVoid: opts.asVoid === true,
      };
      refunds.set(r.refundId, r);
      const status = opts.status ?? "SUCCEEDED";
      if (status !== "PENDING") settleRefund(r.refundId, status, opts.failureCode);
      return r.refundId;
    },
    /**
     * A PENDING refund settles. SUCCEEDED adds a REFUND (or VOID) transaction and moves the link to REFUNDED
     * (or VOIDED) as options.refundLinkStatus says.
     */
    settleRefund,
    /** A CHARGEBACK transaction on a SUCCEEDED charge (the charge and link are untouched). Returns the transactionId. */
    chargeback(chargeId: string, amount?: number): string {
      const c = mustCharge(chargeId);
      if (c.status !== "SUCCEEDED") throw new Error(`fake beam: charge ${chargeId} is ${c.status}; only a SUCCEEDED charge is charged back`);
      const id = uniqueId(() => `cb_${base62(27)}`, transactions);
      addTransaction(id, "CHARGEBACK", c, amount ?? c.amount);
      return id;
    },

    /* ---------------- faults ---------------- */

    /**
     * The next request whose "METHOD /path" matches answers `status` with
     * Beam's error body (status 0: a network error, the fetch rejects). With
     * afterProcessing the request is processed first and only its answer fails.
     */
    failNext(pattern: RegExp, status: number, errorCode: string | null = null, opts: FailNextOptions = {}): void {
      failures.push({
        pattern,
        status,
        errorCode,
        afterProcessing: opts.afterProcessing === true,
        message: opts.message ?? (status >= 500 ? "internal server error" : "simulated failure"),
        body: opts.body ?? null,
      });
    },
    /** The next n requests (matching the pattern, if given) answer 429 TOO_MANY_REQUESTS_ERROR. */
    rateLimitNext(n = 1, pattern?: RegExp): void {
      for (let i = 0; i < n; i++) rateLimits.push({ pattern: pattern ?? null });
    },
    /** Failed answers are cached under their idempotency key and replayed for 12 hours, like successes (gap review 15). */
    replayErrorsForKey(on = true): void {
      replayErrors = on;
    },
    /** The unfiltered charge list (no sourceId, no referenceId) answers 400 API_VALIDATION_ERROR. */
    unfilteredListUnsupported(on = true): void {
      unfilteredUnsupported = on;
    },

    /**
     * A webhook delivery: the resource's current GET body, exactly as Beam
     * POSTs it, with X-Beam-Signature over those bytes. `header` sends a
     * misleading X-Beam-Event (Beam does not sign the header); `hmacKeyB64`
     * signs with another key.
     */
    signedEvent(kind: FakeBeamEventKind, resourceId: string, opts: { header?: string; hmacKeyB64?: string } = {}): FakeBeamSignedEvent {
      let body: Json;
      switch (kind) {
        case "charge.succeeded":
        case "charge.failed": {
          const c = mustCharge(resourceId);
          const want = kind === "charge.succeeded" ? "SUCCEEDED" : "FAILED";
          if (c.status !== want) throw new Error(`fake beam: ${kind} for charge ${resourceId}, which is ${c.status}`);
          body = chargeView(c);
          break;
        }
        case "payment_link.paid": {
          const l = mustLink(resourceId);
          if (l.status !== "PAID") throw new Error(`fake beam: ${kind} for link ${resourceId}, which is ${l.status}`);
          body = linkView(l);
          break;
        }
        case "refund.succeeded":
        case "refund.failed": {
          const r = refundRecord(resourceId);
          const want = kind === "refund.succeeded" ? "SUCCEEDED" : "FAILED";
          if (r.status !== want) throw new Error(`fake beam: ${kind} for refund ${resourceId}, which is ${r.status}`);
          body = refundView(r);
          break;
        }
        case "transaction.created": {
          const t = transactions.get(resourceId);
          if (!t) throw new Error(`fake beam: no transaction ${resourceId}`);
          body = transactionView(t);
          break;
        }
        default:
          throw new Error(`fake beam: unknown event kind ${String(kind)}`);
      }
      const raw = JSON.stringify(body);
      return {
        raw,
        headers: {
          "x-beam-signature": beamSignature(raw, opts.hmacKeyB64 ?? hmacKeyB64),
          "x-beam-event": opts.header ?? kind,
        },
      };
    },
  };
}

export type FakeBeam = ReturnType<typeof createFakeBeam>;

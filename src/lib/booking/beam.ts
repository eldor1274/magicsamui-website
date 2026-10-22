// Beam Checkout (beamcheckout.com) client - Payment Links, Charges and Refunds, API v1.
// Server only. Spec: docs.beamcheckout.com (OpenAPI v1.25.0).
//
// - Auth: HTTP Basic base64(merchantId:apiKey). Credentials only ever go to
//   Beam's two API bases (live and playground); any other base is refused.
// - Amounts: integer satang; order.netAmount (>= 100) is exactly what is
//   charged. orderItems are display-only.
// - linkSettings REPLACES the account defaults: anything omitted is disabled.
// - The hosted page sends X-Frame-Options: DENY -> top-level redirect only. Its
//   host follows the API base: live -> pay.beamcheckout.com only, playground ->
//   playground-pay.beamcheckout.com only.
// - Webhooks: X-Beam-Signature = base64(HMAC-SHA256(base64decode(key), raw body)).
// - errorCode is an open string: CHARGE_PENDING, REFUND_PENDING and
//   CARD_AUTHORIZATION_PENDING are missing from the spec's enum.
// - Timestamps are parsed only when they carry Z or an offset (GET answers
//   carry +07:00; a bare local time would be read in the server's zone).
// - Reads (GET) and the create retry once on 429, 5xx and network errors after
//   100-400 ms of jitter, inside the caller's time budget (the create with the
//   same idempotency key). The disable is never retried.
// - Charges are reduced to the fields below: the customer block and the card's
//   last four digits never leave this module (only brand and country are kept).

import { createHmac, timingSafeEqual } from "node:crypto";
import { formatDisplayDate } from "./dates.ts";
import { BEAM_ID_PATTERN, isBeamLinkId } from "./payments/beamIds.ts";
import { MIN_CHARGE_SATANG, percentOf } from "./quote.ts";
import type { BeamCredentials } from "./config.ts";
import type { PayMethod, PaymentStatus, Quote } from "./types.ts";

export type { BeamCredentials };

export type BeamPaymentLinkStatus = "ACTIVE" | "PAID" | "EXPIRED" | "DISABLED" | "VOIDED" | "REFUNDED";

/**
 * Our two payment-method groups. The guest picks one on our page and the link
 * enables only that group: cards plus e-wallets, or the Thai PromptPay QR.
 * The request's, token's and quote's PayMethod (types.ts, design S3.2).
 */
export type BeamMethodGroup = PayMethod;

/**
 * The largest netAmount we send to Beam. PLACEHOLDER until Beam answers our
 * question 6 (maximum netAmount per link and per method); it equals Stripe's.
 */
export const BEAM_MAX_CHARGE_SATANG = 99_999_999;

export interface BeamOrderItem {
  itemName: string;
  description?: string;
  price: number;
  quantity: number;
  sku?: string;
}

export interface BeamMethodSetting {
  isEnabled: boolean;
}

/** LinkSettings: each group is on or off; a group left out is OFF (the account defaults are replaced). */
export interface BeamLinkSettings {
  card?: BeamMethodSetting;
  cardInstallments?: BeamMethodSetting;
  qrPromptPay?: BeamMethodSetting;
  /** All e-wallets at once (LINE_PAY, TRUE_MONEY, ALIPAY, WECHAT_PAY, SHOPEE_PAY): the spec has no per-wallet switch. */
  eWallets?: BeamMethodSetting;
  mobileBanking?: BeamMethodSetting;
  buyNowPayLater?: BeamMethodSetting;
}

export interface BeamCreatePaymentLinkRequest {
  order: {
    currency: "THB";
    netAmount: number;
    description: string;
    referenceId: string;
    internalNote: string;
    orderItems: BeamOrderItem[];
  };
  linkSettings: BeamLinkSettings;
  collectPhoneNumber: false;
  collectDeliveryAddress: false;
  redirectUrl: string;
  cancelUrl: string;
  expiresAt: string;
}

export interface BeamCreatePaymentLinkResponse {
  id: string;
  url: string;
}

export interface BeamPaymentLink {
  paymentLinkId: string;
  merchantId?: string;
  url?: string;
  status: BeamPaymentLinkStatus;
  order: {
    netAmount: number;
    currency: string;
    referenceId?: string;
    description?: string;
    /** The note we sent (the signed, PII-free note on hold-first links). */
    internalNote?: string;
    orderItems?: BeamOrderItem[];
  };
  linkSettings?: BeamLinkSettings;
  redirectUrl?: string;
  cancelUrl?: string;
  /** Offset-aware: read it with parseBeamTime. */
  expiresAt?: string;
  /** TRANSACTION_FEE (the default) or SERVICE_FEE; kept open. */
  feeType?: string;
}

export type BeamChargeStatus = "PENDING" | "SUCCEEDED" | "FAILED";

/** The card details we keep. Beam also sends the last four digits; parseBeamCharge drops them, so they can never be logged or stored. */
export interface BeamCardDetails {
  brand?: string;
  countryAlpha2?: string;
}

export interface BeamPaymentMethod {
  /** CARD, CARD_INSTALLMENTS, QR_PROMPT_PAY, ALIPAY, WECHAT_PAY, LINE_PAY, TRUE_MONEY, SHOPEE_PAY, ... (kept open). */
  paymentMethodType: string;
  card?: BeamCardDetails;
}

export interface BeamCharge {
  chargeId: string;
  merchantId?: string;
  referenceId?: string;
  status: BeamChargeStatus;
  amount: number;
  currency: string;
  source?: string;
  sourceId?: string;
  failureCode?: string;
  paymentMethod?: BeamPaymentMethod;
  /** When the charge was recorded as SUCCEEDED or FAILED. */
  transactionTime?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type BeamRefundStatus = "PENDING" | "SUCCEEDED" | "FAILED";

export interface BeamRefund {
  refundId: string;
  chargeId: string;
  merchantId?: string;
  referenceId?: string;
  amount: number;
  currency: string;
  status: BeamRefundStatus;
  failureCode?: string;
  createdAt?: string;
}

export class BeamApiError extends Error {
  /** The HTTP status; 0 when no HTTP answer is involved (refused base, budget spent). */
  readonly status: number;
  readonly errorCode: string | null;
  constructor(status: number, errorCode: string | null, message: string) {
    super(message);
    this.name = "BeamApiError";
    this.status = status;
    this.errorCode = errorCode;
  }
}

/** Beam answered 404 (NOT_FOUND_ERROR): the link, charge or refund does not exist for these credentials. */
export function isBeamNotFound(err: unknown): boolean {
  return err instanceof BeamApiError && err.status === 404;
}

/** What may be logged about a failed Beam call: no PII, no card data, no URL query strings. */
export interface BeamErrorInfo {
  status: number | null;
  errorCode: string | null;
  message: string;
}

export function beamErrorInfo(err: unknown): BeamErrorInfo {
  if (err instanceof BeamApiError) return { status: err.status, errorCode: err.errorCode, message: scrub(err.message) };
  if (err instanceof Error) {
    const errorCode =
      err.name === "TimeoutError" || err.name === "AbortError" ? "TIMEOUT" : err.name === "TypeError" ? "NETWORK_ERROR" : null;
    return { status: null, errorCode, message: scrub(`${err.name}: ${err.message}`) };
  }
  return { status: null, errorCode: null, message: "Beam request failed" };
}

/** Removes anything that could be personal data from a message: emails, long digit runs, URL queries. */
function scrub(message: string): string {
  const cleaned = message
    .slice(0, 2_000)
    .replace(/[^\s@]+@[^\s@]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]*\d/g, (run) => (run.replace(/\D/g, "").length >= 9 ? "[number]" : run))
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1");
  return clip(cleaned, 300);
}

const TIMEOUT_MS = 10_000;
/** A read's default wall-clock budget, both attempts included, when the caller gives none. */
export const DEFAULT_READ_BUDGET_MS = 15_000;
/** A retry starts only when at least this much of the caller's budget is left after the jitter. */
const MIN_ATTEMPT_MS = 1_000;
const RETRY_JITTER_MIN_MS = 100;
const RETRY_JITTER_MAX_MS = 400;
/** Beam's largest page (limit 1-100). */
const PAGE_SIZE = 100;

/** Beam's two API bases and the one hosted-page host each may hand out. */
const HOSTED_HOST_BY_API_BASE = new Map<string, string>([
  ["https://api.beamcheckout.com", "pay.beamcheckout.com"],
  ["https://playground.api.beamcheckout.com", "playground-pay.beamcheckout.com"],
]);

/** Options of one Beam call. Every member is optional; the test seams default to the real clock. */
export interface BeamCallOptions {
  /**
   * Wall-clock budget of the call in ms, retries and their jitter included.
   * Reads default to DEFAULT_READ_BUDGET_MS; createPaymentLink and
   * disablePaymentLink keep a plain 10 s per attempt when it is unset. For
   * listLinkChargesSince it is the budget of the whole scan. A caller inside a
   * route passes what is left of the route's deadline.
   */
  budgetMs?: number;
  /** Runs on every HTTP 429 answer (the runtime counts and alerts them). It can never break the call. */
  onRateLimited?: () => void;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function basicAuthHeader(merchantId: string, apiKey: string): string {
  return `Basic ${Buffer.from(`${merchantId}:${apiKey}`, "utf8").toString("base64")}`;
}

/** A Beam payment link id as we accept it in URLs, tokens and keys (payments/beamIds.ts, which imports nothing). */
export { isBeamLinkId };

/**
 * The only hosted-page host the given API base may hand out: the live base ->
 * pay.beamcheckout.com, the playground base -> playground-pay.beamcheckout.com,
 * any other base -> null.
 */
export function beamHostedHost(apiBase: string): string | null {
  return HOSTED_HOST_BY_API_BASE.get(apiBase.replace(/\/+$/, "")) ?? null;
}

/** True only for an https URL on exactly the base's hosted-page host (no port, no credentials). */
export function isBeamHostedPageUrl(url: string, apiBase: string): boolean {
  const host = beamHostedHost(apiBase);
  if (!host) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.host === host && u.username === "" && u.password === "";
}

/** The API base, refused (before any request) unless it is one of Beam's two. */
function apiBaseOf(creds: BeamCredentials): string {
  if (!beamHostedHost(creds.apiBase)) throw new BeamApiError(0, "UNEXPECTED_HOST", "Unexpected Beam API base");
  return creds.apiBase.replace(/\/+$/, "");
}

const BEAM_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Epoch ms of a Beam timestamp, or null. Only an ISO date-time with Z or an
 * explicit offset is read ("...+07:00" from GET, "...Z" in webhooks); a time
 * without a zone is refused rather than read in the server's own zone.
 */
export function parseBeamTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!BEAM_TIME.test(s)) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Reduces a Charge object (API answer or webhook body) to the fields we use; null when it is not an object.
 * The customer block and card.last4 are dropped here.
 */
export function parseBeamCharge(raw: unknown): BeamCharge | null {
  if (!isObject(raw)) return null;
  const charge: BeamCharge = {
    chargeId: str(raw.chargeId) ?? "",
    status: (str(raw.status) ?? "") as BeamChargeStatus,
    amount: typeof raw.amount === "number" ? raw.amount : Number.NaN,
    currency: str(raw.currency) ?? "",
  };
  const optional = ["merchantId", "referenceId", "source", "sourceId", "failureCode", "transactionTime", "createdAt", "updatedAt"] as const;
  for (const key of optional) {
    const v = str(raw[key]);
    if (v !== undefined) charge[key] = v;
  }
  if (isObject(raw.paymentMethod)) {
    const pm = raw.paymentMethod;
    const method: BeamPaymentMethod = { paymentMethodType: str(pm.paymentMethodType) ?? "" };
    if (isObject(pm.card)) {
      const card: BeamCardDetails = {};
      for (const key of ["brand", "countryAlpha2"] as const) {
        const v = str(pm.card[key]);
        if (v !== undefined) card[key] = v;
      }
      method.card = card;
    }
    charge.paymentMethod = method;
  }
  return charge;
}

/** Reduces a Refund object to the fields we use (the free-text refund reason is dropped); null when it is not one. */
export function parseBeamRefund(raw: unknown): BeamRefund | null {
  if (!isObject(raw) || typeof raw.refundId !== "string") return null;
  const refund: BeamRefund = {
    refundId: raw.refundId,
    chargeId: str(raw.chargeId) ?? "",
    amount: typeof raw.amount === "number" ? raw.amount : Number.NaN,
    currency: str(raw.currency) ?? "",
    status: (str(raw.status) ?? "") as BeamRefundStatus,
  };
  for (const key of ["merchantId", "referenceId", "failureCode", "createdAt"] as const) {
    const v = str(raw[key]);
    if (v !== undefined) refund[key] = v;
  }
  return refund;
}

/** The linkSettings of a method group: card_ewallet -> cards (+ e-wallets when on); promptpay -> the QR only. */
export function beamLinkSettings(group: BeamMethodGroup, ewallets: boolean): BeamLinkSettings {
  switch (group) {
    case "card_ewallet":
      return { card: { isEnabled: true }, eWallets: { isEnabled: ewallets === true } };
    case "promptpay":
      return { qrPromptPay: { isEnabled: true } };
    default:
      throw new RangeError(`Unknown Beam payment method group ${String(group)}`);
  }
}

interface PaymentLinkBaseInput {
  ref: string;
  quote: Quote;
  merchantName: string;
  redirectUrl: string;
  cancelUrl: string;
  nowMs: number;
  ttlMinutes: number;
}

/** The preview's link (no hold): card + PromptPay and a trace note, exactly as before. S4.6 removes it. */
export interface LegacyPaymentLinkInput extends PaymentLinkBaseInput {
  group?: undefined;
}

/** A hold-first link: only the chosen method group, the caller's note, one item per room line plus the fee. */
export interface GroupPaymentLinkInput extends PaymentLinkBaseInput {
  group: BeamMethodGroup;
  /** card_ewallet: also offer the e-wallets (the BEAM_EWALLETS switch). Ignored for promptpay. */
  ewallets: boolean;
  /**
   * The fee % this method group must carry: the caller's feePctFor(config, group) (S3.2), i.e. the card fee
   * for card_ewallet and BEAM_PROMPTPAY_FEE_PCT (0 unless the owner overrides it) for promptpay. The quote's
   * fee must be exactly this % of its fee base, else RangeError: a PromptPay link carrying the card fee, or a
   * card_ewallet link built from the fee-free quote, never reaches Beam (owner decision 1).
   */
  expectedFeePct: number;
  /** The signed, PII-free note (S2.4): sent verbatim, at most 500 characters, never clipped. */
  internalNote: string;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export type PaymentLinkInput = LegacyPaymentLinkInput | GroupPaymentLinkInput;

/**
 * Builds the create-payment-link body from a SERVER quote. The charged amount
 * is quote.dueNowSatang - nothing in here comes from the browser. Without a
 * group the preview's body (card + PromptPay) is built exactly as before.
 */
export function buildPaymentLinkRequest(input: PaymentLinkInput): BeamCreatePaymentLinkRequest {
  const { quote, ref } = input;
  const netAmount = quote.dueNowSatang;
  if (!Number.isInteger(netAmount) || netAmount < MIN_CHARGE_SATANG) {
    throw new RangeError(`Beam netAmount must be an integer >= ${MIN_CHARGE_SATANG} satang`);
  }
  const guests = quote.lines.reduce((s, l) => s + l.adults, 0);
  const rooms = quote.lines.map((l) => l.roomName).join(" + ");
  const dates = `${formatDisplayDate(quote.checkIn)} - ${formatDisplayDate(quote.checkOut)}`;
  const nightsLabel = `${quote.nights} night${quote.nights === 1 ? "" : "s"}`;
  const isDeposit = quote.dueNowSatang < quote.totalSatang;
  const description = clip(
    `${input.merchantName} - ${rooms}, ${dates} (${nightsLabel}, ${guests} guest${guests === 1 ? "" : "s"})${isDeposit ? " - deposit" : ""}`,
    500,
  );
  const wholeOrderItem: BeamOrderItem = {
    itemName: clip(`Booking ${ref}: ${rooms}`, 255),
    description: clip(`${dates}, ${nightsLabel}${isDeposit ? `, ${quote.depositPct}% deposit` : ""}`, 511),
    price: netAmount,
    quantity: 1,
    sku: ref,
  };
  const expiresAt = new Date(input.nowMs + input.ttlMinutes * 60_000).toISOString();

  if (input.group === undefined) {
    return {
      order: {
        currency: "THB",
        netAmount,
        description,
        referenceId: ref,
        internalNote: clip(
          `ref=${ref}; rooms=${quote.lines.map((l) => `${l.slug}:${l.ratePlanId}:${l.adults}`).join(",")}; ` +
            `total=${quote.totalSatang}; fee=${quote.cardFeeSatang}; due=${quote.dueNowSatang}; promo=${quote.promo?.code ?? "-"}`,
          500,
        ),
        orderItems: [wholeOrderItem],
      },
      linkSettings: {
        card: { isEnabled: true },
        qrPromptPay: { isEnabled: true },
      },
      collectPhoneNumber: false,
      collectDeliveryAddress: false,
      redirectUrl: input.redirectUrl,
      cancelUrl: input.cancelUrl,
      expiresAt,
    };
  }

  if (netAmount > BEAM_MAX_CHARGE_SATANG) {
    throw new RangeError(`Beam netAmount must be at most ${BEAM_MAX_CHARGE_SATANG} satang`);
  }
  if (typeof input.internalNote !== "string" || input.internalNote.length > 500) {
    // Never clipped: a clipped signed note would no longer verify.
    throw new RangeError("Beam internalNote must be a string of at most 500 characters");
  }
  checkGroupFee(input);
  const linkSettings = beamLinkSettings(input.group, input.ewallets);
  return {
    order: {
      currency: "THB",
      netAmount,
      description,
      referenceId: ref,
      internalNote: input.internalNote,
      orderItems: groupOrderItems(input, netAmount, `${dates}, ${nightsLabel}`, wholeOrderItem),
    },
    linkSettings,
    collectPhoneNumber: false,
    collectDeliveryAddress: false,
    redirectUrl: input.redirectUrl,
    cancelUrl: input.cancelUrl,
    expiresAt,
  };
}

/**
 * The last check before a money request: the quote's fee must be the fee of the link's method group,
 * expectedFeePct of the quote's fee base, and the total must be the fee base plus that fee (so dueNowSatang
 * cannot carry a fee the fee fields do not show).
 */
function checkGroupFee(input: GroupPaymentLinkInput): void {
  const { quote, group, expectedFeePct } = input;
  if (typeof expectedFeePct !== "number" || !Number.isFinite(expectedFeePct) || expectedFeePct < 0 || expectedFeePct > 100) {
    throw new RangeError("Beam expectedFeePct must be a number from 0 to 100");
  }
  const fee = quote.cardFeeSatang;
  const expectedFee = percentOf(quote.feeBaseSatang, expectedFeePct);
  if (quote.cardFeePct !== expectedFeePct || fee !== expectedFee || quote.totalSatang !== quote.feeBaseSatang + fee) {
    throw new RangeError(
      `Beam ${group} link: the quote's fee is ${quote.cardFeePct}% (${fee} satang), not the ${expectedFeePct}% (${expectedFee} satang) this method group must carry`,
    );
  }
}

/**
 * One item per room line plus 'Payment processing fee (n%)' when there is a
 * fee. Items are display-only, so when they do not add up to netAmount exactly
 * (a site-side promo, a deposit) one item for the whole amount is sent instead.
 */
function groupOrderItems(input: GroupPaymentLinkInput, netAmount: number, stay: string, wholeOrderItem: BeamOrderItem): BeamOrderItem[] {
  const { quote } = input;
  const items: BeamOrderItem[] = quote.lines.map((l) => ({
    itemName: clip(l.roomName, 255),
    description: clip(`${stay}, ${l.adults} guest${l.adults === 1 ? "" : "s"}, ${l.ratePlanName}`, 511),
    price: l.roomSatang + l.addonsSatang,
    quantity: 1,
    sku: clip(l.slug, 255),
  }));
  if (quote.cardFeeSatang > 0) {
    items.push({ itemName: `Payment processing fee (${quote.cardFeePct}%)`, price: quote.cardFeeSatang, quantity: 1 });
  }
  const itemsSatang = items.reduce((s, i) => s + i.price, 0);
  if (items.length > 0 && items.every((i) => Number.isInteger(i.price) && i.price > 0) && itemsSatang === netAmount) {
    return items;
  }
  input.log?.("beam_items_fallback", { ref: input.ref, netAmount, itemsSatang, items: items.length });
  return [wholeOrderItem];
}

async function readError(res: Response): Promise<BeamApiError> {
  let code: string | null = null;
  let message = `Beam HTTP ${res.status}`;
  try {
    const j = (await res.json()) as { message?: unknown; error?: { errorCode?: unknown; errorMessage?: unknown } };
    if (typeof j.error?.errorCode === "string") code = j.error.errorCode;
    if (typeof j.error?.errorMessage === "string") message = `${message}: ${j.error.errorMessage}`;
    else if (typeof j.message === "string") message = `${message}: ${j.message}`;
  } catch {
    // non-JSON error body
  }
  return new BeamApiError(res.status, code, message);
}

/** A 2xx body that is not JSON is a Beam-side fault, not a network error. */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new BeamApiError(res.status, "INVALID_RESPONSE", `Beam HTTP ${res.status}: the answer is not JSON`);
    }
    throw err;
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof BeamApiError) return err.status === 429 || err.status >= 500;
  return true; // network error / timeout
}

function rateLimited(opts: BeamCallOptions): void {
  try {
    opts.onRateLimited?.();
  } catch {
    // a counter must never break a payment call
  }
}

function authHeaders(creds: BeamCredentials): Record<string, string> {
  return { authorization: basicAuthHeader(creds.merchantId, creds.apiKey), accept: "application/json" };
}

function jitterMs(random: () => number): number {
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.min(RETRY_JITTER_MAX_MS, RETRY_JITTER_MIN_MS + Math.floor(r * (RETRY_JITTER_MAX_MS - RETRY_JITTER_MIN_MS + 1)));
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function failure(lastError: unknown): Error {
  if (lastError instanceof Error) return lastError;
  if (lastError === null) return new BeamApiError(0, "BUDGET_EXHAUSTED", "Beam call not attempted: the time budget is spent");
  return new Error("Beam request failed");
}

/**
 * GET {base}{path}. One retry on 429, 5xx and network errors after 100-400 ms
 * of jitter, only while the budget leaves room for it; each attempt's timeout
 * is the smaller of 10 s and what is left.
 */
async function beamGet(creds: BeamCredentials, path: string, fetchImpl: typeof fetch, opts: BeamCallOptions): Promise<unknown> {
  const url = `${apiBaseOf(creds)}${path}`;
  const now = opts.now ?? Date.now;
  const budget = opts.budgetMs ?? DEFAULT_READ_BUDGET_MS;
  const started = now();
  const left = () => budget - (now() - started);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = Math.floor(left());
    if (remaining < 1) break;
    try {
      const res = await fetchImpl(url, {
        headers: authHeaders(creds),
        cache: "no-store",
        signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, remaining)),
      });
      if (res.status === 429) rateLimited(opts);
      if (!res.ok) throw await readError(res);
      return await readJson(res);
    } catch (err) {
      lastError = err;
      if (attempt === 1 || !isRetryable(err)) break;
      const delay = jitterMs(opts.random ?? Math.random);
      if (left() - delay < MIN_ATTEMPT_MS) break;
      await (opts.sleep ?? realSleep)(delay);
    }
  }
  throw failure(lastError);
}

/**
 * POST /api/v1/payment-links. Retries once (same idempotency key, same body)
 * on network errors, 429 and 5xx, after 100-400 ms of jitter (Beam asks for
 * backoff with jitter, above all on 429). Returns {id, url}; the url must be
 * an https page on the base's own hosted host before it is ever used as a
 * redirect (otherwise BeamApiError UNEXPECTED_HOST). With opts.budgetMs each
 * attempt's timeout fits the budget, and the retry runs only when at least
 * MIN_ATTEMPT_MS of the budget is still left after the jitter.
 */
export async function createPaymentLink(
  creds: BeamCredentials,
  body: BeamCreatePaymentLinkRequest,
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch,
  opts: BeamCallOptions = {},
): Promise<BeamCreatePaymentLinkResponse> {
  const base = apiBaseOf(creds);
  const payload = JSON.stringify(body);
  const now = opts.now ?? Date.now;
  const started = now();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let timeoutMs = TIMEOUT_MS;
    if (opts.budgetMs !== undefined) {
      const remaining = Math.floor(opts.budgetMs - (now() - started));
      if (remaining < (attempt === 0 ? 1 : MIN_ATTEMPT_MS)) break;
      timeoutMs = Math.min(TIMEOUT_MS, remaining);
    }
    try {
      const res = await fetchImpl(`${base}/api/v1/payment-links`, {
        method: "POST",
        headers: {
          authorization: basicAuthHeader(creds.merchantId, creds.apiKey),
          "content-type": "application/json",
          accept: "application/json",
          "x-beam-idempotency-key": idempotencyKey,
        },
        body: payload,
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429) rateLimited(opts);
      if (res.status !== 201 && res.status !== 200) throw await readError(res);
      const j = (await readJson(res)) as Partial<BeamCreatePaymentLinkResponse> | null;
      if (typeof j?.id !== "string" || typeof j.url !== "string") {
        throw new BeamApiError(res.status, null, "Beam response missing id/url");
      }
      if (!isBeamHostedPageUrl(j.url, base)) {
        let host = "(invalid URL)";
        try {
          host = new URL(j.url).host;
        } catch {
          // keep the placeholder
        }
        throw new BeamApiError(res.status, "UNEXPECTED_HOST", `Unexpected Beam hosted page host ${host}`);
      }
      return { id: j.id, url: j.url };
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === 1) break;
      const delay = jitterMs(opts.random ?? Math.random);
      if (opts.budgetMs !== undefined && opts.budgetMs - (now() - started) - delay < MIN_ATTEMPT_MS) break;
      await (opts.sleep ?? realSleep)(delay);
    }
  }
  throw failure(lastError);
}

/** GET /api/v1/payment-links/{id} (read retry, see beamGet). */
export async function getPaymentLink(
  creds: BeamCredentials,
  paymentLinkId: string,
  fetchImpl: typeof fetch = fetch,
  opts: BeamCallOptions = {},
): Promise<BeamPaymentLink> {
  if (!isBeamLinkId(paymentLinkId)) throw new BeamApiError(400, null, "Invalid payment link id");
  const j = await beamGet(creds, `/api/v1/payment-links/${encodeURIComponent(paymentLinkId)}`, fetchImpl, opts);
  if (!isObject(j)) throw new BeamApiError(200, "INVALID_RESPONSE", "Beam payment link answer is not an object");
  if (typeof j.paymentLinkId === "string" && j.paymentLinkId !== paymentLinkId) {
    throw new BeamApiError(200, "INVALID_RESPONSE", "Beam answered for another payment link");
  }
  return j as unknown as BeamPaymentLink;
}

export type BeamDisableResult = "disabled" | "not_open";

/** Error codes that refuse a disable because of the link's own state: it is no longer ACTIVE. */
const DISABLE_NOT_OPEN_CODES = new Set(["OPERATION_NOT_ALLOWED_ERROR", "REQUEST_CONFLICT_ERROR"]);

/** Error codes that say OUR request, key or account is wrong: a disable answered with one throws (the caller alerts). */
const DISABLE_FAULT_CODES = new Set([
  "INVALID_JSON_ERROR",
  "INVALID_XML_ERROR",
  "API_VALIDATION_ERROR",
  "INVALID_CREDENTIALS_ERROR",
  "NO_PERMISSION_ERROR",
  "NOT_FOUND_ERROR",
  "IDEMPOTENCY_KEY_ERROR",
  "MERCHANT_STATUS_INVALID_ERROR",
  "TOO_MANY_REQUESTS_ERROR",
]);

/**
 * PATCH /api/v1/payment-links/{id}/disable with the caller's idempotency key
 * (a fresh one per attempt). 2xx (202) -> 'disabled'. 'not_open' only when
 * Beam refuses because of the link's state: errorCode OPERATION_NOT_ALLOWED_ERROR
 * or REQUEST_CONFLICT_ERROR on any 4xx other than 401/404/429, or a 409/422
 * whose code is not one of DISABLE_FAULT_CODES (no code, CHARGE_PENDING, a new
 * code). Everything else throws, so a configuration fault (400 validation or
 * JSON errors, 403 NO_PERMISSION_ERROR, 412 IDEMPOTENCY_KEY_ERROR, 422
 * MERCHANT_STATUS_INVALID_ERROR) never reads as "already closed"; 404
 * (isBeamNotFound), 401, 429, 5xx and network errors throw too. Beam's answer
 * for a link that is no longer ACTIVE is UNVERIFIED, so callers always re-read
 * the link afterwards. No retry here (a retry is a new attempt with a new key).
 */
export async function disablePaymentLink(
  creds: BeamCredentials,
  paymentLinkId: string,
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch,
  opts: BeamCallOptions = {},
): Promise<BeamDisableResult> {
  if (!isBeamLinkId(paymentLinkId)) throw new BeamApiError(400, null, "Invalid payment link id");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 255) {
    throw new RangeError("Beam idempotency key must be 1-255 characters");
  }
  const base = apiBaseOf(creds);
  const budget = opts.budgetMs === undefined ? TIMEOUT_MS : Math.floor(opts.budgetMs);
  if (budget < 1) throw failure(null);
  const timeoutMs = Math.min(TIMEOUT_MS, budget);
  const res = await fetchImpl(`${base}/api/v1/payment-links/${encodeURIComponent(paymentLinkId)}/disable`, {
    method: "PATCH",
    headers: { ...authHeaders(creds), "x-beam-idempotency-key": idempotencyKey },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429) rateLimited(opts);
  if (res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return "disabled";
  }
  const err = await readError(res);
  if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 404 && res.status !== 429) {
    if (err.errorCode !== null && DISABLE_NOT_OPEN_CODES.has(err.errorCode)) return "not_open";
    if ((res.status === 409 || res.status === 422) && (err.errorCode === null || !DISABLE_FAULT_CODES.has(err.errorCode))) return "not_open";
  }
  throw err;
}

/** How to find a payment link's charges: by link id (the documented join key) or by our booking ref. */
export type ChargeLookup = { sourceId: string } | { referenceId: string };

interface ChargePage {
  charges: BeamCharge[];
  /** Entries Beam sent on this page (before parsing), to detect the last page. */
  rawCount: number;
  totalCount: number | null;
}

async function readChargePage(creds: BeamCredentials, q: URLSearchParams, fetchImpl: typeof fetch, opts: BeamCallOptions): Promise<ChargePage> {
  const j = await beamGet(creds, `/api/v1/charges?${q.toString()}`, fetchImpl, opts);
  if (!isObject(j) || !Array.isArray(j.data)) {
    // Never read a malformed answer as "no charges": that could release a paid booking.
    throw new BeamApiError(200, "INVALID_RESPONSE", "Beam charge list answer has no data array");
  }
  const charges: BeamCharge[] = [];
  for (const raw of j.data) {
    const c = parseBeamCharge(raw);
    if (c) charges.push(c);
  }
  return { charges, rawCount: j.data.length, totalCount: typeof j.totalCount === "number" ? j.totalCount : null };
}

/**
 * GET /api/v1/charges?source_in=PAYMENT_LINK&sourceId={paymentLinkId}: a
 * link's charges carry sourceId = paymentLinkId. The `referenceId` form is only
 * a fallback for when the browser lost the link id (e.g. returned in a new
 * tab). Beam's examples copy order.referenceId onto the charge, but that is
 * not guaranteed, so an empty answer there proves nothing. One page of 100,
 * newest first (read retry, see beamGet).
 */
export async function listPaymentLinkCharges(
  creds: BeamCredentials,
  lookup: ChargeLookup,
  fetchImpl: typeof fetch = fetch,
  opts: BeamCallOptions = {},
): Promise<BeamCharge[]> {
  const q = new URLSearchParams({ source_in: "PAYMENT_LINK", limit: String(PAGE_SIZE) });
  if ("sourceId" in lookup) {
    if (!isBeamLinkId(lookup.sourceId)) throw new BeamApiError(400, null, "Invalid payment link id");
    q.set("sourceId", lookup.sourceId);
  } else {
    q.set("referenceId", lookup.referenceId);
  }
  return (await readChargePage(creds, q, fetchImpl, opts)).charges;
}

export interface ChargeScan {
  /**
   * Every PAYMENT_LINK charge created at or after sinceMs that was read, newest first, each chargeId once:
   * at the position it was first read, holding its freshest copy (see isFresherCopy).
   */
  charges: BeamCharge[];
  /** True when the scan reached a charge older than sinceMs or the end of the list. */
  complete: boolean;
  /** Set when a later page failed (the charges before it are kept). */
  error?: BeamErrorInfo;
}

/**
 * Whether a later-read copy of a charge replaces the copy already kept: a SUCCEEDED copy beats a copy in
 * any other state (and is never replaced by one); between two copies in the same state the later
 * updatedAt wins, and the later read wins when the times tie or cannot be read.
 */
function isFresherCopy(kept: BeamCharge, later: BeamCharge): boolean {
  const keptSucceeded = kept.status === "SUCCEEDED";
  const laterSucceeded = later.status === "SUCCEEDED";
  if (keptSucceeded !== laterSucceeded) return laterSucceeded;
  const keptMs = parseBeamTime(kept.updatedAt);
  const laterMs = parseBeamTime(later.updatedAt);
  return keptMs === null || laterMs === null || laterMs >= keptMs;
}

/**
 * The backstop scan: GET /api/v1/charges?source_in=PAYMENT_LINK&limit=100&offset=n,
 * newest first, page by page, stopping at the first charge whose createdAt
 * (offset-aware) is older than sinceMs. A charge without a readable createdAt
 * is kept and the scan goes on. complete=false when maxPages (default 10) or
 * the budget ran out first. The first page's failure throws (e.g. Beam refusing
 * the unfiltered list); a later page's failure returns what was read, with
 * complete=false and error. opts.budgetMs is the budget of the whole scan.
 * New charges at the top shift the offsets, so a charge can come back on the
 * next page, changed in between (PENDING -> SUCCEEDED): it is listed once, at
 * its first position, with its freshest copy (isFresherCopy), so a success
 * seen on the later page is never lost behind the stale copy.
 */
export async function listLinkChargesSince(
  creds: BeamCredentials,
  { sinceMs, maxPages = 10 }: { sinceMs: number; maxPages?: number },
  fetchImpl: typeof fetch = fetch,
  opts: BeamCallOptions = {},
): Promise<ChargeScan> {
  if (!Number.isFinite(sinceMs)) throw new RangeError("sinceMs must be a finite epoch time in ms");
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new RangeError("maxPages must be a positive integer");
  const now = opts.now ?? Date.now;
  const started = now();
  const positionOf = new Map<string, number>();
  const charges: BeamCharge[] = [];
  for (let page = 0; page < maxPages; page++) {
    let pageOpts = opts;
    if (opts.budgetMs !== undefined) {
      const remaining = opts.budgetMs - (now() - started);
      if (remaining < MIN_ATTEMPT_MS) return { charges, complete: false };
      pageOpts = { ...opts, budgetMs: remaining };
    }
    const q = new URLSearchParams({ source_in: "PAYMENT_LINK", limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
    let result: ChargePage;
    try {
      result = await readChargePage(creds, q, fetchImpl, pageOpts);
    } catch (err) {
      if (page === 0) throw err;
      return { charges, complete: false, error: beamErrorInfo(err) };
    }
    for (const c of result.charges) {
      const createdMs = parseBeamTime(c.createdAt);
      if (createdMs !== null && createdMs < sinceMs) return { charges, complete: true };
      if (c.chargeId !== "") {
        // New charges arriving at the top shift the offsets: a charge can come back on the next page.
        const i = positionOf.get(c.chargeId);
        if (i !== undefined) {
          if (isFresherCopy(charges[i], c)) charges[i] = c;
          continue;
        }
        positionOf.set(c.chargeId, charges.length);
      }
      charges.push(c);
    }
    const read = page * PAGE_SIZE + result.rawCount;
    if (result.rawCount < PAGE_SIZE || (result.totalCount !== null && read >= result.totalCount)) {
      return { charges, complete: true };
    }
  }
  return { charges, complete: false };
}

/** GET /api/v1/refunds/{refundId}: the refund's real status (read retry, see beamGet). */
export async function getRefund(
  creds: BeamCredentials,
  refundId: string,
  fetchImpl: typeof fetch = fetch,
  opts: BeamCallOptions = {},
): Promise<BeamRefund> {
  if (typeof refundId !== "string" || !BEAM_ID_PATTERN.test(refundId)) throw new BeamApiError(400, null, "Invalid refund id");
  const j = await beamGet(creds, `/api/v1/refunds/${encodeURIComponent(refundId)}`, fetchImpl, opts);
  const refund = parseBeamRefund(j);
  if (!refund || refund.refundId !== refundId) {
    throw new BeamApiError(200, "INVALID_RESPONSE", "Beam refund answer is not the refund asked for");
  }
  return refund;
}

export function mapLinkStatus(status: BeamPaymentLinkStatus | string): PaymentStatus {
  switch (status) {
    case "PAID":
      return "paid";
    case "ACTIVE":
      return "pending";
    case "EXPIRED":
      return "expired";
    case "DISABLED":
      return "cancelled";
    case "VOIDED":
    case "REFUNDED":
      return "refunded";
    default:
      return "pending";
  }
}

/**
 * Verifies X-Beam-Signature against the EXACT raw request body bytes.
 * The Lighthouse HMAC key is base64 and must be decoded before use.
 */
export function verifyBeamSignature(
  rawBody: Uint8Array | string,
  signatureHeader: string | null | undefined,
  base64HmacKey: string,
): boolean {
  if (!signatureHeader || !base64HmacKey) return false;
  const key = Buffer.from(base64HmacKey, "base64");
  if (key.length === 0) return false;
  const given = Buffer.from(signatureHeader.trim(), "base64");
  const expected = createHmac("sha256", key)
    .update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody)
    .digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

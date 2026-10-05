// Beam Checkout (beamcheckout.com) client - Payment Links API, v1.
// Server only. Spec: docs.beamcheckout.com (OpenAPI v1.25.0).
//
// - Auth: HTTP Basic base64(merchantId:apiKey).
// - Amounts: integer satang; order.netAmount (>= 100) is exactly what is
//   charged. orderItems are display-only.
// - linkSettings REPLACES the account defaults: anything omitted is disabled.
// - The hosted page sends X-Frame-Options: DENY -> top-level redirect only.
// - Webhooks: X-Beam-Signature = base64(HMAC-SHA256(base64decode(key), raw body)).

import { createHmac, timingSafeEqual } from "node:crypto";
import { formatDisplayDate } from "./dates.ts";
import { MIN_CHARGE_SATANG } from "./quote.ts";
import type { BeamCredentials } from "./config.ts";
import type { PaymentStatus, Quote } from "./types.ts";

export type { BeamCredentials };

export type BeamPaymentLinkStatus = "ACTIVE" | "PAID" | "EXPIRED" | "DISABLED" | "VOIDED" | "REFUNDED";

export interface BeamOrderItem {
  itemName: string;
  description?: string;
  price: number;
  quantity: number;
  sku?: string;
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
  linkSettings: {
    card: { isEnabled: true };
    qrPromptPay: { isEnabled: true };
  };
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
  order: { netAmount: number; currency: string; referenceId?: string; description?: string };
  expiresAt?: string;
}

export class BeamApiError extends Error {
  readonly status: number;
  readonly errorCode: string | null;
  constructor(status: number, errorCode: string | null, message: string) {
    super(message);
    this.name = "BeamApiError";
    this.status = status;
    this.errorCode = errorCode;
  }
}

const HOSTED_PAGE_HOSTS = new Set(["pay.beamcheckout.com", "playground-pay.beamcheckout.com"]);
const TIMEOUT_MS = 10_000;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function basicAuthHeader(merchantId: string, apiKey: string): string {
  return `Basic ${Buffer.from(`${merchantId}:${apiKey}`, "utf8").toString("base64")}`;
}

export interface PaymentLinkInput {
  ref: string;
  quote: Quote;
  merchantName: string;
  redirectUrl: string;
  cancelUrl: string;
  nowMs: number;
  ttlMinutes: number;
}

/**
 * Builds the create-payment-link body from a SERVER quote. The charged amount
 * is quote.dueNowSatang - nothing in here comes from the browser.
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

  return {
    order: {
      currency: "THB",
      netAmount,
      description: clip(
        `${input.merchantName} - ${rooms}, ${dates} (${nightsLabel}, ${guests} guest${guests === 1 ? "" : "s"})${isDeposit ? " - deposit" : ""}`,
        500,
      ),
      referenceId: ref,
      internalNote: clip(
        `ref=${ref}; rooms=${quote.lines.map((l) => `${l.slug}:${l.ratePlanId}:${l.adults}`).join(",")}; ` +
          `total=${quote.totalSatang}; fee=${quote.cardFeeSatang}; due=${quote.dueNowSatang}; promo=${quote.promo?.code ?? "-"}`,
        500,
      ),
      orderItems: [
        {
          itemName: clip(`Booking ${ref}: ${rooms}`, 255),
          description: clip(`${dates}, ${nightsLabel}${isDeposit ? `, ${quote.depositPct}% deposit` : ""}`, 511),
          price: netAmount,
          quantity: 1,
          sku: ref,
        },
      ],
    },
    linkSettings: {
      card: { isEnabled: true },
      qrPromptPay: { isEnabled: true },
    },
    collectPhoneNumber: false,
    collectDeliveryAddress: false,
    redirectUrl: input.redirectUrl,
    cancelUrl: input.cancelUrl,
    expiresAt: new Date(input.nowMs + input.ttlMinutes * 60_000).toISOString(),
  };
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

function isRetryable(err: unknown): boolean {
  if (err instanceof BeamApiError) return err.status === 429 || err.status >= 500;
  return true; // network error / timeout
}

/**
 * POST /api/v1/payment-links. Retries once (same idempotency key, same body)
 * on network errors, 429 and 5xx. Returns {id, url}; the url is checked to be
 * a Beam hosted page before it is ever used as a redirect.
 */
export async function createPaymentLink(
  creds: BeamCredentials,
  body: BeamCreatePaymentLinkRequest,
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BeamCreatePaymentLinkResponse> {
  const payload = JSON.stringify(body);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(`${creds.apiBase}/api/v1/payment-links`, {
        method: "POST",
        headers: {
          authorization: basicAuthHeader(creds.merchantId, creds.apiKey),
          "content-type": "application/json",
          accept: "application/json",
          "x-beam-idempotency-key": idempotencyKey,
        },
        body: payload,
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status !== 201 && res.status !== 200) throw await readError(res);
      const j = (await res.json()) as Partial<BeamCreatePaymentLinkResponse>;
      if (typeof j.id !== "string" || typeof j.url !== "string") {
        throw new BeamApiError(res.status, null, "Beam response missing id/url");
      }
      const host = new URL(j.url).host;
      if (new URL(j.url).protocol !== "https:" || !HOSTED_PAGE_HOSTS.has(host)) {
        throw new BeamApiError(res.status, null, `Unexpected Beam hosted page host ${host}`);
      }
      return { id: j.id, url: j.url };
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === 1) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Beam request failed");
}

/** GET /api/v1/payment-links/{id}. */
export async function getPaymentLink(
  creds: BeamCredentials,
  paymentLinkId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BeamPaymentLink> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(paymentLinkId)) throw new BeamApiError(400, null, "Invalid payment link id");
  const res = await fetchImpl(`${creds.apiBase}/api/v1/payment-links/${encodeURIComponent(paymentLinkId)}`, {
    headers: { authorization: basicAuthHeader(creds.merchantId, creds.apiKey), accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as BeamPaymentLink;
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

export interface BeamCharge {
  chargeId: string;
  referenceId?: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  amount: number;
  currency: string;
  source?: string;
  sourceId?: string;
  failureCode?: string;
}

/**
 * GET /api/v1/charges?referenceId=..&source_in=PAYMENT_LINK - fallback used
 * when the browser lost the payment link id (e.g. returned in a new tab).
 */
export async function listPaymentLinkCharges(
  creds: BeamCredentials,
  referenceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BeamCharge[]> {
  const q = new URLSearchParams({ referenceId, source_in: "PAYMENT_LINK", limit: "20" });
  const res = await fetchImpl(`${creds.apiBase}/api/v1/charges?${q.toString()}`, {
    headers: { authorization: basicAuthHeader(creds.merchantId, creds.apiKey), accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw await readError(res);
  const j = (await res.json()) as { data?: BeamCharge[] };
  return Array.isArray(j.data) ? j.data : [];
}

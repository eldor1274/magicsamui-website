// Stripe Checkout (WI-2). Server only. Official SDK, pinned (package.json).
//
// - Checkout Session, mode=payment, currency thb. THB is a 2-decimal currency
//   in Stripe, so unit_amount is our integer SATANG 1:1 (no conversion here).
// - card + promptpay through allowed_payment_method_types (API 2026-09-30
//   replaced payment_method_types); Apple Pay / Google Pay come via card.
//   A Thai Stripe account takes Visa and Mastercard only.
// - client_reference_id = MSV ref; metadata (and payment_intent_data.metadata)
//   carry the ref, the Cloudbeds reservationID, amounts, yes/no guest
//   flags (late arrival, requests entered, note saved) and the booking terms
//   version the guest agreed to (POLICY_VERSION) - NO personal data.
// - customer_email = the guest's email (Stripe receipt), submit_type=book,
//   expires_at = now + 30 min (+1 min clock margin; Stripe's minimum is 30),
//   locale auto, Adaptive Pricing off (always THB), one idempotency key per
//   booking attempt.
// - Webhooks: stripe.webhooks.constructEvent over the RAW body, 300 s tolerance.

import Stripe from "stripe";
import { POLICY_VERSION } from "../catalogue.ts";
import { formatDisplayDate } from "../dates.ts";
import type { Quote } from "../types.ts";

/** The API version this code is written against (= the pinned SDK's own). */
export const STRIPE_API_VERSION = "2026-09-30.endive" as const;
export const WEBHOOK_TOLERANCE_SECONDS = 300;
/** Stripe requires expires_at >= 30 min after creation; one extra minute absorbs clock skew. */
export const SESSION_EXPIRY_MARGIN_SECONDS = 60;
/**
 * Stripe's largest charge: amounts are limited to 8 digits in the smallest
 * unit (THB 999,999.99). PromptPay may cap lower - verified in Stage B.
 */
export const STRIPE_MAX_CHARGE_SATANG = 99_999_999;

export type StripeClient = Stripe;
export type CheckoutSession = Stripe.Checkout.Session;
export type StripeEvent = Stripe.Event;

export interface StripeClientOptions {
  /** Custom fetch (the in-repo fake in tests and stripe-mock). */
  fetchImpl?: typeof fetch;
  maxNetworkRetries?: number;
}

export function createStripeClient(secretKey: string, options: StripeClientOptions = {}): Stripe {
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    // The SDK adds idempotency keys to retried POSTs itself; ours is explicit anyway.
    maxNetworkRetries: options.maxNetworkRetries ?? (options.fetchImpl ? 0 : 2),
    timeout: 15_000,
    telemetry: false,
    appInfo: { name: "magicsamui-booking" },
    ...(options.fetchImpl ? { httpClient: Stripe.createFetchHttpClient(options.fetchImpl) } : {}),
  });
}

/* ------------------------------ metadata ------------------------------ */

/** What we put on every session (and its PaymentIntent). Strings only, no PII. */
export interface SessionMeta {
  ref: string;
  reservationId: string;
  roomsSatang: number;
  feeSatang: number;
  totalSatang: number;
  checkIn: string;
  checkOut: string;
  mode: string;
  /**
   * Yes/no guest flags (NEVER the request text or other personal data): arrival after 11 PM,
   * special requests entered, and whether the pre-payment Cloudbeds note carrying them was saved.
   * null/absent = unknown (sessions created before the flags existed): nothing is done on them.
   */
  arrivalLate?: boolean | null;
  hasRequests?: boolean | null;
  noteSaved?: boolean | null;
  /** The booking terms version agreed to (msv_terms); null/absent on sessions created before it existed. */
  termsVersion?: string | null;
}

const META_PREFIX = "msv_";

export function sessionMetadata(m: SessionMeta): Record<string, string> {
  const flags = { msv_arrival_late: m.arrivalLate, msv_has_requests: m.hasRequests, msv_note_saved: m.noteSaved };
  return {
    msv_ref: m.ref,
    msv_cb_reservation_id: m.reservationId,
    msv_rooms_satang: String(m.roomsSatang),
    msv_fee_satang: String(m.feeSatang),
    msv_total_satang: String(m.totalSatang),
    msv_checkin: m.checkIn,
    msv_checkout: m.checkOut,
    msv_mode: m.mode,
    ...(m.termsVersion ? { msv_terms: m.termsVersion } : {}),
    ...Object.fromEntries(Object.entries(flags).flatMap(([k, v]) => (typeof v === "boolean" ? [[k, v ? "1" : "0"]] : []))),
  };
}

const REF_RE = /^MSV-\d{8}-[A-HJ-NP-Z2-9]{4}$/;

/**
 * Our metadata from a session, or null when the session is not one of ours
 * (this Stripe account is shared with Cloudbeds, so other sessions exist).
 */
export function parseSessionMeta(session: Pick<CheckoutSession, "metadata" | "client_reference_id">): SessionMeta | null {
  const md = session.metadata ?? {};
  const int = (v: unknown) => (typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : NaN);
  const flag = (v: unknown) => (v === "1" ? true : v === "0" ? false : null);
  const ref = md[`${META_PREFIX}ref`];
  const reservationId = md[`${META_PREFIX}cb_reservation_id`];
  const m: SessionMeta = {
    ref: typeof ref === "string" ? ref : "",
    reservationId: typeof reservationId === "string" ? reservationId : "",
    roomsSatang: int(md.msv_rooms_satang),
    feeSatang: int(md.msv_fee_satang),
    totalSatang: int(md.msv_total_satang),
    checkIn: String(md.msv_checkin ?? ""),
    checkOut: String(md.msv_checkout ?? ""),
    mode: String(md.msv_mode ?? ""),
    arrivalLate: flag(md.msv_arrival_late),
    hasRequests: flag(md.msv_has_requests),
    noteSaved: flag(md.msv_note_saved),
    // Goes into a Cloudbeds note: only a plain version string, anything else is unknown.
    termsVersion: typeof md.msv_terms === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(md.msv_terms) ? md.msv_terms : null,
  };
  if (!REF_RE.test(m.ref) || session.client_reference_id !== m.ref) return null;
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(m.reservationId)) return null;
  if (![m.roomsSatang, m.feeSatang, m.totalSatang].every(Number.isInteger)) return null;
  if (m.roomsSatang + m.feeSatang !== m.totalSatang) return null;
  return m;
}

/* --------------------------- session creation -------------------------- */

export interface SessionInput {
  ref: string;
  reservationId: string;
  quote: Quote;
  customerEmail: string;
  /** Must contain the literal {CHECKOUT_SESSION_ID} placeholder. */
  successUrl: string;
  cancelUrl: string;
  nowMs: number;
  ttlMinutes: number;
  /** null = the account's dynamic payment methods. */
  allowedPaymentMethodTypes: string[] | null;
  merchantName: string;
  mode: string;
  /** Yes/no guest flags for fulfilment (see SessionMeta); never the request text. */
  guestFlags?: { arrivalLate: boolean; hasRequests: boolean; noteSaved: boolean };
}

/**
 * Builds the Checkout Session params from a SERVER quote (pure). The line
 * items are the rooms plus the openly shown "Payment processing fee"; they add
 * up to exactly quote.dueNowSatang (= the total: Stripe bookings are paid in
 * full). Throws if they don't.
 */
export function buildCheckoutSessionParams(input: SessionInput): Stripe.Checkout.SessionCreateParams {
  const { quote } = input;
  if (quote.dueNowSatang !== quote.totalSatang) throw new RangeError("Stripe bookings are paid in full (depositPct must be 100)");
  if (!input.successUrl.includes("{CHECKOUT_SESSION_ID}")) throw new RangeError("successUrl must carry {CHECKOUT_SESSION_ID}");
  const dates = `${formatDisplayDate(quote.checkIn)} - ${formatDisplayDate(quote.checkOut)}`;
  const nights = `${quote.nights} night${quote.nights === 1 ? "" : "s"}`;
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = quote.lines.map((l) => ({
    quantity: 1,
    price_data: {
      currency: "thb",
      unit_amount: l.roomSatang,
      product_data: {
        // A room on Cloudbeds' Direct rate says so, as on the booking page.
        name: `${l.roomName} - ${l.ratePlanName}${l.listRoomSatang !== undefined ? " (Direct rate)" : ""}`.slice(0, 250),
        description: `${dates} (${nights}, ${l.adults} guest${l.adults === 1 ? "" : "s"})`.slice(0, 500),
      },
    },
  }));
  if (quote.cardFeeSatang > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: "thb",
        unit_amount: quote.cardFeeSatang,
        product_data: { name: `Payment processing fee (${quote.cardFeePct}%)` },
      },
    });
  }
  const sum = lineItems.reduce((s, li) => s + (li.price_data?.unit_amount ?? 0) * (li.quantity ?? 1), 0);
  if (sum !== quote.dueNowSatang || !Number.isInteger(sum) || sum < 1000) {
    // 1000 satang = 10 THB, comfortably above Stripe's minimum charge.
    throw new RangeError(`line items (${sum}) must add up to the amount due (${quote.dueNowSatang})`);
  }
  if (sum > STRIPE_MAX_CHARGE_SATANG) throw new RangeError(`the amount due (${sum}) is above Stripe's maximum charge`);
  if (quote.promo || quote.addonsSubtotalSatang !== 0) throw new RangeError("promos and add-ons are not sold through Stripe");

  const metadata = sessionMetadata({
    ref: input.ref,
    reservationId: input.reservationId,
    roomsSatang: quote.roomsSubtotalSatang,
    feeSatang: quote.cardFeeSatang,
    totalSatang: quote.totalSatang,
    checkIn: quote.checkIn,
    checkOut: quote.checkOut,
    mode: input.mode,
    // = the version the guest's page showed: runCheckout refuses any other one (terms_changed) before the hold.
    termsVersion: POLICY_VERSION,
    ...input.guestFlags,
  });
  return {
    mode: "payment",
    line_items: lineItems,
    ...(input.allowedPaymentMethodTypes ? { allowed_payment_method_types: input.allowedPaymentMethodTypes } : {}),
    customer_email: input.customerEmail,
    client_reference_id: input.ref,
    metadata,
    payment_intent_data: {
      description: `${input.merchantName} booking ${input.ref}`,
      metadata,
      // Stripe sends a live-mode receipt to this address whatever the account-wide email settings are, so
      // the shared (Cloudbeds-connected) account's "Successful payments" switch never needs to change.
      receipt_email: input.customerEmail,
    },
    submit_type: "book",
    // Always charge the THB amount the guest was shown: no converted local-currency price (and FX margin)
    // from Adaptive Pricing, whatever the Dashboard default is; refunds then stay in THB too.
    adaptive_pricing: { enabled: false },
    locale: "auto",
    expires_at: Math.floor(input.nowMs / 1000) + input.ttlMinutes * 60 + SESSION_EXPIRY_MARGIN_SECONDS,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  };
}

/** Hosts a session URL may point at (the fake points at our own stripe-mock page). */
export function isStripeCheckoutUrl(url: string | null | undefined, allowSameOriginMock: string | null = null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol === "https:" && u.host === "checkout.stripe.com") return true;
    return allowSameOriginMock !== null && u.origin === allowSameOriginMock && u.pathname === "/booking-preview/stripe-mock";
  } catch {
    return false;
  }
}

/* ---------------------------- session state --------------------------- */

/**
 * open: the guest can still pay. paid: money taken. processing: a delayed
 * method (e.g. bank) is pending. failed: a delayed payment failed.
 * expired: the session can never be paid.
 */
export type SessionPaymentState = "open" | "paid" | "processing" | "failed" | "expired";

export function sessionPaymentState(session: Pick<CheckoutSession, "status" | "payment_status" | "payment_intent">): SessionPaymentState {
  if (session.status === "expired") return "expired";
  if (session.status === "open") return "open";
  if (session.payment_status === "paid" || session.payment_status === "no_payment_required") return "paid";
  const pi = session.payment_intent;
  if (pi && typeof pi === "object" && (pi.status === "requires_payment_method" || pi.status === "canceled")) return "failed";
  return "processing";
}

/** Retrieves a session with its PaymentIntent expanded. */
export async function retrieveSession(stripe: Stripe, sessionId: string): Promise<CheckoutSession> {
  return stripe.checkout.sessions.retrieve(sessionId, { expand: ["payment_intent"] });
}

export function paymentIntentId(session: Pick<CheckoutSession, "payment_intent">): string | null {
  const pi = session.payment_intent;
  if (!pi) return null;
  return typeof pi === "string" ? pi : pi.id;
}

export function chargeId(session: Pick<CheckoutSession, "payment_intent">): string | null {
  const pi = session.payment_intent;
  if (!pi || typeof pi === "string") return null;
  const ch = pi.latest_charge;
  if (!ch) return null;
  return typeof ch === "string" ? ch : ch.id;
}

export const SESSION_ID_RE = /^cs_(test|live)_[A-Za-z0-9_]{6,200}$/;

export function isSessionId(v: unknown): v is string {
  return typeof v === "string" && SESSION_ID_RE.test(v);
}

/** Sessions created since `sinceMs` (newest first), at most `max`. */
export async function listRecentSessions(stripe: Stripe, sinceMs: number, max = 300): Promise<CheckoutSession[]> {
  const out: CheckoutSession[] = [];
  for await (const s of stripe.checkout.sessions.list({ created: { gte: Math.floor(sinceMs / 1000) }, limit: 100 })) {
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/* ------------------------------- webhooks ------------------------------ */

/**
 * Verifies the Stripe-Signature header against the EXACT raw body and returns
 * the event. Throws Stripe's StripeSignatureVerificationError on a bad or
 * stale (older than 300 s) signature. `nowMs` is for tests (the SDK's receivedAt is in ms).
 */
export function verifyStripeWebhook(rawBody: string | Uint8Array, header: string | null, secret: string, nowMs?: number): Stripe.Event {
  const payload = typeof rawBody === "string" ? rawBody : Buffer.from(rawBody);
  if (!header) throw new Stripe.errors.StripeSignatureVerificationError("", payload, { message: "No Stripe-Signature header" });
  return Stripe.webhooks.constructEvent(payload, header, secret, WEBHOOK_TOLERANCE_SECONDS, undefined, nowMs);
}

export function isSignatureError(e: unknown): boolean {
  return e instanceof Stripe.errors.StripeSignatureVerificationError;
}

/** Stripe answered that the session does not exist (in this account and mode): it can never be paid. */
export function isMissingSessionError(e: unknown): boolean {
  return e instanceof Stripe.errors.StripeInvalidRequestError && (e.code === "resource_missing" || e.statusCode === 404);
}

/** True for a Stripe "only open sessions can be expired" style answer (the session is no longer open). */
export function isNotOpenError(e: unknown): boolean {
  return e instanceof Stripe.errors.StripeInvalidRequestError;
}

/** Non-personal diagnostics of a Stripe error for logs and alerts (type, code, request id, HTTP status). */
export function stripeErrorInfo(e: unknown): { type: string; code: string | null; requestId: string | null; statusCode: number | null } {
  if (e instanceof Stripe.errors.StripeError) {
    return { type: e.rawType ?? e.type, code: e.code ?? null, requestId: e.requestId ?? null, statusCode: e.statusCode ?? null };
  }
  return { type: e instanceof Error ? e.name : "unknown", code: null, requestId: null, statusCode: null };
}

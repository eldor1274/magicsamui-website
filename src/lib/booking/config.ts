// Server-side configuration for the booking preview. Reads secrets from the
// environment, so import it ONLY from route handlers and server components.
//
// Safety model (non-negotiable):
// - Default payment mode is "demo": nothing leaves our servers, no card is
//   charged, no reservation is created.
// - "beam-playground" needs merchant id + API key AND the playground base URL.
// - "beam-live" needs the production base URL AND BOOKING_ALLOW_LIVE_PAYMENTS
//   === "true" AND VERCEL_ENV === "production". Any other combination that
//   points at the live API is refused with an error - never silently used.

import type { PaymentMode, PublicBookingConfig } from "./types.ts";

export const BEAM_PLAYGROUND_BASE = "https://playground.api.beamcheckout.com";
export const BEAM_LIVE_BASE = "https://api.beamcheckout.com";

/** Built-in token secret for demo mode only. Never accepted in beam-* modes. */
export const DEMO_TOKEN_SECRET = "msv-booking-preview-DEMO-ONLY-not-a-real-secret";

export const MERCHANT_NAME = "Magic Suites & Villas";
export const PROMO_CODE = "DIRECT";
export const MAX_NIGHTS = 30;
export const BOOKING_WINDOW_MONTHS = 18;
export const MAX_SEARCH_ADULTS = 18;
export const MAX_CART_ITEMS = 6;
/** Beam payment link lifetime. */
export const PAYMENT_LINK_TTL_MINUTES = 30;
/** Booking token lifetime (return page may be revisited later). */
export const TOKEN_TTL_HOURS = 48;

export type Env = Record<string, string | undefined>;

export type BookingConfigErrorCode = "live_payments_locked" | "token_secret_missing" | "invalid_beam_base";

export class BookingConfigError extends Error {
  readonly code: BookingConfigErrorCode;
  constructor(code: BookingConfigErrorCode, message: string) {
    super(message);
    this.name = "BookingConfigError";
    this.code = code;
  }
}

export interface BeamCredentials {
  apiBase: string;
  merchantId: string;
  apiKey: string;
}

export interface BookingConfig {
  paymentMode: PaymentMode;
  dataSource: "demo" | "cloudbeds";
  tokenSecret: string;
  tokenSecretIsDemo: boolean;
  beam: BeamCredentials | null;
  /** Base64 HMAC key from Lighthouse (webhook signature), if configured. */
  beamWebhookHmacKey: string | null;
  cloudbeds: { apiKey: string; propertyId: string | null } | null;
  cardFeePct: number;
  depositPct: number;
  promoPct: number;
}

function trimmed(v: string | undefined): string {
  return (v ?? "").trim();
}

/** Parses a percentage env var, clamped to [min, max]; falls back on garbage. */
export function parsePct(raw: string | undefined, fallback: number, min: number, max: number): number {
  const s = trimmed(raw);
  if (s === "") return fallback;
  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;
  // Two decimals at most so satang arithmetic stays exact (basis points).
  const rounded = Math.round(n * 100) / 100;
  return Math.min(max, Math.max(min, rounded));
}

/**
 * Derives the payment mode. Throws BookingConfigError when the live Beam API
 * is configured without every live-mode condition.
 */
export function resolvePaymentMode(env: Env): PaymentMode {
  const base = trimmed(env.BEAM_API_BASE).replace(/\/+$/, "");
  const hasKeys = trimmed(env.BEAM_MERCHANT_ID) !== "" && trimmed(env.BEAM_API_KEY) !== "";

  if (base === BEAM_LIVE_BASE) {
    const allowed =
      hasKeys && env.BOOKING_ALLOW_LIVE_PAYMENTS === "true" && env.VERCEL_ENV === "production";
    if (!allowed) {
      throw new BookingConfigError(
        "live_payments_locked",
        "BEAM_API_BASE points at the live Beam API but live payments are not fully enabled " +
          "(needs BEAM_MERCHANT_ID, BEAM_API_KEY, BOOKING_ALLOW_LIVE_PAYMENTS=true and VERCEL_ENV=production).",
      );
    }
    return "beam-live";
  }
  if (base === BEAM_PLAYGROUND_BASE && hasKeys) return "beam-playground";
  if (base !== "" && base !== BEAM_PLAYGROUND_BASE) {
    throw new BookingConfigError("invalid_beam_base", "BEAM_API_BASE is not a recognised Beam API base URL.");
  }
  return "demo";
}

export function resolveDataSource(env: Env): "demo" | "cloudbeds" {
  return trimmed(env.CLOUDBEDS_API_KEY) !== "" && env.BOOKING_DATA_SOURCE !== "demo" ? "cloudbeds" : "demo";
}

/** Full server config. Throws BookingConfigError on unsafe configuration. */
export function getBookingConfig(env: Env = process.env): BookingConfig {
  const paymentMode = resolvePaymentMode(env);
  const dataSource = resolveDataSource(env);

  const secret = trimmed(env.BOOKING_TOKEN_SECRET);
  if (paymentMode !== "demo" && secret.length < 32) {
    throw new BookingConfigError(
      "token_secret_missing",
      "BOOKING_TOKEN_SECRET (32+ characters) is required when Beam payments are enabled.",
    );
  }
  const tokenSecretIsDemo = secret === "";

  const beam: BeamCredentials | null =
    paymentMode === "demo"
      ? null
      : {
          apiBase: paymentMode === "beam-live" ? BEAM_LIVE_BASE : BEAM_PLAYGROUND_BASE,
          merchantId: trimmed(env.BEAM_MERCHANT_ID),
          apiKey: trimmed(env.BEAM_API_KEY),
        };

  const hmac = trimmed(env.BEAM_WEBHOOK_HMAC_KEY);

  return {
    paymentMode,
    dataSource,
    tokenSecret: tokenSecretIsDemo ? DEMO_TOKEN_SECRET : secret,
    tokenSecretIsDemo,
    beam,
    beamWebhookHmacKey: hmac === "" ? null : hmac,
    cloudbeds:
      dataSource === "cloudbeds"
        ? { apiKey: trimmed(env.CLOUDBEDS_API_KEY), propertyId: trimmed(env.CLOUDBEDS_PROPERTY_ID) || null }
        : null,
    cardFeePct: parsePct(env.BOOKING_CARD_FEE_PCT, 3, 0, 10),
    depositPct: parsePct(env.BOOKING_DEPOSIT_PCT, 100, 1, 100),
    promoPct: parsePct(env.BOOKING_DEMO_PROMO_PCT, 10, 0, 50),
  };
}

export function toPublicConfig(config: BookingConfig): PublicBookingConfig {
  return {
    paymentMode: config.paymentMode,
    paymentStatus: "ok",
    dataSource: config.dataSource,
    cardFeePct: config.cardFeePct,
    depositPct: config.depositPct,
    merchantName: MERCHANT_NAME,
    maxNights: MAX_NIGHTS,
    bookingWindowMonths: BOOKING_WINDOW_MONTHS,
    maxSearchAdults: MAX_SEARCH_ADULTS,
  };
}

/**
 * Never throws: on an unsafe payment configuration it reports
 * paymentStatus "locked" (and demo-shaped values) so pages can still render
 * a clear message instead of crashing.
 */
export function getPublicBookingConfig(env: Env = process.env): PublicBookingConfig {
  try {
    return toPublicConfig(getBookingConfig(env));
  } catch {
    return {
      paymentMode: "demo",
      paymentStatus: "locked",
      dataSource: resolveDataSource(env),
      cardFeePct: parsePct(env.BOOKING_CARD_FEE_PCT, 3, 0, 10),
      depositPct: parsePct(env.BOOKING_DEPOSIT_PCT, 100, 1, 100),
      merchantName: MERCHANT_NAME,
      maxNights: MAX_NIGHTS,
      bookingWindowMonths: BOOKING_WINDOW_MONTHS,
      maxSearchAdults: MAX_SEARCH_ADULTS,
    };
  }
}

/** Inventory + pricing settings only; never throws (availability works even when payments are locked). */
export function getInventoryConfig(env: Env = process.env): Pick<BookingConfig, "dataSource" | "cloudbeds" | "promoPct"> {
  const dataSource = resolveDataSource(env);
  return {
    dataSource,
    cloudbeds:
      dataSource === "cloudbeds"
        ? { apiKey: trimmed(env.CLOUDBEDS_API_KEY), propertyId: trimmed(env.CLOUDBEDS_PROPERTY_ID) || null }
        : null,
    promoPct: parsePct(env.BOOKING_DEMO_PROMO_PCT, 10, 0, 50),
  };
}

// Signed, stateless booking tokens (server only - uses node:crypto).
//
// There is no database in this project, so the booking facts needed after
// the payment redirect (ref, dates, rooms, amounts, Beam link id) travel in a
// compact HMAC-SHA256-signed token: base64url(JSON) + "." + base64url(sig).
// Tokens carry NO personal data (no name, email or phone) because they end up
// in URLs. A "kind" field stops one token type being replayed as another.

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { ADDONS, getCatalogueRoom, isAddonId, isRatePlanId } from "./catalogue.ts";
import { MAX_CART_ITEMS, MAX_NIGHTS } from "./config.ts";
import { compactDate, isIsoDate, nightsBetween } from "./dates.ts";
import { BOOKING_REF_RE, isBookingRef } from "./ref.ts";
import type { BookingSummary, DemoFailureCode, IsoDate, PaymentMode } from "./types.ts";

export type TokenKind = "booking" | "demo-proof";

interface TokenEnvelope {
  kind: TokenKind;
  v: 1;
  /** Issued-at and expiry, epoch seconds. */
  iat: number;
  exp: number;
}

export interface BookingTokenPayload extends TokenEnvelope {
  kind: "booking";
  booking: BookingSummary;
  /** Beam payment link id (null in demo mode). */
  paymentLinkId: string | null;
}

export interface DemoProofPayload extends TokenEnvelope {
  kind: "demo-proof";
  ref: string;
  status: "paid" | "failed";
  failureCode: DemoFailureCode | null;
}

export type VerifyFailure = "malformed" | "bad_signature" | "expired" | "wrong_kind";
export type Verified<T> = { ok: true; payload: T } | { ok: false; reason: VerifyFailure };

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(segment: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(segment).digest();
}

function signPayload(payload: TokenEnvelope, secret: string): string {
  const segment = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${segment}.${b64url(sign(segment, secret))}`;
}

function verifyPayload<T extends TokenEnvelope>(token: unknown, kind: TokenKind, secret: string, nowMs: number): Verified<T> {
  if (typeof token !== "string" || token.length > 4096) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) {
    return { ok: false, reason: "malformed" };
  }
  const given = Buffer.from(parts[1], "base64url");
  const expected = sign(parts[0], secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as T;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload !== "object" || payload === null || payload.v !== 1) return { ok: false, reason: "malformed" };
  if (payload.kind !== kind) return { ok: false, reason: "wrong_kind" };
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

export function createBookingToken(
  booking: BookingSummary,
  paymentLinkId: string | null,
  secret: string,
  ttlSeconds: number,
  nowMs: number = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const payload: BookingTokenPayload = { kind: "booking", v: 1, iat, exp: iat + ttlSeconds, booking, paymentLinkId };
  return signPayload(payload, secret);
}

export function verifyBookingToken(token: unknown, secret: string, nowMs: number = Date.now()): Verified<BookingTokenPayload> {
  const v = verifyPayload<BookingTokenPayload>(token, "booking", secret, nowMs);
  if (!v.ok) return v;
  const linkId = v.payload.paymentLinkId;
  const linkIdOk = linkId === null || (typeof linkId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(linkId));
  // A valid signature is not enough: whatever the payload says is rendered on
  // our own domain, so it must also be a booking this code could have issued.
  if (!linkIdOk || !isBookingSummary(v.payload.booking)) return { ok: false, reason: "malformed" };
  return v;
}

/* ------------------------- payload validation ------------------------- */

const PAYMENT_MODES: PaymentMode[] = ["demo", "beam-playground", "beam-live", "stripe-mock", "stripe-test", "stripe-live"];
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const PROMO_CODE_RE = /^[A-Z0-9_-]{1,32}$/;
/** Generous ceiling (100M THB) so no absurd amount is ever displayed as a real booking. */
const MAX_SATANG = 10_000_000_000;

function isSatang(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_SATANG;
}

function isTimestamp(v: unknown): v is string {
  return typeof v === "string" && ISO_TIMESTAMP_RE.test(v) && Number.isFinite(Date.parse(v));
}

/**
 * Strict shape check of a token's booking facts: known refs, dates, rooms,
 * plans, add-ons and sane integer amounts only. Anything else (a forged or
 * stale token) is rejected before it can be rendered.
 */
export function isBookingSummary(v: unknown): v is BookingSummary {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const b = v as Record<string, unknown>;
  if (!isBookingRef(b.ref)) return false;
  if (!PAYMENT_MODES.includes(b.paymentMode as PaymentMode)) return false;
  if (!isIsoDate(b.checkIn) || !isIsoDate(b.checkOut)) return false;
  const nights = nightsBetween(b.checkIn, b.checkOut);
  if (!Number.isInteger(nights) || nights < 1 || nights > MAX_NIGHTS || b.nights !== nights) return false;
  if (!isTimestamp(b.createdAt) || !isTimestamp(b.linkExpiresAt)) return false;
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > MAX_CART_ITEMS) return false;
  for (const raw of b.items as unknown[]) {
    if (typeof raw !== "object" || raw === null) return false;
    const item = raw as Record<string, unknown>;
    const room = typeof item.slug === "string" ? getCatalogueRoom(item.slug) : undefined;
    if (!room || !room.bookable || !isRatePlanId(item.ratePlanId)) return false;
    const adults = item.adults;
    if (typeof adults !== "number" || !Number.isInteger(adults) || adults < 1 || adults > room.maxGuests) return false;
    if (!Array.isArray(item.addonIds) || item.addonIds.length > 5) return false;
    for (const a of item.addonIds as unknown[]) {
      if (!isAddonId(a) || !ADDONS[a].ratePlans.includes(item.ratePlanId)) return false;
    }
  }
  if (!Array.isArray(b.itemRoomSatang) || b.itemRoomSatang.length !== b.items.length || !b.itemRoomSatang.every(isSatang)) {
    return false;
  }
  if (!isSatang(b.totalSatang) || !isSatang(b.cardFeeSatang) || !isSatang(b.dueNowSatang)) return false;
  if (b.dueNowSatang > b.totalSatang || b.cardFeeSatang > b.totalSatang) return false;
  if (!(b.promoCode === null || (typeof b.promoCode === "string" && PROMO_CODE_RE.test(b.promoCode)))) return false;
  if (b.theme !== undefined && b.theme !== "magic" && b.theme !== "classic") return false;
  return true;
}

export function createDemoProof(
  ref: string,
  status: "paid" | "failed",
  failureCode: DemoFailureCode | null,
  secret: string,
  ttlSeconds: number,
  nowMs: number = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const payload: DemoProofPayload = { kind: "demo-proof", v: 1, iat, exp: iat + ttlSeconds, ref, status, failureCode };
  return signPayload(payload, secret);
}

export function verifyDemoProof(token: unknown, secret: string, nowMs: number = Date.now()): Verified<DemoProofPayload> {
  const v = verifyPayload<DemoProofPayload>(token, "demo-proof", secret, nowMs);
  if (!v.ok) return v;
  const p = v.payload;
  const shapeOk =
    isBookingRef(p.ref) &&
    (p.status === "paid" ? p.failureCode === null : p.status === "failed") &&
    (p.failureCode === null || p.failureCode === "CH_CARD_DECLINED" || p.failureCode === "CH_INSUFFICIENT_FUNDS");
  return shapeOk ? v : { ok: false, reason: "malformed" };
}

/* ---------------------------- references ---------------------------- */

const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export { BOOKING_REF_RE, isBookingRef };

/** "MSV-20261005-7F3K": creation date (Bangkok) + 4 random characters. */
export function generateBookingRef(today: IsoDate, pick: (max: number) => number = randomInt): string {
  let suffix = "";
  for (let i = 0; i < 4; i++) suffix += REF_ALPHABET[pick(REF_ALPHABET.length)];
  return `MSV-${compactDate(today)}-${suffix}`;
}

/** Random hex salt (server only). */
export function generateNonce(): string {
  return randomBytes(12).toString("hex");
}

/**
 * Idempotency key for one booking attempt's Beam payment link, shaped as a
 * UUID v4 (Beam documents uuid v4; max 255 chars). Same ref + mode + salt ->
 * same key; checkout passes a random salt per attempt so two bookings whose
 * short refs collide can never share a key.
 */
export function idempotencyKeyFor(ref: string, mode: string, salt = ""): string {
  const h = createHash("sha256").update(`beam-payment-link|${mode}|${ref}|${salt}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** True once the booking's payment link (30 min) has expired. */
export function isPaymentLinkExpired(booking: Pick<BookingSummary, "linkExpiresAt">, nowMs: number = Date.now()): boolean {
  return Date.parse(booking.linkExpiresAt) <= nowMs;
}

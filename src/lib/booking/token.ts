// Signed, stateless booking tokens (server only - uses node:crypto).
//
// There is no database in this project, so the booking facts needed after
// the payment redirect (ref, dates, rooms, amounts, Beam link id) travel in a
// compact HMAC-SHA256-signed token: base64url(JSON) + "." + base64url(sig).
// Tokens carry NO personal data (no name, email or phone) because they end up
// in URLs. A "kind" field stops one token type being replayed as another.

import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { compactDate } from "./dates.ts";
import type { BookingSummary, DemoFailureCode, IsoDate } from "./types.ts";

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
  return verifyPayload<BookingTokenPayload>(token, "booking", secret, nowMs);
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
  return verifyPayload<DemoProofPayload>(token, "demo-proof", secret, nowMs);
}

/* ---------------------------- references ---------------------------- */

const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export const BOOKING_REF_RE = /^MSV-\d{8}-[A-HJ-NP-Z2-9]{4}$/;

/** "MSV-20261005-7F3K": creation date (Bangkok) + 4 random characters. */
export function generateBookingRef(today: IsoDate, pick: (max: number) => number = randomInt): string {
  let suffix = "";
  for (let i = 0; i < 4; i++) suffix += REF_ALPHABET[pick(REF_ALPHABET.length)];
  return `MSV-${compactDate(today)}-${suffix}`;
}

export function isBookingRef(v: unknown): v is string {
  return typeof v === "string" && BOOKING_REF_RE.test(v);
}

/**
 * Stable idempotency key for one booking's Beam payment link, shaped as a
 * UUID v4 (Beam documents uuid v4; max 255 chars). Same ref + mode -> same key.
 */
export function idempotencyKeyFor(ref: string, mode: string): string {
  const h = createHash("sha256").update(`beam-payment-link|${mode}|${ref}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** True once the booking's payment link (30 min) has expired. */
export function isPaymentLinkExpired(booking: Pick<BookingSummary, "linkExpiresAt">, nowMs: number = Date.now()): boolean {
  return Date.parse(booking.linkExpiresAt) <= nowMs;
}

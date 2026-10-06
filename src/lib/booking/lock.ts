// Idempotency for fulfilment and release (WI-4).
//
// Stripe says fulfilment "might be called multiple times, possibly
// concurrently" (webhook + return page + sweeper), and Cloudbeds postPayment
// has no dedupe key. So every write path runs under a short lock
// (SET NX EX 120 on lock:<kind>:<id>) and finishes by writing a 30-day "done"
// marker that later calls return early on.

import { randomBytes } from "node:crypto";
import type { KvStore } from "./kv.ts";

export const LOCK_TTL_SECONDS = 120;
export const DONE_TTL_SECONDS = 30 * 24 * 3600;

/**
 * Key scope of a payment mode: "live" for stripe-live, else the mode itself
 * (e.g. "stripe-test"). Keys that are not tied to one record (alert claims,
 * pending alerts, the last sweep, failure counters, the paid-but-unconfirmed
 * index) carry it, so a Stage B deployment sharing the live Redis can never
 * hide, re-send, clear or suppress the live deployment's ones.
 */
export function keyScope(mode: string): string {
  if (mode === "stripe-live") return "live";
  const m = mode.toLowerCase().replace(/[^a-z0-9-]/g, "");
  return m === "" || m === "live" ? "other" : m;
}

export const keys = {
  fulfilLock: (sessionId: string) => `msv:lock:fulfil:${sessionId}`,
  fulfilDone: (sessionId: string) => `msv:done:fulfil:${sessionId}`,
  /**
   * fee / payment: the step is done. payment-attempt: postPayment was SENT at
   * this time (ms) and its outcome may be unknown - a retry must not post again
   * before the folio could show it (see fulfil.ts PAYMENT_DOUBT_COOLDOWN_MS).
   * paid-note: the "PAID via Stripe - do not cancel" note is on the reservation.
   */
  fulfilStep: (sessionId: string, step: "fee" | "payment" | "payment-attempt" | "paid-note") => `msv:step:fulfil:${sessionId}:${step}`,
  releaseLock: (reservationId: string) => `msv:lock:release:${reservationId}`,
  releaseDone: (reservationId: string) => `msv:done:release:${reservationId}`,
  /** Set BEFORE any payment write once a session for this reservation is known to be paid: release refuses it. Value = the session id. */
  reservationPaid: (reservationId: string) => `msv:paid:res:${reservationId}`,
  /** A paid session not yet fulfilled: JSON PaidPending (ref, reservation, amount, first seen paid). */
  paidPending: (sessionId: string) => `msv:paid:session:${sessionId}`,
  /** Sorted set of paid sessions without a done marker (score = first seen paid ms): the sweeper retries and escalates them. */
  paidIndex: (scope: string) => `msv:${scope}:paid:open`,
  /** Hold record: JSON HoldRecord. */
  hold: (reservationId: string) => `msv:hold:${reservationId}`,
  /** Sorted set of open holds (score = created ms). */
  holdIndex: () => "msv:holds:open",
  /** booking ref -> JSON BookingPointer (lets status/abandon work without the browser's link token). */
  booking: (ref: string) => `msv:booking:${ref}`,
  /** Marks a session the guest abandoned (Cancel/Back) so the return page can say "cancelled". */
  abandoned: (sessionId: string) => `msv:abandoned:${sessionId}`,
  /** One alert per subject key per window (per mode scope). */
  alerted: (scope: string, key: string) => `msv:${scope}:alerted:${key}`,
  /**
   * Hold INTENT: written before postReservation (JSON HoldIntent), so an
   * attempt whose outcome is unknown (timeout, 5xx, crash) is never lost.
   */
  intent: (ref: string) => `msv:intent:${ref}`,
  /** Sorted set of unresolved intents (score = created ms, member = ref). */
  intentIndex: () => "msv:intents:open",
  /** Serialises our own holds per PHYSICAL unit (combination types share units). */
  unitLock: (unit: string) => `msv:lock:unit:${unit}`,
  /** Hold attempts per client (hashed IP, or hashed IP + guest email) in a fixed window. */
  clientHolds: (clientKey: string) => `msv:holds:client:${clientKey}`,
  /** Last sweeper run (of this mode scope) whose Cloudbeds side worked (ms): the only recovery path for lost holds. */
  lastSweep: (scope: string) => `msv:${scope}:sweep:last`,
  /** Consecutive sweeper runs whose Cloudbeds listing failed. */
  sweepCloudbedsFailures: (scope: string) => `msv:${scope}:sweep:cbfail`,
  /** Consecutive checkouts refused because Cloudbeds reads failed. */
  checkoutReadFailures: (scope: string) => `msv:${scope}:checkout:readfail`,
  /** A critical alert not yet delivered (JSON PendingAlert, alerts.ts). */
  pendingAlert: (scope: string, id: string) => `msv:${scope}:alert:pending:${id}`,
  /** Sorted set of undelivered critical alerts (score = first raised ms). */
  pendingAlertIndex: (scope: string) => `msv:${scope}:alerts:pending`,
  /** Rejected webhook signatures in the current hour. */
  badSignatures: (scope: string) => `msv:${scope}:webhook:badsig`,
  /** A confirmed MSV reservation with no record of ours was reported to the owner (sweeper, once). */
  noRecordReported: (scope: string, reservationId: string) => `msv:${scope}:norecord:${reservationId}`,
};

/** thirdPartyIdentifier suffix for holds written by a NON-live deployment (Stage B tests). */
export const TEST_HOLD_SUFFIX = "-TEST";
const HOLD_ID_RE = /^(MSV-\d{8}-[A-HJ-NP-Z2-9]{4})(-TEST)?$/;

/**
 * The thirdPartyIdentifier written on a Cloudbeds hold. Live holds carry the
 * plain booking ref; every other mode appends -TEST, so a live sweeper never
 * touches a test hold (or the reverse) and staff can tell test bookings apart.
 */
export function holdIdentifier(ref: string, mode: string): string {
  return mode === "stripe-live" ? ref : `${ref}${TEST_HOLD_SUFFIX}`;
}

/** Parses a thirdPartyIdentifier we wrote; null for anything else (OTA bookings, staff bookings). */
export function parseHoldIdentifier(id: string | null | undefined): { ref: string; live: boolean } | null {
  const m = HOLD_ID_RE.exec((id ?? "").trim());
  return m ? { ref: m[1], live: m[2] === undefined } : null;
}

export interface HoldIntent {
  ref: string;
  /** The thirdPartyIdentifier sent to Cloudbeds. */
  identifier: string;
  mode: string;
  createdAt: number;
  /** Set once postReservation answered with an id. */
  reservationId: string | null;
}

export interface HoldRecord {
  ref: string;
  reservationId: string;
  sessionId: string | null;
  createdAt: number;
  mode: string;
  /**
   * True once the hold is known to be "not_confirmed" (created that way, or
   * our markPending succeeded). A later "confirmed" without a payment then
   * means staff confirmed it by hand: release alerts instead of cancelling.
   */
  pendingMarked?: boolean;
  /**
   * Physical units and dates the hold occupies (written by checkout under the
   * unit lock). A later checkout refuses an overlapping cart while this hold is
   * open, so our own serialisation never depends on how fast Cloudbeds'
   * availability reflects a new reservation. Absent on records the sweeper
   * creates for orphan holds.
   */
  units?: string[];
  checkIn?: string;
  checkOut?: string;
}

/** A paid session whose fulfilment has not finished yet (lock.ts keys.paidPending). */
export interface PaidPending {
  sessionId: string;
  ref: string;
  reservationId: string;
  totalSatang: number;
  /** When fulfil first saw the session paid (ms). */
  paidAt: number;
  mode: string;
}

export interface BookingPointer {
  sessionId: string;
  reservationId: string;
}

export interface Lock {
  key: string;
  token: string;
}

/** Tries once to take the lock. null when someone else holds it. */
export async function acquireLock(kv: KvStore, key: string, ttlSeconds = LOCK_TTL_SECONDS): Promise<Lock | null> {
  const token = randomBytes(12).toString("hex");
  return (await kv.setNx(key, token, ttlSeconds)) ? { key, token } : null;
}

/** Releases only our own lock (never one that expired and was re-taken by another caller). */
export async function releaseLock(kv: KvStore, lock: Lock): Promise<void> {
  await kv.delIfEquals(lock.key, lock.token);
}

export type LockedResult<T> = { acquired: true; value: T } | { acquired: false };

/** Runs `fn` under the lock; { acquired: false } without running it when the lock is taken. */
export async function withLock<T>(kv: KvStore, key: string, fn: () => Promise<T>, ttlSeconds = LOCK_TTL_SECONDS): Promise<LockedResult<T>> {
  const lock = await acquireLock(kv, key, ttlSeconds);
  if (!lock) return { acquired: false };
  try {
    return { acquired: true, value: await fn() };
  } finally {
    await releaseLock(kv, lock).catch(() => undefined);
  }
}

export async function readJson<T>(kv: KvStore, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJson(kv: KvStore, key: string, value: unknown, ttlSeconds = DONE_TTL_SECONDS): Promise<void> {
  await kv.set(key, JSON.stringify(value), ttlSeconds);
}

/** Records a new hold and adds it to the open-holds index. */
export async function recordHold(kv: KvStore, hold: HoldRecord): Promise<void> {
  await writeJson(kv, keys.hold(hold.reservationId), hold);
  await kv.zadd(keys.holdIndex(), hold.createdAt, hold.reservationId);
}

/** Removes a hold from the open-holds index (it was confirmed or released). */
export async function closeHold(kv: KvStore, reservationId: string): Promise<void> {
  await kv.zrem(keys.holdIndex(), reservationId);
}

/** Records a hold attempt BEFORE postReservation (2-day TTL; the index keeps it until resolved). */
export async function recordIntent(kv: KvStore, intent: HoldIntent): Promise<void> {
  await writeJson(kv, keys.intent(intent.ref), intent, 2 * 24 * 3600);
  await kv.zadd(keys.intentIndex(), intent.createdAt, intent.ref);
}

/** The attempt is settled (no reservation was created, or it is tracked as a hold now). */
export async function closeIntent(kv: KvStore, ref: string): Promise<void> {
  await kv.zrem(keys.intentIndex(), ref);
}


// Idempotency for fulfilment and release (WI-4).
//
// Stripe says fulfilment "might be called multiple times, possibly
// concurrently" (webhook + return page + sweeper), and Cloudbeds postPayment
// has no dedupe key. So every write path runs under a short lock
// (SET NX EX 120 on lock:<kind>:<id>) and finishes by writing a 30-day "done"
// marker that later calls return early on.

import { randomBytes } from "node:crypto";
import { BOOKING_WINDOW_MONTHS } from "./config.ts";
import type { KvStore } from "./kv.ts";
import { isBeamLinkId } from "./payments/beamIds.ts";
import { isLiveMode, providerOf } from "./payments/provider.ts";
import type { PaymentMode } from "./types.ts";

export const LOCK_TTL_SECONDS = 120;
export const DONE_TTL_SECONDS = 30 * 24 * 3600;
/** Card networks accept a dispute (chargeback) up to about 120 days after the service date: the check-out. */
export const BEAM_DISPUTE_WINDOW_DAYS = 120;
/**
 * How long Beam's payment records, charge index and done markers live, so a refund or chargeback after the
 * stay still maps to its booking (gap review 17): the farthest check-out validateStayDates accepts
 * (BOOKING_WINDOW_MONTHS ahead, counted as 31-day months) plus the dispute window plus 30 days of margin =
 * 708 days from the write. The record is written when the link is created, the charge index and the done
 * markers later, so each lives at least that long past the booking day. The Stripe keys keep DONE_TTL_SECONDS.
 */
export const BEAM_RECORD_TTL_SECONDS = (BOOKING_WINDOW_MONTHS * 31 + BEAM_DISPUTE_WINDOW_DAYS + 30) * 24 * 3600;

/** The set-once "told the owner" markers of the Beam payment flow (keys.beamReported). */
export type BeamReportKind = "dup-charge" | "record-missing" | "unknown-payment" | "foreign-link" | "refund-ambiguous" | "scan-refused" | "merchant-switch";

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

  // Beam (design S2.4). Every Beam key carries "beam:" right after "msv:" or after the mode scope, so no Beam
  // key can ever be a Stripe one. The per-payment keys are named by Beam's own ids (a record carries its mode);
  // the others carry keyScope(mode) like the keys above.
  /** A link's PaymentRecord (JSON, payments/beamRecord.ts), BEAM_RECORD_TTL_SECONDS. */
  beamPayment: (linkId: string) => `msv:beam:pay:${linkId}`,
  /** Charge index: a SUCCEEDED charge -> its link (BEAM_RECORD_TTL_SECONDS), so refunds and chargebacks map to the booking. */
  beamCharge: (chargeId: string) => `msv:beam:charge:${chargeId}`,
  /** The charge that paid the link, stored set-once by fulfil: it wins over a later reading's primary. */
  beamPrimary: (linkId: string) => `msv:beam:primary:${linkId}`,
  /** Sorted set of the links we created that are not finished yet (score = the link's expiresAt ms). */
  beamLinksOpen: (scope: string) => `msv:${scope}:beam:links:open`,
  /** Sorted set of links whose hold was released, watched for a late payment (score = release time ms). */
  beamLinksWatch: (scope: string) => `msv:${scope}:beam:links:watch`,
  /**
   * Set-once "told the owner" marker: a duplicate charge, a missing record, an unknown MSV payment, a foreign
   * link (cached as not ours: the sweeper's 8-day cache, S4.2), a refunded link with several successful charges
   * (S4.1), Beam refusing the sweeper's unfiltered charge scan (S4.2; id = '{status}:{UTC day}' since round 5),
   * a link of another Beam merchant than BEAM_MERCHANT_ID that Beam answers 404 for (round 5).
   */
  beamReported: (scope: string, kind: BeamReportKind, id: string) => `msv:${scope}:beam:reported:${kind}:${id}`,
  /** A Beam transaction (PAYMENT, REFUND, VOID, CHARGEBACK) already handled by the webhook. */
  beamTxn: (scope: string, id: string) => `msv:${scope}:beam:txn:${id}`,
  /** Rejected Beam webhook signatures in the current hour (Stripe's count is keys.badSignatures). */
  beamBadSignatures: (scope: string) => `msv:${scope}:beam:webhook:badsig`,
  /** Beam 429 answers in the current window. */
  beamRateLimited: (scope: string) => `msv:${scope}:beam:ratelimited`,
  /** When disabling this link first failed (ms): a disable that keeps failing alerts. */
  beamDisableFail: (scope: string, linkId: string) => `msv:${scope}:beam:disablefail:${linkId}`,
  /** Sorted set of the links the sweeper could not read (score = the first failed reading, ms): one that keeps failing alerts (S4.2). */
  beamReadFailures: (scope: string) => `msv:${scope}:beam:readfail`,
  /** Consecutive failed payment-page creations (the circuit breaker's count). */
  beamPageFail: (scope: string) => `msv:${scope}:beam:pagefail`,
  /** Set while the circuit breaker pauses Beam checkout. */
  beamPaused: (scope: string) => `msv:${scope}:beam:paused`,
  /** The last 7-day charge scan (ms). */
  beamDeepScan: (scope: string) => `msv:${scope}:beam:deepscan`,
  /** Consecutive sweeper runs whose Beam step 1 (sweepRecent) failed: a run of them alerts (round 5). */
  beamSweepFailures: (scope: string) => `msv:${scope}:beam:sweepfail`,
  /**
   * Sorted set of released links whose last reading showed a PENDING charge (score = when first seen so, ms):
   * watched past BEAM_LATE_WATCH_DAYS until that charge settles, for BEAM_PENDING_WATCH_DAYS at most (round 5).
   */
  beamLinksPending: (scope: string) => `msv:${scope}:beam:links:pending`,
};

/**
 * A Beam payment's KEY (PaymentGateway.keyOf): "beam:" + the link id. Tokens and URLs carry the bare link id;
 * only Redis keys add the prefix (money review 14), so a Beam key can never be a Stripe session id.
 */
export const BEAM_KEY_PREFIX = "beam:";

/** The KEY of a Beam payment link id (one isBeamLinkId accepts: payments/beamIds.ts, re-exported by beam.ts). */
export function beamKeyOf(linkId: string): string {
  return `${BEAM_KEY_PREFIX}${linkId}`;
}

/** The link id of a Beam payment KEY; null for any other key (a Stripe session id, a bare link id, a malformed id). */
export function linkIdOf(key: string): string | null {
  if (typeof key !== "string" || !key.startsWith(BEAM_KEY_PREFIX)) return null;
  const linkId = key.slice(BEAM_KEY_PREFIX.length);
  return isBeamLinkId(linkId) ? linkId : null;
}

/** thirdPartyIdentifier suffix for holds written by a NON-live deployment (Stage B tests). */
export const TEST_HOLD_SUFFIX = "-TEST";
/** thirdPartyIdentifier tag of a Beam hold: '{ref}-B' in beam-live, '{ref}-B-TEST' in beam-playground. */
export const BEAM_HOLD_SUFFIX = "-B";
const HOLD_ID_RE = /^(MSV-\d{8}-[A-HJ-NP-Z2-9]{4})(-TEST)?$/;
const BEAM_HOLD_ID_RE = /^(MSV-\d{8}-[A-HJ-NP-Z2-9]{4})-B(-TEST)?$/;

/**
 * The thirdPartyIdentifier written on a Cloudbeds hold. Live holds (any live
 * mode) carry the plain booking ref; every other mode appends -TEST, so a live
 * sweeper never touches a test hold (or the reverse) and staff can tell test
 * bookings apart.
 *
 * Beam holds are tagged as well: '{ref}-B' (beam-live) and '{ref}-B-TEST'
 * (beam-playground). parseHoldIdentifier never matches a -B id, so every
 * Stripe code path (and the pre-Beam code after a rollback) ignores Beam
 * holds; Beam runs read only -B ids (parseBeamHoldIdentifier). Money review 5
 * and 12. The Stripe modes (and the demo) are unchanged.
 */
export function holdIdentifier(ref: string, mode: PaymentMode): string {
  if (providerOf(mode) === "beam") return `${ref}${BEAM_HOLD_SUFFIX}${isLiveMode(mode) ? "" : TEST_HOLD_SUFFIX}`;
  return isLiveMode(mode) ? ref : `${ref}${TEST_HOLD_SUFFIX}`;
}

/** Parses a thirdPartyIdentifier we wrote; null for anything else (OTA bookings, staff bookings). */
export function parseHoldIdentifier(id: string | null | undefined): { ref: string; live: boolean } | null {
  const m = HOLD_ID_RE.exec((id ?? "").trim());
  return m ? { ref: m[1], live: m[2] === undefined } : null;
}

/**
 * Parses the thirdPartyIdentifier of a Beam hold ('{ref}-B' live, '{ref}-B-TEST' playground); null for
 * anything else, a Stripe hold's plain or -TEST id included.
 */
export function parseBeamHoldIdentifier(id: string | null | undefined): { ref: string; live: boolean } | null {
  const m = BEAM_HOLD_ID_RE.exec((id ?? "").trim());
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


// PaymentGateway for Beam payment links (design S4.1; sweepRecent S4.2). Server only.
//
// key = "beam:" + the payment link id (lock.ts beamKeyOf), so no Beam key can ever be a Stripe session id;
// tokens and URLs carry the bare link id (isPaymentId). Every Beam call goes through beam.ts with the time
// budget left before the caller's deadline (the route's, or the sweeper run's).
//
// get(key) - two calls, never getCharge: GET the link, then list its charges (by sourceId), then
// beamPaymentState (payments/beamState.ts) with the expiry we set as the fallback for an unreadable expiresAt.
// - Ours: the Redis PaymentRecord, else the link's internalNote verified as our signed note (then a one-time
//   warning: the record is missing). Neither: meta null (not ours, e.g. the owner's own Lighthouse links). A
//   record or note of another payment mode: meta null and a log line.
// - mismatch (fulfil hands the booking to the owner, never "not ours"): the link's referenceId is not the
//   booking's ref, the link is under another Beam merchant than the record and BEAM_MERCHANT_ID, or
//   beamPaymentState reports one (the charge's amount or currency, a refunded link with several successes).
// - The primary charge id is stored set-once (keys.beamPrimary) the first time a reading of ours shows a
//   SUCCEEDED charge, and from then on wins over a later reading's primary in receipts and alerts, so the id
//   fulfil records in Cloudbeds stays the one every alert names. Every SUCCEEDED charge of ours is indexed
//   (keys.beamCharge -> link, ref, reservation; BEAM_RECORD_TTL_SECONDS), so a refund or chargeback months
//   later still maps to its booking.
// - Duplicates (money review 3): every SUCCEEDED charge other than the stored primary raises one CRITICAL
//   'URGENT: guest charged twice', once per extra charge (keys.beamReported), whatever the done marker says. A
//   refunded link with two or more SUCCEEDED charges raises one CRITICAL 'check in Lighthouse which charges were
//   refunded' (keys.beamReported 'refund-ambiguous'), also after the done marker.
// - Throws on network errors, 429/5xx, a spent budget and Redis failures; a key that is not a Beam key, and a
//   link Beam answers 404 for, throw an error isMissing accepts.
//
// cancel(key) disables the link with a fresh idempotency key per attempt ('msv-bd-{linkId}-{nonce}'), so a
// failed answer Beam cached under an earlier key is never replayed (money review 15, gap review 15):
// 'cancelled', or 'not_open' when the link was no longer ACTIVE. Callers re-read the link afterwards.
//
// releaseGuard(key) is a fresh link + charge read: true only while the payment still can never be paid (state
// 'expired' or 'failed': no SUCCEEDED charge and no PENDING charge inside the grace; money review 9). A link Beam
// answers 404 for can never be paid only when our record says it was created under this BEAM_MERCHANT_ID and its
// expiry plus the pending grace is over (round 5): Beam reads the merchant from the API key, so after a merchant
// switch every older link answers 404, paid ones too, and a 404 before the expiry may be passing.
//
// sweepRecent(sinceMs) is the sweeper's step 1 for Beam (S4.2; money review 1 and 7, gap review 1). Beam sends
// no expiry event and a charge can succeed long after its link closed, so the sweeper finds the payments itself:
// 1. The charge scan: the PAYMENT_LINK charges of the last 72 hours (BEAM_SCAN_LOOKBACK_HOURS), or of the last 7
//    days (BEAM_DEEP_SCAN_DAYS) once the last complete deep pass (keys.beamDeepScan) is 6 hours old. Beam
//    refusing the unfiltered list (a 4xx other than 429) is logged and told to the owner once per HTTP status a
//    day, and the run goes on with the links we track; any other failure of the scan throws (the run fails and
//    keeps every hold), as does a scan that could not finish (a later page failed, the budget or
//    BEAM_SCAN_MAX_PAGES ran out). A deep pass that fails is logged and the 72-hour pass runs in its place, so a
//    deep pass that keeps failing never fails every run (round 5).
// 2. The links: every links-open entry (trackOpenLink at create time, score = expiresAt; every run, not only
//    the expired ones), the late-watch entries younger than BEAM_LATE_WATCH_DAYS, and every link the scan
//    names. A link without a record is read once for its signed note: ours -> tracked (its reading raises the
//    record-missing warning); not ours -> cached as foreign for 8 days (no read again); not ours but carrying
//    a SUCCEEDED charge that names an MSV booking -> one CRITICAL 'A Beam payment names booking {ref} but we
//    have no record of it' (stored and re-sent until delivered: money was taken under our ref). Such a reading
//    that fails (other than 404) is told to the owner after 60 minutes and throws once every link was looked
//    at: without it the link's booking is unknown, so no hold it might belong to may be released by that run.
// 3. One RecentPayment per reservation {key, reservationId (record or note), listedPaid (a SUCCEEDED charge in
//    the scan), read}. read() reads the link afresh; an ACTIVE link past expiresAt + skew (needsDisable) is
//    disabled (a fresh key) and read again. A disable that throws, or whose re-read still says ACTIVE, is a
//    failed disable (keys.beamDisableFail: told to the owner after 60 minutes). A link Beam answers 404 for
//    reads as expired (it can never be paid) only when it was created under this BEAM_MERCHANT_ID and its
//    expiry plus the pending grace is over; before that, or for a link of another merchant (then also one
//    CRITICAL per link), the reading fails like any other. A failed reading throws (the sweeper keeps that hold:
//    RecentPayments.unread) and, after 60 minutes of failures (keys.beamReadFailures), is told to the owner. Two
//    links naming one reservation (never by construction: one payment page per hold) share one entry, which
//    answers the payment that matters most (paid first).
// 4. Housekeeping: a links-open entry whose done marker exists is dropped; one whose hold was released moves
//    to the late watch (score = now); one whose link expired more than BEAM_LATE_WATCH_DAYS ago is dropped;
//    late-watch entries past the window are dropped. A released link whose last reading showed a PENDING
//    charge is also kept in keys.beamLinksPending and read on every run until that charge settles, for
//    BEAM_PENDING_WATCH_DAYS at most (round 5), so a very late success is found even when its webhook is lost.
// 5. A sweepRecent that throws is counted (keys.beamSweepFailures, consecutive runs); the
//    BEAM_SWEEP_FAILURE_ALERT_RUNS-th failed run in a row tells the owner, a good run ends the count (round 5).
// The core's step 1 (sweep.ts) then fulfils the paid ones (a late success on a released hold -> the CRITICAL
// needs_attention of owner decision 3), hands refunded ones to fulfil, and releases the expired ones with the
// guard and the release note ('unconfirmed' ones with the pending-released warning).
//
// No card number digits ever pass through here: beam.ts drops them when it parses a charge.

import {
  getPaymentLink,
  disablePaymentLink,
  beamErrorInfo,
  isBeamLinkId,
  isBeamNotFound,
  listLinkChargesSince,
  listPaymentLinkCharges,
  BeamApiError,
} from "../beam.ts";
import type { BeamCallOptions, BeamCharge, BeamPaymentLink, ChargeScan } from "../beam.ts";
import type { BeamSettings } from "../config.ts";
import type { KvStore } from "../kv.ts";
import { BEAM_RECORD_TTL_SECONDS, beamKeyOf, keyScope, keys, linkIdOf, parseBeamHoldIdentifier } from "../lock.ts";
import type { BeamReportKind } from "../lock.ts";
import { satangToBahtString } from "../quote.ts";
import { isBookingRef } from "../ref.ts";
import type { CoreDeps } from "../stripeDeps.ts";
import { nowOf } from "../stripeDeps.ts";
import { generateNonce } from "../token.ts";
import { readRecord, recordToMeta, verifyBeamNote } from "./beamRecord.ts";
import type { BeamNote, PaymentRecord } from "./beamRecord.ts";
import { beamPaymentState } from "./beamState.ts";
import type { BeamPaymentState } from "./beamState.ts";
import { BEAM_PARTIAL_REFUND_METHODS, BEAM_REFUNDABLE_METHODS, beamGatewayText, beamMethodName } from "./beamText.ts";
import type { GatewayPayment, GatewayReceipt, GatewayState, PaymentGateway, PaymentMeta, RecentPayment } from "./gateway.ts";

const DAY_MS = 86_400_000;
/** The 7-day charge scan (BEAM_DEEP_SCAN_DAYS) runs once the last complete one is this old. */
export const BEAM_DEEP_SCAN_EVERY_MS = 6 * 3_600_000;
/** A disable or a reading of a link that keeps failing this long is told to the owner (as sweep.ts RELEASE_ALERT_AGE_MS). */
export const BEAM_FAILURE_ALERT_MS = 60 * 60_000;
/** A link that is not ours is not read again for this long: past the 7-day scan, so it is read at most once. */
export const BEAM_FOREIGN_CACHE_SECONDS = 8 * 24 * 3600;
/** At most this many links-open entries, and as many late-watch entries, are read per sweeper run. */
export const BEAM_TRACKED_LINKS_LIMIT = 500;
/** The charge scan reads at most this many pages of 100 (a scan that needs more throws, as an unfinished one does). */
export const BEAM_SCAN_MAX_PAGES = 50;
/** TTL of the deep-scan time and of a disable-failure marker (a marker that outlives it simply starts again). */
const MARKER_TTL_SECONDS = 7 * 24 * 3600;
/** The foreign-link cache's value for a link carrying another payment mode's valid note (another deployment's payment). */
const OTHER_MODE_LINK = "other-mode";
/** Failed sweepRecent runs in a row before the owner is told (as sweep.ts CLOUDBEDS_FAILURE_ALERT_RUNS). */
export const BEAM_SWEEP_FAILURE_ALERT_RUNS = 3;
/** TTL of the failed-run count (refreshed by every failed run; a good run deletes it). */
const SWEEP_FAILURE_TTL_SECONDS = 24 * 3600;
/** How long at most a released link whose last reading showed a PENDING charge stays watched (keys.beamLinksPending). */
export const BEAM_PENDING_WATCH_DAYS = 30;

/**
 * Tracks a link we just created in links-open (score = its expiresAt), so every sweeper run reads it until its
 * booking is done or its hold released (S4.2). The checkout adapter (payments/beamCheckoutAdapter.ts, which
 * beamCheckout.ts startBeamCheckout and the test kit run) calls it in afterCreate, once the PaymentRecord is
 * written (design S4.3).
 */
export async function trackOpenLink(kv: Pick<KvStore, "zadd">, mode: string, linkId: string, expiresAtMs: number): Promise<void> {
  await kv.zadd(keys.beamLinksOpen(keyScope(mode)), expiresAtMs, linkId);
}

/** Beam refused the unfiltered charge list: an answer about the request (a 4xx other than 429), not an outage. */
function isScanRefusal(e: unknown): e is BeamApiError {
  return e instanceof BeamApiError && e.status >= 400 && e.status < 500 && e.status !== 429;
}

/** A failed Beam call as the owner reads it: Beam's error code and HTTP status (no personal data). */
function problemOf(e: unknown): string {
  const info = beamErrorInfo(e);
  if (info.errorCode === null && info.status === null) return info.message.slice(0, 200);
  return `${info.errorCode ?? "no error code"}${info.status ? `, HTTP ${info.status}` : ""}`;
}

/** Which payment of a reservation's links matters most: money taken first, a payable one next, a closed one last. */
const SETTLED_RANK: Record<GatewayState, number> = { paid: 0, refunded: 1, processing: 2, open: 3, expired: 4, failed: 5 };
function settledRank(p: GatewayPayment): number {
  // An expired one still pending at the bank comes before a plainly expired one (its release warns the owner).
  return SETTLED_RANK[p.state] * 2 + (p.state === "expired" && p.pendingReason === "unconfirmed" ? 0 : 1);
}

/** What the Beam gateway needs: the core's deps plus Beam's settings and the caller's time limit. */
export type BeamGatewayDeps = CoreDeps & {
  /** config.beam of a Beam mode. */
  beam: BeamSettings;
  /** Beam's fetch (tests: the in-repo fake). Default fetch. */
  fetchImpl?: typeof fetch;
  /** Runs on every HTTP 429 from Beam (the runtime counts and alerts them). */
  onRateLimited?: () => void;
  /**
   * The wall-clock deadline (`clock` ms) of the route or the sweeper run: every Beam call gets what is left of
   * it as its budget. Absent: beam.ts's defaults (reads 15 s, a disable 10 s).
   */
  deadlineMs?: number;
  /** The deadline's clock (default Date.now; independent of deps.now, which tests pin). */
  clock?: () => number;
  /** Salt of the disable's idempotency key, one per attempt (default token.ts generateNonce). */
  nonce?: () => string;
  /** beam.ts's pause before its one retry (tests shorten it). */
  sleep?: (ms: number) => Promise<void>;
};

/** Whose payment link it is: our Redis record, else our verified signed note. */
export type BeamOwner = { source: "record"; facts: PaymentRecord } | { source: "note"; facts: BeamNote };

/** One fresh reading of a link: the link, its charges and its state (nothing written, nothing alerted). */
export interface BeamLinkRead {
  key: string;
  linkId: string;
  link: BeamPaymentLink;
  charges: BeamCharge[];
  /** null = not ours, or another payment mode's. */
  owner: BeamOwner | null;
  state: BeamPaymentState;
}

/** The charge index (keys.beamCharge): a SUCCEEDED charge of ours -> its link and booking (no personal data). */
export interface BeamChargeIndexEntry {
  v: 1;
  linkId: string;
  ref: string;
  reservationId: string;
  mode: string;
}

/** The Beam gateway: a PaymentGateway plus a side-effect-free reading of a link (the sweeper's needsDisable, S4.2). */
export type BeamGateway = PaymentGateway & {
  /** A fresh link + charge read and its state. Throws as get does. Writes nothing and alerts nothing. */
  readLink(key: string): Promise<BeamLinkRead>;
};

/** A link of ours one sweeper run lists (sweepRecent): its booking's facts from the record or the signed note. */
interface TrackedLink {
  linkId: string;
  key: string;
  facts: BeamNote;
  /**
   * The Beam merchant the link was created under: the record's, else (the signed note carries none) this
   * deployment's, whose API key just read the link.
   */
  merchantId: string;
  /** The charge scan showed a SUCCEEDED charge of the link. */
  listedPaid: boolean;
  /** Its hold was released: from the late watch or keys.beamLinksPending, or moved to the late watch this run. */
  watched: boolean;
  /** keys.beamLinksPending lists it (as this run started). */
  pendingWatched: boolean;
}

/** One sweeper run's view of the links whose readings keep failing (keys.beamReadFailures). */
interface ReadFailures {
  /** Every link with a failed reading not followed by a good one. */
  failing: Set<string>;
  /** Those whose first failed reading is BEAM_FAILURE_ALERT_MS old or older (at the start of the run). */
  overdue: Set<string>;
}

/** The error get, cancel and idOf throw for a key that is not a Beam payment key: missing, as a 404 is. */
function notABeamKey(): BeamApiError {
  return new BeamApiError(404, "NOT_FOUND_ERROR", "Not a Beam payment key");
}

function linkIdOrThrow(key: string): string {
  const linkId = linkIdOf(key);
  if (linkId === null) throw notABeamKey();
  return linkId;
}

/** At most `max` printable characters of a value Beam sent, for an owner's alert. */
function shown(v: unknown, max = 40): string {
  if (typeof v !== "string" || v === "") return "(none)";
  const clean = v.replace(/[^\x20-\x7e]/g, "?");
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function money(satang: number | null): string {
  return satang === null || !Number.isFinite(satang) ? "THB ?" : satang < 0 ? `-THB ${satangToBahtString(-satang)}` : `THB ${satangToBahtString(satang)}`;
}

function methodTypeOf(charge: BeamCharge | null | undefined): string | undefined {
  const type = charge?.paymentMethod?.paymentMethodType;
  return typeof type === "string" && type !== "" ? type : undefined;
}

/** A charge's id for markers and alerts (a charge without one is named by its link). */
function chargeIdOf(charge: BeamCharge, linkId: string): string {
  return typeof charge.chargeId === "string" && charge.chargeId !== "" ? charge.chargeId : `${linkId}-no-id`;
}

export function beamGateway(deps: BeamGatewayDeps): BeamGateway {
  const { beam } = deps;
  const mode = deps.config.paymentMode;
  const scope = keyScope(mode);
  const graceMs = beam.pendingGraceMinutes * 60_000;
  const text = beamGatewayText(beam);
  const clock = deps.clock ?? Date.now;

  /** The options of one Beam call: the budget left before the deadline, the 429 counter and the test seams. */
  const callOptions = (): BeamCallOptions => ({
    ...(deps.deadlineMs !== undefined ? { budgetMs: deps.deadlineMs - clock() } : {}),
    ...(deps.onRateLimited ? { onRateLimited: deps.onRateLimited } : {}),
    ...(deps.clock ? { now: deps.clock } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });

  /** Our record of the link, else its verified signed note; null when it carries neither. */
  async function ownerOf(linkId: string, link: BeamPaymentLink): Promise<BeamOwner | null> {
    const record = await readRecord(deps.kv, linkId);
    if (record) return { source: "record", facts: record };
    const note = verifyBeamNote(link?.order?.internalNote, deps.config.tokenSecret);
    return note ? { source: "note", facts: note } : null;
  }

  async function readLink(key: string): Promise<BeamLinkRead> {
    const linkId = linkIdOrThrow(key);
    const link = await getPaymentLink(beam, linkId, deps.fetchImpl, callOptions());
    const charges = await listPaymentLinkCharges(beam, { sourceId: linkId }, deps.fetchImpl, callOptions());
    const found = await ownerOf(linkId, link);
    // Beam's expiresAt wins; the one we set at create time stands in when Beam's can't be read.
    const state = beamPaymentState(link, charges, { nowMs: nowOf(deps), graceMs, ...(found ? { fallbackExpiresAtMs: found.facts.expiresAt } : {}) });
    let owner = found;
    if (found && found.facts.mode !== mode) {
      deps.log("beam_payment_other_mode", { linkId, source: found.source, mode: found.facts.mode });
      owner = null;
    }
    return { key, linkId, link, charges, owner, state };
  }

  /** Sets the "told the owner" marker; true only for the first caller. */
  const firstReport = (kind: BeamReportKind, id: string) => deps.kv.setNx(keys.beamReported(scope, kind, id), "1", BEAM_RECORD_TTL_SECONDS);

  /** The charge that paid the link: the stored one, else this reading's primary (stored now, set-once). */
  async function primaryIdOf(linkId: string, state: BeamPaymentState): Promise<string | null> {
    const stored = await deps.kv.get(keys.beamPrimary(linkId));
    if (stored !== null || !state.primary) return stored;
    const id = chargeIdOf(state.primary, linkId);
    await deps.kv.setNx(keys.beamPrimary(linkId), id, BEAM_RECORD_TTL_SECONDS);
    return (await deps.kv.get(keys.beamPrimary(linkId))) ?? id;
  }

  function receiptOf(linkId: string, state: BeamPaymentState, primaryId: string | null): GatewayReceipt {
    // The method of the charge that paid; before any success, of the youngest attempt still pending.
    const charge = primaryId !== null ? state.succeeded.find((c) => chargeIdOf(c, linkId) === primaryId) : state.pending[state.pending.length - 1];
    const methodType = methodTypeOf(charge);
    return {
      primaryId,
      description: `Beam link ${linkId} charge ${primaryId ?? "pending"} (${beamMethodName(methodType)})`,
      ...(methodType !== undefined
        ? { methodType, refundable: BEAM_REFUNDABLE_METHODS.has(methodType), partialRefundable: BEAM_PARTIAL_REFUND_METHODS.has(methodType) }
        : {}),
    };
  }

  /** Why the link disagrees with our record of the booking, as whole sentences for the owner; undefined when it agrees. */
  function mismatchOf(read: BeamLinkRead, owner: BeamOwner, meta: PaymentMeta): string | undefined {
    const { linkId, link, state } = read;
    const problems: string[] = [];
    const referenceId = link?.order?.referenceId;
    if (referenceId !== meta.ref) {
      problems.push(`Beam payment link ${linkId} names booking ${shown(referenceId)}, but our record of it is booking ${meta.ref}`);
    }
    const merchantId = link?.merchantId;
    if (typeof merchantId === "string" && merchantId !== "" && merchantId !== beam.merchantId) {
      problems.push(`Beam payment link ${linkId} belongs to another Beam merchant than this deployment's BEAM_MERCHANT_ID`);
    }
    if (owner.source === "record" && owner.facts.merchantId !== beam.merchantId) {
      problems.push(`Beam payment link ${linkId} was created under another Beam merchant than this deployment's BEAM_MERCHANT_ID`);
    }
    if (state.mismatch) problems.push(state.mismatch);
    if (problems.length === 0) return undefined;
    return `${problems.join(". ")}. Nothing was confirmed, cancelled or refunded automatically: check the payment in Beam Lighthouse and Cloudbeds reservation ${meta.reservationId} by hand.`;
  }

  /** Indexes every SUCCEEDED charge of ours (set-once: the first sighting's TTL). */
  async function indexCharges(read: BeamLinkRead, meta: PaymentMeta): Promise<void> {
    for (const charge of read.state.succeeded) {
      const entry: BeamChargeIndexEntry = { v: 1, linkId: read.linkId, ref: meta.ref, reservationId: meta.reservationId, mode };
      await deps.kv.setNx(keys.beamCharge(chargeIdOf(charge, read.linkId)), JSON.stringify(entry), BEAM_RECORD_TTL_SECONDS);
    }
  }

  /** One CRITICAL per SUCCEEDED charge other than the stored primary (money review 3), whatever the done marker says. */
  async function reportDuplicates(read: BeamLinkRead, meta: PaymentMeta, primaryId: string | null): Promise<void> {
    if (primaryId === null) return;
    const { linkId, state } = read;
    const extras = state.succeeded.filter((c) => chargeIdOf(c, linkId) !== primaryId);
    if (extras.length === 0) return;
    const count = new Set([primaryId, ...state.succeeded.map((c) => chargeIdOf(c, linkId))]).size;
    const primary = state.succeeded.find((c) => chargeIdOf(c, linkId) === primaryId);
    const primaryText = primary
      ? `${primaryId} (${beamMethodName(methodTypeOf(primary))}, ${money(primary.amount)})`
      : `${primaryId} (not in Beam's charge list right now)`;
    for (const extra of extras) {
      const extraId = chargeIdOf(extra, linkId);
      if (!(await firstReport("dup-charge", extraId))) continue;
      deps.log("beam_duplicate_charge", { ref: meta.ref, linkId, chargeId: extraId, charges: count });
      await deps.alert(
        `URGENT: guest charged twice for booking ${meta.ref}`,
        [
          `Beam payment link ${linkId} (booking ${meta.ref}, Cloudbeds reservation ${meta.reservationId}) has ${count} successful charges. ${primaryText} is the one recorded in Cloudbeds; ${extraId} (${beamMethodName(methodTypeOf(extra))}, ${money(extra.amount)}) is an extra charge.`,
          `Refund ${extraId} in full in Beam Lighthouse (bank transfer for LINE Pay, TrueMoney or ShopeePay). Do NOT record it in Cloudbeds and do not cancel the booking.`,
        ],
        { key: `dup-charge:${extraId}`, severity: "critical" },
      );
    }
  }

  /** One CRITICAL for a refunded (or voided) link with several successful charges, also after the done marker. */
  async function reportRefundAmbiguous(read: BeamLinkRead, meta: PaymentMeta): Promise<void> {
    const { linkId, link, state } = read;
    if (!state.refundAmbiguous || !(await firstReport("refund-ambiguous", linkId))) return;
    const status = shown(link?.status, 20);
    const ids = state.succeeded.map((c) => chargeIdOf(c, linkId));
    deps.log("beam_refund_ambiguous", { ref: meta.ref, linkId, status, charges: ids.length });
    await deps.alert(
      `URGENT: Beam payment link ${linkId} for booking ${meta.ref} is ${status} but has ${ids.length} successful charges - check in Lighthouse which charges were refunded`,
      [
        `Beam payment link ${linkId} for booking ${meta.ref} (Cloudbeds reservation ${meta.reservationId}) is ${status} but has ${ids.length} successful charges (${ids.join(", ")}). Beam does not say which of them were refunded, so nothing was confirmed, cancelled or released automatically.`,
        `Check in Beam Lighthouse which charges were refunded. If one payment is still kept, the booking stands (confirm or keep reservation ${meta.reservationId}); if every charge was refunded, cancel reservation ${meta.reservationId} by hand so the unit goes back on sale.`,
      ],
      { key: `beam-refund-ambiguous:${linkId}`, severity: "critical" },
    );
  }

  /** A reading in the gateway's shape, with the record, primary, index and owner-alert work of a payment of ours. */
  async function paymentOf(read: BeamLinkRead): Promise<GatewayPayment> {
    const { key, linkId, state, owner } = read;
    const base = {
      key,
      paymentId: linkId,
      state: state.state,
      amountSatang: state.amountSatang,
      currency: state.currency,
      attempted: state.attempted,
      ...(state.pendingReason ? { pendingReason: state.pendingReason } : {}),
    };
    if (!owner) return { ...base, meta: null, receipt: receiptOf(linkId, state, state.primary ? chargeIdOf(state.primary, linkId) : null) };
    const meta = recordToMeta(owner.facts);
    if (owner.source === "note" && (await firstReport("record-missing", linkId))) {
      deps.log("beam_record_missing", { ref: meta.ref, linkId });
      await deps.alert(
        `Beam payment record missing for link ${linkId} (booking ${meta.ref})`,
        [
          "Redis no longer has this payment link's record; it was recognised by its signed note and is handled normally. If this repeats, check the Upstash database.",
        ],
        { key: `beam-record-missing:${linkId}`, severity: "warning" },
      );
    }
    const primaryId = await primaryIdOf(linkId, state);
    await indexCharges(read, meta);
    await reportDuplicates(read, meta, primaryId);
    await reportRefundAmbiguous(read, meta);
    const mismatch = mismatchOf(read, owner, meta);
    return { ...base, meta, receipt: receiptOf(linkId, state, primaryId), ...(mismatch ? { mismatch } : {}) };
  }

  /** Disables the link with a fresh idempotency key: 'cancelled', or 'not_open' when it was no longer ACTIVE. */
  async function cancel(key: string): Promise<"cancelled" | "not_open"> {
    const linkId = linkIdOrThrow(key);
    const idempotencyKey = `msv-bd-${linkId}-${(deps.nonce ?? generateNonce)()}`;
    return (await disablePaymentLink(beam, linkId, idempotencyKey, deps.fetchImpl, callOptions())) === "disabled" ? "cancelled" : "not_open";
  }

  /* ------------------------------------- the sweep (S4.2) ------------------------------------- */

  const openKey = keys.beamLinksOpen(scope);
  const watchKey = keys.beamLinksWatch(scope);
  const pendingKey = keys.beamLinksPending(scope);
  const readFailKey = keys.beamReadFailures(scope);
  const bookingOf = (facts: BeamNote | null) => (facts ? `booking ${facts.ref}, Cloudbeds reservation ${facts.reservationId}` : "booking unknown");

  /**
   * One pass of the charge scan, from sinceMs: its charges, or null when Beam refuses the unfiltered list (logged
   * on every run; told to the owner once per HTTP status a day, so a warning whose mail was lost comes again).
   * Any other failure throws, and so does a pass that could not finish (a later page failed, the time budget or
   * the page limit ran out): the charges it did not read may hold the payment of a hold we lost track of.
   */
  async function scanPass(nowMs: number, sinceMs: number, deep: boolean): Promise<BeamCharge[] | null> {
    let scan: ChargeScan;
    try {
      scan = await listLinkChargesSince(beam, { sinceMs, maxPages: BEAM_SCAN_MAX_PAGES }, deps.fetchImpl, callOptions());
    } catch (e) {
      if (!isScanRefusal(e)) throw e;
      deps.log("beam_scan_refused", { status: e.status, errorCode: e.errorCode });
      if (await firstReport("scan-refused", `${e.status}:${new Date(nowMs).toISOString().slice(0, 10)}`)) {
        await deps.alert(
          "Beam refused the sweeper's payment scan",
          [
            `Beam answered the sweeper's list of recent payment-link charges (GET /api/v1/charges without a link id) with ${problemOf(e)}, so the sweeper only checks the payment links the booking engine tracks: the open ones, and released ones for ${beam.lateWatchDays} days.`,
            "A payment on a link the booking engine lost track of (for example after a Redis data loss) is then not found automatically. Ask Beam whether the unfiltered charge list is available for this account.",
          ],
          { key: `beam-scan-refused:${e.status}`, severity: "warning" },
        );
      }
      return null;
    }
    deps.log("beam_sweep_scan", {
      deep,
      charges: scan.charges.length,
      complete: scan.complete,
      ...(scan.error ? { status: scan.error.status, errorCode: scan.error.errorCode } : {}),
    });
    if (!scan.complete) {
      const err = scan.error;
      throw err
        ? new BeamApiError(err.status ?? 0, err.errorCode, `Beam charge scan stopped on a later page: ${err.message}`)
        : new BeamApiError(0, "SCAN_INCOMPLETE", "Beam charge scan did not finish (time budget or page limit)");
    }
    return scan.charges;
  }

  /**
   * The charge scan: 72 hours, or 7 days once the last complete deep pass is BEAM_DEEP_SCAN_EVERY_MS old (from
   * sinceMs at the latest). [] when Beam refuses the unfiltered list. A deep pass that fails is logged and the
   * 72-hour pass runs in its place (its marker is not written, so the next run tries the deep pass again): a deep
   * pass that keeps failing must not fail every run. The 72-hour pass throws as scanPass does.
   */
  async function scanCharges(nowMs: number, sinceMs: number): Promise<BeamCharge[]> {
    const lastRaw = await deps.kv.get(keys.beamDeepScan(scope));
    const last = lastRaw === null ? Number.NaN : Number(lastRaw);
    if (!(Number.isFinite(last) && nowMs - last < BEAM_DEEP_SCAN_EVERY_MS)) {
      let charges: BeamCharge[] | null | undefined;
      try {
        charges = await scanPass(nowMs, Math.min(sinceMs, nowMs - beam.deepScanDays * DAY_MS), true);
      } catch (e) {
        deps.log("beam_deep_scan_failed", { ...beamErrorInfo(e) });
      }
      if (charges === null) return [];
      if (charges !== undefined) {
        await deps.kv.set(keys.beamDeepScan(scope), String(nowMs), MARKER_TTL_SECONDS);
        return charges;
      }
    }
    return (await scanPass(nowMs, Math.min(sinceMs, nowMs - beam.scanLookbackHours * 3_600_000), false)) ?? [];
  }

  /** The links whose readings keep failing, as this run starts (one Redis read when there are none). */
  async function readFailuresAt(nowMs: number): Promise<ReadFailures> {
    const failing = new Set(await deps.kv.zrangeByScore(readFailKey, 0, Number.MAX_SAFE_INTEGER, BEAM_TRACKED_LINKS_LIMIT));
    const overdue = failing.size === 0 ? new Set<string>() : new Set(await deps.kv.zrangeByScore(readFailKey, 0, nowMs - BEAM_FAILURE_ALERT_MS, BEAM_TRACKED_LINKS_LIMIT));
    return { failing, overdue };
  }

  /** A failed reading: the first one is recorded; one that keeps failing BEAM_FAILURE_ALERT_MS is told to the owner. */
  async function noteReadFailure(run: ReadFailures, linkId: string, facts: BeamNote | null, e: unknown): Promise<void> {
    if (!run.failing.has(linkId)) {
      run.failing.add(linkId);
      await deps.kv.zadd(readFailKey, nowOf(deps), linkId);
      return;
    }
    if (!run.overdue.has(linkId)) return;
    await deps.alert(
      `Beam link ${linkId} could not be read for 60 minutes`,
      [
        `The sweeper keeps failing to read Beam payment link ${linkId} (${bookingOf(facts)}): ${problemOf(e)}. While Beam does not answer, the hold of its booking is kept, so the unit stays blocked.`,
        "Check the link in Beam Lighthouse (and status.beamcheckout.com): if the guest paid, confirm the booking by hand; if the link is closed and nobody paid, cancel the reservation in Cloudbeds.",
      ],
      { key: `beam-read-fail:${linkId}`, severity: "warning" },
    );
  }

  /** A good reading ends the link's failure record (best effort: a stale record only brings its alert forward). */
  async function clearReadFailure(run: ReadFailures, linkId: string): Promise<void> {
    if (!run.failing.delete(linkId)) return;
    run.overdue.delete(linkId);
    await deps.kv.zrem(readFailKey, linkId).catch(() => undefined);
  }

  /** A failed disable: the first one is recorded; one that keeps failing BEAM_FAILURE_ALERT_MS is told to the owner. */
  async function noteDisableFailure(linkId: string, facts: BeamNote, problem: string): Promise<void> {
    const nowMs = nowOf(deps);
    deps.log("beam_disable_failed", { linkId, problem });
    const failKey = keys.beamDisableFail(scope, linkId);
    await deps.kv.setNx(failKey, String(nowMs), MARKER_TTL_SECONDS);
    const first = Number(await deps.kv.get(failKey));
    if (!Number.isFinite(first) || nowMs - first < BEAM_FAILURE_ALERT_MS) return;
    await deps.alert(
      `Beam link ${linkId} could not be disabled for 60 minutes`,
      [
        `The sweeper keeps failing to disable an expired Beam payment link (booking ${facts.ref}): ${problem}. Disable it in Lighthouse; its hold is released only once Beam reports no payable charge.`,
      ],
      { key: `beam-disable-fail:${linkId}`, severity: "warning" },
    );
  }

  /**
   * An ACTIVE link past expiresAt + skew: disable it (a fresh key) and read it again. A disable that throws, or
   * whose re-read still says ACTIVE, is a failed disable and leaves the reading as it is (the link stays payable,
   * so its hold stays). A 404 is thrown on (the link is missing); a failed re-read throws.
   */
  async function disableExpired(reading: BeamLinkRead, facts: BeamNote): Promise<BeamLinkRead> {
    let answer: "cancelled" | "not_open";
    try {
      answer = await cancel(reading.key);
    } catch (e) {
      if (isBeamNotFound(e)) throw e;
      await noteDisableFailure(reading.linkId, facts, problemOf(e));
      return reading;
    }
    const next = await readLink(reading.key);
    if (next.link?.status === "ACTIVE") {
      await noteDisableFailure(
        reading.linkId,
        facts,
        answer === "cancelled" ? "Beam accepted the disable, but the link still reads ACTIVE" : "Beam answered that the link is no longer open, but it still reads ACTIVE",
      );
      return next;
    }
    await deps.kv.del(keys.beamDisableFail(scope, reading.linkId));
    return next;
  }

  /**
   * One CRITICAL per link (keys.beamReported 'merchant-switch'): a link of ours created under another Beam merchant
   * than BEAM_MERCHANT_ID, which Beam answers 404 for. The guest may have paid, or may still pay, on that
   * merchant's page; nobody here can see it, so the hold is kept and the owner checks by hand. A released link
   * (the late or pending watch) has no hold left: a late payment on it can't be seen any more (round 5).
   */
  async function reportOtherMerchant(t: Pick<TrackedLink, "linkId" | "facts" | "merchantId" | "watched">): Promise<void> {
    if (!(await firstReport("merchant-switch", t.linkId))) return;
    const { ref, reservationId } = t.facts;
    const old = shown(t.merchantId);
    deps.log("beam_link_other_merchant", { linkId: t.linkId, ref, released: t.watched });
    const why = `Beam payment link ${t.linkId} (booking ${ref}, Cloudbeds reservation ${reservationId}) was created under Beam merchant ${old}, but this deployment's BEAM_MERCHANT_ID is ${shown(beam.merchantId)}, so Beam answers that the link does not exist.`;
    await deps.alert(
      `URGENT: Beam payment link ${t.linkId} for booking ${ref} belongs to another Beam merchant`,
      t.watched
        ? [
            `${why} Its hold was already released (no payment had succeeded when its time ran out), but the sweeper can no longer see a late payment on it.`,
            `Check the link in the Beam Lighthouse of merchant ${old} until it has no pending payment: if the guest paid late, re-book the guest if the unit is still free, otherwise refund the full amount there. Never change BEAM_MERCHANT_ID while payment links are still open or watched.`,
          ]
        : [
            `${why} The sweeper can't tell whether the guest paid: the hold is kept and nothing was confirmed, cancelled or refunded.`,
            `Check the link in the Beam Lighthouse of merchant ${old}: if the guest paid, confirm reservation ${reservationId} by hand (or refund the full amount there); if nobody paid, disable the link there and cancel reservation ${reservationId} in Cloudbeds. Never change BEAM_MERCHANT_ID while payment links are still open.`,
          ],
      { key: `beam-merchant-switch:${t.linkId}`, severity: "critical" },
    );
  }

  /**
   * Why Beam's 404 for a link of ours does NOT mean that it can never be paid, or null when it does (round-4
   * triage). Beam reads the merchant from the API key, so every link of another merchant answers 404, paid and
   * payable ones too: a 404 is final only for a link created under this BEAM_MERCHANT_ID whose expiry plus the
   * pending grace is over (before that the guest may still be on Beam's page). The error is not a 404, so the
   * reading fails like any other (its hold is kept: RecentPayments.unread; told after 60 minutes of failures).
   * A link of another merchant also raises its CRITICAL (best effort: the hold is kept either way).
   */
  async function missingProblem(t: Pick<TrackedLink, "linkId" | "facts" | "merchantId" | "watched">): Promise<BeamApiError | null> {
    if (t.merchantId !== beam.merchantId) {
      await reportOtherMerchant(t).catch((e: unknown) => deps.log("beam_merchant_alert_failed", { linkId: t.linkId, ...beamErrorInfo(e) }));
      return new BeamApiError(0, "LINK_OF_ANOTHER_MERCHANT", `Beam payment link ${t.linkId} was created under another Beam merchant than BEAM_MERCHANT_ID`);
    }
    if (nowOf(deps) < t.facts.expiresAt + graceMs) {
      deps.log("beam_link_missing_early", { linkId: t.linkId, ref: t.facts.ref });
      return new BeamApiError(0, "NOT_FOUND_BEFORE_EXPIRY", `Beam answered 404 for payment link ${t.linkId} before its expiry and pending grace were over`);
    }
    return null;
  }

  /** A released link stays watched while its last reading shows a PENDING charge (keys.beamLinksPending). Best effort. */
  async function notePendingWatch(t: TrackedLink, pending: boolean): Promise<void> {
    if (pending === t.pendingWatched) return;
    const write = pending ? deps.kv.zadd(pendingKey, nowOf(deps), t.linkId) : deps.kv.zrem(pendingKey, t.linkId);
    await write.catch((e: unknown) => deps.log("beam_pending_watch_failed", { linkId: t.linkId, error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));
  }

  /** A link Beam answers 404 for that can never be paid (missingProblem answered null): expired. */
  function missingPayment(t: TrackedLink): GatewayPayment {
    return {
      key: t.key,
      paymentId: t.linkId,
      state: "expired",
      meta: recordToMeta(t.facts),
      amountSatang: t.facts.totalSatang,
      currency: "THB",
      attempted: false,
      receipt: { primaryId: null, description: `Beam link ${t.linkId} charge pending (method pending)` },
    };
  }

  /**
   * RecentPayment.read of one link: a fresh reading (disabled first when it needs it), in the gateway's shape. A
   * released link's reading also keeps keys.beamLinksPending up to date.
   */
  async function readTracked(run: ReadFailures, t: TrackedLink): Promise<GatewayPayment> {
    let payment: GatewayPayment;
    try {
      let reading = await readLink(t.key);
      if (reading.state.needsDisable && reading.owner) reading = await disableExpired(reading, t.facts);
      payment = await paymentOf(reading);
      if (t.watched) await notePendingWatch(t, reading.state.pending.length > 0);
    } catch (e) {
      const failure = isBeamNotFound(e) ? await missingProblem(t) : e;
      if (failure !== null) {
        await noteReadFailure(run, t.linkId, t.facts, failure).catch(() => undefined);
        throw failure;
      }
      deps.log("beam_link_missing", { linkId: t.linkId, ref: t.facts.ref });
      payment = missingPayment(t);
    }
    await clearReadFailure(run, t.linkId);
    return payment;
  }

  /** The step-1 entry of a reservation: its one link, or (never by construction) several sharing one entry. */
  function recentPaymentOf(run: ReadFailures, reservationId: string, links: TrackedLink[]): RecentPayment {
    if (links.length === 1) {
      const [only] = links;
      return { key: only.key, reservationId, listedPaid: only.listedPaid, read: () => readTracked(run, only) };
    }
    deps.log("beam_sweep_links_share_reservation", { reservationId, links: links.map((l) => l.linkId) });
    const entry: RecentPayment = {
      key: links[0].key,
      reservationId,
      listedPaid: links.some((l) => l.listedPaid),
      async read() {
        const payments: GatewayPayment[] = [];
        for (const l of links) payments.push(await readTracked(run, l));
        const chosen = payments.reduce((a, b) => (settledRank(b) < settledRank(a) ? b : a));
        // Step 1 fulfils, releases and alerts under the entry's key: the payment it answers.
        entry.key = chosen.key;
        return chosen;
      },
    };
    return entry;
  }

  /**
   * A not-ours link's SUCCEEDED charges that name an MSV booking: one CRITICAL per charge (keys.beamReported). Money
   * was taken under our booking reference with no booking behind it (owner decision 3's 'guest paid, no booking'),
   * so the alert is stored and re-sent by every sweeper run until a mail goes out (round 5: as a warning, the one
   * send behind the set-once marker could be lost).
   */
  async function reportUnknownPayments(linkId: string, charges: BeamCharge[], link: BeamPaymentLink | null): Promise<void> {
    for (const c of charges) {
      if (c?.status !== "SUCCEEDED" || c.sourceId !== linkId) continue;
      const ref = isBookingRef(c.referenceId) ? c.referenceId : isBookingRef(link?.order?.referenceId) ? link.order.referenceId : null;
      if (ref === null) continue;
      const chargeId = chargeIdOf(c, linkId);
      if (!(await firstReport("unknown-payment", chargeId))) continue;
      deps.log("beam_unknown_msv_payment", { ref, linkId, chargeId });
      await deps.alert(
        `A Beam payment names booking ${ref} but we have no record of it`,
        [
          `Charge ${chargeId} (${money(c.amount)}, ${beamMethodName(methodTypeOf(c))}) on payment link ${linkId} carries our booking reference but neither a record nor a valid signed note. Check it in Lighthouse and Cloudbeds; if it is a real guest payment, book or refund it by hand.`,
        ],
        { key: `beam-unknown-msv:${chargeId}`, severity: "critical" },
      );
    }
  }

  /** A failed step 1: counted (runs in a row); the BEAM_SWEEP_FAILURE_ALERT_RUNS-th tells the owner. Never throws. */
  async function noteSweepFailure(e: unknown): Promise<void> {
    try {
      const failKey = keys.beamSweepFailures(scope);
      const n = Number(await deps.kv.get(failKey)) + 1;
      await deps.kv.set(failKey, String(n), SWEEP_FAILURE_TTL_SECONDS);
      deps.log("beam_sweep_failed", { runs: n, ...beamErrorInfo(e) });
      if (n < BEAM_SWEEP_FAILURE_ALERT_RUNS) return;
      await deps.alert(
        "The booking sweeper cannot check Beam payments",
        [
          `${n} sweeper runs in a row could not finish Beam's payment check (the charge scan, or the reading of a payment link whose record is gone): ${problemOf(e)}.`,
          "While this lasts no Beam hold is released (the units stay blocked) and a payment on a link the booking engine lost track of is not found; paid bookings already known are still retried and stored urgent alerts re-sent. Check status.beamcheckout.com, the Beam API key and the Vercel logs (beam_sweep_scan, beam_sweep_link_unreadable).",
        ],
        { key: "beam-sweep-failing", severity: "warning" },
      );
    } catch {
      // Best effort only.
    }
  }

  /** Step 1 for Beam, with its failures counted (round 5): a good run ends the count (one Redis read when there is none). */
  async function sweepRecent(sinceMs: number): Promise<RecentPayment[]> {
    let listed: RecentPayment[];
    try {
      listed = await listRecent(sinceMs);
    } catch (e) {
      await noteSweepFailure(e);
      throw e;
    }
    const failKey = keys.beamSweepFailures(scope);
    if ((await deps.kv.get(failKey).catch(() => null)) !== null) await deps.kv.del(failKey).catch(() => undefined);
    return listed;
  }

  async function listRecent(sinceMs: number): Promise<RecentPayment[]> {
    const nowMs = nowOf(deps);
    const scanned = new Map<string, BeamCharge[]>();
    for (const c of await scanCharges(nowMs, sinceMs)) {
      if (c.source !== "PAYMENT_LINK" || !isBeamLinkId(c.sourceId)) continue;
      scanned.set(c.sourceId, [...(scanned.get(c.sourceId) ?? []), c]);
    }
    const watchFrom = nowMs - beam.lateWatchDays * DAY_MS;
    for (const linkId of await deps.kv.zrangeByScore(watchKey, 0, watchFrom - 1, BEAM_TRACKED_LINKS_LIMIT)) await deps.kv.zrem(watchKey, linkId);
    const pendingFrom = nowMs - BEAM_PENDING_WATCH_DAYS * DAY_MS;
    for (const linkId of await deps.kv.zrangeByScore(pendingKey, 0, pendingFrom - 1, BEAM_TRACKED_LINKS_LIMIT)) await deps.kv.zrem(pendingKey, linkId);
    const open = await deps.kv.zrangeByScore(openKey, 0, Number.MAX_SAFE_INTEGER, BEAM_TRACKED_LINKS_LIMIT);
    const watched = await deps.kv.zrangeByScore(watchKey, watchFrom, Number.MAX_SAFE_INTEGER, BEAM_TRACKED_LINKS_LIMIT);
    const pendingWatched = await deps.kv.zrangeByScore(pendingKey, pendingFrom, Number.MAX_SAFE_INTEGER, BEAM_TRACKED_LINKS_LIMIT);
    // A released link is "watched" however this run lists it (the charge scan names it first while its charges are recent).
    const watchedSet = new Set(watched);
    const pendingSet = new Set(pendingWatched);
    const run = await readFailuresAt(nowMs);

    const tracked = new Map<string, TrackedLink>();
    const considered = new Set<string>();
    const unreadable = new Set<string>();
    let firstUnreadable: unknown = null;

    /**
     * Classifies one link (ours: tracked; not ours: cached as foreign) and keeps links-open, the late watch and
     * keys.beamLinksPending tidy.
     */
    const consider = async (linkId: string, from: "open" | "scan" | "watch" | "pending"): Promise<void> => {
      if (considered.has(linkId)) return;
      considered.add(linkId);
      const zset = from === "open" ? openKey : from === "watch" ? watchKey : from === "pending" ? pendingKey : null;
      const untrack = async () => {
        if (zset) await deps.kv.zrem(zset, linkId);
      };
      if (!isBeamLinkId(linkId)) return untrack();
      const key = beamKeyOf(linkId);
      const fromScan = scanned.get(linkId) ?? [];
      const record = await readRecord(deps.kv, linkId);
      let facts: BeamNote | null = record;
      // The note carries no merchant: a link read through it was just read with this deployment's API key.
      let merchantId = record?.merchantId ?? beam.merchantId;
      let watching = watchedSet.has(linkId) || pendingSet.has(linkId);
      if (facts && facts.mode !== mode) {
        deps.log("beam_payment_other_mode", { linkId, source: "record", mode: facts.mode });
        return;
      }
      if (!facts) {
        const foreignKey = keys.beamReported(scope, "foreign-link", linkId);
        const cached = await deps.kv.get(foreignKey);
        if (cached !== null) {
          await untrack();
          // A later charge on a cached link is still looked at (no Beam call): unless it is another mode's link.
          return cached === OTHER_MODE_LINK ? undefined : reportUnknownPayments(linkId, fromScan, null);
        }
        let reading: BeamLinkRead | null = null;
        try {
          reading = await readLink(key);
        } catch (e) {
          if (!isBeamNotFound(e)) {
            deps.log("beam_sweep_link_unreadable", { linkId, ...beamErrorInfo(e) });
            unreadable.add(linkId);
            firstUnreadable ??= e;
            await noteReadFailure(run, linkId, null, e).catch(() => undefined);
            return;
          }
        }
        if (!reading?.owner) {
          // Not ours (no record, no valid note of this mode), or unknown to Beam: not read again for 8 days. A valid
          // note of another mode is that deployment's payment, never an unknown one.
          const otherMode = reading !== null && verifyBeamNote(reading.link?.order?.internalNote, deps.config.tokenSecret) !== null;
          await deps.kv.set(foreignKey, otherMode ? OTHER_MODE_LINK : "1", BEAM_FOREIGN_CACHE_SECONDS);
          await untrack();
          deps.log("beam_link_not_ours", { linkId, otherMode });
          if (!otherMode) await reportUnknownPayments(linkId, [...fromScan, ...(reading?.charges ?? [])], reading?.link ?? null);
          return;
        }
        facts = reading.owner.facts;
        if (reading.owner.source === "record") merchantId = reading.owner.facts.merchantId;
      }
      if (from === "open") {
        if ((await deps.kv.get(keys.fulfilDone(key))) !== null) {
          // The booking is done (confirmed or handed to the owner): only a charge the scan shows is read again.
          await untrack();
          if (fromScan.length === 0) return;
        } else if ((await deps.kv.get(keys.releaseDone(facts.reservationId))) !== null) {
          // Released: watched for a late success (owner decision 3).
          await untrack();
          await deps.kv.zadd(watchKey, nowMs, linkId);
          watching = true;
        } else if (facts.expiresAt < watchFrom) {
          // Closed longer than the late watch (its release kept being refused): the charge scan still sees it.
          await untrack();
          deps.log("beam_link_untracked", { linkId, ref: facts.ref });
          if (fromScan.length === 0) return;
        }
      }
      tracked.set(linkId, {
        linkId,
        key,
        facts,
        merchantId,
        listedPaid: fromScan.some((c) => c.status === "SUCCEEDED"),
        watched: watching,
        pendingWatched: pendingSet.has(linkId),
      });
    };
    for (const linkId of open) await consider(linkId, "open");
    for (const linkId of scanned.keys()) await consider(linkId, "scan");
    for (const linkId of watched) await consider(linkId, "watch");
    // Released links still waiting on a PENDING charge, past the late watch (BEAM_PENDING_WATCH_DAYS at most).
    for (const linkId of pendingWatched) await consider(linkId, "pending");

    // Failure records of links this run no longer lists (or that turned out not to be ours) are dropped.
    for (const linkId of [...run.failing]) if (!tracked.has(linkId) && !unreadable.has(linkId)) await clearReadFailure(run, linkId);
    // A link whose booking can't be told may belong to any hold: no hold may be released by this run.
    if (firstUnreadable !== null) throw firstUnreadable;

    const byReservation = new Map<string, TrackedLink[]>();
    for (const t of tracked.values()) byReservation.set(t.facts.reservationId, [...(byReservation.get(t.facts.reservationId) ?? []), t]);
    return [...byReservation.entries()].map(([reservationId, links]) => recentPaymentOf(run, reservationId, links));
  }

  return {
    provider: "beam",
    brand: "Beam",
    keyOf: beamKeyOf,
    idOf: linkIdOrThrow,
    async get(key) {
      return paymentOf(await readLink(key));
    },
    cancel,
    isMissing: isBeamNotFound,
    sweepRecent,
    text,
    doneTtlSeconds: BEAM_RECORD_TTL_SECONDS,
    async releaseGuard(key) {
      // A key that is not a Beam key is never released by this guard.
      const linkId = linkIdOf(key);
      if (linkId === null) return false;
      try {
        const { state } = await readLink(key);
        return state.state === "expired" || state.state === "failed";
      } catch (e) {
        if (!isBeamNotFound(e)) throw e;
        // A link Beam does not know can never be paid only when our record says it is this merchant's and its
        // expiry plus the grace is over (see missingProblem); without a record nothing says so: the hold stays.
        const record = await readRecord(deps.kv, linkId);
        return record !== null && record.merchantId === beam.merchantId && nowOf(deps) >= record.expiresAt + graceMs;
      }
    },
    parseHoldId: parseBeamHoldIdentifier,
    isPaymentId: isBeamLinkId,
    readLink,
  };
}

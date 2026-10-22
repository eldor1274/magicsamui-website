// PaymentGateway for Beam payment links (design S4.1; sweepRecent follows in S4.2). Server only.
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
// 'expired' or 'failed': no SUCCEEDED charge and no PENDING charge inside the grace; money review 9).
//
// No card number digits ever pass through here: beam.ts drops them when it parses a charge.

import {
  getPaymentLink,
  disablePaymentLink,
  isBeamLinkId,
  isBeamNotFound,
  listPaymentLinkCharges,
  BeamApiError,
} from "../beam.ts";
import type { BeamCallOptions, BeamCharge, BeamPaymentLink } from "../beam.ts";
import type { BeamSettings } from "../config.ts";
import { BEAM_RECORD_TTL_SECONDS, beamKeyOf, keyScope, keys, linkIdOf, parseBeamHoldIdentifier } from "../lock.ts";
import type { BeamReportKind } from "../lock.ts";
import { satangToBahtString } from "../quote.ts";
import type { CoreDeps } from "../stripeDeps.ts";
import { nowOf } from "../stripeDeps.ts";
import { generateNonce } from "../token.ts";
import { readRecord, recordToMeta, verifyBeamNote } from "./beamRecord.ts";
import type { BeamNote, PaymentRecord } from "./beamRecord.ts";
import { beamPaymentState } from "./beamState.ts";
import type { BeamPaymentState } from "./beamState.ts";
import { BEAM_PARTIAL_REFUND_METHODS, BEAM_REFUNDABLE_METHODS, beamGatewayText, beamMethodName } from "./beamText.ts";
import type { GatewayPayment, GatewayReceipt, PaymentGateway, PaymentMeta } from "./gateway.ts";

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

  return {
    provider: "beam",
    brand: "Beam",
    keyOf: beamKeyOf,
    idOf: linkIdOrThrow,
    async get(key) {
      return paymentOf(await readLink(key));
    },
    async cancel(key) {
      const linkId = linkIdOrThrow(key);
      const idempotencyKey = `msv-bd-${linkId}-${(deps.nonce ?? generateNonce)()}`;
      return (await disablePaymentLink(beam, linkId, idempotencyKey, deps.fetchImpl, callOptions())) === "disabled" ? "cancelled" : "not_open";
    },
    isMissing: isBeamNotFound,
    async sweepRecent() {
      // Design S4.2. Nothing runs the Beam gateway's sweep yet; a throw keeps every hold (never an empty listing).
      throw new Error("BeamGateway.sweepRecent is not implemented yet (design step S4.2)");
    },
    text,
    doneTtlSeconds: BEAM_RECORD_TTL_SECONDS,
    async releaseGuard(key) {
      const { state } = await readLink(key);
      return state.state === "expired" || state.state === "failed";
    },
    parseHoldId: parseBeamHoldIdentifier,
    isPaymentId: isBeamLinkId,
    readLink,
  };
}

// The refunds Beam's webhook saw SUCCEED on a payment link (keys.beamRefunds), read by the WhatsApp bot's payment
// lookup (supportLookup.ts) so a booking refunded after it was confirmed - in full, voided, or in part (a 50% card
// cancellation refund) - is answered as refunded without a Beam call. Server only.
//
// Why a note of our own: Beam's link reads REFUNDED (or VOIDED) after a refund, but whether a partial refund already
// moves it there is UNVERIFIED (fakeBeam's refundLinkStatus), and the link never says how much was refunded or when.
// The webhook re-reads every refund from Beam (getRefund) before it acts, so what it notes here is Beam's own word.
//
// - Written by the webhook only (beamWebhook.ts handleRefund, a SUCCEEDED refund of a link of ours), under a short
//   lock (keys.beamRefundsLock): two refunds of one link delivered at once never lose one. A refund already noted
//   (Beam's retries) changes nothing. Kept BEAM_RECORD_TTL_SECONDS, as long as the charge index it was mapped through.
// - Each entry: the refund id, the charge it refunded, its amount (satang) and when (Beam's createdAt, else the
//   webhook's time). No personal data: Beam's free-text refund reason is never read (beam.ts parseBeamRefund).
// - Read by the lookup: a garbled or missing note reads as no refund; a Redis failure throws.

import type { KvStore } from "../kv.ts";
import { BEAM_RECORD_TTL_SECONDS, keys, readJson, withLock } from "../lock.ts";
import { BEAM_ID_PATTERN } from "./beamIds.ts";

/** Refunds kept per link (newest last); far more than one link ever has (a 50% refund, then the rest). */
export const BEAM_REFUNDS_MAX = 20;
/** How long the webhook's lock on one link's note lives at most (the write is a read and a write). */
export const BEAM_REFUNDS_LOCK_SECONDS = 30;

/** One refund Beam reported SUCCEEDED (no personal data). */
export interface BeamRefundEntry {
  refundId: string;
  /** The charge refunded ("" when Beam's answer named none in its id shape). */
  chargeId: string;
  /** The amount refunded in satang; null when Beam's answer had no whole number. */
  amountSatang: number | null;
  /** When it was refunded (epoch ms): Beam's createdAt, else when the webhook saw it. */
  at: number;
}

/** keys.beamRefunds: the link's refunds, oldest first. */
export interface BeamRefundsNote {
  v: 1;
  refunds: BeamRefundEntry[];
}

function entryOf(v: unknown): BeamRefundEntry | null {
  if (typeof v !== "object" || v === null) return null;
  const e = v as Record<string, unknown>;
  if (typeof e.refundId !== "string" || !BEAM_ID_PATTERN.test(e.refundId)) return null;
  if (typeof e.chargeId !== "string" || (e.chargeId !== "" && !BEAM_ID_PATTERN.test(e.chargeId))) return null;
  const amount = e.amountSatang === null || (Number.isSafeInteger(e.amountSatang) && (e.amountSatang as number) > 0) ? (e.amountSatang as number | null) : undefined;
  if (amount === undefined || !Number.isSafeInteger(e.at) || (e.at as number) <= 0) return null;
  return { refundId: e.refundId, chargeId: e.chargeId, amountSatang: amount, at: e.at as number };
}

/** The refunds noted for a link, oldest first ([] when none, or when the note can't be read as one). Throws on a Redis failure. */
export async function readBeamRefunds(kv: KvStore, linkId: string): Promise<BeamRefundEntry[]> {
  const note = await readJson<unknown>(kv, keys.beamRefunds(linkId));
  if (typeof note !== "object" || note === null || (note as { v?: unknown }).v !== 1) return [];
  const list = (note as { refunds?: unknown }).refunds;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const refunds: BeamRefundEntry[] = [];
  for (const raw of list) {
    const e = entryOf(raw);
    if (e && !seen.has(e.refundId)) {
      seen.add(e.refundId);
      refunds.push(e);
    }
  }
  return refunds;
}

/** A refund as the webhook hands it over: Beam's answer, shape-checked here. */
export interface BeamRefundSeen {
  refundId: string;
  chargeId: unknown;
  amount: unknown;
  at: number;
}

/**
 * Adds a SUCCEEDED refund to the link's note: 'noted', 'known' (already there: nothing written), or 'busy' (another
 * delivery holds the lock: the caller asks Beam to retry). Throws on a Redis failure or a refund id we never accept.
 */
export async function noteBeamRefund(kv: KvStore, linkId: string, seen: BeamRefundSeen): Promise<"noted" | "known" | "busy"> {
  if (!BEAM_ID_PATTERN.test(seen.refundId)) throw new RangeError("noteBeamRefund: unexpected refund id");
  const entry: BeamRefundEntry = {
    refundId: seen.refundId,
    chargeId: typeof seen.chargeId === "string" && BEAM_ID_PATTERN.test(seen.chargeId) ? seen.chargeId : "",
    amountSatang: Number.isSafeInteger(seen.amount) && (seen.amount as number) > 0 ? (seen.amount as number) : null,
    at: Number.isSafeInteger(seen.at) && seen.at > 0 ? seen.at : Date.now(),
  };
  const locked = await withLock(
    kv,
    keys.beamRefundsLock(linkId),
    async () => {
      const refunds = await readBeamRefunds(kv, linkId);
      if (refunds.some((r) => r.refundId === entry.refundId)) return "known" as const;
      const note: BeamRefundsNote = { v: 1, refunds: [...refunds, entry].slice(-BEAM_REFUNDS_MAX) };
      await kv.set(keys.beamRefunds(linkId), JSON.stringify(note), BEAM_RECORD_TTL_SECONDS);
      return "noted" as const;
    },
    BEAM_REFUNDS_LOCK_SECONDS,
  );
  return locked.acquired ? locked.value : "busy";
}

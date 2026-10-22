// Beam's payment record and signed internalNote (design S2.4). Server only (node:crypto).
//
// A Beam payment link is ours when Redis holds its PaymentRecord (lock.ts keys.beamPayment, kept
// BEAM_RECORD_TTL_SECONDS) or, failing that, when its order.internalNote is a note signed with
// BOOKING_TOKEN_SECRET (money review 2). A link with neither is not ours (e.g. the owner's own Lighthouse
// links). Neither carries personal data: no name, email or phone, only the booking's facts and yes/no guest
// flags (never the request text).
//
// PaymentRecord
// - Written once the link exists (it needs Beam's link id and our merchant id). writeRecord stores only the
//   record's own fields and refuses a malformed record; readRecord answers null for a missing, unreadable or
//   malformed record, or one stored under another link's key, so the caller falls back to the signed note.
// - recordToMeta gives the shared core's PaymentMeta (the Stripe session-metadata shape); it takes a
//   verified note too.
//
// The signed note: 'msv1|m=..|r=..|res=..|rm=..|fee=..|tot=..|ci=..|co=..|pm=..|tv=..|fl=..|ex=..|s=..'
// - m the payment mode, r the booking ref, res the Cloudbeds reservation id, rm / fee / tot the rooms, fee
//   and total in satang (rm + fee = tot), ci / co check-in and check-out, pm the method group, tv the booking
//   terms version (empty: none), fl the three guest flags in the order arrival after 11 PM, special requests
//   entered, pre-payment note saved ('1' yes, '0' no, '-' unknown), ex the link's expiresAt as we set it
//   (epoch ms: what the gateway passes as fallbackExpiresAtMs when Beam's own expiresAt cannot be read, S4.1).
// - s = base64url(HMAC-SHA256(BOOKING_TOKEN_SECRET, everything before '|s=')) cut to 27 characters (162
//   bits). A booking token signs a base64url segment, which can never contain '|', so a token signature can
//   never stand in for a note's or the reverse.
// - Every value has a fixed pattern without '|' or '=', and the fields come in exactly this order. At most
//   500 characters (Beam's internalNote limit; the longest possible note is under 300), never clipped.
// - verifyBeamNote answers null on any change: an edited, added, missing or reordered field, another
//   version, another secret, a cut or padded signature (compared in constant time).
//
// Rotating BOOKING_TOKEN_SECRET makes older notes unverifiable; that only matters for a link whose Redis
// record is lost as well (design risks).

import { createHmac, timingSafeEqual } from "node:crypto";
import type { BeamMethodGroup } from "../beam.ts";
import { isIsoDate } from "../dates.ts";
import type { KvStore } from "../kv.ts";
import { BEAM_RECORD_TTL_SECONDS, keys, readJson, writeJson } from "../lock.ts";
import { isBookingRef } from "../ref.ts";
import { isBeamLinkId } from "./beamIds.ts";
import type { PaymentMeta } from "./gateway.ts";

/** What the booking engine knows about one Beam payment link (no personal data). */
export interface PaymentRecord {
  v: 1;
  /** Beam's paymentLinkId. */
  linkId: string;
  ref: string;
  /** The Cloudbeds hold the link was created for. */
  reservationId: string;
  roomsSatang: number;
  feeSatang: number;
  /** roomsSatang + feeSatang: exactly the link's netAmount (Beam bookings are paid in full). */
  totalSatang: number;
  /** The method group the guest picked, the only one the link offers. */
  payMethod: BeamMethodGroup;
  checkIn: string;
  checkOut: string;
  /** The payment mode that created the link (beam-live or beam-playground). */
  mode: string;
  /** The Beam merchant id the link was created under (config.beam.merchantId). */
  merchantId: string;
  /** Yes/no guest flags as in PaymentMeta; null = unknown. */
  arrivalLate: boolean | null;
  hasRequests: boolean | null;
  noteSaved: boolean | null;
  /** The booking terms version agreed to; null = unknown. */
  termsVersion: string | null;
  /** When we created the link (epoch ms). */
  createdAt: number;
  /** The link's expiresAt as we set it (epoch ms). */
  expiresAt: number;
}

/** What the signed note carries: the record without Beam's link id, the merchant id and our creation time. */
export type BeamNote = Omit<PaymentRecord, "v" | "linkId" | "merchantId" | "createdAt">;

export const BEAM_NOTE_VERSION = "msv1";
/** Beam's limit on order.internalNote. */
export const BEAM_NOTE_MAX_LENGTH = 500;
const SIGNATURE_LENGTH = 27;

/** The note's fields after the version, in order. */
const NOTE_FIELDS = ["m", "r", "res", "rm", "fee", "tot", "ci", "co", "pm", "tv", "fl", "ex"] as const;
type NoteField = (typeof NOTE_FIELDS)[number];

/** As parseSessionMeta (payments/stripe.ts) accepts them. */
const RESERVATION_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const TERMS_VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;
const MODE_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** Printable ASCII, no spaces (the merchant id never goes into the note). */
const MERCHANT_ID_RE = /^[\x21-\x7e]{1,128}$/;
/** Twelve digits, as parseSessionMeta. */
const MAX_SATANG = 999_999_999_999;
const DECIMAL_RE = /^(0|[1-9]\d{0,15})$/;
const FLAGS_RE = /^[01-]{3}$/;

const isSatang = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_SATANG;
const isEpochMs = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isFlag = (v: unknown): v is boolean | null => v === true || v === false || v === null;
const isPayMethod = (v: unknown): v is BeamMethodGroup => v === "card_ewallet" || v === "promptpay";

/** The first booking fact (of a record or a note) that is malformed; null when all are fine. */
function badFact(f: Record<string, unknown>): string | null {
  if (typeof f.mode !== "string" || !MODE_RE.test(f.mode)) return "mode";
  if (!isBookingRef(f.ref)) return "ref";
  if (typeof f.reservationId !== "string" || !RESERVATION_ID_RE.test(f.reservationId)) return "reservationId";
  if (!isSatang(f.roomsSatang)) return "roomsSatang";
  if (!isSatang(f.feeSatang)) return "feeSatang";
  if (!isSatang(f.totalSatang) || (f.roomsSatang as number) + (f.feeSatang as number) !== f.totalSatang) return "totalSatang";
  if (!isIsoDate(f.checkIn)) return "checkIn";
  if (!isIsoDate(f.checkOut)) return "checkOut";
  if (!isPayMethod(f.payMethod)) return "payMethod";
  if (!(f.termsVersion === null || (typeof f.termsVersion === "string" && TERMS_VERSION_RE.test(f.termsVersion)))) return "termsVersion";
  for (const flag of ["arrivalLate", "hasRequests", "noteSaved"]) if (!isFlag(f[flag])) return flag;
  if (!isEpochMs(f.expiresAt)) return "expiresAt";
  return null;
}

/** The first field of a record that is malformed; null for a well-formed PaymentRecord. */
function badRecordField(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "record";
  const r = value as Record<string, unknown>;
  if (r.v !== 1) return "v";
  if (!isBeamLinkId(r.linkId)) return "linkId";
  if (typeof r.merchantId !== "string" || !MERCHANT_ID_RE.test(r.merchantId)) return "merchantId";
  if (!isEpochMs(r.createdAt)) return "createdAt";
  return badFact(r);
}

export function isPaymentRecord(value: unknown): value is PaymentRecord {
  return badRecordField(value) === null;
}

/** Exactly the record's own fields, in a fixed order (nothing a caller added comes along). */
function recordOf(r: PaymentRecord): PaymentRecord {
  return {
    v: 1,
    linkId: r.linkId,
    ref: r.ref,
    reservationId: r.reservationId,
    roomsSatang: r.roomsSatang,
    feeSatang: r.feeSatang,
    totalSatang: r.totalSatang,
    payMethod: r.payMethod,
    checkIn: r.checkIn,
    checkOut: r.checkOut,
    mode: r.mode,
    merchantId: r.merchantId,
    arrivalLate: r.arrivalLate,
    hasRequests: r.hasRequests,
    noteSaved: r.noteSaved,
    termsVersion: r.termsVersion,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  };
}

/**
 * Writes a link's record (keys.beamPayment, BEAM_RECORD_TTL_SECONDS). Only the record's own fields are stored.
 * Throws RangeError on a malformed record (nothing is written) and whatever Redis throws.
 */
export async function writeRecord(kv: KvStore, record: PaymentRecord): Promise<void> {
  const bad = badRecordField(record);
  if (bad !== null) throw new RangeError(`Beam payment record: invalid ${bad}`);
  await writeJson(kv, keys.beamPayment(record.linkId), recordOf(record), BEAM_RECORD_TTL_SECONDS);
}

/**
 * A link's record; null when Redis has none, or only an unreadable or malformed one, or one written for another
 * link (the caller then falls back to the signed note). Throws when Redis fails, so an outage never reads as a
 * missing record.
 */
export async function readRecord(kv: KvStore, linkId: string): Promise<PaymentRecord | null> {
  if (!isBeamLinkId(linkId)) return null;
  const raw = await readJson<unknown>(kv, keys.beamPayment(linkId));
  if (!isPaymentRecord(raw) || raw.linkId !== linkId) return null;
  return recordOf(raw);
}

/** The shared core's PaymentMeta of a record, or of a verified note. */
export function recordToMeta(record: BeamNote): PaymentMeta {
  return {
    ref: record.ref,
    reservationId: record.reservationId,
    roomsSatang: record.roomsSatang,
    feeSatang: record.feeSatang,
    totalSatang: record.totalSatang,
    checkIn: record.checkIn,
    checkOut: record.checkOut,
    mode: record.mode,
    arrivalLate: record.arrivalLate,
    hasRequests: record.hasRequests,
    noteSaved: record.noteSaved,
    termsVersion: record.termsVersion,
  };
}

/* ------------------------------- the signed note ------------------------------- */

function noteSignature(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64url").slice(0, SIGNATURE_LENGTH);
}

const flagChar = (f: boolean | null): string => (f === true ? "1" : f === false ? "0" : "-");
const charFlag = (c: string): boolean | null => (c === "1" ? true : c === "0" ? false : null);

/**
 * The signed, PII-free internalNote of a link (sent verbatim: buildPaymentLinkRequest never clips it). Only
 * the note's own fields are read from `note`. Throws RangeError on a malformed fact or an empty secret.
 */
export function buildBeamNote(note: BeamNote, secret: string): string {
  const bad = badFact(note as unknown as Record<string, unknown>);
  if (bad !== null) throw new RangeError(`Beam note: invalid ${bad}`);
  if (typeof secret !== "string" || secret === "") throw new RangeError("Beam note: a signing secret is required");
  const values: Record<NoteField, string> = {
    m: note.mode,
    r: note.ref,
    res: note.reservationId,
    rm: String(note.roomsSatang),
    fee: String(note.feeSatang),
    tot: String(note.totalSatang),
    ci: note.checkIn,
    co: note.checkOut,
    pm: note.payMethod,
    tv: note.termsVersion ?? "",
    fl: [note.arrivalLate, note.hasRequests, note.noteSaved].map(flagChar).join(""),
    ex: String(note.expiresAt),
  };
  const body = [BEAM_NOTE_VERSION, ...NOTE_FIELDS.map((k) => `${k}=${values[k]}`)].join("|");
  const text = `${body}|s=${noteSignature(body, secret)}`;
  if (text.length > BEAM_NOTE_MAX_LENGTH) throw new RangeError(`Beam note: longer than ${BEAM_NOTE_MAX_LENGTH} characters`);
  return text;
}

/** The facts of a note we signed with this secret; null for anything else, and on any change to it. */
export function verifyBeamNote(note: unknown, secret: string): BeamNote | null {
  if (typeof note !== "string" || note.length > BEAM_NOTE_MAX_LENGTH || typeof secret !== "string" || secret === "") return null;
  const at = note.lastIndexOf("|s=");
  if (at < 0) return null;
  const body = note.slice(0, at);
  const given = Buffer.from(note.slice(at + 3), "utf8");
  const expected = Buffer.from(noteSignature(body, secret), "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  const parts = body.split("|");
  if (parts.length !== NOTE_FIELDS.length + 1 || parts[0] !== BEAM_NOTE_VERSION) return null;
  const v = {} as Record<NoteField, string>;
  for (const [i, field] of NOTE_FIELDS.entries()) {
    const part = parts[i + 1];
    if (!part.startsWith(`${field}=`)) return null;
    v[field] = part.slice(field.length + 1);
  }
  const int = (s: string): number => (DECIMAL_RE.test(s) ? Number(s) : NaN);
  if (!FLAGS_RE.test(v.fl)) return null;
  const facts: BeamNote = {
    ref: v.r,
    reservationId: v.res,
    roomsSatang: int(v.rm),
    feeSatang: int(v.fee),
    totalSatang: int(v.tot),
    payMethod: v.pm as BeamMethodGroup,
    checkIn: v.ci,
    checkOut: v.co,
    mode: v.m,
    arrivalLate: charFlag(v.fl[0]),
    hasRequests: charFlag(v.fl[1]),
    noteSaved: charFlag(v.fl[2]),
    termsVersion: v.tv === "" ? null : v.tv,
    expiresAt: int(v.ex),
  };
  return badFact(facts as unknown as Record<string, unknown>) === null ? facts : null;
}

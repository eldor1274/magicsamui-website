// The support index of Beam payment attempts, read by the WhatsApp bot's payment lookup (supportLookup.ts,
// POST /api/support/payment-lookup). Server only (node:crypto).
//
// Why: the bot used to read Stripe to tell a guest why a payment failed. A Beam API key can create payment links and
// refunds (Beam keys have no read-only scope), so the bot never gets one: it asks our site instead, and our site needs
// to find a guest's attempts by the email address or phone number the guest gives the bot.
//
// What is written (Beam only: the Beam checkout adapter calls writeSupportIndex once the payment link exists and its
// PaymentRecord is written; no Stripe code path writes or reads any of it):
// - keys.beamSupportRef(scope, ref) -> BeamSupportEntry {ref, linkId, at, rooms}: lets a lookup by booking ref work
//   after the 48-hour msv:booking:{ref} pointer is gone, and names the rooms.
// - keys.beamSupportContact(scope, "email" | "phone", code) -> BeamSupportEntry[] (newest first, at most
//   SUPPORT_INDEX_MAX_ENTRIES), one key for the email address and one to three for the phone number (supportPhoneForms).
//   `code` is supportCode: HMAC-SHA256 under BOOKING_TOKEN_SECRET of the normalised value, so Redis never holds an email
//   address or phone number, and a copy of the database can't be reversed by trying every phone number without the
//   secret. Rotating BOOKING_TOKEN_SECRET only makes the older entries unfindable by email or phone.
// - Every key lives SUPPORT_INDEX_TTL_SECONDS (30 days) from its last write; the scope is keyScope(mode), so Stage B
//   (beam-playground) entries are never answered on production (beam-live) and the reverse.
// Entries carry booking facts only (ref, Beam link id, time, room slugs): no name, email address, phone number or card
// detail. Two checkouts by one guest in the same instant may keep only one of the two entries (read, then write): the
// index is a support aid, never part of the money path.

import { createHmac } from "node:crypto";
import type { KvStore } from "../kv.ts";
import { keyScope, keys } from "../lock.ts";
import { isBookingRef } from "../ref.ts";
import { isBeamLinkId } from "./beamIds.ts";

/** How long an index key lives after its last write. */
export const SUPPORT_INDEX_TTL_SECONDS = 30 * 24 * 3600;
/** Attempts kept per email address or phone number (newest first). */
export const SUPPORT_INDEX_MAX_ENTRIES = 10;
/** How long the checkout waits for the index write before it goes on without it (the write keeps running). */
export const SUPPORT_INDEX_WAIT_MS = 750;
/** The checkout skips the index when less than this is left of its deadline (its own last steps come first). */
export const SUPPORT_INDEX_MIN_REMAINING_MS = 3_000;

const ROOM_SLUG_RE = /^[a-z0-9-]{1,40}$/;
const MAX_ROOMS = 6;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL_LENGTH = 254;
/** E.164: at most 15 digits; 8 is the shortest number worth looking up. */
const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;
const THAI_CODE = "66";

/** One Beam payment attempt in the support index (no personal data). */
export interface BeamSupportEntry {
  v: 1;
  ref: string;
  /** Beam's paymentLinkId. */
  linkId: string;
  /** When the link was created (epoch ms): the PaymentRecord's createdAt. */
  at: number;
  /** The catalogue slugs of the rooms booked (e.g. "honeymoon-suite"). */
  rooms: string[];
}

/** What the checkout adapter hands writeSupportIndex: the entry and the one-way codes of the guest's contacts. */
export interface SupportIndexWrite {
  mode: string;
  entry: BeamSupportEntry;
  /** supportCode("email", ...) of the normalised email address; null when it can't be normalised. */
  emailCode: string | null;
  /** supportCode("phone", ...) of each of supportPhoneForms. */
  phoneCodes: string[];
}

export function isSupportEntry(v: unknown): v is BeamSupportEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    e.v === 1 &&
    isBookingRef(e.ref) &&
    isBeamLinkId(e.linkId) &&
    Number.isSafeInteger(e.at) &&
    (e.at as number) > 0 &&
    Array.isArray(e.rooms) &&
    e.rooms.length <= MAX_ROOMS &&
    e.rooms.every((r) => typeof r === "string" && ROOM_SLUG_RE.test(r))
  );
}

/** Exactly an entry's own fields (nothing a caller added comes along). */
function entryOf(e: BeamSupportEntry): BeamSupportEntry {
  return { v: 1, ref: e.ref, linkId: e.linkId, at: e.at, rooms: [...e.rooms] };
}

/** An entry for a link just created; null when a fact is malformed (nothing is then indexed). */
export function supportEntry(ref: string, linkId: string, at: number, roomSlugs: readonly string[]): BeamSupportEntry | null {
  const rooms = [...new Set(roomSlugs)].filter((s) => typeof s === "string" && ROOM_SLUG_RE.test(s)).slice(0, MAX_ROOMS);
  const entry: BeamSupportEntry = { v: 1, ref, linkId, at, rooms };
  return isSupportEntry(entry) ? entry : null;
}

/** An email address as it is indexed and looked up: NFKC, trimmed, lower case; null when it is not one. */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.normalize("NFKC").trim().toLowerCase();
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(email) ? email : null;
}

/**
 * A phone number as the lookup reads it, in international digits without '+' ("66952466011"); null when it is not one.
 * "+66 95 246 6011", "0066952466011", "66952466011" (a WhatsApp number) and the Thai national "095 246 6011" all read
 * "66952466011": a leading '+' or "00" is the international prefix, a single leading 0 is a Thai national number
 * (owner's guests: the bot is on a Thai WhatsApp number), and the trunk 0 after 66 ("+66 095...") is dropped.
 */
export function lookupPhoneDigits(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.normalize("NFKC").trim();
  if (s.length > 32 || !/^\+?[\d\s().-]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  let intl: string;
  if (s.startsWith("+")) intl = digits;
  else if (digits.startsWith("00")) intl = digits.slice(2);
  else if (digits.startsWith("0")) intl = `${THAI_CODE}${digits.slice(1)}`;
  else intl = digits;
  if (intl.startsWith(`${THAI_CODE}0`)) intl = `${THAI_CODE}${intl.slice(THAI_CODE.length + 1)}`;
  return intl.length >= MIN_PHONE_DIGITS && intl.length <= MAX_PHONE_DIGITS && !intl.startsWith("0") ? intl : null;
}

/**
 * Every form a guest's phone (the booking form's dial code and number as typed) is indexed under, each as
 * lookupPhoneDigits would read it, so the bot's lookup finds it however the guest typed it: the dial code with the
 * number as typed ("+44" "07700 900123" -> 4407700900123), with its trunk zeros dropped (-> 447700900123, the WhatsApp
 * form), and the number alone when the guest typed it internationally ("0044...", or the dial code repeated). At most 3.
 */
export function supportPhoneForms(dialCode: unknown, phone: unknown): string[] {
  if (typeof dialCode !== "string" || typeof phone !== "string") return [];
  const dial = dialCode.replace(/\D/g, "");
  const national = phone.replace(/\D/g, "");
  if (dial === "" || national === "") return [];
  const candidates = [`+${dial}${national}`, `+${dial}${national.replace(/^0+/, "")}`];
  if (national.startsWith("00")) candidates.push(`+${national.slice(2)}`);
  if (national.startsWith(dial) && national.length >= dial.length + MIN_PHONE_DIGITS) candidates.push(`+${national}`);
  const forms: string[] = [];
  for (const c of candidates) {
    const form = lookupPhoneDigits(c);
    if (form !== null && !forms.includes(form)) forms.push(form);
  }
  return forms.slice(0, 3);
}

/**
 * The one-way code a normalised email address, phone number or client IP is indexed under: base64url
 * HMAC-SHA256(BOOKING_TOKEN_SECRET, 'msv-support-v1|{kind}|{value}'), 43 characters. Throws on an empty secret.
 */
export function supportCode(secret: string, kind: "email" | "phone" | "ip", value: string): string {
  if (typeof secret !== "string" || secret === "") throw new RangeError("support code: a secret is required");
  return createHmac("sha256", secret).update(`msv-support-v1|${kind}|${value}`, "utf8").digest("base64url");
}

/** The index write for a guest's contact details (the raw values are hashed here and never kept). */
export function supportIndexWrite(
  mode: string,
  secret: string,
  entry: BeamSupportEntry,
  guest: { email?: unknown; dialCode?: unknown; phone?: unknown },
): SupportIndexWrite {
  const email = normaliseEmail(guest.email);
  return {
    mode,
    entry,
    emailCode: email === null ? null : supportCode(secret, "email", email),
    phoneCodes: supportPhoneForms(guest.dialCode, guest.phone).map((form) => supportCode(secret, "phone", form)),
  };
}

/** A contact key's entries (newest first); [] when it is missing or unreadable. Throws when Redis fails. */
export async function readSupportList(kv: Pick<KvStore, "get">, key: string): Promise<BeamSupportEntry[]> {
  const raw = await kv.get(key);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter(isSupportEntry).map(entryOf) : [];
}

/** A ref's entry; null when it is missing, unreadable or another ref's. Throws when Redis fails. */
export async function readSupportRef(kv: Pick<KvStore, "get">, scope: string, ref: string): Promise<BeamSupportEntry | null> {
  if (!isBookingRef(ref)) return null;
  const raw = await kv.get(keys.beamSupportRef(scope, ref));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSupportEntry(parsed) && parsed.ref === ref ? entryOf(parsed) : null;
  } catch {
    return null;
  }
}

/** Adds the entry at the front of a contact key's list (the same ref once), capped, with a fresh TTL. */
async function prepend(kv: Pick<KvStore, "get" | "set">, key: string, entry: BeamSupportEntry): Promise<void> {
  const list = (await readSupportList(kv, key)).filter((e) => e.ref !== entry.ref);
  const next = [entryOf(entry), ...list].sort((a, b) => b.at - a.at).slice(0, SUPPORT_INDEX_MAX_ENTRIES);
  await kv.set(key, JSON.stringify(next), SUPPORT_INDEX_TTL_SECONDS);
}

/**
 * Writes the ref entry and the contact lists (in parallel). Throws whatever Redis throws, after every write was
 * tried (the first failure): the checkout adapter catches it, logs it without personal data and goes on.
 */
export async function writeSupportIndex(kv: Pick<KvStore, "get" | "set">, write: SupportIndexWrite): Promise<void> {
  const scope = keyScope(write.mode);
  const { entry } = write;
  if (!isSupportEntry(entry)) throw new RangeError("support index: malformed entry");
  const contactKeys = [
    ...(write.emailCode !== null ? [keys.beamSupportContact(scope, "email", write.emailCode)] : []),
    ...write.phoneCodes.map((code) => keys.beamSupportContact(scope, "phone", code)),
  ];
  const results = await Promise.allSettled([
    kv.set(keys.beamSupportRef(scope, entry.ref), JSON.stringify(entryOf(entry)), SUPPORT_INDEX_TTL_SECONDS),
    ...contactKeys.map((key) => prepend(kv, key, entry)),
  ]);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

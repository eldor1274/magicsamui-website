// The WhatsApp bot's payment lookup (POST /api/support/payment-lookup): what happened to a guest's Beam payment and
// what the guest should do next, in words the bot can relay. Read-only. Server only.
//
// Why: the owner's WhatsApp bot (whatsapp-cloud-bot on the droplet) used to read Stripe to tell a guest why a payment
// failed. Payments now go through Beam, and a Beam API key can create payment links and refunds (Beam keys have no
// read-only scope), so the bot never gets one: it asks this route, which reads Beam on the server.
//
// Security model
// - Authorization: Bearer <BOT_LOOKUP_SECRET> only (bearerMatches: constant time, never from the query string).
//   BOT_LOOKUP_SECRET unset or shorter than 32 characters: 503 not_configured for every request (logged by name, never
//   the value, once per server instance); a wrong or missing token: 401, counted and logged per server instance
//   (support_lookup_unauthorized: the count and whether an Authorization header came, never its contents). Nothing is
//   read before the token matches.
// - Rate limits in Redis (fixed one-minute windows): SUPPORT_LOOKUP_IP_LIMIT per client IP (a keyed one-way code of
//   it, never the IP) and SUPPORT_LOOKUP_GLOBAL_LIMIT in all, 429 with Retry-After. JSON bodies only (415), at most
//   SUPPORT_LOOKUP_MAX_BODY_BYTES (413), exactly one of ref / email / phone, or email and ref together (400).
// - Read-only: Redis reads, and two Beam reads per attempt for the newest SUPPORT_LOOKUP_BEAM_READS attempts only (the
//   link and its charges, through the Beam gateway's side-effect-free readLink, inside the route's deadline); older
//   attempts answer from our own markers. Nothing is confirmed, released, disabled, refunded or alerted from here; the
//   only writes are the two rate-limit counters (and the runtime's Beam 429 counter). No cache: a reading even 30 s old
//   could still say "failed" while the guest's next try on the same page is already pending.
// - The answer carries booking facts only: no guest name, email address or phone number, no card digits (beam.ts
//   drops them when a charge is read; a failureCode not in Beam's code shape is answered as null). A lookup that finds
//   nothing says only "no recent payment attempt found", whether or not the address or number was ever used.
// - Who learns what: a ref, the sender's own phone number (the bot's rule: never a number typed in a message), or an
//   email address together with a ref of that email's attempts get the full answer. An email address alone gets only
//   how many attempts it has (detailsWithheld, payAgainSafe false), never a state, reason or code: anyone can type
//   someone else's email address, so the bot asks for the booking ref first.
// - Beam only: a Stripe booking's ref answers notBeam (the bot keeps its Stripe lookup for those); no Stripe call.
//
// Finding the attempts
// - ref: the msv:booking:{ref} pointer (48 hours), else the support index's ref entry (30 days).
// - email / phone: the support index (payments/beamSupport.ts), written at Beam checkout under a keyed one-way code of
//   the normalised value (email: trimmed, lower case; phone: international digits, a Thai national 0 read as 66).
// - email + ref: the email's attempts when the ref is one of them (the ref always among those answered), else the
//   ref's own attempt, exactly as a ref lookup finds it.
// - At most SUPPORT_LOOKUP_MAX_MATCHES attempts, newest first.
//
// The state of each attempt (first match wins)
// - Fulfil's done marker: confirmed (the Cloudbeds reservation is confirmed), refunded (refunded before confirmation),
//   needs_attention. No Beam call.
// - An attempt older than the newest SUPPORT_LOOKUP_BEAM_READS (the attempt a query's ref names is always read): paid
//   while fulfil's paid marker is there; expired once its window, the pending grace and BEAM_PENDING_BLOCK_MS are over
//   (a Beam reading could then say nothing else unless a late payment came, which the sweeper's late watch turns into
//   a paid or done marker); else unknown. No Beam call.
// - Else the Beam link and its charges (payments/beamState.ts): a link that disagrees with our record -> needs_attention;
//   paid -> paid (being confirmed), or needs_attention when the hold was already released; refunded; processing (a
//   charge waiting for the bank or wallet; also once the window is over while it is still unconfirmed); open, or failed
//   when its latest charge FAILED; expired, or failed when its latest charge FAILED. A Beam or Redis read that fails
//   -> unknown. An ACTIVE link past its expiry that Beam has not closed yet (needsDisable) adds "Please don't use the
//   old payment page" and is never retrySafe until it reads EXPIRED or DISABLED.
// - retrySafe only for open, failed and expired: never while a PENDING PromptPay, wallet or 3-D Secure charge may still
//   succeed, and never once money was taken.
// - payAgainSafe (the whole answer: what the bot goes by): no returned attempt is processing, paid, needs_attention or
//   unknown. While it is false, every open, failed and expired attempt says "don't pay again" instead (naming the
//   attempts still being settled) and is not retrySafe: a failed card next to a PromptPay payment still pending must
//   never be paid again. Confirmed, refunded, expired and failed attempts of other bookings never block it.

import { bearerMatches } from "../bearerAuth.ts";
import { parseBeamTime } from "./beam.ts";
import type { BeamCharge } from "./beam.ts";
import { getCatalogueRoom } from "./catalogue.ts";
import { formatThb } from "./format.ts";
import type { FulfilDone } from "./fulfil.ts";
import { beamKeyOf, keyScope, keys, linkIdOf, readJson } from "./lock.ts";
import type { BookingPointer } from "./lock.ts";
import { beamGateway } from "./payments/beamGateway.ts";
import type { BeamGateway, BeamGatewayDeps, BeamLinkRead } from "./payments/beamGateway.ts";
import { readRecord } from "./payments/beamRecord.ts";
import type { BeamNote, PaymentRecord } from "./payments/beamRecord.ts";
import { BEAM_PENDING_BLOCK_MS } from "./payments/beamState.ts";
import { lookupPhoneDigits, normaliseEmail, readSupportList, readSupportRef, supportCode } from "./payments/beamSupport.ts";
import { feePctFor, isPayMethod, payMethodOffered } from "./quote.ts";
import { BOOKING_REF_RE } from "./ref.ts";
import { NO_STORE, clientIp, readJsonBody } from "./routeUtils.ts";
import { nowOf } from "./stripeDeps.ts";
import type { PayMethod } from "./types.ts";

/** BOT_LOOKUP_SECRET must be at least this long, else the route answers 503 not_configured. */
export const BOT_LOOKUP_SECRET_MIN_LENGTH = 32;
/** Requests per client IP per window (the bot is one IP: at most 10 lookups, so 60 Beam GETs, a minute). */
export const SUPPORT_LOOKUP_IP_LIMIT = 10;
/** Requests in all per window (every client together). */
export const SUPPORT_LOOKUP_GLOBAL_LIMIT = 20;
export const SUPPORT_LOOKUP_WINDOW_SECONDS = 60;
export const SUPPORT_LOOKUP_MAX_BODY_BYTES = 2_048;
export const SUPPORT_LOOKUP_MAX_MATCHES = 5;
/** Attempts per lookup whose Beam link is read (the newest; the one a query's ref names always is): two Beam GETs each. */
export const SUPPORT_LOOKUP_BEAM_READS = 3;
/** Beam's failureCode shape (CH_CARD_DECLINED); anything else is answered as null. */
const FAILURE_CODE_RE = /^[A-Z0-9_]{1,64}$/i;
/** Every Beam call of a lookup ends by this long after the request arrived (the route's maxDuration is 15 s). */
export const SUPPORT_LOOKUP_BEAM_BUDGET_MS = 8_000;

/** Where a guest books again. */
const BOOKING_PAGE = "magicsamui.com/booking";

export type LookupState = "open" | "processing" | "paid" | "confirmed" | "expired" | "refunded" | "failed" | "needs_attention" | "unknown";

/** The states that make paying again unsafe for every attempt of the same answer (payAgainSafe false). */
const PAY_AGAIN_BLOCKERS: ReadonlySet<LookupState> = new Set<LookupState>(["processing", "paid", "needs_attention", "unknown"]);

/** One payment attempt, as the bot relays it (no personal data). */
export interface LookupMatch {
  ref: string;
  /** When the payment page was created (ISO), when known. */
  createdAt: string | null;
  checkIn: string | null;
  checkOut: string | null;
  /** The rooms booked, by their public names ([] when unknown). */
  units: string[];
  /** The amount of the payment page in satang, and as shown ("41,715.00"). */
  totalSatang: number | null;
  total: string | null;
  currency: "THB";
  /** The method group the guest chose on our page. */
  payMethod: PayMethod | null;
  state: LookupState;
  /** Beam's failureCode of the latest charge (state failed only), e.g. CH_CARD_DECLINED; null unless it matches /^[A-Z0-9_]{1,64}$/i. */
  failureCode: string | null;
  /** What happened, in one or two plain sentences for the guest. */
  reason: string;
  /** What the guest should do next. */
  nextStep: string;
  /** The Cloudbeds reservation was confirmed (fulfil's done marker). */
  cloudbedsConfirmed: boolean;
  /**
   * Paying again (on the page, or by booking again) can't charge the guest twice for this attempt. false while the
   * answer's payAgainSafe is false, and for a link Beam has not closed yet past its expiry.
   */
  retrySafe: boolean;
  /** Beam's payment page is still open for this attempt. */
  paymentPageOpen: boolean;
}

export interface LookupAnswer {
  ok: true;
  lookup: LookupQuery["kind"];
  found: number;
  matches: LookupMatch[];
  /**
   * What the bot goes by: true when no returned attempt is processing, paid, needs_attention or unknown, so paying
   * again can't charge the guest twice (also true when nothing is found). false on an email-only answer that found
   * attempts (detailsWithheld: they were not checked).
   */
  payAgainSafe: boolean;
  /** An email-only lookup that found attempts: no details until the guest gives the booking ref (then look up email + ref). */
  detailsWithheld?: true;
  /** A Stripe booking's ref: not a Beam payment (look it up in Stripe). */
  notBeam?: true;
  /** Present when nothing is found, or when the details are withheld. */
  message?: string;
  checkedAt: string;
}

export type LookupQuery =
  | { kind: "ref"; value: string }
  | { kind: "email"; value: string }
  | { kind: "phone"; value: string }
  /** An email address (value) with a booking ref (ref): the full answer for that email's attempts when the ref is one of them. */
  | { kind: "email_ref"; value: string; ref: string };

export const NOTHING_FOUND_MESSAGE = "No recent payment attempt found.";
export const NOT_BEAM_MESSAGE = "This booking was not paid through Beam (an older Stripe booking): look it up in Stripe.";
export const DETAILS_WITHHELD_MESSAGE =
  "Recent payment attempts were found for this email address. Their details are shared only with the booking reference (MSV-YYYYMMDD-XXXX, shown on our booking page after the payment step): ask the guest for it, then look up the email and the ref together.";

/** Per server instance (the route keeps one): whether "unconfigured" was logged, and the rejected tokens counted. */
export interface LookupInstanceState {
  unconfiguredLogged: boolean;
  unauthorized: number;
}

export function lookupInstanceState(): LookupInstanceState {
  return { unconfiguredLogged: false, unauthorized: 0 };
}

export interface PaymentLookupDeps {
  /** The Beam deps that finish Beam payments (runtime.ts getBeamFulfilmentDeps with the route's deadline); null without a Beam config. */
  beamDeps: () => BeamGatewayDeps | null;
  log: (message: string, data?: Record<string, unknown>) => void;
  /** This server instance's state (the route's module-level one). Absent: a fresh one for each request. */
  instance?: LookupInstanceState;
}

function answer(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

const errorName = (e: unknown): string => (e instanceof Error ? e.name : "unknown");

/** The request body as a query: exactly one of ref, email or phone, or email and ref together, each normalised; null otherwise. */
export function parseLookupQuery(body: unknown): LookupQuery | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const fields = Object.entries(body as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (fields.length === 0 || fields.length > 2) return null;
  const values = new Map<string, string>();
  for (const [name, raw] of fields) {
    if (typeof raw !== "string" || raw.length > 256) return null;
    values.set(name, raw);
  }
  const rawRef = values.get("ref");
  const upper = rawRef === undefined ? null : rawRef.trim().toUpperCase();
  const ref = upper !== null && BOOKING_REF_RE.test(upper) ? upper : null;
  const email = values.has("email") ? normaliseEmail(values.get("email")) : null;
  switch ([...values.keys()].sort().join(",")) {
    case "ref":
      return ref === null ? null : { kind: "ref", value: ref };
    case "email":
      return email === null ? null : { kind: "email", value: email };
    case "phone": {
      const phone = lookupPhoneDigits(values.get("phone"));
      return phone === null ? null : { kind: "phone", value: phone };
    }
    case "email,ref":
      return email === null || ref === null ? null : { kind: "email_ref", value: email, ref };
    default:
      return null;
  }
}

/** POST /api/support/payment-lookup (see the header). `env` is process.env in production. */
export async function handlePaymentLookup(request: Request, env: Record<string, string | undefined>, deps: PaymentLookupDeps): Promise<Response> {
  const instance = deps.instance ?? lookupInstanceState();
  const secret = (env.BOT_LOOKUP_SECRET ?? "").trim();
  const authorised = bearerMatches(request, [secret]);
  if (secret.length < BOT_LOOKUP_SECRET_MIN_LENGTH) {
    // Once per instance: every scanner's request would log it again.
    if (!instance.unconfiguredLogged) {
      instance.unconfiguredLogged = true;
      deps.log("support_lookup_unconfigured", { reason: secret === "" ? "BOT_LOOKUP_SECRET unset" : `BOT_LOOKUP_SECRET shorter than ${BOT_LOOKUP_SECRET_MIN_LENGTH} characters` });
    }
    return answer(503, { ok: false, error: "not_configured", message: "The payment lookup is not configured." });
  }
  if (!authorised) {
    // Counted, so attempts to guess the secret show; nothing of the header itself is logged.
    instance.unauthorized++;
    deps.log("support_lookup_unauthorized", { count: instance.unauthorized, header: request.headers.has("authorization") ? "present" : "missing" });
    return answer(401, { ok: false, error: "unauthorized", message: "Unauthorized." });
  }

  let beam: BeamGatewayDeps | null;
  try {
    beam = deps.beamDeps();
  } catch {
    beam = null;
  }
  if (!beam) {
    deps.log("support_lookup_unavailable", { reason: "no Beam config" });
    return answer(503, { ok: false, error: "beam_unavailable", message: "Beam is not configured on this deployment." });
  }

  const scope = keyScope(beam.config.paymentMode);
  try {
    const ipCode = supportCode(beam.config.tokenSecret, "ip", clientIp(request));
    const perClient = await beam.kv.incr(keys.beamSupportRate(scope, `ip:${ipCode}`), SUPPORT_LOOKUP_WINDOW_SECONDS);
    const limited = perClient > SUPPORT_LOOKUP_IP_LIMIT || (await beam.kv.incr(keys.beamSupportRate(scope, "all"), SUPPORT_LOOKUP_WINDOW_SECONDS)) > SUPPORT_LOOKUP_GLOBAL_LIMIT;
    if (limited) {
      deps.log("support_lookup_rate_limited");
      return answer(
        429,
        { ok: false, error: "rate_limited", message: "Too many lookups - try again in a minute.", retryAfterSeconds: SUPPORT_LOOKUP_WINDOW_SECONDS },
        { "Retry-After": String(SUPPORT_LOOKUP_WINDOW_SECONDS) },
      );
    }
  } catch (e) {
    deps.log("support_lookup_failed", { step: "rate_limit", error: errorName(e) });
    return answer(503, { ok: false, error: "unavailable", message: "The payment lookup is unavailable right now. Try again in a minute." });
  }

  const body = await readJsonBody(request, SUPPORT_LOOKUP_MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const query = parseLookupQuery(body.value);
  if (!query) {
    return answer(400, {
      ok: false,
      error: "invalid_request",
      message: 'Send exactly one of {"ref": "MSV-YYYYMMDD-XXXX"}, {"email": "..."} or {"phone": "+66..."}, or {"email": "...", "ref": "MSV-YYYYMMDD-XXXX"}.',
    });
  }

  const startedMs = Date.now();
  try {
    const result = await lookupPayments(query, beam);
    deps.log("support_lookup", {
      by: query.kind,
      found: result.found,
      states: result.matches.map((m) => m.state),
      payAgainSafe: result.payAgainSafe,
      ...(result.detailsWithheld ? { detailsWithheld: true } : {}),
      ...(result.notBeam ? { notBeam: true } : {}),
      ms: Date.now() - startedMs,
    });
    return answer(200, result);
  } catch (e) {
    deps.log("support_lookup_failed", { by: query.kind, step: "lookup", error: errorName(e) });
    return answer(503, { ok: false, error: "unavailable", message: "The payment lookup is unavailable right now. Try again in a minute." });
  }
}

/* ------------------------------------------------ the lookup ------------------------------------------------ */

/** An attempt to describe: its ref and link, and what the support index knows (creation time, rooms). */
interface Candidate {
  ref: string;
  linkId: string;
  at: number | null;
  rooms: string[];
}

interface LookupContext {
  beam: BeamGatewayDeps;
  gw: BeamGateway;
  mode: string;
  nowMs: number;
}

/** A contact's attempts in the support index: newest first, each ref once (all of them: the caller caps them). */
async function contactCandidates(beam: BeamGatewayDeps, scope: string, kind: "email" | "phone", value: string, nowMs: number): Promise<Candidate[]> {
  const code = supportCode(beam.config.tokenSecret, kind, value);
  const seen = new Set<string>();
  return (await readSupportList(beam.kv, keys.beamSupportContact(scope, kind, code), nowMs))
    .sort((a, b) => b.at - a.at)
    .filter((e) => (seen.has(e.ref) ? false : (seen.add(e.ref), true)))
    .map((e) => ({ ref: e.ref, linkId: e.linkId, at: e.at, rooms: e.rooms }));
}

/** The attempts a query names and their answers, newest first. Throws when the index or pointer can't be read. */
export async function lookupPayments(query: LookupQuery, beam: BeamGatewayDeps): Promise<LookupAnswer> {
  const mode = beam.config.paymentMode;
  const scope = keyScope(mode);
  const nowMs = nowOf(beam);
  const checkedAt = new Date(nowMs).toISOString();
  const nothing = (extra: Partial<LookupAnswer> = {}): LookupAnswer => ({
    ok: true,
    lookup: query.kind,
    found: 0,
    matches: [],
    payAgainSafe: true,
    message: NOTHING_FOUND_MESSAGE,
    ...extra,
    checkedAt,
  });

  // An email address alone: how many attempts, nothing more (anyone can type someone else's address). No Beam call.
  if (query.kind === "email") {
    const found = Math.min((await contactCandidates(beam, scope, "email", query.value, nowMs)).length, SUPPORT_LOOKUP_MAX_MATCHES);
    if (found === 0) return nothing();
    return { ok: true, lookup: "email", found, matches: [], payAgainSafe: false, detailsWithheld: true, message: DETAILS_WITHHELD_MESSAGE, checkedAt };
  }

  /** The ref the query names: always among the attempts read live. */
  const named = query.kind === "ref" ? query.value : query.kind === "email_ref" ? query.ref : null;
  let candidates: Candidate[] = [];
  if (query.kind === "phone") {
    candidates = (await contactCandidates(beam, scope, "phone", query.value, nowMs)).slice(0, SUPPORT_LOOKUP_MAX_MATCHES);
  } else if (query.kind === "email_ref") {
    // The email's attempts, only when the ref is one of them (the ref then always among those answered).
    const own = await contactCandidates(beam, scope, "email", query.value, nowMs);
    const mine = own.find((c) => c.ref === query.ref);
    if (mine) {
      candidates = own.slice(0, SUPPORT_LOOKUP_MAX_MATCHES);
      if (!candidates.includes(mine)) candidates[SUPPORT_LOOKUP_MAX_MATCHES - 1] = mine;
    }
  }
  if (named !== null && candidates.length === 0) {
    // The ref's own attempt (also for an email + ref whose email is not that booking's: no more than the ref alone answers).
    const [pointer, entry] = await Promise.all([readJson<BookingPointer>(beam.kv, keys.booking(named)), readSupportRef(beam.kv, scope, named, nowMs)]);
    const sessionId = typeof pointer?.sessionId === "string" ? pointer.sessionId : null;
    // A Stripe Checkout Session (cs_test_..., cs_live_...): never a Beam key, so no Beam call and no Stripe call.
    if (sessionId !== null && sessionId.startsWith("cs_")) return nothing({ notBeam: true, message: NOT_BEAM_MESSAGE });
    const linkId = (sessionId !== null ? linkIdOf(sessionId) : null) ?? entry?.linkId ?? null;
    candidates = linkId === null ? [] : [{ ref: named, linkId, at: entry?.linkId === linkId ? entry.at : null, rooms: entry?.linkId === linkId ? entry.rooms : [] }];
  }
  if (candidates.length === 0) return nothing();

  // Beam is read for the newest SUPPORT_LOOKUP_BEAM_READS attempts, the named ref's always among them.
  const namedHere = named !== null && candidates.some((c) => c.ref === named);
  const live = new Set(
    candidates
      .map((c) => c.ref)
      .filter((ref) => ref !== named)
      .slice(0, namedHere ? SUPPORT_LOOKUP_BEAM_READS - 1 : SUPPORT_LOOKUP_BEAM_READS),
  );
  if (namedHere && named !== null) live.add(named);

  const ctx: LookupContext = { beam, gw: beamGateway(beam), mode, nowMs };
  const described = await Promise.all(candidates.map((c) => describe(c, ctx, live.has(c.ref))));
  const matches = described
    .filter((m): m is LookupMatch => m !== null)
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .slice(0, SUPPORT_LOOKUP_MAX_MATCHES);
  if (matches.length === 0) return nothing();

  // payAgainSafe: an attempt that may still take money (or has taken it) makes paying again on any other one unsafe.
  const unsettled = matches.filter((m) => PAY_AGAIN_BLOCKERS.has(m.state));
  if (unsettled.length > 0) {
    for (const m of matches) {
      if (m.state !== "open" && m.state !== "failed" && m.state !== "expired") continue;
      m.nextStep = waitForOthers(unsettled.map((u) => u.ref));
      m.retrySafe = false;
    }
  }
  return { ok: true, lookup: query.kind, found: matches.length, matches, payAgainSafe: unsettled.length === 0, checkedAt };
}

/** The link's own charge begun last (Beam lists newest first; an unreadable createdAt counts as the newest, as in beamState.ts). */
function latestCharge(read: BeamLinkRead): BeamCharge | null {
  let latest: BeamCharge | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const c of read.charges) {
    if (!c || c.source !== "PAYMENT_LINK" || c.sourceId !== read.linkId) continue;
    const ms = parseBeamTime(c.createdAt) ?? Number.POSITIVE_INFINITY;
    if (latest === null || ms > latestMs) {
      latest = c;
      latestMs = ms;
    }
  }
  return latest;
}

/** The public names of the rooms: the index's slugs, else the link's order items (whose sku is the slug). */
function unitNames(rooms: string[], read: BeamLinkRead | null): string[] {
  const slugs = rooms.length > 0 ? rooms : (read?.link?.order?.orderItems ?? []).map((i) => (typeof i?.sku === "string" ? i.sku : ""));
  const names: string[] = [];
  for (const slug of slugs) {
    const name = slug ? getCatalogueRoom(slug)?.name : undefined;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** What the link says that disagrees with our record of the booking (fulfil would hand it to the owner). */
function disagrees(read: BeamLinkRead, ref: string, record: PaymentRecord | null, merchantId: string): boolean {
  if (read.state.mismatch !== undefined) return true;
  if (read.owner && read.owner.facts.ref !== ref) return true;
  if (read.link?.order?.referenceId !== ref) return true;
  const linkMerchant = read.link?.merchantId;
  if (typeof linkMerchant === "string" && linkMerchant !== "" && linkMerchant !== merchantId) return true;
  return record !== null && record.merchantId !== merchantId;
}

interface Facts {
  ref: string;
  createdAt: number | null;
  facts: BeamNote | null;
  totalSatang: number | null;
  units: string[];
}

function matchOf(f: Facts, state: LookupState, words: { reason: string; nextStep: string }, extra: Partial<LookupMatch> = {}): LookupMatch {
  const total = f.totalSatang;
  return {
    ref: f.ref,
    createdAt: f.createdAt !== null ? new Date(f.createdAt).toISOString() : null,
    checkIn: f.facts?.checkIn ?? null,
    checkOut: f.facts?.checkOut ?? null,
    units: f.units,
    totalSatang: total,
    total: total !== null ? formatThb(total) : null,
    currency: "THB",
    payMethod: f.facts && isPayMethod(f.facts.payMethod) ? f.facts.payMethod : null,
    state,
    failureCode: null,
    reason: words.reason,
    nextStep: words.nextStep,
    cloudbedsConfirmed: false,
    retrySafe: state === "open" || state === "failed" || state === "expired",
    paymentPageOpen: false,
    ...extra,
  };
}

/**
 * One attempt's answer; null when it is not ours (another payment mode's, or a link nothing of ours names). live:
 * its Beam link may be read; otherwise it answers from our own markers only (describeStored).
 */
async function describe(c: Candidate, ctx: LookupContext, live: boolean): Promise<LookupMatch | null> {
  const { beam, gw, mode } = ctx;
  const { kv } = beam;
  const key = beamKeyOf(c.linkId);
  let record: PaymentRecord | null;
  let done: FulfilDone | null;
  let abandoned: boolean;
  try {
    [record, done, abandoned] = await Promise.all([
      readRecord(kv, c.linkId),
      readJson<FulfilDone>(kv, keys.fulfilDone(key)),
      kv.get(keys.abandoned(key)).then((v) => v !== null),
    ]);
  } catch {
    return matchOf({ ref: c.ref, createdAt: c.at, facts: null, totalSatang: null, units: unitNames(c.rooms, null) }, "unknown", WORDS.unknown);
  }
  // Another payment mode's link (a Stage B booking read on production, or the reverse), or another booking's.
  if (record && (record.mode !== mode || record.ref !== c.ref)) return null;
  const finished = done && done.ref === c.ref && (done.state === "confirmed" || done.state === "needs_attention") ? done : null;

  if (!live && !finished) return describeStored(c, ctx, record);

  // Beam is read unless the done marker settles it and the record gives the facts (a finished booking needs no Beam call).
  let read: BeamLinkRead | null = null;
  let readFailed = false;
  if (live && (!finished || !record)) {
    try {
      read = await gw.readLink(key);
    } catch {
      readFailed = true;
    }
  }
  // Neither our record nor a verified note of this mode: not ours.
  if (read && !read.owner && !record && !finished) return null;
  const facts: BeamNote | null = record ?? read?.owner?.facts ?? null;
  const f: Facts = {
    ref: c.ref,
    createdAt: record?.createdAt ?? c.at,
    facts,
    totalSatang: facts?.totalSatang ?? finished?.totalSatang ?? null,
    units: unitNames(c.rooms, read),
  };

  if (finished) {
    if (finished.state === "confirmed") return matchOf(f, "confirmed", WORDS.confirmed, { cloudbedsConfirmed: true });
    if (finished.refunded === true) return matchOf(f, "refunded", WORDS.refunded);
    return matchOf(f, "needs_attention", WORDS.needsAttention);
  }
  if (!read || readFailed) return matchOf(f, "unknown", WORDS.unknown);

  const pageOpen = read.link?.status === "ACTIVE" && !read.state.needsDisable;
  // Past its expiry but still ACTIVE at Beam (the sweeper disables it): the old page may still take a payment.
  const oldPageActive = read.link?.status === "ACTIVE" && read.state.needsDisable;
  const closing = (m: LookupMatch): LookupMatch => (oldPageActive ? { ...m, nextStep: `${m.nextStep} ${OLD_PAGE}`, retrySafe: false } : m);
  if (disagrees(read, c.ref, record, beam.beam.merchantId)) return matchOf(f, "needs_attention", WORDS.needsAttention);
  const s = read.state;
  switch (s.state) {
    case "paid": {
      // Paid after its hold was released: the owner re-books or refunds (owner decision 3).
      let released: boolean;
      try {
        released = facts !== null && (await kv.get(keys.releaseDone(facts.reservationId))) !== null;
      } catch {
        return matchOf(f, "unknown", WORDS.unknown);
      }
      return released ? matchOf(f, "needs_attention", WORDS.paidAfterRelease) : matchOf(f, "paid", WORDS.paid);
    }
    case "refunded":
      return matchOf(f, "refunded", WORDS.refunded);
    case "processing":
      return matchOf(f, "processing", WORDS.processing, { paymentPageOpen: pageOpen });
    case "open":
    case "expired":
    case "failed": {
      if (s.state === "expired" && s.pendingReason === "unconfirmed") return matchOf(f, "processing", WORDS.unconfirmed);
      const latest = latestCharge(read);
      if (latest?.status === "FAILED" || s.state === "failed") {
        // Only Beam's code shape is passed on (an unexpected string, markup or digits never reach the bot).
        const code = typeof latest?.failureCode === "string" && FAILURE_CODE_RE.test(latest.failureCode) ? latest.failureCode : null;
        const offer: FailureOffer = {
          ewallets: beam.beam.ewallets,
          promptPay: payMethodOffered(beam.config, "promptpay"),
          promptPayFree: feePctFor(beam.config, "promptpay") === 0,
        };
        return closing(
          matchOf(f, "failed", failureWords(code, f.facts?.payMethod ?? null, offer, pageOpen), {
            failureCode: code,
            paymentPageOpen: pageOpen,
          }),
        );
      }
      // An ACTIVE link past its expiry (Beam has not closed it yet; the sweeper disables it) can't be offered as open.
      if (s.state === "open" && pageOpen) return matchOf(f, "open", WORDS.open, { paymentPageOpen: true });
      return closing(matchOf(f, "expired", abandoned ? WORDS.cancelled : WORDS.expired));
    }
    default:
      return matchOf(f, "unknown", WORDS.unknown);
  }
}

/**
 * An attempt past the newest SUPPORT_LOOKUP_BEAM_READS, with no done marker: our own markers only (no Beam call).
 * paid while fulfil's paid marker is there; expired once the window, the pending grace and BEAM_PENDING_BLOCK_MS are
 * over (by then a Beam reading says expired too, unless a late payment came: the sweeper's late watch turns that into
 * a paid or done marker); else unknown.
 */
async function describeStored(c: Candidate, ctx: LookupContext, record: PaymentRecord | null): Promise<LookupMatch> {
  const f: Facts = { ref: c.ref, createdAt: record?.createdAt ?? c.at, facts: record, totalSatang: record?.totalSatang ?? null, units: unitNames(c.rooms, null) };
  if (!record) return matchOf(f, "unknown", WORDS.notChecked);
  let paidMarker: boolean;
  try {
    paidMarker = (await ctx.beam.kv.get(keys.paidPending(beamKeyOf(c.linkId)))) !== null;
  } catch {
    return matchOf(f, "unknown", WORDS.unknown);
  }
  if (paidMarker) return matchOf(f, "paid", WORDS.paid);
  const settledAtMs = record.expiresAt + ctx.beam.beam.pendingGraceMinutes * 60_000 + BEAM_PENDING_BLOCK_MS;
  return ctx.nowMs >= settledAtMs ? matchOf(f, "expired", WORDS.closedEarlier) : matchOf(f, "unknown", WORDS.notChecked);
}

/* ------------------------------------------------ the words ------------------------------------------------ */

const DONT_PAY_AGAIN = "Please don't pay again.";
/** Added to an expired or failed attempt whose page Beam has not closed yet. */
const OLD_PAGE = "Please don't use the old payment page.";

/** The next step of an open, failed or expired attempt while another attempt of the same answer is not settled. */
function waitForOthers(refs: string[]): string {
  const several = refs.length > 1;
  return `${DONT_PAY_AGAIN} Your other recent payment attempt${several ? "s" : ""} (${refs.join(", ")}) ${several ? "are" : "is"} still being processed or checked, so paying again now could charge you twice. We'll confirm your booking or contact you shortly.`;
}

const WORDS = {
  open: {
    reason: "Your payment page is still open and nothing has been charged yet.",
    nextStep: `You can still pay on the same payment page (it closes 30 minutes after it was opened), or make a new booking on ${BOOKING_PAGE}.`,
  },
  processing: {
    reason: "Your payment is still being confirmed by your bank or wallet.",
    nextStep: `${DONT_PAY_AGAIN} This usually takes a few minutes; your booking confirmation email follows once it is through.`,
  },
  unconfirmed: {
    reason: "Your bank or wallet hasn't confirmed this payment yet, and the payment window has ended.",
    nextStep: `${DONT_PAY_AGAIN} If the payment still goes through, we'll confirm your booking or contact you; if it doesn't, nothing is charged.`,
  },
  paid: {
    reason: "We've received your payment and are confirming your booking now.",
    nextStep: `${DONT_PAY_AGAIN} Your booking confirmation email follows shortly; if it hasn't arrived within an hour, message us here.`,
  },
  confirmed: {
    reason: "Your payment was received and your booking is confirmed.",
    nextStep: "Your confirmation email was sent by our reservation system (please check your spam folder too). Nothing else to do.",
  },
  expired: {
    reason: "The 30-minute payment window ended before any payment was made, so nothing was charged and the room hold was released.",
    nextStep: `You're welcome to book again on ${BOOKING_PAGE}.`,
  },
  cancelled: {
    reason: "The payment page was cancelled, so nothing was charged and the room hold was released.",
    nextStep: `You're welcome to book again on ${BOOKING_PAGE}.`,
  },
  refunded: {
    reason: "This payment was refunded to you.",
    nextStep: "A refund can take a few business days to show on your statement. Message us here with any questions.",
  },
  needsAttention: {
    reason: "Your payment needs a quick manual check by our team.",
    nextStep: `${DONT_PAY_AGAIN} Our team will contact you shortly.`,
  },
  paidAfterRelease: {
    reason: "Your payment arrived after the room hold had ended, so our team needs to check your booking by hand.",
    nextStep: `${DONT_PAY_AGAIN} Our team will contact you shortly to confirm your booking or refund the payment in full.`,
  },
  unknown: {
    reason: "We couldn't check this payment just now.",
    nextStep: `${DONT_PAY_AGAIN} Our team will check it and get back to you shortly.`,
  },
  notChecked: {
    reason: "We didn't check this earlier payment attempt just now.",
    nextStep: `${DONT_PAY_AGAIN} Our team will check it and get back to you shortly.`,
  },
  closedEarlier: {
    reason: "This earlier payment page has closed, and no payment from it has reached us.",
    nextStep: "Nothing to do for this one.",
  },
} as const;

/**
 * Beam's failure codes (CH_ prefixed; Beam's test data lists some without it), each as what happened and a tip.
 * "{another}" is "another card or an e-wallet" on a card / e-wallet page with the e-wallets on, else "another card".
 */
const FAILURES: Record<string, { reason: string; tip: string }> = {
  CARD_DECLINED: { reason: "Your bank declined the card.", tip: "Try {another}, or ask your bank to allow the payment." },
  DECLINED: { reason: "Your payment was declined.", tip: "Try {another}, or ask your bank to allow the payment." },
  REJECTED: { reason: "Your payment was declined.", tip: "Try {another}, or ask your bank to allow the payment." },
  INSUFFICIENT_FUNDS: { reason: "Your bank declined the payment for insufficient funds.", tip: "Try {another}." },
  AUTHENTICATION_FAILED: {
    reason: "The card's security check (3-D Secure or your bank's one-time code) wasn't completed.",
    tip: "Try again and finish your bank's verification step, or use {another}.",
  },
  CARD_EXPIRED: { reason: "The card has expired.", tip: "Please use {another}." },
  CARD_RESTRICTED: {
    reason: "Your bank has restricted this card for this kind of payment (for example online or international payments).",
    tip: "Ask your bank to allow it, or use {another}.",
  },
  CARD_INCORRECT_DETAILS: {
    reason: "Some card details (number, expiry date or security code) weren't accepted.",
    tip: "Please check the card details and try again.",
  },
  CARD_INCORRECT_PIN: { reason: "The card PIN was incorrect.", tip: "Try again with the correct PIN, or use {another}." },
  CARD_PIN_ATTEMPT_EXCEEDED: {
    reason: "There were too many wrong PIN attempts, so your bank has blocked the card for now.",
    tip: "Please use {another}; your bank can unblock this card.",
  },
  PROCESSING_FAILED: {
    reason: "Your bank or the payment provider couldn't process the payment.",
    tip: "Please try again in a few minutes, or use another payment method.",
  },
};
const UNKNOWN_FAILURE = { reason: "Your payment didn't go through.", tip: "Please try again, or use another payment method." };

/** What this deployment's Beam checkout offers, for the failure tips. */
export interface FailureOffer {
  /** BEAM_EWALLETS: card / e-wallet pages offer the e-wallets too. */
  ewallets: boolean;
  /** BEAM_PROMPTPAY: the Thai PromptPay QR can be chosen. */
  promptPay: boolean;
  /** PromptPay carries no fee (BEAM_PROMPTPAY_FEE_PCT 0, owner decision 1). */
  promptPayFree: boolean;
}

/** The reason and next step of a failed attempt, from Beam's failureCode, the method group and whether the page is still open. */
export function failureWords(failureCode: string | null, payMethod: PayMethod | null, offer: FailureOffer, pageOpen: boolean): { reason: string; nextStep: string } {
  const code = (failureCode ?? "").trim().toUpperCase().replace(/^CH_/, "");
  const known = FAILURES[code] ?? UNKNOWN_FAILURE;
  const promptPayPage = payMethod === "promptpay";
  // A PromptPay page offers only the QR: a card tip doesn't fit it.
  const tip = (promptPayPage && known !== FAILURES.PROCESSING_FAILED ? UNKNOWN_FAILURE.tip : known.tip).replace(
    "{another}",
    !promptPayPage && offer.ewallets ? "another card or an e-wallet" : "another card",
  );
  const other = promptPayPage
    ? `You can choose ${offer.ewallets ? "card or e-wallet" : "card"} instead when you book again.`
    : offer.promptPay
      ? `You can also choose Thai PromptPay QR${offer.promptPayFree ? " (no fee)" : ""} when you book again.`
      : "";
  const page = pageOpen
    ? "Your payment page is still open for a short while, so you can try again there right away."
    : `The room hold has been released, so please make a new booking on ${BOOKING_PAGE}.`;
  return { reason: known.reason, nextStep: [tip, other, page].filter((s) => s !== "").join(" ") };
}

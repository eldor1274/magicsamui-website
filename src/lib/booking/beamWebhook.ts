// Beam webhook handling (design S4.4). Server only. The route (app/api/beam/webhook, S4.7) reads the RAW body
// (capped) and hands it here with the request headers, the Beam deps (the active config's, or the Beam drain's;
// null when there are none, and then the body is not read) and the config's BEAM_WEBHOOK_HMAC_KEY.
//
// - Unconfigured (no HMAC key, or no Beam deps) -> 503: Beam retries every non-2xx answer (10 attempts).
// - X-Beam-Signature = base64(HMAC-SHA256(base64decode(key), the exact raw body)). A bad or missing one -> 401,
//   counted per hour (keys.beamBadSignatures); the 3rd in an hour alerts the owner once (a wrong key, e.g. the
//   Playground key in Production, means every event fails). Signed but not JSON -> 200 and a log line.
// - The webhook carries no event id, no timestamp and an unsigned X-Beam-Event header, so the event kind comes
//   from the body's ids (money review 6) and the header is only a hint (a disagreement is logged):
//   paymentLinkId + order -> a link event; chargeId + source PAYMENT_LINK + sourceId -> a charge event (its
//   link = sourceId); refundId -> a refund event; transactionId + transactionType -> a transaction event;
//   anything else (another source's charge, an id we never issue) -> 200 ignored. Nothing the body says is
//   trusted beyond naming the resource: every payment is re-read from Beam.
// - Link and charge events: gw.get(key) always ("not ours" is never decided from Redis alone, money review 2;
//   the duplicate-charge and refund-ambiguous checks run inside it). Not ours (meta null, or a link Beam
//   answers 404 for) -> 200. Beam or Redis unreadable -> 503 (Beam retries; nothing was decided).
//   - paid: the paid marker and the unconfirmed-paid entry are written FIRST (fulfil.ts markPaymentPaid; once
//     only, skipped when the booking is already done), then fulfilPayment runs inline. Every outcome answers
//     200 once those two exist - confirmed, needs_attention, in_progress, and a thrown error (alerted with
//     alertFulfilPaymentFailure): the sweeper retries the paid entry on its next run (money review 7 and 12).
//     Only a failure to write them answers 503, so a paid event is never acknowledged before it is durable.
//   - open / processing -> 200 (a charge.failed leaves the link ACTIVE so the guest can retry).
//   - expired (or failed, which beamPaymentState never answers) -> releasePayment (guarded by gw.releaseGuard)
//     with the reason 'Beam webhook: payment link expired', best effort -> 200: the sweeper owns releases (Beam
//     sends no expiry event).
//   - refunded -> fulfilPayment (needs_attention once, nothing once done) -> 200.
// - Refund events: getRefund(refundId) for the real status (503 when it can't be read; a refund Beam does not
//   know -> 200 not ours). The booking is found through the charge index (keys.beamCharge, 708 days), else the
//   refund's referenceId (an MSV ref: its pointer and record when they still exist). The owner's alert is keyed
//   refund:{refundId}:{status}: SUCCEEDED -> info 'Beam refund done for booking {ref} (THB x)' with the folio
//   steps; FAILED -> CRITICAL with the bank-transfer fallback (gap review 17): the guest is still owed money and
//   this answer is 200 (Beam does not retry), so the alert is stored and re-sent by the sweeper until a mail goes
//   out (round 5); PENDING -> nothing yet. Only a deps.alert that throws (never the production alerter, which
//   stores a critical alert first and reports a failed send as false) answers 503.
// - Transaction events: set-once keys.beamTxn (90 days), then one log line with the type, gross, fee, VAT, net,
//   currency and sourceId (no personal data). A CHARGEBACK raises CRITICAL 'URGENT: chargeback on Beam payment
//   for booking {ref}' (the booking from the charge index, the link's record or the referenceId).
// - A charge-index entry or record of another payment mode is not ours (another deployment's payment).
// - Nothing from the body is logged but ids, statuses and amounts: the charge body's customer block and card
//   digits are never read.

import { beamErrorInfo, getRefund, isBeamNotFound, listPaymentLinkCharges, verifyBeamSignature } from "./beam.ts";
import type { BeamCallOptions, BeamRefund } from "./beam.ts";
import { redactForLog } from "./cloudbedsWrite.ts";
import { alertFulfilPaymentFailure, fulfilPayment, markPaymentPaid, releasePayment } from "./fulfil.ts";
import { beamKeyOf, keyScope, keys, linkIdOf, readJson } from "./lock.ts";
import type { BookingPointer } from "./lock.ts";
import { BEAM_ID_PATTERN, isBeamLinkId } from "./payments/beamIds.ts";
import { beamGateway } from "./payments/beamGateway.ts";
import type { BeamChargeIndexEntry, BeamGateway, BeamGatewayDeps } from "./payments/beamGateway.ts";
import { readRecord } from "./payments/beamRecord.ts";
import { beamMethodName } from "./payments/beamText.ts";
import type { GatewayPayment, PaymentMeta } from "./payments/gateway.ts";
import { satangToBahtString } from "./quote.ts";
import { isBookingRef } from "./ref.ts";

export interface BeamWebhookResult {
  status: number;
  body: string;
}

/** The request's headers: a fetch Headers object, or a plain record (names compared without case). */
export type BeamWebhookHeaders = { get(name: string): string | null } | Readonly<Record<string, string | null | undefined>>;

/** Rejected signatures per hour before the owner is alerted (one stray probe is not worth an email). */
export const BEAM_BAD_SIGNATURE_ALERT_THRESHOLD = 3;
/** How long a handled transaction id is remembered (keys.beamTxn): far past Beam's 10 retries and any resend. */
export const BEAM_TXN_TTL_SECONDS = 90 * 24 * 3600;

/** What a signed body is about, decided from its ids alone (the X-Beam-Event header is only a hint). */
export type BeamWebhookEvent =
  | { kind: "link"; linkId: string }
  | { kind: "charge"; linkId: string; chargeId: string; status: string | null }
  | { kind: "refund"; refundId: string; status: string | null }
  | { kind: "transaction"; transactionId: string; transactionType: string }
  | { kind: "ignored"; reason: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function textOf(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * The event a signed body describes: a payment link (paymentLinkId + order), a payment-link charge (chargeId +
 * source PAYMENT_LINK + sourceId), a refund (refundId), a transaction (transactionId + transactionType), else
 * ignored. An id in a shape we never issue or accept is ignored too (it can't name a payment of ours).
 */
export function beamWebhookEventOf(body: Record<string, unknown>): BeamWebhookEvent {
  const paymentLinkId = textOf(body.paymentLinkId);
  if (paymentLinkId !== null && isObject(body.order)) {
    return isBeamLinkId(paymentLinkId) ? { kind: "link", linkId: paymentLinkId } : { kind: "ignored", reason: "unexpected payment link id" };
  }
  const chargeId = textOf(body.chargeId);
  if (chargeId !== null && body.source === "PAYMENT_LINK" && textOf(body.sourceId) !== null) {
    const sourceId = body.sourceId as string;
    return isBeamLinkId(sourceId) ? { kind: "charge", linkId: sourceId, chargeId, status: textOf(body.status) } : { kind: "ignored", reason: "unexpected payment link id" };
  }
  const refundId = textOf(body.refundId);
  if (refundId !== null) {
    return BEAM_ID_PATTERN.test(refundId) ? { kind: "refund", refundId, status: textOf(body.status) } : { kind: "ignored", reason: "unexpected refund id" };
  }
  const transactionId = textOf(body.transactionId);
  const transactionType = textOf(body.transactionType);
  if (transactionId !== null && transactionType !== null) {
    return BEAM_ID_PATTERN.test(transactionId) ? { kind: "transaction", transactionId, transactionType } : { kind: "ignored", reason: "unexpected transaction id" };
  }
  if (chargeId !== null) return { kind: "ignored", reason: "not a payment-link charge" };
  return { kind: "ignored", reason: "no payment link, charge, refund or transaction id" };
}

/** The X-Beam-Event values that agree with the event the body describes. */
function expectedEvents(ev: Exclude<BeamWebhookEvent, { kind: "ignored" }>): string[] {
  switch (ev.kind) {
    case "link":
      return ["payment_link.paid"];
    case "charge":
      return ev.status === "SUCCEEDED" ? ["charge.succeeded"] : ev.status === "FAILED" ? ["charge.failed"] : ["charge.succeeded", "charge.failed"];
    case "refund":
      return ev.status === "SUCCEEDED" ? ["refund.succeeded"] : ev.status === "FAILED" ? ["refund.failed"] : ["refund.succeeded", "refund.failed"];
    case "transaction":
      return ["transaction.created"];
  }
}

function headerOf(headers: BeamWebhookHeaders, name: string): string | null {
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") return (headers as { get(name: string): string | null }).get(name);
  for (const [k, v] of Object.entries(headers as Readonly<Record<string, string | null | undefined>>)) {
    if (k.toLowerCase() === name) return typeof v === "string" ? v : null;
  }
  return null;
}

/** The X-Beam-Event header as it may be logged: lower case, at most 40 safe characters; null when absent. */
function eventHint(header: string | null): string | null {
  if (header === null) return null;
  const clean = header.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "?").slice(0, 40);
  return clean === "" ? null : clean;
}

/** At most `max` printable characters of a value Beam sent, for an owner's alert or a log line. */
function shown(v: unknown, max = 40): string {
  if (typeof v !== "string" || v === "") return "(none)";
  const clean = v.replace(/[^\x20-\x7e]/g, "?");
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function money(satang: unknown): string {
  if (typeof satang !== "number" || !Number.isInteger(satang)) return "THB ?";
  return satang < 0 ? `-THB ${satangToBahtString(-satang)}` : `THB ${satangToBahtString(satang)}`;
}

function amountOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function errorText(e: unknown): string {
  return redactForLog(e instanceof Error ? e.message : String(e)).slice(0, 200);
}

/** The options of one Beam call: the budget left before the deps' deadline, the 429 counter and the test seams. */
function callOptions(deps: BeamGatewayDeps): BeamCallOptions {
  const clock = deps.clock ?? Date.now;
  return {
    ...(deps.deadlineMs !== undefined ? { budgetMs: deps.deadlineMs - clock() } : {}),
    ...(deps.onRateLimited ? { onRateLimited: deps.onRateLimited } : {}),
    ...(deps.clock ? { now: deps.clock } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  };
}

/** A booking a refund or transaction maps to (no personal data). reservationId null: only the ref is known. */
interface BookingFacts {
  ref: string;
  reservationId: string | null;
  linkId: string | null;
}

/** found: ours; otherMode: another payment mode's (not ours); null: no mapping by this route. */
type Mapping = { found: BookingFacts } | { otherMode: string } | null;

function isChargeIndexEntry(v: unknown): v is BeamChargeIndexEntry {
  return (
    isObject(v) &&
    v.v === 1 &&
    typeof v.linkId === "string" &&
    typeof v.ref === "string" &&
    typeof v.reservationId === "string" &&
    typeof v.mode === "string"
  );
}

interface Ctx {
  deps: BeamGatewayDeps;
  gw: BeamGateway;
  mode: string;
  scope: string;
}

/** The charge index (708 days): a SUCCEEDED charge of ours -> its link and booking. */
async function bookingOfCharge(ctx: Ctx, chargeId: unknown): Promise<Mapping> {
  if (typeof chargeId !== "string" || !BEAM_ID_PATTERN.test(chargeId)) return null;
  const entry = await readJson<unknown>(ctx.deps.kv, keys.beamCharge(chargeId));
  if (!isChargeIndexEntry(entry)) return null;
  if (entry.mode !== ctx.mode) return { otherMode: entry.mode };
  return { found: { ref: entry.ref, reservationId: entry.reservationId, linkId: entry.linkId } };
}

/** The link's PaymentRecord (708 days). */
async function bookingOfLink(ctx: Ctx, linkId: unknown): Promise<Mapping> {
  if (!isBeamLinkId(linkId)) return null;
  const record = await readRecord(ctx.deps.kv, linkId);
  if (!record) return null;
  if (record.mode !== ctx.mode) return { otherMode: record.mode };
  return { found: { ref: record.ref, reservationId: record.reservationId, linkId } };
}

/** A booking ref Beam copied onto the payment: its pointer and record while they exist, else the ref alone. */
async function bookingOfRef(ctx: Ctx, ref: unknown): Promise<Mapping> {
  if (!isBookingRef(ref)) return null;
  const pointer = await readJson<BookingPointer>(ctx.deps.kv, keys.booking(ref));
  const linkId = pointer && typeof pointer.sessionId === "string" ? linkIdOf(pointer.sessionId) : null;
  if (linkId !== null) {
    const viaLink = await bookingOfLink(ctx, linkId);
    if (viaLink && ("otherMode" in viaLink || viaLink.found.ref === ref)) return viaLink;
  }
  return { found: { ref, reservationId: null, linkId: null } };
}

/** The first route that maps the payment (in the order given). */
async function firstMapping(...routes: (() => Promise<Mapping>)[]): Promise<Mapping> {
  for (const route of routes) {
    const m = await route();
    if (m !== null) return m;
  }
  return null;
}

/** Bad signature: counted per hour; the 3rd tells the owner (best effort: the answer stays 401). */
async function noteBadSignature(deps: BeamGatewayDeps): Promise<void> {
  const mode = deps.config.paymentMode;
  try {
    const n = await deps.kv.incr(keys.beamBadSignatures(keyScope(mode)), 3600);
    if (n !== BEAM_BAD_SIGNATURE_ALERT_THRESHOLD) return;
    await deps.alert(
      "Beam webhook: signatures are being rejected",
      [
        `${n} Beam webhook deliveries in the last hour failed the signature check (mode ${mode}). Check BEAM_WEBHOOK_HMAC_KEY is the key of THIS environment's Lighthouse webhook (Playground and Production keys differ). Paid bookings are still confirmed by the return page and the sweeper.`,
      ],
      { key: "beam-webhook-bad-signature", severity: "warning" },
    );
  } catch {
    // Best effort only.
  }
}

export async function handleBeamWebhook(
  raw: string | Uint8Array,
  headers: BeamWebhookHeaders,
  deps: BeamGatewayDeps | null,
  hmacKey: string | null | undefined,
): Promise<BeamWebhookResult> {
  const secret = typeof hmacKey === "string" ? hmacKey.trim() : "";
  if (secret === "" || !deps) {
    deps?.log("beam_webhook_unconfigured", { hmacKey: secret !== "" });
    return { status: 503, body: "webhook not configured" };
  }
  const signature = headerOf(headers, "x-beam-signature");
  if (!verifyBeamSignature(raw, signature, secret)) {
    // Whether a signature was sent is all that is logged; never the header itself.
    deps.log("beam_webhook_bad_signature", { mode: deps.config.paymentMode, hasHeader: Boolean(signature) });
    await noteBadSignature(deps);
    return { status: 401, body: "invalid signature" };
  }

  const event = eventHint(headerOf(headers, "x-beam-event"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
  } catch {
    parsed = undefined;
  }
  if (!isObject(parsed)) {
    // Signed but not a JSON object: acknowledged, so Beam does not retry it ten times.
    deps.log("beam_webhook_unparseable", { event });
    return { status: 200, body: "ignored: not a JSON object" };
  }
  const ev = beamWebhookEventOf(parsed);
  if (ev.kind === "ignored") {
    deps.log("beam_webhook_ignored", { event, reason: ev.reason });
    return { status: 200, body: "ignored" };
  }
  const expected = expectedEvents(ev);
  if (event !== null && !expected.includes(event)) {
    // Beam signs only the body: the header can't change what is done, only what we expected.
    deps.log("beam_webhook_event_mismatch", { event, kind: ev.kind, expected: expected.join("|") });
  }

  const mode = deps.config.paymentMode;
  const ctx: Ctx = { deps, gw: beamGateway(deps), mode, scope: keyScope(mode) };
  switch (ev.kind) {
    case "link":
      deps.log("beam_webhook", { kind: ev.kind, event, linkId: ev.linkId });
      return handlePayment(ctx, ev.linkId, ev.kind);
    case "charge":
      deps.log("beam_webhook", { kind: ev.kind, event, linkId: ev.linkId, chargeId: shown(ev.chargeId, 64) });
      return handlePayment(ctx, ev.linkId, ev.kind);
    case "refund":
      deps.log("beam_webhook", { kind: ev.kind, event, refundId: ev.refundId });
      return handleRefund(ctx, ev.refundId);
    case "transaction":
      deps.log("beam_webhook", { kind: ev.kind, event, transactionId: ev.transactionId });
      return handleTransaction(ctx, ev.transactionId, ev.transactionType, parsed);
  }
}

/* ------------------------------------- link and charge events ------------------------------------- */

async function handlePayment(ctx: Ctx, linkId: string, kind: "link" | "charge"): Promise<BeamWebhookResult> {
  const { deps, gw } = ctx;
  const key = beamKeyOf(linkId);
  let payment: GatewayPayment;
  try {
    payment = await gw.get(key);
  } catch (e) {
    if (gw.isMissing(e)) {
      // Beam does not know the link for these credentials: it can never be one of our payments.
      deps.log("beam_webhook_not_ours", { kind, linkId, reason: "missing" });
      return { status: 200, body: "not ours" };
    }
    deps.log("beam_webhook_read_failed", { kind, linkId, ...beamErrorInfo(e) });
    return { status: 503, body: "payment could not be read - retry" };
  }
  const meta = payment.meta;
  if (!meta) {
    // Not one of our links (e.g. the owner's own Lighthouse link), or another payment mode's.
    deps.log("beam_webhook_not_ours", { kind, linkId, reason: "no record or note of ours" });
    return { status: 200, body: "not ours" };
  }
  switch (payment.state) {
    case "paid":
      return handlePaid(ctx, key, linkId, meta, kind);
    case "refunded":
      return handleRefunded(ctx, key, linkId, meta);
    case "expired":
    case "failed":
      return handleClosed(ctx, key, linkId, meta, payment.state);
    default:
      // open / processing: the guest may still pay (a declined attempt leaves the link ACTIVE).
      deps.log("beam_webhook_payment", { kind, linkId, ref: meta.ref, state: payment.state });
      return { status: 200, body: payment.state };
  }
}

async function handlePaid(ctx: Ctx, key: string, linkId: string, meta: PaymentMeta, kind: "link" | "charge"): Promise<BeamWebhookResult> {
  const { deps, gw } = ctx;
  // Durable first: from here on release refuses the hold and the sweeper retries the booking, whatever happens.
  try {
    if ((await deps.kv.get(keys.fulfilDone(key))) === null) await markPaymentPaid(deps, gw, key, meta);
  } catch (e) {
    deps.log("beam_webhook_paid_marker_failed", { linkId, ref: meta.ref, error: errorText(e) });
    return { status: 503, body: "payment could not be recorded - retry" };
  }
  try {
    const outcome = await fulfilPayment(key, deps, gw);
    deps.log("beam_webhook_payment", { kind, linkId, ref: meta.ref, state: "paid", outcome: outcome.state });
    return { status: 200, body: outcome.state };
  } catch (e) {
    // The paid marker and the paid entry exist: the sweeper (and the return page) finish it.
    await alertFulfilPaymentFailure(deps, gw, key, e).catch(() => undefined);
    return { status: 200, body: "fulfilment failed - retried by the sweeper" };
  }
}

async function handleRefunded(ctx: Ctx, key: string, linkId: string, meta: PaymentMeta): Promise<BeamWebhookResult> {
  const { deps, gw } = ctx;
  try {
    // Never confirmed and never released automatically (money review 4): fulfil hands it to the owner once.
    const outcome = await fulfilPayment(key, deps, gw);
    deps.log("beam_webhook_payment", { linkId, ref: meta.ref, state: "refunded", outcome: outcome.state });
    return { status: 200, body: outcome.state };
  } catch (e) {
    // The sweeper hands a refunded payment to fulfil again on its next run.
    deps.log("beam_webhook_refunded_fulfil_failed", { linkId, ref: meta.ref, error: errorText(e) });
    return { status: 200, body: "refunded - left to the sweeper" };
  }
}

async function handleClosed(ctx: Ctx, key: string, linkId: string, meta: PaymentMeta, state: "expired" | "failed"): Promise<BeamWebhookResult> {
  const { deps, gw } = ctx;
  try {
    // Guarded: a charge that became payable or paid since this reading keeps the hold (money review 9). 'failed' is
    // handled as 'expired' (design S4.4 (e)): a link that can never be paid.
    const released = await releasePayment(key, deps, gw, "Beam webhook: payment link expired");
    deps.log("beam_webhook_payment", { linkId, ref: meta.ref, state, outcome: released.state });
    return { status: 200, body: released.state };
  } catch (e) {
    // Best effort: the sweeper owns releases.
    deps.log("beam_webhook_release_failed", { linkId, ref: meta.ref, reservationId: meta.reservationId, error: errorText(e) });
    return { status: 200, body: "release left to the sweeper" };
  }
}

/* ------------------------------------------ refund events ------------------------------------------ */

/** The paid method of a charge of the link, best effort (one Beam call); a reading that fails says so. */
async function methodOfCharge(ctx: Ctx, linkId: string | null, chargeId: string): Promise<string> {
  if (linkId === null) return "method not known";
  try {
    const charges = await listPaymentLinkCharges(ctx.deps.beam, { sourceId: linkId }, ctx.deps.fetchImpl, callOptions(ctx.deps));
    const type = charges.find((c) => c?.chargeId === chargeId)?.paymentMethod?.paymentMethodType;
    return typeof type === "string" && type !== "" ? beamMethodName(type) : "method not known";
  } catch (e) {
    ctx.deps.log("beam_refund_method_unread", { linkId, ...beamErrorInfo(e) });
    return "method not known";
  }
}

async function handleRefund(ctx: Ctx, refundId: string): Promise<BeamWebhookResult> {
  const { deps } = ctx;
  let refund: BeamRefund;
  try {
    // The real status: a signed body under another X-Beam-Event header can never fake a refund (money review 6).
    refund = await getRefund(deps.beam, refundId, deps.fetchImpl, callOptions(deps));
  } catch (e) {
    if (isBeamNotFound(e)) {
      deps.log("beam_webhook_not_ours", { kind: "refund", refundId, reason: "missing" });
      return { status: 200, body: "not ours" };
    }
    deps.log("beam_webhook_read_failed", { kind: "refund", refundId, ...beamErrorInfo(e) });
    return { status: 503, body: "refund could not be read - retry" };
  }
  if (refund.status !== "SUCCEEDED" && refund.status !== "FAILED") {
    deps.log("beam_refund_pending", { refundId, status: shown(refund.status, 20) });
    return { status: 200, body: "refund pending" };
  }
  let mapping: Mapping;
  try {
    mapping = await firstMapping(
      () => bookingOfCharge(ctx, refund.chargeId),
      () => bookingOfRef(ctx, refund.referenceId),
    );
  } catch (e) {
    deps.log("beam_webhook_redis_failed", { kind: "refund", refundId, error: errorText(e) });
    return { status: 503, body: "refund could not be mapped - retry" };
  }
  if (mapping === null || "otherMode" in mapping) {
    deps.log("beam_webhook_not_ours", { kind: "refund", refundId, reason: mapping === null ? "no booking of ours" : "other mode", ...(mapping ? { mode: mapping.otherMode } : {}) });
    return { status: 200, body: "not ours" };
  }
  const booking = mapping.found;
  const chargeId = shown(refund.chargeId, 64);
  const amount = money(refund.amount);
  const reservation = booking.reservationId !== null ? `reservation ${booking.reservationId}` : `the reservation of booking ${booking.ref} (search the booking reference in Cloudbeds)`;
  try {
    if (refund.status === "SUCCEEDED") {
      const method = await methodOfCharge(ctx, booking.linkId, refund.chargeId);
      await deps.alert(
        `Beam refund done for booking ${booking.ref} (${amount})`,
        [
          `Beam refunded ${amount} of charge ${chargeId} (${method}), refund ${refundId} (Beam accepted it; the guest's bank may take days).`,
          `Record it in Cloudbeds by hand: a negative adjustment on ${reservation}; cancel the reservation if the stay is cancelled; for a full refund retract the Google Ads conversion (docs section 8).`,
        ],
        { key: `refund:${refundId}:SUCCEEDED`, severity: "info" },
      );
    } else {
      await deps.alert(
        `Beam refund FAILED for booking ${booking.ref}`,
        [
          `Refund ${refundId} of ${amount} on charge ${chargeId} failed (${refund.failureCode ? shown(refund.failureCode) : "no failure code"}). Try again in Lighthouse; if Beam keeps refusing (low balance or the method), pay the guest back by bank transfer.`,
        ],
        { key: `refund:${refundId}:FAILED`, severity: "critical" },
      );
    }
  } catch (e) {
    // Only a deps.alert that throws gets here (the production alerter never does): Beam's retry tells the owner.
    deps.log("beam_webhook_alert_failed", { kind: "refund", refundId, error: errorText(e) });
    return { status: 503, body: "refund alert failed - retry" };
  }
  deps.log("beam_refund", { refundId, chargeId, status: refund.status, ref: booking.ref, amount: amountOf(refund.amount) });
  return { status: 200, body: `refund ${refund.status.toLowerCase()}` };
}

/* ---------------------------------------- transaction events ---------------------------------------- */

/** CRITICAL for a chargeback: the booking from the charge index, the link's record or the referenceId. */
async function alertChargeback(ctx: Ctx, transactionId: string, body: Record<string, unknown>): Promise<"alerted" | "other mode"> {
  const { deps } = ctx;
  const sourceId = isBeamLinkId(body.sourceId) ? body.sourceId : null;
  const mapping = await firstMapping(
    () => bookingOfCharge(ctx, body.chargeId),
    () => bookingOfCharge(ctx, transactionId),
    () => bookingOfLink(ctx, sourceId),
    () => bookingOfRef(ctx, body.referenceId),
  );
  if (mapping !== null && "otherMode" in mapping) return "other mode";
  const amount = money(body.grossAmount);
  const booking = mapping?.found ?? null;
  if (booking === null) {
    await deps.alert(
      "URGENT: chargeback on a Beam payment",
      [
        `Beam recorded a CHARGEBACK of ${amount} (transaction ${transactionId}${sourceId ? `, payment link ${sourceId}` : ""}) that matches no booking of ours (the owner's own Lighthouse link, or our record of it is gone). Find the payment in Beam Lighthouse and answer Beam's dispute process: docs section 8.`,
      ],
      { key: `beam-chargeback:${transactionId}`, severity: "critical" },
    );
    return "alerted";
  }
  const linkId = booking.linkId ?? sourceId;
  const named = typeof body.chargeId === "string" && BEAM_ID_PATTERN.test(body.chargeId) ? body.chargeId : linkId ? await deps.kv.get(keys.beamPrimary(linkId)) : null;
  const charge = named ? `charge ${named}` : linkId ? `the payment of Beam link ${linkId}` : `a Beam payment (transaction ${transactionId})`;
  const where = booking.reservationId !== null ? `booking ${booking.ref}, Cloudbeds reservation ${booking.reservationId}` : `booking ${booking.ref}`;
  await deps.alert(
    `URGENT: chargeback on Beam payment for booking ${booking.ref}`,
    [
      `Beam recorded a CHARGEBACK of ${amount} on ${charge} (${where}). Collect the booking evidence (agreed terms version, PAID note, guest messages) and answer Beam's dispute process: docs section 8.`,
    ],
    { key: `beam-chargeback:${transactionId}`, severity: "critical" },
  );
  return "alerted";
}

async function handleTransaction(ctx: Ctx, transactionId: string, transactionType: string, body: Record<string, unknown>): Promise<BeamWebhookResult> {
  const { deps, scope } = ctx;
  const marker = keys.beamTxn(scope, transactionId);
  let first: boolean;
  try {
    first = await deps.kv.setNx(marker, "1", BEAM_TXN_TTL_SECONDS);
  } catch (e) {
    deps.log("beam_webhook_redis_failed", { kind: "transaction", transactionId, error: errorText(e) });
    return { status: 503, body: "transaction could not be recorded - retry" };
  }
  if (!first) return { status: 200, body: "duplicate" };
  const type = shown(transactionType, 20);
  let outcome: "logged" | "alerted" | "other mode" = "logged";
  if (transactionType === "CHARGEBACK") {
    try {
      outcome = await alertChargeback(ctx, transactionId, body);
    } catch (e) {
      // Not told yet: forget the transaction so Beam's retry tells the owner.
      await deps.kv.del(marker).catch(() => undefined);
      deps.log("beam_webhook_chargeback_failed", { transactionId, error: errorText(e) });
      return { status: 503, body: "chargeback could not be handled - retry" };
    }
  }
  // Reconciliation (fee and VAT come only with this event); no personal data.
  deps.log("beam_transaction", {
    transactionId,
    type,
    currency: typeof body.currency === "string" ? shown(body.currency, 8) : null,
    gross: amountOf(body.grossAmount),
    fee: amountOf(body.feeAmount),
    vat: amountOf(body.vatAmount),
    net: amountOf(body.netAmount),
    sourceId: isBeamLinkId(body.sourceId) ? body.sourceId : null,
  });
  return { status: 200, body: outcome === "other mode" ? "not ours" : outcome };
}

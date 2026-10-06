// Fulfilment and release of Stripe-paid bookings (WI-6, WI-7 server side).
//
// fulfilSession(sessionId): turns a PAID Checkout Session into a confirmed
// Cloudbeds reservation. Called by the webhook, the return page (status) and
// the sweeper - possibly at the same time - so it is idempotent:
//   1. 30-day done marker -> return at once;
//   2. SET NX lock (120 s) -> a second caller gets "in_progress";
//   3. re-read the session from Stripe (never trust the caller): paid, ours,
//      amount = metadata total, currency thb, livemode = ours;
//   4. mark the reservation "paid" BEFORE any write, so release() can never
//      cancel it from now on, and list the session as paid-but-unfinished
//      (the sweeper retries it beyond Stripe's own retries and escalates it);
//      then a best-effort note on the reservation: "PAID via Stripe - do NOT
//      cancel" (so staff never take it for a stale unpaid hold);
//   5. fee line via postCustomItem (referenceID dedupes) + step marker - an
//      optional write: if it fails, the payment is still recorded and the
//      booking confirmed, the fee is retried once more after confirming,
//      and the owner is alerted if it is still missing;
//   6. postPayment (custom "Stripe" method, baht, Stripe ids in the
//      description) unless the folio already shows it paid + step marker.
//      postPayment has no dedupe key, so the attempt is CLAIMED (with its
//      time) before it is sent: when its answer is lost (timeout, 5xx) a retry
//      does not post again until the folio has had PAYMENT_DOUBT_COOLDOWN_MS
//      to show it; a folio whose paid amount can't be read after such an
//      attempt goes to the owner (needs_attention) instead of being guessed;
//   7. putReservation status=confirmed - only from "not_confirmed" (a stay
//      staff already confirmed or checked in is left as it is; any other
//      status goes to the owner); check the balance is 0 (alert if not);
//   8. done marker; drop the hold from the open-holds and paid indexes; notify the owner.
// Outside live mode every text written to Cloudbeds starts with
// "TEST MODE - NOT REAL MONEY" (and CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD can
// route test money to its own Cloudbeds payment method).
//
// releaseHold(reservationId): cancels an unpaid hold (putReservation
// status=canceled) under its own lock - but NEVER when a paid marker exists,
// the folio shows a payment, the guest is checked in, or staff confirmed a
// hold we had marked pending. releaseSession(sessionId) only releases when
// Stripe says the session is expired or its delayed payment failed.

import { CloudbedsWriteError, redactForLog } from "./cloudbedsWrite.ts";
import { closeHold, keyScope, keys, readJson, withLock, writeJson, DONE_TTL_SECONDS } from "./lock.ts";
import type { BookingPointer, HoldRecord, PaidPending } from "./lock.ts";
import { chargeId, isMissingSessionError, isNotOpenError, parseSessionMeta, paymentIntentId, retrieveSession, sessionPaymentState } from "./payments/stripe.ts";
import type { CheckoutSession, SessionMeta, SessionPaymentState } from "./payments/stripe.ts";
import { satangToBahtString } from "./quote.ts";
import type { StripeDeps } from "./stripeDeps.ts";
import { nowOf } from "./stripeDeps.ts";

export interface FulfilDone {
  state: "confirmed" | "needs_attention";
  reservationId: string;
  ref: string;
  totalSatang: number;
  reason?: string;
  at: number;
}

export type FulfilOutcome =
  | { state: "confirmed"; reservationId: string; ref: string; totalSatang: number; alreadyDone: boolean }
  | { state: "needs_attention"; reservationId: string; ref: string; reason: string }
  | { state: "in_progress" }
  | { state: "not_paid"; payment: SessionPaymentState }
  | { state: "not_ours" };

export type ReleaseOutcome =
  | { state: "released"; reservationId: string }
  | { state: "already_released"; reservationId: string }
  | { state: "refused_paid"; reservationId: string }
  /** Confirmed by staff (or checked in): never cancelled automatically - the owner is alerted. */
  | { state: "refused_confirmed"; reservationId: string }
  | { state: "refused_open" }
  | { state: "in_progress" }
  | { state: "not_ours" };

const FEE_ITEM_NAME = "Payment processing fee";

/**
 * The fee line's Cloudbeds item. Cloudbeds keeps the name/description sent the
 * FIRST time an appItemID is used and ignores later ones, so live and test
 * each have their own item, and its text never carries a ref or a Stripe id
 * (those are in the payment description and the "PAID" reservation note).
 */
export function feeItemFor(mode: string): { appItemId: string; itemSku: string; name: string; note: string } {
  return mode === "stripe-live"
    ? { appItemId: "msv-payment-processing-fee", itemSku: "MSV-PAYMENT-FEE", name: FEE_ITEM_NAME, note: "Online booking payment processing fee, paid via Stripe." }
    : {
        appItemId: "msv-payment-processing-fee-test",
        itemSku: "MSV-PAYMENT-FEE-TEST",
        name: `TEST - ${FEE_ITEM_NAME}`,
        note: "TEST MODE - NOT REAL MONEY. Test fee line.",
      };
}

/** A paid session still not confirmed after this long is escalated to a CRITICAL (stored, re-sent) alert. */
export const PAID_UNCONFIRMED_ESCALATE_MS = 2 * 3600_000;

/**
 * After a postPayment whose answer was lost, retries wait this long for the
 * folio to show the payment before posting again (Cloudbeds may still commit
 * it after our 15 s timeout; the return page retries every 3 s).
 */
export const PAYMENT_DOUBT_COOLDOWN_MS = 10 * 60_000;

/** Prefix for everything written to Cloudbeds outside live mode. */
export function testMoneyLabel(deps: Pick<StripeDeps, "config">): string {
  return deps.config.paymentMode === "stripe-live" ? "" : "TEST MODE - NOT REAL MONEY. ";
}

/** True when the session belongs to this deployment's Stripe mode (test vs live). */
function modeMatches(session: Pick<CheckoutSession, "livemode">, deps: StripeDeps): boolean {
  return session.livemode === (deps.config.stripe?.livemode ?? false);
}

function money(satang: number): string {
  return `THB ${satangToBahtString(satang)}`;
}

async function markDone(deps: StripeDeps, sessionId: string, done: FulfilDone): Promise<void> {
  await writeJson(deps.kv, keys.fulfilDone(sessionId), done, DONE_TTL_SECONDS);
  await closeHold(deps.kv, done.reservationId);
  await deps.kv.zrem(keys.paidIndex(keyScope(deps.config.paymentMode)), sessionId).catch(() => undefined);
}

/** Lists a paid session as not yet fulfilled (until its done marker exists); keeps the first "paid" time. */
async function notePaid(deps: StripeDeps, sessionId: string, meta: SessionMeta): Promise<void> {
  const existing = await readJson<PaidPending>(deps.kv, keys.paidPending(sessionId));
  const rec: PaidPending = existing ?? {
    sessionId,
    ref: meta.ref,
    reservationId: meta.reservationId,
    totalSatang: meta.totalSatang,
    paidAt: nowOf(deps),
    mode: deps.config.paymentMode,
  };
  if (!existing) await writeJson(deps.kv, keys.paidPending(sessionId), rec, DONE_TTL_SECONDS);
  await deps.kv.zadd(keys.paidIndex(keyScope(deps.config.paymentMode)), rec.paidAt, sessionId);
}

/**
 * Confirms a paid session in Cloudbeds. Never throws for "not paid" or "not
 * ours"; throws on transient failures (Cloudbeds/Stripe down) so the webhook
 * answers 5xx and Stripe retries (the sweeper and the return page retry too).
 */
export async function fulfilSession(sessionId: string, deps: StripeDeps): Promise<FulfilOutcome> {
  const done = await readJson<FulfilDone>(deps.kv, keys.fulfilDone(sessionId));
  if (done) {
    return done.state === "confirmed"
      ? { state: "confirmed", reservationId: done.reservationId, ref: done.ref, totalSatang: done.totalSatang, alreadyDone: true }
      : { state: "needs_attention", reservationId: done.reservationId, ref: done.ref, reason: done.reason ?? "needs attention" };
  }

  const locked = await withLock(deps.kv, keys.fulfilLock(sessionId), () => fulfilLocked(sessionId, deps));
  if (!locked.acquired) return { state: "in_progress" };
  return locked.value;
}

async function fulfilLocked(sessionId: string, deps: StripeDeps): Promise<FulfilOutcome> {
  // Re-check under the lock: another caller may have finished in between.
  const done = await readJson<FulfilDone>(deps.kv, keys.fulfilDone(sessionId));
  if (done) {
    return done.state === "confirmed"
      ? { state: "confirmed", reservationId: done.reservationId, ref: done.ref, totalSatang: done.totalSatang, alreadyDone: true }
      : { state: "needs_attention", reservationId: done.reservationId, ref: done.ref, reason: done.reason ?? "needs attention" };
  }

  const session = await retrieveSession(deps.stripe, sessionId);
  const meta = parseSessionMeta(session);
  if (!meta || !modeMatches(session, deps)) return { state: "not_ours" };
  const payment = sessionPaymentState(session);
  if (payment !== "paid") return { state: "not_paid", payment };

  const { reservationId, ref } = meta;
  // From here on this reservation must never be released, whatever happens below.
  await deps.kv.set(keys.reservationPaid(reservationId), sessionId, DONE_TTL_SECONDS);
  await notePaid(deps, sessionId, meta);

  const pi = paymentIntentId(session) ?? "-";
  const charge = chargeId(session) ?? "-";
  const label = testMoneyLabel(deps);

  // Staff must never take a paid booking for a stale unpaid hold, even while confirming it keeps failing.
  if ((await deps.kv.get(keys.fulfilStep(sessionId, "paid-note"))) === null) {
    try {
      await deps.writer.addNote(
        reservationId,
        `${label}PAID via Stripe ${pi} (${money(meta.totalSatang)}) for online booking ${ref} - do NOT cancel. The "cancelled automatically if unpaid" rule no longer applies.`,
      );
      await deps.kv.set(keys.fulfilStep(sessionId, "paid-note"), "1", DONE_TTL_SECONDS);
    } catch (e) {
      deps.log("fulfil_paid_note_failed", { ref, reservationId, error: redactForLog(e instanceof Error ? e.message : String(e)) });
    }
  }

  if (session.amount_total !== meta.totalSatang || (session.currency ?? "").toLowerCase() !== "thb") {
    return needsAttention(deps, sessionId, meta, `Stripe amount ${session.amount_total} ${session.currency} does not match the booking total ${meta.totalSatang} satang`);
  }

  const reservation = await deps.writer.getReservation(reservationId);
  if (reservation.status === "canceled") {
    return needsAttention(
      deps,
      sessionId,
      meta,
      "The guest PAID but the Cloudbeds hold is CANCELLED. Re-instate or re-book the guest in Cloudbeds (if the unit is still free) or refund in Stripe.",
    );
  }

  // 5. Fee line (so the folio balances: rooms + fee = payment). Optional: it never blocks the booking.
  const addFee = async (): Promise<boolean> => {
    if (meta.feeSatang <= 0 || (await deps.kv.get(keys.fulfilStep(sessionId, "fee"))) !== null) return true;
    try {
      await deps.writer.addFeeItem({ reservationId, amountSatang: meta.feeSatang, referenceId: `${ref}-fee`, ...feeItemFor(deps.config.paymentMode) });
    } catch (e) {
      deps.log("fulfil_fee_item_failed", { ref, reservationId, error: redactForLog(e instanceof Error ? e.message : String(e)) });
      return false;
    }
    await deps.kv.set(keys.fulfilStep(sessionId, "fee"), "1", DONE_TTL_SECONDS);
    return true;
  };
  let feeOk = await addFee();

  // 6. Payment. postPayment has no dedupe key: the step marker, the attempt
  // claim and the folio's own "paid" figure guard against posting it twice
  // (a lost response followed by a retry while Cloudbeds is still committing it).
  if ((await deps.kv.get(keys.fulfilStep(sessionId, "payment"))) === null) {
    const attemptKey = keys.fulfilStep(sessionId, "payment-attempt");
    const before = await deps.writer.getReservation(reservationId);
    const attemptRaw = await deps.kv.get(attemptKey);
    const attemptAt = attemptRaw === null ? null : Number(attemptRaw);
    const post = async () => {
      // Claimed BEFORE sending: whatever happens to the answer, a retry knows a payment may be on its way.
      await deps.kv.set(attemptKey, String(nowOf(deps)), DONE_TTL_SECONDS);
      try {
        await deps.writer.recordPayment({
          reservationId,
          amountSatang: meta.totalSatang,
          method: deps.config.cloudbedsPaymentMethod,
          description: `${label}Stripe ${pi} charge ${charge} session ${sessionId} ref ${ref}`,
        });
      } catch (e) {
        // Refused outright (never processed): the next retry may post at once.
        if (e instanceof CloudbedsWriteError && !e.ambiguous) await deps.kv.del(attemptKey).catch(() => undefined);
        throw e;
      }
    };
    if (before.paidSatang !== null && before.paidSatang >= meta.totalSatang) {
      deps.log("fulfil_payment_already_on_folio", { ref, reservationId });
    } else if (attemptAt !== null && Number.isFinite(attemptAt)) {
      // An earlier postPayment may have landed without us seeing the answer.
      if (before.paidSatang === null) {
        return needsAttention(
          deps,
          sessionId,
          meta,
          `PAYMENT RECORD IN DOUBT: recording the Stripe payment in Cloudbeds got no clear answer, and the folio's paid amount can't be read. Check reservation ${reservationId}: if the ${money(meta.totalSatang)} Stripe payment (${pi}) is not on the folio, add it once with the Stripe payment method; then set the reservation to Confirmed. Do not add it twice.`,
        );
      }
      if (nowOf(deps) - attemptAt < PAYMENT_DOUBT_COOLDOWN_MS) {
        deps.log("fulfil_payment_in_doubt", { ref, reservationId, waitedMs: nowOf(deps) - attemptAt });
        return { state: "in_progress" };
      }
      // The cool-down passed and the folio still shows no full payment: the earlier attempt did not land.
      deps.log("fulfil_payment_reposted", { ref, reservationId });
      await post();
    } else {
      await post();
    }
    await deps.kv.set(keys.fulfilStep(sessionId, "payment"), "1", DONE_TTL_SECONDS);
  }

  // 7. Confirm - only a reservation still "Confirmation pending". One staff already confirmed, checked in
  // or checked out is left as it is (fulfil can run late); any other status needs a person.
  const current = await deps.writer.getReservation(reservationId);
  if (current.status === "not_confirmed") {
    await deps.writer.confirm(reservationId, deps.config.sendCloudbedsStatusEmail);
  } else if (current.status === "checked_in" || current.status === "checked_out") {
    deps.log("fulfil_status_left_as_is", { ref, reservationId, status: current.status });
  } else if (current.status !== "confirmed") {
    return needsAttention(
      deps,
      sessionId,
      meta,
      `The guest PAID (${money(meta.totalSatang)} via Stripe, ${pi}) and the payment is recorded on the folio, but Cloudbeds reservation ${reservationId} is "${String(current.status).slice(0, 30)}", so it was not confirmed automatically. Check it in Cloudbeds: re-instate and confirm it, or refund in Stripe.`,
    );
  }
  const feeWasMissing = !feeOk;
  if (!feeOk) feeOk = await addFee();
  if (!feeOk) {
    await deps.alert(
      `Booking ${ref}: the processing fee line is missing in Cloudbeds`,
      [
        `Cloudbeds reservation ${reservationId} is paid (${money(meta.totalSatang)} via Stripe, ${pi}) and confirmed, but adding the "${FEE_ITEM_NAME}" item (${money(meta.feeSatang)}) failed, so the folio shows a credit of that amount.`,
        "Add the fee as an item on the folio by hand. If this repeats, check that the booking API key has the write:item scope.",
      ],
      { key: `fee-missing:${reservationId}`, severity: "warning" },
    );
  }
  // The balance is only meaningful once the fee line is there (re-read when it was added late).
  const final = feeWasMissing && feeOk ? await deps.writer.getReservation(reservationId) : current;
  if (deps.writer.mode === "live" && feeOk && final.balanceSatang !== null && final.balanceSatang !== 0) {
    await deps.alert(
      `Booking ${ref}: Cloudbeds balance is not zero after payment`,
      [
        `Cloudbeds reservation ${reservationId} shows a balance of ${money(final.balanceSatang)} after we recorded ${money(meta.totalSatang)} from Stripe.`,
        "The reservation is confirmed. Please check the folio (taxes or a rate change in Cloudbeds?).",
      ],
      { key: `balance:${reservationId}`, severity: "warning" },
    );
  }

  await markDone(deps, sessionId, { state: "confirmed", reservationId, ref, totalSatang: meta.totalSatang, at: nowOf(deps) });
  deps.log("fulfil_confirmed", { ref, reservationId, amount: meta.totalSatang, mode: deps.config.paymentMode });
  await deps.alert(
    `New direct booking ${ref} confirmed (${money(meta.totalSatang)})`,
    [
      `Cloudbeds reservation ${reservationId}, ${meta.checkIn} to ${meta.checkOut}.`,
      `Paid ${money(meta.totalSatang)} via Stripe (${pi}); the payment${feeOk ? " and the fee line are" : " is"} on the folio and the reservation is confirmed.`,
    ],
    { key: `booked:${reservationId}`, severity: "info" },
  );
  return { state: "confirmed", reservationId, ref, totalSatang: meta.totalSatang, alreadyDone: false };
}

async function needsAttention(deps: StripeDeps, sessionId: string, meta: SessionMeta, reason: string): Promise<FulfilOutcome> {
  await markDone(deps, sessionId, { state: "needs_attention", reservationId: meta.reservationId, ref: meta.ref, totalSatang: meta.totalSatang, reason, at: nowOf(deps) });
  deps.log("fulfil_needs_attention", { ref: meta.ref, reservationId: meta.reservationId });
  await deps.alert(
    `URGENT: paid booking ${meta.ref} needs attention`,
    [reason, `Stripe Checkout Session ${sessionId}, Cloudbeds reservation ${meta.reservationId}, ${meta.checkIn} to ${meta.checkOut}, ${money(meta.totalSatang)}.`],
    { key: `attention:${sessionId}`, severity: "critical" },
  );
  return { state: "needs_attention", reservationId: meta.reservationId, ref: meta.ref, reason };
}

/**
 * Called when fulfil throws: one alert per session per window (the alerter
 * frees the window again if the mail was not delivered, so every later retry
 * that still fails tries again), then rethrow upstream. Once fulfil has seen
 * the session paid, the alert names the booking (ref, Cloudbeds reservation,
 * amount); once it has been paid for PAID_UNCONFIRMED_ESCALATE_MS without
 * being confirmed, the alert is CRITICAL (stored and re-sent until delivered).
 */
export async function alertFulfilFailure(deps: StripeDeps, sessionId: string, error: unknown): Promise<void> {
  const message = redactForLog(error instanceof Error ? error.message : String(error));
  deps.log("fulfil_failed", { sessionId, error: message });
  const paid = await readJson<PaidPending>(deps.kv, keys.paidPending(sessionId)).catch(() => null);
  const ageMs = paid ? nowOf(deps) - paid.paidAt : 0;
  if (paid && ageMs >= PAID_UNCONFIRMED_ESCALATE_MS) {
    await alertPaidStuck(deps, paid, `${Math.round(ageMs / 60_000)} minutes; latest error: ${message.slice(0, 200)}`);
    return;
  }
  await deps.alert(
    `Paid booking ${paid ? `${paid.ref} ` : ""}not yet confirmed in Cloudbeds (retrying)`,
    [
      paid
        ? `Booking ${paid.ref} (Cloudbeds reservation ${paid.reservationId}, ${money(paid.totalSatang)}, Stripe session ${sessionId}) is PAID, but confirming it in Cloudbeds failed: ${message.slice(0, 200)}`
        : `Stripe Checkout Session ${sessionId} is paid but confirming it in Cloudbeds failed: ${message.slice(0, 200)}`,
      "It is retried automatically (Stripe webhook retries, the guest's return page and the sweeper). Do NOT cancel the reservation. If this repeats, check Cloudbeds.",
    ],
    { key: `fulfil-fail:${sessionId}`, severity: "warning" },
  );
}

/** CRITICAL: a paid session is still not confirmed long after payment (stored and re-sent until delivered). */
export async function alertPaidStuck(deps: StripeDeps, paid: PaidPending, detail: string): Promise<void> {
  await deps.alert(
    `URGENT: paid booking ${paid.ref} still not confirmed in Cloudbeds`,
    [
      `Booking ${paid.ref} (Cloudbeds reservation ${paid.reservationId}) was PAID via Stripe (${money(paid.totalSatang)}, session ${paid.sessionId}), but confirming it in Cloudbeds has failed for ${detail}`,
      "Do NOT cancel this reservation: the guest has paid. Record the Stripe payment once on its folio (the custom \"Stripe\" method) and confirm it by hand - or fix the cause (CLOUDBEDS_STRIPE_PAYMENT_METHOD, the booking key's scopes). The sweeper keeps retrying it.",
    ],
    { key: `fulfil-stuck:${paid.sessionId}`, severity: "critical" },
  );
}

/* ------------------------------- release ------------------------------- */

/**
 * Cancels an unpaid Cloudbeds hold. Refuses when the reservation is marked
 * paid (or the folio shows a payment). Idempotent (lock + done marker).
 */
export async function releaseHold(
  reservationId: string,
  deps: StripeDeps,
  reason: string,
  options: {
    /**
     * Checkout giving back its own hold before the guest ever saw a payment page
     * (nobody can have paid): an unreadable folio does not block the cancel.
     */
    neverPayable?: boolean;
  } = {},
): Promise<ReleaseOutcome> {
  if ((await deps.kv.get(keys.releaseDone(reservationId))) !== null) return { state: "already_released", reservationId };
  if ((await deps.kv.get(keys.reservationPaid(reservationId))) !== null) return { state: "refused_paid", reservationId };
  const locked = await withLock(deps.kv, keys.releaseLock(reservationId), async (): Promise<ReleaseOutcome> => {
    if ((await deps.kv.get(keys.reservationPaid(reservationId))) !== null) return { state: "refused_paid", reservationId };
    const r = await deps.writer.getReservation(reservationId);
    if (r.status === "canceled") {
      await deps.kv.set(keys.releaseDone(reservationId), reason, DONE_TTL_SECONDS);
      await closeHold(deps.kv, reservationId);
      return { state: "already_released", reservationId };
    }
    if (r.paidSatang === null && !options.neverPayable) {
      // The folio's payments can't be read: never guess "unpaid" before cancelling.
      deps.log("release_refused_paid_unknown", { reservationId, status: r.status });
      await deps.alert(
        `Hold ${reservationId} was not cancelled: its payments could not be read`,
        [
          `We were about to release Cloudbeds reservation ${reservationId} (${reason}), but Cloudbeds did not tell us what has been paid on it, so nothing was cancelled.`,
          "Please check the folio: if nobody paid, cancel it in Cloudbeds so the unit goes back on sale.",
        ],
        { key: `release-paid-unknown:${reservationId}`, severity: "warning" },
      );
      return { state: "refused_paid", reservationId };
    }
    if ((r.paidSatang ?? 0) > 0) {
      deps.log("release_refused_folio_paid", { reservationId, status: r.status });
      // A confirmed reservation with a payment is simply a booking; only a PENDING hold with a payment is odd.
      if (r.status !== "confirmed") {
        await deps.alert(
          `Hold ${reservationId} was not cancelled: the folio shows a payment`,
          [`We were about to release Cloudbeds reservation ${reservationId} (${reason}), but its folio already has a payment. Nothing was cancelled - please check it.`],
          { key: `release-paid:${reservationId}`, severity: "warning" },
        );
      }
      return { state: "refused_paid", reservationId };
    }
    if (r.status !== "not_confirmed" && r.status !== "confirmed") {
      // checked_in / checked_out / no_show / unknown: a stay staff are handling. Never cancel it.
      deps.log("release_refused_status", { reservationId, status: r.status });
      return { state: "refused_confirmed", reservationId };
    }
    if (r.status === "confirmed") {
      // We had marked it "Confirmation pending": someone confirmed it by hand since. Ask, don't cancel.
      const rec = await holdRecord(deps, reservationId);
      if (rec?.pendingMarked) {
        deps.log("release_refused_staff_confirmed", { reservationId });
        await deps.alert(
          `Hold ${reservationId} is confirmed but unpaid`,
          [
            `Cloudbeds reservation ${reservationId} (online booking ${rec.ref}) was an unpaid online hold (${reason}), but it was confirmed in Cloudbeds since and no payment is recorded.`,
            "We did NOT cancel it. If the guest is not paying another way, cancel it in Cloudbeds so the unit goes back on sale.",
          ],
          { key: `release-confirmed:${reservationId}`, severity: "warning" },
        );
        return { state: "refused_confirmed", reservationId };
      }
    }
    await deps.writer.cancel(reservationId);
    await deps.kv.set(keys.releaseDone(reservationId), reason, DONE_TTL_SECONDS);
    await closeHold(deps.kv, reservationId);
    deps.log("hold_released", { reservationId, reason });
    return { state: "released", reservationId };
  });
  return locked.acquired ? locked.value : { state: "in_progress" };
}

/** Releases the hold of a session Stripe says can no longer be paid (expired, or delayed payment failed). */
export async function releaseSession(sessionId: string, deps: StripeDeps, reason: string): Promise<ReleaseOutcome> {
  const session = await retrieveSession(deps.stripe, sessionId);
  const meta = parseSessionMeta(session);
  if (!meta || !modeMatches(session, deps)) return { state: "not_ours" };
  const payment = sessionPaymentState(session);
  if (payment === "paid") return { state: "refused_paid", reservationId: meta.reservationId };
  if (payment === "open" || payment === "processing") return { state: "refused_open" };
  return releaseHold(meta.reservationId, deps, reason);
}

export type AbandonOutcome = { state: "released" | "paid" | "pending" | "closed" };

/**
 * The guest pressed Cancel/Back: expire the session (so it can never be paid
 * afterwards) and release the hold. A session that is already paid is
 * fulfilled instead - never cancelled.
 */
export async function abandonSession(sessionId: string, deps: StripeDeps, expectedRef: string | null = null): Promise<AbandonOutcome> {
  // Only the booking's own session may be expired (a token for booking A must never cancel booking B).
  let first: CheckoutSession;
  try {
    first = await retrieveSession(deps.stripe, sessionId);
  } catch (e) {
    // No such session (in this account and mode): nothing can be paid or expired. Network/5xx errors rethrow.
    if (isMissingSessionError(e)) return { state: "closed" };
    throw e;
  }
  const firstMeta = parseSessionMeta(first);
  if (!firstMeta || !modeMatches(first, deps) || (expectedRef !== null && firstMeta.ref !== expectedRef)) return { state: "closed" };
  try {
    await deps.stripe.checkout.sessions.expire(sessionId);
    await deps.kv.set(keys.abandoned(sessionId), "1", 2 * 24 * 3600);
  } catch (e) {
    if (!isNotOpenError(e)) throw e; // network/5xx: let the caller answer an error; the sweeper covers it
  }
  const session = await retrieveSession(deps.stripe, sessionId);
  const meta = parseSessionMeta(session);
  if (!meta || !modeMatches(session, deps)) return { state: "closed" };
  const payment = sessionPaymentState(session);
  if (payment === "paid") {
    await fulfilSession(sessionId, deps).catch((e) => alertFulfilFailure(deps, sessionId, e));
    return { state: "paid" };
  }
  if (payment === "processing" || payment === "open") return { state: "pending" };
  const released = await releaseHold(meta.reservationId, deps, "guest abandoned checkout");
  return { state: released.state === "released" ? "released" : "closed" };
}

/** Where the session id for a booking ref was recorded at checkout (status/abandon fallback). */
export async function bookingPointer(deps: Pick<StripeDeps, "kv">, ref: string): Promise<BookingPointer | null> {
  return readJson<BookingPointer>(deps.kv, keys.booking(ref));
}

export async function holdRecord(deps: Pick<StripeDeps, "kv">, reservationId: string): Promise<HoldRecord | null> {
  return readJson<HoldRecord>(deps.kv, keys.hold(reservationId));
}

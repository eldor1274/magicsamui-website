// Safety net (WI-7): reconciles Stripe sessions and Cloudbeds holds that a
// dropped webhook, a timeout or a crash left behind. Run every ~10 minutes
// (POST/GET /api/booking/sweep with the sweep secret - the droplet cron, or a
// Vercel cron on Pro; Hobby crons only run daily).
//
// 1. Stripe sessions created in the last 48 h that are ours (this mode):
//    paid -> fulfil (no-op once done); expired / delayed-payment failed -> release.
// 2. Holds, from three sources, each with an age WE can vouch for:
//    a. our open-holds index (age = our own createdAt);
//    b. hold INTENTS (written before postReservation): an attempt whose answer
//       never arrived is matched to the Cloudbeds reservation by its
//       thirdPartyIdentifier (age = the intent's createdAt);
//    c. Cloudbeds' own list of reservations created in the window, in ANY
//       non-cancelled status (API bookings may come back "confirmed"), whose
//       thirdPartyIdentifier is ours AND of this mode (live vs -TEST); age =
//       our record if we have one, else Cloudbeds' creation time read
//       cautiously (never older than it could be).
//    Only holds older than the session lifetime (+ margin) are considered:
//    a paid session -> fulfil; an open one -> leave; otherwise -> release.
// A hold is NEVER released while any session for it is paid (release refuses),
// nor when it carries our paid marker or the folio shows a payment. A
// CONFIRMED reservation with an MSV id that we have no record or intent of
// is never cancelled either (staff may have re-booked a guest under the ref,
// or Redis lost the record): the owner is told once instead.
// A paid hold stays in the index until fulfil's done marker exists, so a paid
// booking whose confirmation keeps failing is retried on every run.
// 1b. Paid sessions still unconfirmed (the paid index, no time limit): retried
//    beyond the 48 h Stripe lookback, and escalated to a CRITICAL alert once
//    paid for PAID_UNCONFIRMED_ESCALATE_MS.
// 2d. Index hygiene: entries whose hold record expired, or older than
//    INDEX_PRUNE_MS (other-mode leftovers, releases that kept failing) are
//    dropped (the latter with an alert); an index that keeps growing alerts.
// 3. Critical alerts that were never delivered are re-sent (alerts.ts).
//
// The run only counts as a sweep (msv:sweep:last, which checkout watches) when
// its Cloudbeds side worked: a sweeper that can't list Cloudbeds reservations
// can't find orphan holds, so it alerts after a few failed runs in a row and
// the route answers 502 (the cron's curl -f then fails visibly).

import { resendPendingAlerts } from "./alerts.ts";
import { redactForLog } from "./cloudbedsWrite.ts";
import type { ListedReservation } from "./cloudbedsWrite.ts";
import { PAID_UNCONFIRMED_ESCALATE_MS, alertFulfilFailure, alertPaidStuck, fulfilSession, holdRecord, releaseHold } from "./fulfil.ts";
import { closeHold, closeIntent, keyScope, keys, parseHoldIdentifier, readJson, recordHold } from "./lock.ts";
import type { HoldIntent, PaidPending } from "./lock.ts";
import { listRecentSessions, parseSessionMeta, retrieveSession, sessionPaymentState } from "./payments/stripe.ts";
import type { CheckoutSession, SessionPaymentState } from "./payments/stripe.ts";
import type { StripeDeps } from "./stripeDeps.ts";
import { nowOf } from "./stripeDeps.ts";

export const SWEEP_LOOKBACK_MS = 48 * 3600_000;
/** A hold older than this with no payable session is released (30 min session + margin). */
export const STALE_HOLD_MS = 40 * 60_000;
/** Cloudbeds' getReservations window is sent as Bangkok time but its zone is undocumented: pad by this much. */
export const WINDOW_PAD_MS = 8 * 3600_000;
/** An intent whose reservation never shows up in Cloudbeds is dropped after this long. */
export const INTENT_GIVE_UP_MS = 12 * 3600_000;
/** A hold that still can't be released this long after creation triggers an alert. */
export const RELEASE_ALERT_AGE_MS = 60 * 60_000;
/** Checkout alerts (live) when the last successful sweep is older than this. */
export const SWEEP_STALE_ALERT_MS = 30 * 60_000;
/** Consecutive runs whose Cloudbeds listing failed before the owner is alerted. */
export const CLOUDBEDS_FAILURE_ALERT_RUNS = 3;
/** Open-holds index entries older than this are dropped (with an alert when they are this mode's). */
export const INDEX_PRUNE_MS = 7 * 24 * 3600_000;
/** The open-holds index holding more entries than this alerts the owner (it should hold a handful). */
export const INDEX_SIZE_ALERT = 50;

export interface SweepSummary {
  sessionsChecked: number;
  fulfilled: number;
  released: number;
  holdsChecked: number;
  skippedOpen: number;
  /** Candidates younger than STALE_HOLD_MS (or of unknown age): left for a later run. */
  skippedYoung: number;
  /** Records written by the other Stripe mode (test vs live) sharing this Redis: never touched. */
  skippedOtherMode: number;
  /** Unpaid holds still open after this run (index + unresolved intents) - 0 before any provider/key change. */
  openHolds: number;
  errors: number;
  /** False when the Cloudbeds listing failed: orphan holds could not be looked for this run. */
  cloudbedsOk: boolean;
  /** Critical alerts still undelivered at the start of this run (re-sent now). */
  undeliveredAlerts: number;
  /** Paid sessions still not confirmed in Cloudbeds after this run (should be 0). */
  paidUnconfirmed: number;
  /** Stale open-holds index entries dropped this run. */
  pruned: number;
}

interface Candidate {
  reservationId: string;
  createdMs: number;
  ref: string | null;
  /** Found through a hold intent (an attempt whose answer never arrived): alert on any release failure. */
  fromIntent?: boolean;
  /** Read from our open-holds index. */
  indexed?: boolean;
  /** Indexed, but its hold record is gone (expired after 30 days, or lost). */
  recordMissing?: boolean;
}

export async function runSweep(deps: StripeDeps): Promise<SweepSummary> {
  const now = nowOf(deps);
  const summary: SweepSummary = {
    sessionsChecked: 0,
    fulfilled: 0,
    released: 0,
    holdsChecked: 0,
    skippedOpen: 0,
    skippedYoung: 0,
    skippedOtherMode: 0,
    openHolds: 0,
    errors: 0,
    cloudbedsOk: true,
    undeliveredAlerts: 0,
    paidUnconfirmed: 0,
    pruned: 0,
  };
  const mode = deps.config.paymentMode;
  const scope = keyScope(mode);
  const wantLive = deps.config.stripe?.livemode ?? false;
  const liveTag = mode === "stripe-live";

  // 1. Stripe side.
  const byReservation = new Map<string, { session: CheckoutSession; state: SessionPaymentState }[]>();
  /** Paid sessions step 1 already ran fulfil for (successfully or not) this run. */
  const triedPaid = new Set<string>();
  const sessions = await listRecentSessions(deps.stripe, now - SWEEP_LOOKBACK_MS);
  for (const listed of sessions) {
    const meta = parseSessionMeta(listed);
    if (!meta || listed.livemode !== wantLive) continue;
    summary.sessionsChecked++;
    try {
      // List entries don't expand the PaymentIntent; re-read when the state depends on it.
      const session = listed.status === "complete" && listed.payment_status === "unpaid" ? await retrieveSession(deps.stripe, listed.id) : listed;
      const state = sessionPaymentState(session);
      const list = byReservation.get(meta.reservationId) ?? [];
      list.push({ session, state });
      byReservation.set(meta.reservationId, list);
      if (state === "paid") {
        if ((await deps.kv.get(keys.fulfilDone(session.id))) !== null) continue;
        triedPaid.add(session.id);
        const outcome = await fulfilSession(session.id, deps);
        if (outcome.state === "confirmed" && !outcome.alreadyDone) summary.fulfilled++;
      } else if (state === "expired" || state === "failed") {
        if ((await deps.kv.get(keys.releaseDone(meta.reservationId))) !== null) continue;
        // Another session may exist for the same hold (never in practice: one session per hold).
        const r = await releaseHold(meta.reservationId, deps, `sweeper: session ${state}`);
        if (r.state === "released") summary.released++;
      }
    } catch (e) {
      summary.errors++;
      if (listed.payment_status === "paid") await alertFulfilFailure(deps, listed.id, e).catch(() => undefined);
      else deps.log("sweep_session_error", { sessionId: listed.id, error: redactForLog(e instanceof Error ? e.message : String(e)) });
    }
  }

  // 1b. Paid sessions fulfil has not finished (no time limit: beyond the 48 h lookback and Stripe's retries).
  for (const sessionId of await deps.kv.zrangeByScore(keys.paidIndex(scope), 0, Number.MAX_SAFE_INTEGER, 50)) {
    if ((await deps.kv.get(keys.fulfilDone(sessionId))) !== null) {
      await deps.kv.zrem(keys.paidIndex(scope), sessionId);
      continue;
    }
    const paid = await readJson<PaidPending>(deps.kv, keys.paidPending(sessionId));
    if (!paid) {
      await deps.kv.zrem(keys.paidIndex(scope), sessionId); // record expired (30 days)
      continue;
    }
    if (triedPaid.has(sessionId)) {
      // Step 1 already tried it this run (and alerted on a failure): only escalate a long-stuck one.
      summary.paidUnconfirmed++;
      if (now - paid.paidAt >= PAID_UNCONFIRMED_ESCALATE_MS) {
        await alertPaidStuck(deps, paid, `${Math.round((now - paid.paidAt) / 60_000)} minutes`).catch(() => undefined);
      }
      continue;
    }
    triedPaid.add(sessionId);
    try {
      const outcome = await fulfilSession(sessionId, deps);
      if (outcome.state === "confirmed" || outcome.state === "needs_attention") {
        if (outcome.state === "confirmed" && !outcome.alreadyDone) summary.fulfilled++;
        continue;
      }
      summary.paidUnconfirmed++;
      if (now - paid.paidAt >= PAID_UNCONFIRMED_ESCALATE_MS) {
        await alertPaidStuck(deps, paid, `${Math.round((now - paid.paidAt) / 60_000)} minutes (fulfil: ${outcome.state})`).catch(() => undefined);
      }
    } catch (e) {
      summary.errors++;
      summary.paidUnconfirmed++;
      await alertFulfilFailure(deps, sessionId, e).catch(() => undefined);
    }
  }

  // 2. Hold side.
  const candidates = new Map<string, Candidate>();
  const add = (c: Candidate) => {
    if (!candidates.has(c.reservationId)) candidates.set(c.reservationId, c);
  };

  // 2a. Our open-holds index (score = our createdAt, so only stale ones are read).
  // Oldest first; 2d below keeps the index small, so the 200 read here are the ones that matter.
  for (const reservationId of await deps.kv.zrangeByScore(keys.holdIndex(), 0, now - STALE_HOLD_MS, 200)) {
    const rec = await holdRecord(deps, reservationId);
    if (rec && rec.mode !== mode) {
      summary.skippedOtherMode++;
      // Another mode's leftover (e.g. a Stage B hold after the test phase): never touched, only dropped from the index late.
      if (now - rec.createdAt > INDEX_PRUNE_MS) {
        await closeHold(deps.kv, reservationId);
        summary.pruned++;
      }
      continue;
    }
    add({ reservationId, createdMs: rec?.createdAt ?? now - STALE_HOLD_MS, ref: rec?.ref ?? null, indexed: true, recordMissing: rec === null });
  }

  // 2c (read first: 2b matches intents against it). Every reservation Cloudbeds created in the window.
  let listed: ListedReservation[] | null = null;
  try {
    listed = await deps.writer.findHolds(now - SWEEP_LOOKBACK_MS - WINDOW_PAD_MS, now + WINDOW_PAD_MS);
    await deps.kv.del(keys.sweepCloudbedsFailures(keyScope(deps.config.paymentMode))).catch(() => undefined);
  } catch (e) {
    summary.errors++;
    summary.cloudbedsOk = false;
    const error = redactForLog(e instanceof Error ? e.message : String(e));
    deps.log("sweep_find_holds_failed", { error });
    await noteCloudbedsFailure(deps, error);
  }
  const ours = (listed ?? []).filter((r) => {
    const id = parseHoldIdentifier(r.thirdPartyIdentifier);
    if (!id) return false;
    if (id.live !== liveTag) {
      summary.skippedOtherMode++;
      return false;
    }
    return r.status === "not_confirmed" || r.status === "confirmed";
  });

  // 2b. Intents: attempts whose postReservation answer never arrived (or a crash right after it).
  const intentAge = new Map<string, number>(); // identifier -> createdAt
  for (const ref of await deps.kv.zrangeByScore(keys.intentIndex(), 0, now - STALE_HOLD_MS, 200)) {
    const intent = await readJson<HoldIntent>(deps.kv, keys.intent(ref));
    if (!intent) {
      await closeIntent(deps.kv, ref);
      continue;
    }
    if (intent.mode !== mode) {
      summary.skippedOtherMode++;
      continue;
    }
    if (intent.reservationId) {
      await adoptOrphan(deps, intent, intent.reservationId);
      add({ reservationId: intent.reservationId, createdMs: intent.createdAt, ref, fromIntent: true });
      await closeIntent(deps.kv, ref);
      continue;
    }
    if (listed === null) {
      summary.openHolds++; // Cloudbeds unreachable: unresolved, try again next run
      continue;
    }
    const match = listed.filter((r) => r.thirdPartyIdentifier === intent.identifier);
    const live = match.filter((r) => r.status === "not_confirmed" || r.status === "confirmed");
    intentAge.set(intent.identifier, intent.createdAt);
    // Each match becomes a hold record carrying the INTENT's age (one we can vouch for), so a release that
    // fails now is retried by later runs on that age - never on Cloudbeds' own creation time.
    for (const r of live) {
      await adoptOrphan(deps, intent, r.reservationId);
      add({ reservationId: r.reservationId, createdMs: intent.createdAt, ref, fromIntent: true });
    }
    if (live.length > 0 || match.length > 0) {
      await closeIntent(deps.kv, ref); // tracked through its hold record from now on
      deps.log("sweep_intent_matched", { ref, reservations: match.length });
    } else if (now - intent.createdAt > INTENT_GIVE_UP_MS) {
      await closeIntent(deps.kv, ref); // Cloudbeds never listed it
      deps.log("sweep_intent_dropped", { ref });
      await deps
        .alert(
          `Booking attempt ${ref}: no Cloudbeds reservation found`,
          [
            `An online booking attempt (${ref}) got no clear answer from Cloudbeds ${Math.round((now - intent.createdAt) / 3_600_000)} hours ago, and no reservation with third-party id ${intent.identifier} has shown up since. The sweeper has stopped looking for it.`,
            `Please check Cloudbeds by hand for a reservation with third-party id ${intent.identifier} and cancel it if it exists (nobody paid for it).`,
          ],
          { key: `intent-dropped:${ref}`, severity: "warning" },
        )
        .catch(() => undefined);
    } else {
      summary.openHolds++;
    }
  }

  // 2c. Cloudbeds' list: only with an age we can vouch for.
  for (const r of ours) {
    if (candidates.has(r.reservationId)) continue;
    const rec = await holdRecord(deps, r.reservationId);
    if (rec && rec.mode !== mode) {
      summary.skippedOtherMode++;
      continue;
    }
    const intentCreated = intentAge.get(r.thirdPartyIdentifier ?? "");
    const createdMs = rec?.createdAt ?? intentCreated ?? r.createdMs;
    if (createdMs === null || now - createdMs < STALE_HOLD_MS) {
      summary.skippedYoung++;
      if (createdMs === null) deps.log("sweep_hold_unknown_age", { reservationId: r.reservationId });
      continue;
    }
    if (!rec && intentCreated === undefined && r.status !== "not_confirmed") {
      // A CONFIRMED reservation carrying one of our ids that we never recorded: staff may have re-booked a
      // paid guest under the ref, or Redis lost the record. Never cancel it - tell the owner once.
      await reportConfirmedWithoutRecord(deps, scope, r);
      continue;
    }
    add({ reservationId: r.reservationId, createdMs, ref: parseHoldIdentifier(r.thirdPartyIdentifier)?.ref ?? null });
  }

  for (const c of candidates.values()) {
    const { reservationId } = c;
    summary.holdsChecked++;
    try {
      if (now - c.createdMs < STALE_HOLD_MS) {
        summary.skippedYoung++;
        continue;
      }
      if (c.recordMissing) {
        // Its hold record expired (30 days) or is gone: nothing we can vouch for - drop it from the index.
        await closeHold(deps.kv, reservationId);
        summary.pruned++;
        deps.log("sweep_index_pruned", { reservationId, reason: "no record" });
        continue;
      }
      if ((await deps.kv.get(keys.releaseDone(reservationId))) !== null) {
        await closeHold(deps.kv, reservationId);
        continue;
      }
      const paidSession = await deps.kv.get(keys.reservationPaid(reservationId));
      if (paidSession !== null) {
        // Paid: fulfil owns it, and its done marker closes the hold. Until then retry it here, on every run.
        if ((await deps.kv.get(keys.fulfilDone(paidSession))) !== null) {
          await closeHold(deps.kv, reservationId);
        } else if (!triedPaid.has(paidSession)) {
          triedPaid.add(paidSession);
          try {
            const outcome = await fulfilSession(paidSession, deps);
            if (outcome.state === "confirmed" && !outcome.alreadyDone) summary.fulfilled++;
          } catch (e) {
            summary.errors++;
            await alertFulfilFailure(deps, paidSession, e).catch(() => undefined);
          }
        }
        continue;
      }
      const seen = byReservation.get(reservationId) ?? [];
      const rec = await holdRecord(deps, reservationId);
      if (rec?.sessionId && !seen.some((x) => x.session.id === rec.sessionId)) {
        const session = await retrieveSession(deps.stripe, rec.sessionId);
        seen.push({ session, state: sessionPaymentState(session) });
      }
      const paid = seen.find((x) => x.state === "paid");
      if (paid) {
        const outcome = await fulfilSession(paid.session.id, deps);
        if (outcome.state === "confirmed" && !outcome.alreadyDone) summary.fulfilled++;
        continue;
      }
      if (seen.some((x) => x.state === "open" || x.state === "processing")) {
        summary.skippedOpen++;
        summary.openHolds++;
        continue;
      }
      // No payable session (expired/failed, or none was ever created): release.
      const r = await releaseHold(reservationId, deps, "sweeper: stale hold");
      if (r.state === "released") summary.released++;
      if (r.state === "already_released" || r.state === "released" || r.state === "refused_paid" || r.state === "refused_confirmed") {
        await closeHold(deps.kv, reservationId);
      } else {
        summary.openHolds++;
      }
    } catch (e) {
      summary.errors++;
      summary.openHolds++;
      const error = redactForLog(e instanceof Error ? e.message : String(e));
      deps.log("sweep_hold_error", { reservationId, error });
      // An orphan from a lost postReservation answer is already past the session lifetime: alert at once.
      if (c.fromIntent || now - c.createdMs >= RELEASE_ALERT_AGE_MS) {
        await deps
          .alert(
            `Hold ${reservationId} could not be released`,
            [
              `The sweeper could not release Cloudbeds reservation ${reservationId}${c.ref ? ` (booking ${c.ref})` : ""}, created ${Math.round((now - c.createdMs) / 60_000)} minutes ago: ${error.slice(0, 200)}`,
              "The unit may stay blocked on the OTAs. If nobody paid for it, cancel it in Cloudbeds by hand.",
            ],
            { key: `release-fail:${reservationId}`, severity: "warning" },
          )
          .catch(() => undefined);
      }
      if (c.indexed && now - c.createdMs > INDEX_PRUNE_MS) {
        // A week of failed releases: stop retrying so it can't crowd out new holds; the owner was alerted.
        await closeHold(deps.kv, reservationId).catch(() => undefined);
        summary.pruned++;
        await deps
          .alert(
            `Stopped tracking hold ${reservationId}`,
            [
              `The sweeper could not release Cloudbeds reservation ${reservationId}${c.ref ? ` (booking ${c.ref})` : ""} for over ${Math.round(INDEX_PRUNE_MS / 86_400_000)} days and has stopped retrying it.`,
              "Check it in Cloudbeds by hand: cancel it if nobody paid for it.",
            ],
            { key: `index-pruned:${reservationId}`, severity: "warning" },
          )
          .catch(() => undefined);
      }
    }
  }

  // 2d. The open-holds index should hold a handful of entries: a growing one means something keeps failing.
  const indexSize = (await deps.kv.zrangeByScore(keys.holdIndex(), 0, Number.MAX_SAFE_INTEGER, INDEX_SIZE_ALERT + 1)).length;
  if (indexSize > INDEX_SIZE_ALERT) {
    await deps
      .alert(
        "The booking sweeper's hold index keeps growing",
        [
          `More than ${INDEX_SIZE_ALERT} holds are listed as open in Redis (msv:holds:open). Releases may be failing, or another mode's holds were left behind.`,
          "Check the sweeper's answers (errors, skippedOtherMode) and the Vercel logs (sweep_hold_error).",
        ],
        { key: "hold-index-size", severity: "warning" },
      )
      .catch(() => undefined);
  }

  // Unpaid holds still open (fresh ones the stale query above did not read).
  summary.openHolds += (await deps.kv.zrangeByScore(keys.holdIndex(), now - STALE_HOLD_MS, now + 3_600_000, 200)).length;
  summary.openHolds += (await deps.kv.zrangeByScore(keys.intentIndex(), now - STALE_HOLD_MS, now + 3_600_000, 200)).length;

  // 3. Critical alerts that never reached the owner (this mode's only).
  try {
    summary.undeliveredAlerts = await resendPendingAlerts(deps, scope, now);
  } catch (e) {
    summary.errors++;
    deps.log("sweep_alert_resend_failed", { error: redactForLog(e instanceof Error ? e.message : String(e)) });
  }

  // Only a run that could look for orphan holds in Cloudbeds counts as a sweep.
  if (summary.cloudbedsOk) await deps.kv.set(keys.lastSweep(scope), String(now), 7 * 24 * 3600).catch(() => undefined);
  deps.log("sweep_done", { ...summary });
  return summary;
}

/** Tells the owner (once per reservation) about a confirmed MSV reservation we hold no record or intent of. */
async function reportConfirmedWithoutRecord(deps: StripeDeps, scope: string, r: ListedReservation): Promise<void> {
  try {
    if (!(await deps.kv.setNx(keys.noRecordReported(scope, r.reservationId), "1", 30 * 24 * 3600))) return;
    deps.log("sweep_confirmed_without_record", { reservationId: r.reservationId, status: r.status });
    await deps.alert(
      `Reservation ${r.reservationId} carries an online-booking id we have no record of`,
      [
        `Cloudbeds reservation ${r.reservationId} (third-party id ${r.thirdPartyIdentifier ?? "-"}, status ${r.status}) looks like one of our online bookings, but the booking engine has no record of it, so the sweeper did NOT cancel it.`,
        "If staff re-booked a guest under this reference, make sure the guest's payment is on its folio. If it is an unpaid leftover, cancel it in Cloudbeds so the unit goes back on sale.",
      ],
      { key: `no-record:${r.reservationId}`, severity: "warning" },
    );
  } catch {
    // Best effort only.
  }
}

/** Turns an orphan found through an intent into a hold record with the intent's (trusted) age. */
async function adoptOrphan(deps: StripeDeps, intent: HoldIntent, reservationId: string): Promise<void> {
  if (await holdRecord(deps, reservationId)) return;
  await recordHold(deps.kv, { ref: intent.ref, reservationId, sessionId: null, createdAt: intent.createdAt, mode: intent.mode }).catch((e) =>
    deps.log("sweep_adopt_failed", { ref: intent.ref, reservationId, error: redactForLog(e instanceof Error ? e.message : String(e)) }),
  );
}

/** Counts consecutive failed Cloudbeds listings; alerts once a few runs in a row failed. */
async function noteCloudbedsFailure(deps: StripeDeps, error: string): Promise<void> {
  try {
    const n = Number(await deps.kv.get(keys.sweepCloudbedsFailures(keyScope(deps.config.paymentMode)))) + 1;
    await deps.kv.set(keys.sweepCloudbedsFailures(keyScope(deps.config.paymentMode)), String(n), 24 * 3600);
    if (n < CLOUDBEDS_FAILURE_ALERT_RUNS) return;
    await deps.alert(
      "The booking sweeper cannot read Cloudbeds reservations",
      [
        `${n} sweeper runs in a row could not list Cloudbeds reservations (getReservations): ${error.slice(0, 200)}`,
        "While this lasts, holds whose Cloudbeds answer was lost are NOT found or released, so a unit can stay blocked on Booking.com and Airbnb. Check the booking API key (read:reservation scope) and Cloudbeds' status.",
      ],
      { key: "sweep-cloudbeds-failing", severity: "warning" },
    );
  } catch {
    // Best effort only.
  }
}

// Safety net (WI-7): reconciles payments (Stripe: Checkout Sessions) and
// Cloudbeds holds that a dropped webhook, a timeout or a crash left behind. Run
// every ~10 minutes (POST/GET /api/booking/sweep with the sweep secret - the
// droplet cron, or a Vercel cron on Pro; Hobby crons only run daily).
//
// runSweep(deps, gw, opts) sweeps for ONE payment provider, reached only
// through its PaymentGateway (default: Stripe); the hold side is shared.
//
// 1. The provider's payments created in the last 48 h that are ours (this
//    mode; gw.sweepRecent - Stripe: its session list): paid -> fulfil (no-op
//    once done); expired / delayed-payment failed -> release.
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
//    a paid payment -> fulfil; an open one -> leave; otherwise -> release.
// A hold is NEVER released while any payment for it is paid (release refuses),
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
//
// Several providers (the active one, plus a drain finishing the other one's
// in-flight payments): every provider's step 1 runs first
// (sweepRecentPayments), then one runSweep per provider - the active one with
// primary: true, each drain with primary: false - handed its own step 1
// (opts.recent), the other providers' (opts.peers) and one Cloudbeds listing
// for all (opts.listed, from listSweepReservations).
// Ownership of a hold between those runs:
// - one with a record or an intent belongs to the run of its mode (any other
//   run skips it as another mode's);
// - one with neither (an orphan: Redis lost its record) can't be told apart by
//   provider, since every provider's live holds carry the plain ref. A drain run
//   never touches it (no release, no "no record" report). The primary run
//   releases it only when no provider sees a payment for it that is not over:
//   neither its own step 1 nor a peer's. Without the peers' view, a paid or
//   still-payable booking of another provider whose record was lost would be
//   cancelled before that provider's run got to it;
// - whatever its record says, the hold side never releases a hold that a peer
//   sees a paid, open, processing or refunded payment for (step 1 only ever
//   releases the hold its own provider's payment was made for).

import { resendPendingAlerts } from "./alerts.ts";
import { redactForLog } from "./cloudbedsWrite.ts";
import type { ListedReservation } from "./cloudbedsWrite.ts";
import { PAID_UNCONFIRMED_ESCALATE_MS, alertFulfilPaymentFailure, alertPaidPaymentStuck, fulfilPayment, holdRecord, releaseHold } from "./fulfil.ts";
import { closeHold, closeIntent, keyScope, keys, parseHoldIdentifier, readJson, recordHold } from "./lock.ts";
import type { HoldIntent, PaidPending } from "./lock.ts";
import type { GatewayPayment, GatewayText, PaymentGateway } from "./payments/gateway.ts";
import { isLiveMode } from "./payments/provider.ts";
import type { CheckoutSession, SessionPaymentState } from "./payments/stripe.ts";
import { stripeGateway } from "./payments/stripeGateway.ts";
import type { CoreDeps, StripeDeps } from "./stripeDeps.ts";
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

/**
 * One line for the Cloudbeds reservation note when the sweeper gives a hold back: what the guest's payment page
 * did (2026-10-20: the reason only lived in server logs, which expire). A session without a PaymentIntent was never
 * submitted; with one, a payment was started. The Stripe wording, for its callers: the sweeper itself writes
 * gw.text.releaseNoteText (STRIPE_GATEWAY_TEXT's is this text).
 */
export function releaseNoteText(sessions: { session: Pick<CheckoutSession, "payment_intent">; state: SessionPaymentState }[]): string {
  if (sessions.length === 0) {
    return "Hold released by the sweeper: no payment page was ever created (the booking page failed before Stripe). Nothing was charged.";
  }
  if (sessions.some((x) => x.state === "failed")) {
    return "Hold released by the sweeper: a payment was attempted on the Stripe page but did not go through. Nothing was charged.";
  }
  const attempted = sessions.some((x) => x.session.payment_intent !== null && x.session.payment_intent !== undefined);
  return attempted
    ? "Hold released by the sweeper: the Stripe payment page was opened and a payment was started but never completed. Nothing was charged."
    : "Hold released by the sweeper: the Stripe payment page was created but no payment was ever attempted. Nothing was charged.";
}

async function noteRelease(deps: CoreDeps, reservationId: string, text: string): Promise<void> {
  await deps.writer.addNote(reservationId, text).catch((e) => deps.log("release_note_failed", { reservationId, error: redactForLog(e instanceof Error ? e.message : String(e)) }));
}

/** The release note in the words of the provider whose payment page the hold had: a peer's when only a peer saw one. */
function releaseNote(text: GatewayText, seen: GatewayPayment[], peers: RecentPayments[], reservationId: string): string {
  if (seen.length === 0) {
    for (const peer of peers) {
      const theirs = peer.byReservation.get(reservationId) ?? [];
      if (theirs.length > 0) return peer.text.releaseNoteText(theirs);
    }
  }
  return text.releaseNoteText(seen);
}

export interface SweepSummary {
  sessionsChecked: number;
  fulfilled: number;
  released: number;
  holdsChecked: number;
  skippedOpen: number;
  /** Candidates younger than STALE_HOLD_MS (or of unknown age): left for a later run. */
  skippedYoung: number;
  /** Records written by another mode (test vs live, or another provider's) sharing this Redis: never touched. */
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
  /** Found only in Cloudbeds' list: neither a record nor an intent of ours names its provider (primary run only). */
  orphan?: boolean;
}

/**
 * What one provider's step 1 saw (sweepRecentPayments): read by the hold side of that provider's own run, and
 * by the other providers' runs as a peer.
 */
export interface RecentPayments {
  /** The provider's words (a release note about its payment page is written in them). */
  text: GatewayText;
  /** Its recent payments of ours (this mode), by Cloudbeds reservation. */
  byReservation: Map<string, GatewayPayment[]>;
  /** Paid payments step 1 already ran fulfil for (successfully or not). */
  triedPaid: Set<string>;
  /** Step 1's share of the run's summary. */
  counts: Pick<SweepSummary, "sessionsChecked" | "fulfilled" | "released" | "errors">;
}

export interface SweepOptions {
  /**
   * false for a drain run (a provider other than the active one, finishing its in-flight payments): it never
   * touches an orphan hold (no record, no intent) - see "Ownership" above. Default true.
   */
  primary?: boolean;
  /**
   * Cloudbeds' reservations of the sweep window from earlier in the same request (listSweepReservations, taken
   * after every step 1): not listed again. A hold an earlier run released since is skipped by its release marker.
   */
  listed?: ListedReservation[];
  /** This run's own step 1, already run by the caller (so the other runs could see it first): not run again. */
  recent?: RecentPayments;
  /**
   * The other configured providers' step 1, run before this hold side. A hold any of them sees a payment for
   * that is not over (paid, open, processing, refunded) is never released by this run. Every run that shares
   * Cloudbeds with another provider's run needs them: the primary run releases orphans on what it can see.
   */
  peers?: RecentPayments[];
}

/** Cloudbeds' reservations of the sweep window (step 2c). One listing can serve every run of a request (opts.listed). */
export function listSweepReservations(deps: Pick<CoreDeps, "writer">, nowMs: number): Promise<ListedReservation[]> {
  return deps.writer.findHolds(nowMs - SWEEP_LOOKBACK_MS - WINDOW_PAD_MS, nowMs + WINDOW_PAD_MS);
}

/**
 * Step 1 for one provider: its payments of ours (this mode) created in the lookback window. Paid -> fulfil
 * (no-op once done); expired / failed -> release, with a note on the reservation. Throws when the provider
 * can't list them (the whole run fails, as before the gateway).
 */
export async function sweepRecentPayments(deps: CoreDeps, gw: PaymentGateway, nowMs: number = nowOf(deps)): Promise<RecentPayments> {
  const recent: RecentPayments = { text: gw.text, byReservation: new Map(), triedPaid: new Set(), counts: { sessionsChecked: 0, fulfilled: 0, released: 0, errors: 0 } };
  const { byReservation, triedPaid, counts } = recent;
  for (const listed of await gw.sweepRecent(nowMs - SWEEP_LOOKBACK_MS)) {
    counts.sessionsChecked++;
    try {
      const payment = await listed.read();
      const list = byReservation.get(listed.reservationId) ?? [];
      list.push(payment);
      byReservation.set(listed.reservationId, list);
      if (payment.state === "paid") {
        if ((await deps.kv.get(keys.fulfilDone(listed.key))) !== null) continue;
        triedPaid.add(listed.key);
        const outcome = await fulfilPayment(listed.key, deps, gw);
        if (outcome.state === "confirmed" && !outcome.alreadyDone) counts.fulfilled++;
      } else if (payment.state === "expired" || payment.state === "failed") {
        if ((await deps.kv.get(keys.releaseDone(listed.reservationId))) !== null) continue;
        // Another payment may exist for the same hold (never in practice: one payment page per hold).
        const r = await releaseHold(listed.reservationId, deps, `sweeper: ${gw.text.sessionLabel.short} ${payment.state}`);
        if (r.state === "released") {
          counts.released++;
          await noteRelease(deps, listed.reservationId, gw.text.releaseNoteText(list));
        }
      }
    } catch (e) {
      counts.errors++;
      if (listed.listedPaid) await alertFulfilPaymentFailure(deps, gw, listed.key, e).catch(() => undefined);
      else deps.log("sweep_session_error", { sessionId: listed.key, error: redactForLog(e instanceof Error ? e.message : String(e)) });
    }
  }
  return recent;
}

/** One sweep for the Stripe deployment (gw = Stripe, the primary run): what the route runs today. */
export function runSweep(deps: StripeDeps, gw?: PaymentGateway, opts?: SweepOptions): Promise<SweepSummary>;
/** One sweep for the provider `gw` (see "Several providers" above for the options). */
export function runSweep(deps: CoreDeps, gw: PaymentGateway, opts?: SweepOptions): Promise<SweepSummary>;
export async function runSweep(deps: CoreDeps, gw: PaymentGateway = stripeGateway(deps as StripeDeps), opts: SweepOptions = {}): Promise<SweepSummary> {
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
  const liveTag = isLiveMode(mode);
  const primary = opts.primary ?? true;
  const peers = opts.peers ?? [];

  // 1. Provider side (unless the caller already ran it, so the other providers' runs could see it first).
  const recent = opts.recent ?? (await sweepRecentPayments(deps, gw, now));
  const { byReservation } = recent;
  /** Paid payments step 1 already ran fulfil for (successfully or not) this run. */
  const triedPaid = new Set(recent.triedPaid);
  summary.sessionsChecked = recent.counts.sessionsChecked;
  summary.fulfilled = recent.counts.fulfilled;
  summary.released = recent.counts.released;
  summary.errors = recent.counts.errors;

  // 1b. Paid payments fulfil has not finished (no time limit: beyond the 48 h lookback and the provider's retries).
  for (const key of await deps.kv.zrangeByScore(keys.paidIndex(scope), 0, Number.MAX_SAFE_INTEGER, 50)) {
    if ((await deps.kv.get(keys.fulfilDone(key))) !== null) {
      await deps.kv.zrem(keys.paidIndex(scope), key);
      continue;
    }
    const paid = await readJson<PaidPending>(deps.kv, keys.paidPending(key));
    if (!paid) {
      await deps.kv.zrem(keys.paidIndex(scope), key); // record expired (30 days)
      continue;
    }
    if (triedPaid.has(key)) {
      // Step 1 already tried it this run (and alerted on a failure): only escalate a long-stuck one.
      summary.paidUnconfirmed++;
      if (now - paid.paidAt >= PAID_UNCONFIRMED_ESCALATE_MS) {
        await alertPaidPaymentStuck(deps, gw, paid, `${Math.round((now - paid.paidAt) / 60_000)} minutes`).catch(() => undefined);
      }
      continue;
    }
    triedPaid.add(key);
    try {
      const outcome = await fulfilPayment(key, deps, gw);
      if (outcome.state === "confirmed" || outcome.state === "needs_attention") {
        if (outcome.state === "confirmed" && !outcome.alreadyDone) summary.fulfilled++;
        continue;
      }
      summary.paidUnconfirmed++;
      if (now - paid.paidAt >= PAID_UNCONFIRMED_ESCALATE_MS) {
        await alertPaidPaymentStuck(deps, gw, paid, `${Math.round((now - paid.paidAt) / 60_000)} minutes (fulfil: ${outcome.state})`).catch(() => undefined);
      }
    } catch (e) {
      summary.errors++;
      summary.paidUnconfirmed++;
      await alertFulfilPaymentFailure(deps, gw, key, e).catch(() => undefined);
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
    listed = opts.listed ?? (await listSweepReservations(deps, now));
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
  /** Identifiers of other modes' unresolved attempts: their reservations are those modes' runs' to adopt. */
  const otherModeIntents = new Set<string>();
  for (const ref of await deps.kv.zrangeByScore(keys.intentIndex(), 0, now - STALE_HOLD_MS, 200)) {
    const intent = await readJson<HoldIntent>(deps.kv, keys.intent(ref));
    if (!intent) {
      await closeIntent(deps.kv, ref);
      continue;
    }
    if (intent.mode !== mode) {
      summary.skippedOtherMode++;
      otherModeIntents.add(intent.identifier);
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
    if (!rec && intentCreated === undefined && otherModeIntents.has(r.thirdPartyIdentifier ?? "")) {
      // Another mode's attempt whose answer was lost (live holds of every provider carry the same plain ref).
      summary.skippedOtherMode++;
      continue;
    }
    const orphan = !rec && intentCreated === undefined;
    if (orphan && !primary) {
      // Nothing of ours names its provider: only the primary run decides (and reports) it - see "Ownership".
      deps.log("sweep_orphan_left_to_primary", { reservationId: r.reservationId });
      continue;
    }
    const createdMs = rec?.createdAt ?? intentCreated ?? r.createdMs;
    if (createdMs === null || now - createdMs < STALE_HOLD_MS) {
      summary.skippedYoung++;
      if (createdMs === null) deps.log("sweep_hold_unknown_age", { reservationId: r.reservationId });
      continue;
    }
    if (orphan && r.status !== "not_confirmed") {
      // A CONFIRMED reservation carrying one of our ids that we never recorded: staff may have re-booked a
      // paid guest under the ref, or Redis lost the record. Never cancel it - tell the owner once.
      await reportConfirmedWithoutRecord(deps, scope, r);
      continue;
    }
    add({ reservationId: r.reservationId, createdMs, ref: parseHoldIdentifier(r.thirdPartyIdentifier)?.ref ?? null, orphan });
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
      const paidKey = await deps.kv.get(keys.reservationPaid(reservationId));
      if (paidKey !== null) {
        // An orphan's paid marker may name another provider's payment: the provider that took the money
        // finishes it (its own step 1 / 1b), and release refuses the hold meanwhile.
        if (c.orphan && peers.length > 0) continue;
        // Paid: fulfil owns it, and its done marker closes the hold. Until then retry it here, on every run.
        if ((await deps.kv.get(keys.fulfilDone(paidKey))) !== null) {
          await closeHold(deps.kv, reservationId);
        } else if (!triedPaid.has(paidKey)) {
          triedPaid.add(paidKey);
          try {
            const outcome = await fulfilPayment(paidKey, deps, gw);
            if (outcome.state === "confirmed" && !outcome.alreadyDone) summary.fulfilled++;
          } catch (e) {
            summary.errors++;
            await alertFulfilPaymentFailure(deps, gw, paidKey, e).catch(() => undefined);
          }
        }
        continue;
      }
      // A copy: the step 1 view may also be another run's peer.
      const seen = [...(byReservation.get(reservationId) ?? [])];
      const rec = await holdRecord(deps, reservationId);
      if (rec?.sessionId && !seen.some((x) => x.key === rec.sessionId)) seen.push(await gw.get(rec.sessionId));
      const paid = seen.find((x) => x.state === "paid");
      if (paid) {
        const outcome = await fulfilPayment(paid.key, deps, gw);
        if (outcome.state === "confirmed" && !outcome.alreadyDone) summary.fulfilled++;
        continue;
      }
      if (seen.some((x) => x.state === "open" || x.state === "processing")) {
        summary.skippedOpen++;
        summary.openHolds++;
        continue;
      }
      // Another provider sees a payment for it that is not over (paid, open, processing, refunded): its run owns it.
      const elsewhere = peers.flatMap((p) => p.byReservation.get(reservationId) ?? []).filter((x) => x.state !== "expired" && x.state !== "failed");
      if (elsewhere.length > 0) {
        deps.log("sweep_hold_left_to_peer", { reservationId, states: elsewhere.map((x) => x.state) });
        summary.skippedOpen++;
        summary.openHolds++;
        continue;
      }
      // No payable payment at any provider (expired/failed, or none was ever created): release.
      const r = await releaseHold(reservationId, deps, "sweeper: stale hold");
      if (r.state === "released") {
        summary.released++;
        await noteRelease(deps, reservationId, releaseNote(gw.text, seen, peers, reservationId));
      }
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
async function reportConfirmedWithoutRecord(deps: CoreDeps, scope: string, r: ListedReservation): Promise<void> {
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
async function adoptOrphan(deps: CoreDeps, intent: HoldIntent, reservationId: string): Promise<void> {
  if (await holdRecord(deps, reservationId)) return;
  await recordHold(deps.kv, { ref: intent.ref, reservationId, sessionId: null, createdAt: intent.createdAt, mode: intent.mode }).catch((e) =>
    deps.log("sweep_adopt_failed", { ref: intent.ref, reservationId, error: redactForLog(e instanceof Error ? e.message : String(e)) }),
  );
}

/** Counts consecutive failed Cloudbeds listings; alerts once a few runs in a row failed. */
async function noteCloudbedsFailure(deps: CoreDeps, error: string): Promise<void> {
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

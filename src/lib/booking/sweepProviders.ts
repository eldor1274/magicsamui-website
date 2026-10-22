// One sweeper request for every configured payment provider (Beam design S4.8): the active provider and a drain
// finishing the other provider's in-flight payments, on one Cloudbeds listing. The sweep route uses it only while
// a Beam config (active or drain) exists; without one it keeps its single Stripe runSweep(deps), unchanged.
//
// sweepProviders(runs, {deadlineMs}):
// 0. The order: Stripe first, unless another provider's run is the primary (Beam is the active provider): then the
//    primary first and the drains after it (round 6), so a drain whose provider hangs can never starve the active
//    provider's sweep. The answer lists the runs Stripe first either way.
// 1. Every provider's step 1 (sweep.ts sweepRecentPayments), in that order, each in its own try/catch and time
//    slice: a step 1 must end SWEEP_HOLD_SIDE_RESERVE_MS before the deadline, so a slow provider can never eat the
//    time of the hold sides that follow.
// 2. One run per provider, in that order (sweep.ts runSweep): primary = the active provider's run, else the first
//    run (the demo, or a config error, with drains); ownsOrphans for every run (Beam holds carry '-B' and Stripe
//    holds never do, so each orphan is read by exactly one run's parser); recent = its own step 1 and peers = the
//    others', both exactly as sweepRecentPayments returned them (their unread maps included); one Cloudbeds
//    listing for every run, taken by the first run that needs it at its own listing point (where a lone run takes
//    it) and handed to every later run, its failure included. Each run keeps one clock: the time taken before its
//    step 1 is its hold side's too (SweepOptions.nowMs), as a lone run's.
//    A provider whose step 1 threw gets no hold side this request (its holds wait for the next one): only
//    sweep.ts sweepPaidAndAlerts - its step 1b and step 3, and its heartbeat when the shared listing worked,
//    except for Stripe (round 6: Stripe keeps no failure count of its own, so a Stripe run whose session list
//    failed is no sweep and checkout's stale-sweeper warning still fires). The others proceed: no hold can belong
//    to both.
// 3. Time: the first run always runs (Stripe's whenever Stripe is the active provider or none is: what the route
//    ran alone before). A later run with less than SWEEP_MIN_SLICE_MS left of its phase (step 1: its slice; the
//    hold side: the deadline) is skipped, reported, and gets nothing that request. run.open(timing) hands out the
//    provider's deps for a phase: every Beam call ends by that phase's end; Stripe ignores it, so a later Stripe run
//    (a Stripe drain behind the Beam primary) gets its Stripe client bounded here instead (stripeWithin: every
//    request's timeout is what is left of the phase, no retry), so a Stripe API that hangs fails at the phase's end.
// 4. The answer: {ok, error?, mode (the primary run's), ...the primary run's summary, runs: [{provider, mode, ok,
//    error?, skipped?, ...summary}]}, 502 when any run failed, was skipped or had cloudbedsOk false, so the cron's
//    curl -f fails visibly; every run is still attempted. Each run writes its own scope's heartbeat (sweep.ts).
//    error is the first failed run's (Stripe's first). The top level is the primary run's only: every run's
//    openHolds, errors and paidUnconfirmed are in runs[] (a drain's open holds are never at the top level).
//
// This file loads no Beam code (importGraph.test.ts): the route hands in runtime.ts getFulfilmentProviderDeps,
// whose Beam gateway loads payments/beamGateway.ts on its first Beam call.

import { redactForLog } from "./cloudbedsWrite.ts";
import type { ListedReservation } from "./cloudbedsWrite.ts";
import type { PaymentGateway, SweepLinkCounts } from "./payments/gateway.ts";
import type { StripeClient } from "./payments/stripe.ts";
import { stripeGateway } from "./payments/stripeGateway.ts";
import { listSweepReservations, runSweep, sweepPaidAndAlerts, sweepRecentPayments } from "./sweep.ts";
import type { RecentPayments, SweepSummary } from "./sweep.ts";
import type { CoreDeps, LogFn, ProviderDeps, StripeDeps } from "./stripeDeps.ts";
import { nowOf } from "./stripeDeps.ts";

/** Every step 1 ends this long before the deadline: the hold sides keep at least this much of the budget. */
export const SWEEP_HOLD_SIDE_RESERVE_MS = 20_000;
/** A run after the first is skipped when less than this is left of its phase (it could not finish its provider calls). */
export const SWEEP_MIN_SLICE_MS = 5_000;

/** A phase's end on the deadline's clock (runtime.ts BeamTiming): every Beam call of the phase gets what is left of it. */
export interface SweepTiming {
  deadlineMs: number;
  /** Default Date.now. */
  clock?: () => number;
}

export interface SweepRun {
  provider: PaymentGateway["provider"];
  /** The active provider's run. When no run is, the first run is primary. */
  primary?: boolean;
  /**
   * The provider's deps and gateway for one phase (step 1, then the hold side): every provider call ends by
   * timing.deadlineMs (runtime.ts getFulfilmentProviderDeps; Stripe ignores it, and a later Stripe run is bounded
   * by sweepProviders itself). A throw fails the run.
   */
  open(timing: SweepTiming): ProviderDeps;
}

/**
 * payments_unavailable: its step 1 threw (only sweepPaidAndAlerts ran); cloudbeds_unavailable: the shared listing
 * failed; out_of_time: skipped; sweep_failed: its deps could not be built, or its run threw.
 */
export type SweepRunError = "payments_unavailable" | "cloudbeds_unavailable" | "out_of_time" | "sweep_failed";

export type SweepRunReport = {
  provider: PaymentGateway["provider"];
  /** Its deps' payment mode; null when they could not be built. */
  mode: string | null;
  ok: boolean;
  error?: SweepRunError;
  skipped?: "out of time";
  /** What the provider's own tracking read in its step 1 (Beam's links, round 6); at the top level too when Beam is the primary. */
  links?: SweepLinkCounts;
} & Partial<SweepSummary>;

export interface SweepProvidersAnswer {
  status: 200 | 502;
  body: { ok: boolean; error?: SweepRunError; mode: string | null; runs: SweepRunReport[] } & Partial<SweepSummary>;
}

interface RunState {
  run: SweepRun;
  report: SweepRunReport;
  /** Its step 1, when it ran and returned. */
  recent: RecentPayments | null;
  /** The run's one clock: its deps' time, taken right before its step 1. */
  nowMs: number | null;
  /** Done: failed or skipped before its hold side. */
  over: boolean;
}

/** A run report's own fields (the rest is its summary). */
const REPORT_FIELDS = new Set(["provider", "mode", "ok", "error", "skipped"]);

const messageOf = (e: unknown) => redactForLog(e instanceof Error ? e.message : String(e)).slice(0, 200);

/**
 * A Stripe client whose every request ends by timing.deadlineMs (round 6): each one is sent with what is left of the
 * phase as its timeout (re-read for every page of a list) and no network retry, and none is sent once the phase is
 * over (the call throws at once). Only the Checkout Session calls the Stripe gateway makes (list, retrieve, expire)
 * are bounded; their parameters are the caller's own.
 */
export function stripeWithin(stripe: StripeClient, timing: SweepTiming): StripeClient {
  const clock = timing.clock ?? Date.now;
  const left = () => Math.floor(timing.deadlineMs - clock());
  // A getter: the SDK reads the options again for every page of an auto-paginated list.
  const options = {
    maxNetworkRetries: 0,
    get timeout(): number {
      return Math.max(1, left());
    },
  };
  const inTime = () => {
    if (left() <= 0) throw new Error("Stripe request not sent: the sweeper run's time is up");
  };
  const real = stripe.checkout.sessions;
  const sessions: Pick<StripeClient["checkout"]["sessions"], "list" | "retrieve" | "expire"> = {
    list: (params) => {
      inTime();
      return real.list(params, options);
    },
    retrieve: (id, params) => {
      inTime();
      return real.retrieve(id, params, options);
    },
    expire: (id, params) => {
      inTime();
      return real.expire(id, params, options);
    },
  };
  const checkout = Object.create(stripe.checkout, { sessions: { value: sessions, enumerable: true } }) as StripeClient["checkout"];
  return Object.create(stripe, { checkout: { value: checkout, enumerable: true } }) as StripeClient;
}

/** A later Stripe run's deps for one phase: its client bounded by the phase's end (stripeWithin), its gateway on it. */
function stripeRunWithin(opened: ProviderDeps, timing: SweepTiming): ProviderDeps {
  const stripe = (opened.deps as Partial<StripeDeps>).stripe;
  if (opened.gw.provider !== "stripe" || !stripe) return opened;
  const deps: StripeDeps = { ...(opened.deps as StripeDeps), stripe: stripeWithin(stripe, timing) };
  return { deps, gw: stripeGateway(deps) };
}

/** Runs every provider's sweep for one request (see the top of this file). Never throws. */
export async function sweepProviders(runs: SweepRun[], opts: SweepTiming & { log: LogFn }): Promise<SweepProvidersAnswer> {
  const clock = opts.clock ?? Date.now;
  const timing = (deadlineMs: number): SweepTiming => (opts.clock ? { deadlineMs, clock: opts.clock } : { deadlineMs });
  const step1End = opts.deadlineMs - SWEEP_HOLD_SIDE_RESERVE_MS;
  // The answer's order: Stripe first (a stable sort keeps the rest in the caller's order).
  const states: RunState[] = runs
    .map((run, i) => ({ run, i }))
    .sort((a, b) => Number(b.run.provider === "stripe") - Number(a.run.provider === "stripe") || a.i - b.i)
    .map(({ run }) => ({ run, report: { provider: run.provider, mode: null, ok: true }, recent: null, nowMs: null, over: false }));
  const primary: RunState | undefined = states.find((s) => s.run.primary === true) ?? states[0];
  // The order the runs go in: the primary first when it is not Stripe's (round 6), else the answer's order.
  const order: RunState[] = primary && primary.run.provider !== "stripe" ? [primary, ...states.filter((s) => s !== primary)] : states;

  /** A run after the first with less than SWEEP_MIN_SLICE_MS left before `end`: skipped and reported. */
  const skippedForTime = (s: RunState, index: number, end: number, phase: string): boolean => {
    const leftMs = end - clock();
    if (index === 0 || leftMs >= SWEEP_MIN_SLICE_MS) return false;
    s.report = { provider: s.run.provider, mode: s.report.mode, ok: false, error: "out_of_time", skipped: "out of time" };
    s.over = true;
    opts.log("sweep_run_skipped", { provider: s.run.provider, phase, leftMs });
    return true;
  };
  const failed = (s: RunState, phase: string, e: unknown) => {
    s.report = { provider: s.run.provider, mode: s.report.mode, ok: false, error: "sweep_failed" };
    s.over = true;
    opts.log("sweep_failed", { provider: s.run.provider, phase, error: messageOf(e) });
  };
  const open = (s: RunState, index: number, end: number): ProviderDeps => {
    const opened = s.run.open(timing(end));
    s.report.mode = opened.deps.config.paymentMode;
    // The first run is what the route ran alone (or the Beam primary, whose deps carry the phase's end already).
    return index === 0 ? opened : stripeRunWithin(opened, timing(end));
  };

  // 1. Every provider's step 1, in order.
  for (const [index, s] of order.entries()) {
    let opened: ProviderDeps;
    try {
      opened = open(s, index, step1End);
    } catch (e) {
      failed(s, "step 1", e);
      continue;
    }
    if (skippedForTime(s, index, step1End, "step 1")) continue;
    s.nowMs = nowOf(opened.deps);
    try {
      s.recent = await sweepRecentPayments(opened.deps, opened.gw, s.nowMs);
    } catch (e) {
      // No hold side for it this request: only sweepPaidAndAlerts (below).
      opts.log("sweep_step1_failed", { provider: s.run.provider, mode: s.report.mode, error: messageOf(e) });
    }
  }

  // One Cloudbeds listing for every run: the first caller's (its deps, its time).
  let listing: Promise<ListedReservation[]> | null = null;
  const sharedListing =
    (deps: Pick<CoreDeps, "writer">) =>
    (nowMs: number): Promise<ListedReservation[]> =>
      (listing ??= listSweepReservations(deps, nowMs));

  // 2. One run per provider, in order.
  for (const [index, s] of order.entries()) {
    if (s.over || skippedForTime(s, index, opts.deadlineMs, "hold side")) continue;
    let opened: ProviderDeps;
    try {
      opened = open(s, index, opts.deadlineMs);
    } catch (e) {
      failed(s, "hold side", e);
      continue;
    }
    const { provider, mode } = s.report;
    const nowMs = s.nowMs ?? nowOf(opened.deps);
    try {
      if (s.recent) {
        const peers = order.filter((p) => p !== s && p.recent !== null).map((p) => p.recent as RecentPayments);
        const summary = await runSweep(opened.deps, opened.gw, {
          primary: s === primary,
          ownsOrphans: true,
          recent: s.recent,
          peers,
          listed: sharedListing(opened.deps),
          nowMs,
        });
        const links = s.recent.links ? { links: s.recent.links } : {};
        s.report = summary.cloudbedsOk ? { provider, mode, ok: true, ...summary, ...links } : { provider, mode, ok: false, error: "cloudbeds_unavailable", ...summary, ...links };
      } else {
        const cloudbedsOk = await sharedListing(opened.deps)(nowMs).then(
          () => true,
          () => false,
        );
        const summary = await sweepPaidAndAlerts(opened.deps, opened.gw, { cloudbedsOk, heartbeat: opened.gw.provider !== "stripe", nowMs });
        s.report = { provider, mode, ok: false, error: "payments_unavailable", ...summary };
      }
    } catch (e) {
      failed(s, "hold side", e);
    }
  }

  const reports = states.map((s) => s.report);
  if (!primary) return { status: 200, body: { ok: true, mode: null, runs: [] } };
  const ok = reports.every((r) => r.ok);
  const error = reports.find((r) => !r.ok)?.error;
  const summary = Object.fromEntries(Object.entries(primary.report).filter(([key]) => !REPORT_FIELDS.has(key))) as Partial<SweepSummary>;
  return {
    status: ok ? 200 : 502,
    body: { ok, ...(ok || error === undefined ? {} : { error }), mode: primary.report.mode, ...summary, runs: reports },
  };
}

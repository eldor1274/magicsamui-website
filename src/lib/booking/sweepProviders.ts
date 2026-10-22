// One sweeper request for every configured payment provider (Beam design S4.8): the active provider and a drain
// finishing the other provider's in-flight payments, on one Cloudbeds listing. The sweep route uses it only while
// a Beam config (active or drain) exists; without one it keeps its single Stripe runSweep(deps), unchanged.
//
// sweepProviders(runs, {deadlineMs}):
// 1. Every provider's step 1 (sweep.ts sweepRecentPayments), Stripe first, each in its own try/catch and time
//    slice: a step 1 must end SWEEP_HOLD_SIDE_RESERVE_MS before the deadline, so a slow provider can never eat the
//    time of the hold sides that follow (Stripe's first).
// 2. One run per provider, Stripe first (sweep.ts runSweep): primary = the active provider's run, else the first
//    run (the demo, or a config error, with drains); ownsOrphans for every run (Beam holds carry '-B' and Stripe
//    holds never do, so each orphan is read by exactly one run's parser); recent = its own step 1 and peers = the
//    others', both exactly as sweepRecentPayments returned them (their unread maps included); one Cloudbeds
//    listing for every run, taken by the first run that needs it at its own listing point (where a lone run takes
//    it) and handed to every later run, its failure included.
//    A provider whose step 1 threw gets no hold side this request (its holds wait for the next one): only
//    sweep.ts sweepPaidAndAlerts - its step 1b, step 3 and heartbeat - with cloudbedsOk = whether the shared
//    listing worked. The others proceed: no hold can belong to both.
// 3. Time: the first run (Stripe's whenever Stripe is configured: what the route ran alone before) always runs.
//    A later run with less than SWEEP_MIN_SLICE_MS left of its phase (step 1: its slice; the hold side: the
//    deadline) is skipped, reported, and gets nothing that request. run.open(timing) hands out the provider's
//    deps for a phase: every Beam call ends by that phase's end (what Stripe left of the budget); Stripe ignores it.
// 4. The answer: {ok, error?, mode (the primary run's), ...the primary run's summary, runs: [{provider, mode, ok,
//    error?, skipped?, ...summary}]}, 502 when any run failed, was skipped or had cloudbedsOk false, so the cron's
//    curl -f fails visibly; every run is still attempted. Each run writes its own scope's heartbeat (sweep.ts).
//    error is the first failed run's (Stripe's first).
//
// This file loads no Beam code (importGraph.test.ts): the route hands in runtime.ts getFulfilmentProviderDeps,
// whose Beam gateway loads payments/beamGateway.ts on its first Beam call.

import { redactForLog } from "./cloudbedsWrite.ts";
import type { ListedReservation } from "./cloudbedsWrite.ts";
import type { PaymentGateway } from "./payments/gateway.ts";
import { listSweepReservations, runSweep, sweepPaidAndAlerts, sweepRecentPayments } from "./sweep.ts";
import type { RecentPayments, SweepSummary } from "./sweep.ts";
import type { CoreDeps, LogFn, ProviderDeps } from "./stripeDeps.ts";
import { nowOf } from "./stripeDeps.ts";

/** Every step 1 ends this long before the deadline: the hold sides (Stripe's first) keep at least this much of the budget. */
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
   * timing.deadlineMs (runtime.ts getFulfilmentProviderDeps; Stripe ignores it). A throw fails the run.
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
  /** Done: failed or skipped before its hold side. */
  over: boolean;
}

/** A run report's own fields (the rest is its summary). */
const REPORT_FIELDS = new Set(["provider", "mode", "ok", "error", "skipped"]);

const messageOf = (e: unknown) => redactForLog(e instanceof Error ? e.message : String(e)).slice(0, 200);

/** Runs every provider's sweep for one request (see the top of this file). Never throws. */
export async function sweepProviders(runs: SweepRun[], opts: SweepTiming & { log: LogFn }): Promise<SweepProvidersAnswer> {
  const clock = opts.clock ?? Date.now;
  const timing = (deadlineMs: number): SweepTiming => (opts.clock ? { deadlineMs, clock: opts.clock } : { deadlineMs });
  const step1End = opts.deadlineMs - SWEEP_HOLD_SIDE_RESERVE_MS;
  // Stripe first (a stable sort keeps the rest in the caller's order).
  const states: RunState[] = runs
    .map((run, i) => ({ run, i }))
    .sort((a, b) => Number(b.run.provider === "stripe") - Number(a.run.provider === "stripe") || a.i - b.i)
    .map(({ run }) => ({ run, report: { provider: run.provider, mode: null, ok: true }, recent: null, over: false }));
  const primaryIndex = Math.max(0, states.findIndex((s) => s.run.primary === true));

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
  const open = (s: RunState, end: number): ProviderDeps => {
    const opened = s.run.open(timing(end));
    s.report.mode = opened.deps.config.paymentMode;
    return opened;
  };

  // 1. Every provider's step 1, Stripe first.
  for (const [index, s] of states.entries()) {
    let opened: ProviderDeps;
    try {
      opened = open(s, step1End);
    } catch (e) {
      failed(s, "step 1", e);
      continue;
    }
    if (skippedForTime(s, index, step1End, "step 1")) continue;
    try {
      s.recent = await sweepRecentPayments(opened.deps, opened.gw);
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

  // 2. One run per provider, Stripe first.
  for (const [index, s] of states.entries()) {
    if (s.over || skippedForTime(s, index, opts.deadlineMs, "hold side")) continue;
    let opened: ProviderDeps;
    try {
      opened = open(s, opts.deadlineMs);
    } catch (e) {
      failed(s, "hold side", e);
      continue;
    }
    const { provider, mode } = s.report;
    try {
      if (s.recent) {
        const peers = states.filter((p) => p !== s && p.recent !== null).map((p) => p.recent as RecentPayments);
        const summary = await runSweep(opened.deps, opened.gw, {
          primary: index === primaryIndex,
          ownsOrphans: true,
          recent: s.recent,
          peers,
          listed: sharedListing(opened.deps),
        });
        s.report = summary.cloudbedsOk ? { provider, mode, ok: true, ...summary } : { provider, mode, ok: false, error: "cloudbeds_unavailable", ...summary };
      } else {
        const cloudbedsOk = await sharedListing(opened.deps)(nowOf(opened.deps)).then(
          () => true,
          () => false,
        );
        const summary = await sweepPaidAndAlerts(opened.deps, opened.gw, { cloudbedsOk });
        s.report = { provider, mode, ok: false, error: "payments_unavailable", ...summary };
      }
    } catch (e) {
      failed(s, "hold side", e);
    }
  }

  const reports = states.map((s) => s.report);
  if (reports.length === 0) return { status: 200, body: { ok: true, mode: null, runs: [] } };
  const ok = reports.every((r) => r.ok);
  const error = reports.find((r) => !r.ok)?.error;
  const primary = reports[primaryIndex];
  const summary = Object.fromEntries(Object.entries(primary).filter(([key]) => !REPORT_FIELDS.has(key))) as Partial<SweepSummary>;
  return {
    status: ok ? 200 : 502,
    body: { ok, ...(ok || error === undefined ? {} : { error }), mode: primary.mode, ...summary, runs: reports },
  };
}

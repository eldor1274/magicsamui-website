// Operational alert delivery (server only). The owner's safety net for money
// problems ("a guest paid for a cancelled hold") must not get lost:
//
// - Repeat suppression is CLAIMED for a short while before sending and only
//   turned into the full window AFTER the mail was accepted. A failed send (or
//   a function killed mid-send) frees the key again, so the next call retries.
// - A failed send is logged (alert_send_failed) - sendSiteMail never throws, it
//   answers false, so its result is checked rather than caught.
// - CRITICAL alerts are stored in the KV store before anything is sent and
//   removed only once delivered. The sweeper (sweep.ts) re-sends whatever is
//   still pending on every run and reports the count.
// - The send itself can be deferred until after the response (next/server
//   after(), wired up in runtime.ts) so a slow mail relay never stalls a
//   guest's checkout or a Stripe webhook; the stored record covers a function
//   that is killed before the deferred send finishes.

import { createHash } from "node:crypto";
import type { KvStore } from "./kv.ts";
import { keys, readJson, writeJson } from "./lock.ts";
import type { AlertFn, AlertSeverity, LogFn } from "./stripeDeps.ts";

/** Repeat suppression window once an alert was delivered. */
export const ALERT_WINDOW_SECONDS = 6 * 3600;
/** How long a send in progress holds the repeat-suppression key (a killed function frees it after this). */
export const ALERT_CLAIM_SECONDS = 120;
/** Critical alerts are re-sent by the sweeper for up to this long. */
export const PENDING_ALERT_TTL_SECONDS = 7 * 24 * 3600;
/** Relay/SMTP time limit for alert mail: both routes fit well inside a 30 s function. */
export const ALERT_MAIL_TIMEOUT_MS = 8_000;

export interface PendingAlert {
  id: string;
  subject: string;
  lines: string[];
  severity: AlertSeverity;
  key: string | null;
  createdAt: number;
}

export interface AlertMail {
  subject: string;
  text: string;
}

export interface AlerterOptions {
  kv: KvStore;
  /** Delivers one mail; true once it was accepted. Must not throw (a throw counts as false). */
  send: (mail: AlertMail) => Promise<boolean>;
  log: LogFn;
  /** False = log lines only (test modes without BOOKING_ALERTS_IN_TEST). */
  emailEnabled: boolean;
  /** Prefix for the subject outside live mode (e.g. "[stripe-test] "). */
  subjectPrefix: string;
  /** Last line of every mail. */
  footer: string;
  /**
   * Key scope of the deployment's mode (lock.ts keyScope): repeat claims and
   * stored critical alerts are kept per mode, so a test deployment sharing the
   * live Redis never suppresses, re-sends or clears a live alert.
   */
  scope: string;
  /** Runs the send after the response when possible (next/server after()); default: await it. */
  defer?: (task: () => Promise<void>) => void;
  now?: () => number;
}

/** Stable id of a critical alert: its dedupe key, else a hash of its text. */
export function pendingAlertId(subject: string, lines: string[], key: string | null | undefined): string {
  if (key) return key;
  return `h-${createHash("sha256").update(`${subject}\n${lines.join("\n")}`).digest("hex").slice(0, 24)}`;
}

async function storePending(kv: KvStore, scope: string, alert: PendingAlert): Promise<void> {
  await writeJson(kv, keys.pendingAlert(scope, alert.id), alert, PENDING_ALERT_TTL_SECONDS);
  await kv.zadd(keys.pendingAlertIndex(scope), alert.createdAt, alert.id);
}

async function clearPending(kv: KvStore, scope: string, id: string): Promise<void> {
  await kv.zrem(keys.pendingAlertIndex(scope), id);
  await kv.del(keys.pendingAlert(scope, id));
}

export function createAlerter(options: AlerterOptions): AlertFn {
  const { kv, log, scope } = options;
  const now = options.now ?? Date.now;
  return async (subject, lines, alertOptions = {}) => {
    const severity = alertOptions.severity ?? "warning";
    const key = alertOptions.key ?? null;
    log(`alert_${severity}`, { subject });
    if (!options.emailEnabled) return;

    // 1. A critical alert is recorded BEFORE anything else, so the sweeper re-sends it if this attempt fails.
    const pendingId = severity === "critical" ? pendingAlertId(subject, lines, key) : null;
    if (pendingId) {
      // A re-send keeps the original record (first text, first time raised).
      const existing = await readJson<PendingAlert>(kv, keys.pendingAlert(scope, pendingId)).catch(() => null);
      const store = existing
        ? kv.zadd(keys.pendingAlertIndex(scope), existing.createdAt, pendingId)
        : storePending(kv, scope, { id: pendingId, subject, lines, severity, key, createdAt: now() });
      await store.catch(() => log("alert_pending_store_failed", { subject }));
    }

    // 2. Repeat suppression: a short claim while sending (KV down -> send anyway).
    const claimKey = key ? keys.alerted(scope, key) : null;
    if (claimKey) {
      const claimed = await kv.setNx(claimKey, "sending", ALERT_CLAIM_SECONDS).catch(() => true);
      if (!claimed) return;
    }

    const task = async (): Promise<void> => {
      const ok = await options
        .send({
          subject: `${options.subjectPrefix}[Booking ${severity}] ${subject}`.slice(0, 200),
          text: [...lines, "", options.footer].join("\n"),
        })
        .catch(() => false);
      if (ok) {
        if (claimKey) await kv.set(claimKey, "1", ALERT_WINDOW_SECONDS).catch(() => undefined);
        if (pendingId) await clearPending(kv, scope, pendingId).catch(() => log("alert_pending_clear_failed", { subject }));
        return;
      }
      log("alert_send_failed", { subject, severity, pending: pendingId !== null });
      // Free the key so the next occurrence (or the sweeper, for critical alerts) tries again.
      if (claimKey) await kv.del(claimKey).catch(() => undefined);
    };

    if (options.defer) {
      try {
        options.defer(task);
        return;
      } catch {
        // Outside a request scope: send inline below.
      }
    }
    await task();
  };
}

/**
 * Re-sends every critical alert that was never delivered (called by the
 * sweeper). Returns how many were still undelivered at the start of the run.
 */
export async function resendPendingAlerts(
  deps: { kv: KvStore; alert: AlertFn; log: LogFn },
  scope: string,
  nowMs: number,
  limit = 20,
): Promise<number> {
  // Only this mode's alerts: the alerter re-sends them under this deployment's mode and scope.
  const ids = await deps.kv.zrangeByScore(keys.pendingAlertIndex(scope), 0, Number.MAX_SAFE_INTEGER, limit);
  let pending = 0;
  for (const id of ids) {
    const rec = await readJson<PendingAlert>(deps.kv, keys.pendingAlert(scope, id));
    if (!rec) {
      // Expired (7 days) or cleared: drop it from the index.
      await deps.kv.zrem(keys.pendingAlertIndex(scope), id);
      deps.log("alert_pending_expired", { id: id.slice(0, 40) });
      continue;
    }
    pending++;
    const ageMinutes = Math.max(0, Math.round((nowMs - rec.createdAt) / 60_000));
    await deps
      .alert(rec.subject, [...rec.lines, "", `(Re-sent by the booking sweeper: this alert was first raised ${ageMinutes} minutes ago and not delivered.)`], {
        // The id doubles as the key of a key-less alert, so the re-send updates the same record.
        key: rec.key ?? rec.id,
        severity: rec.severity,
      })
      .catch(() => undefined);
  }
  return pending;
}

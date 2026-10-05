// Small helpers shared by the booking route handlers (server only).

import { BookingConfigError } from "./config.ts";
import type { ApiError } from "./types.ts";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function apiError(status: number, error: ApiError["error"], message: string, issues?: string[]): Response {
  const body: ApiError = { ok: false, error, message, ...(issues ? { issues } : {}) };
  return json(body, status);
}

/** Maps a config error to a 503 the UI can explain; rethrows anything else. */
export function configErrorResponse(e: unknown): Response {
  if (e instanceof BookingConfigError) {
    console.error(`[booking] config error: ${e.code}`);
    return e.code === "live_payments_locked"
      ? apiError(503, "live_payments_locked", "Live payments are switched off for this site. No payment was taken.")
      : apiError(503, "payment_unavailable", "Online payment is not configured right now. No payment was taken.");
  }
  throw e;
}

export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/**
 * Best-effort per-IP sliding-window limiter (in memory, per serverless
 * instance) - a burst brake, not a security boundary.
 */
export function createRateLimiter(limit: number, windowMs: number): (key: string) => boolean {
  const hits = new Map<string, number[]>();
  return (key: string) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    const limited = recent.length >= limit;
    if (!limited) recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5_000) hits.clear();
    return limited;
  };
}

/** Structured server log line without personal data. */
export function logEvent(message: string, data?: Record<string, unknown>): void {
  console.info(`[booking] ${message}`, data ? JSON.stringify(data) : "");
}

/** Reads a JSON body with a size cap; returns undefined on bad or oversized JSON. */
export async function readJsonBody(request: Request, maxBytes = 16_384): Promise<unknown> {
  const text = await request.text();
  if (text.length > maxBytes) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

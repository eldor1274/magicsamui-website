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
    // Names of the missing/invalid settings only (never values), so go-live day can see what is left.
    console.error(`[booking] config error: ${e.code}${e.missing.length ? ` - missing: ${e.missing.join(", ")}` : ""}`);
    return e.code === "live_payments_locked"
      ? apiError(503, "live_payments_locked", "Online payment on this page is paused right now. No payment was taken.")
      : apiError(503, "payment_unavailable", "Online payment is not configured right now. No payment was taken.");
  }
  throw e;
}

export function clientIp(request: Request): string {
  return ipFromHeaders(request.headers);
}

/** Client IP from forwarding headers (server components pass `await headers()`). */
export function ipFromHeaders(headers: Pick<Headers, "get">): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
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

/**
 * Reads a request body but never buffers more than `maxBytes`: an oversized
 * Content-Length is refused before reading, and the stream is cancelled as
 * soon as the running total passes the cap. Returns null when too large.
 */
export async function readCapped(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export type JsonBodyResult = { ok: true; value: unknown } | { ok: false; response: Response };

/**
 * Reads a JSON POST body: application/json only (415 otherwise, so cross-site
 * "simple" text/plain form posts are refused before any work is done), size
 * capped (413), and parsed (400 on bad JSON).
 */
export async function readJsonBody(request: Request, maxBytes = 16_384): Promise<JsonBodyResult> {
  const type = (request.headers.get("content-type") ?? "").trim().toLowerCase();
  if (!type.startsWith("application/json")) {
    return { ok: false, response: apiError(415, "invalid_request", "Expected a JSON request body.") };
  }
  const bytes = await readCapped(request, maxBytes);
  if (bytes === null) return { ok: false, response: apiError(413, "invalid_request", "Request body too large.") };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { ok: false, response: apiError(400, "invalid_request", "Invalid request body.") };
  }
}

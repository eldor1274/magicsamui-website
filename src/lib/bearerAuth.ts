import { timingSafeEqual } from "node:crypto";

/**
 * True when the request carries `Authorization: Bearer <secret>` for one of
 * `secrets`. Every secret is compared (no early exit), each in constant time;
 * an empty secret never matches. Used by the booking sweeper and the daily
 * health check (Vercel cron sends `Bearer <CRON_SECRET>`). Never read a secret
 * from the query string.
 */
export function bearerMatches(request: Request, secrets: readonly string[]): boolean {
  const header = request.headers.get("authorization") ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7).trim() : "", "utf8");
  let ok = false;
  for (const secret of secrets) {
    const expected = Buffer.from(secret, "utf8");
    if (expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected)) ok = true;
  }
  return ok;
}

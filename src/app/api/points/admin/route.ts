import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { buildAccounts, netFactor, phoneKey, pointsForStay } from "@/lib/points";
import { appendClear, loadClears, loadStays } from "@/lib/pointsData";
import { clientIp, logEvent } from "@/lib/booking/routeUtils";

// Eldor-only. Search a guest, then clear their points once the discount has
// actually been given. Clears are appended as events, never edits to a balance,
// so the history stays auditable if a guest ever disputes it.
//
// Access: the `x-admin-password` header must equal POINTS_ADMIN_PASSWORD
// (MIN_PASSWORD_LENGTH+ characters; unset or shorter: 503 for everything, so a
// weak or missing password never opens the guest list). Compared in constant
// time. Wrong passwords are counted per IP: after MAX_FAILURES within
// FAILURE_WINDOW_MS every attempt from that IP is refused (429) until the
// window passes, so the password can't be brute-forced. Successful requests
// are never counted. In-memory per server instance, like the limiters in
// routeUtils.

const MIN_PASSWORD_LENGTH = 16;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 10 * 60_000;
const failures = new Map<string, number[]>();

function recentFailures(ip: string, now: number): number[] {
  const recent = (failures.get(ip) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  if (recent.length > 0) failures.set(ip, recent);
  else failures.delete(ip);
  return recent;
}

function configuredPassword(): string | null {
  const password = process.env.POINTS_ADMIN_PASSWORD ?? "";
  return password.length >= MIN_PASSWORD_LENGTH ? password : null;
}

function passwordMatches(expected: string, given: string | null): boolean {
  if (given === null) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  const expected = configuredPassword();
  if (expected === null) {
    logEvent("points_admin_unconfigured");
    return NextResponse.json(
      { error: `Points admin is disabled: set POINTS_ADMIN_PASSWORD (${MIN_PASSWORD_LENGTH}+ characters).` },
      { status: 503 }
    );
  }

  const ip = clientIp(request);
  const now = Date.now();
  if (recentFailures(ip, now).length >= MAX_FAILURES) {
    logEvent("points_admin_rate_limited");
    return NextResponse.json(
      { error: "Too many wrong passwords - please wait 10 minutes." },
      { status: 429, headers: { "Retry-After": String(FAILURE_WINDOW_MS / 1000) } }
    );
  }

  if (!passwordMatches(expected, request.headers.get("x-admin-password"))) {
    failures.set(ip, [...recentFailures(ip, now), now]);
    logEvent("points_admin_refused");
    return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const [stays, clears] = await Promise.all([loadStays(), loadClears()]);
  const accounts = buildAccounts(stays, clears);

  if (action === "search") {
    const q = String(body.query ?? "").trim().toLowerCase();
    const digits = q.replace(/\D/g, "");
    // Accounts are keyed on the last 9 digits, so a full international number
    // has to be trimmed the same way before comparing or it can never match.
    const digitTail = digits.length >= 9 ? digits.slice(-9) : digits;
    const matches = [...accounts.values()]
      .filter((a) => {
        if (!q) return a.balance > 0;
        const byName = a.name.toLowerCase().includes(q);
        const byPhone = digitTail.length >= 3 && a.phoneKey.includes(digitTail);
        return byName || byPhone;
      })
      .sort((a, b) => b.balance - a.balance)
      .slice(0, 40)
      .map((a) => ({
        phoneKey: a.phoneKey,
        name: a.name,
        hasPhone: a.hasPhone,
        balance: a.balance,
        earned: a.earned,
        cleared: a.cleared,
        spend: a.spend,
        stays: a.stays.map((s) => ({
          startDate: s.startDate,
          endDate: s.endDate,
          total: s.total,
          net: Math.round(s.total * netFactor(s.source)),
          points: pointsForStay(s),
          source: s.source,
          roomTypeName: s.roomTypeName,
        })),
      }));
    const totalLiability = [...accounts.values()].reduce((sum, a) => sum + a.balance, 0);
    return NextResponse.json({ matches, totalLiability, accounts: accounts.size });
  }

  if (action === "clear") {
    const key = phoneKey(String(body.phoneKey ?? "")) || String(body.phoneKey ?? "");
    const account = accounts.get(key);
    if (!account) {
      return NextResponse.json({ error: "Guest not found" }, { status: 404 });
    }
    const points = Math.floor(Number(body.points));
    if (!Number.isFinite(points) || points <= 0 || points > account.balance) {
      return NextResponse.json(
        { error: `Enter an amount between 1 and ${account.balance}` },
        { status: 400 }
      );
    }
    const saved = await appendClear({
      phoneKey: key,
      points,
      clearedAt: new Date().toISOString(),
      note: String(body.note ?? "").slice(0, 200),
    });
    if (!saved) {
      return NextResponse.json(
        { error: "Could not save — points NOT cleared. Try again." },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true, remaining: account.balance - points });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

import { NextRequest, NextResponse } from "next/server";
import { buildAccounts, netFactor, phoneKey, pointsForStay } from "@/lib/points";
import { appendClear, loadClears, loadStays } from "@/lib/pointsData";

// Eldor-only. Search a guest, then clear their points once the discount has
// actually been given. Clears are appended as events, never edits to a balance,
// so the history stays auditable if a guest ever disputes it.

function authorised(request: NextRequest): boolean {
  const expected = process.env.POINTS_ADMIN_PASSWORD;
  if (!expected) return false;
  return request.headers.get("x-admin-password") === expected;
}

export async function POST(request: NextRequest) {
  if (!authorised(request)) {
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

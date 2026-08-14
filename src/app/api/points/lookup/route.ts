import { NextRequest, NextResponse } from "next/server";
import { buildAccounts, lookup } from "@/lib/points";
import { loadClears, loadStays } from "@/lib/pointsData";

// Guest-facing balance lookup. Requires phone number AND surname together:
// either one alone would turn this into a public "who stayed at Magic Suites"
// search, which leaks guest travel history and, via the 3% rate, what they paid.

// Generous enough that a guest mistyping their number never gets locked out,
// tight enough that nobody can walk the number space. Mobile networks put many
// people behind one IP, so this has to allow for a whole network, not one phone.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 40;
const attempts = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  attempts.set(ip, recent);
  return recent.length > MAX_ATTEMPTS;
}

export async function POST(request: NextRequest) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many lookups. Please try again later." },
      { status: 429 }
    );
  }

  let phone = "";
  let lastName = "";
  try {
    const body = await request.json();
    phone = String(body.phone ?? "");
    lastName = String(body.lastName ?? "");
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  if (!phone.trim()) {
    return NextResponse.json(
      { error: "Enter the phone number you booked with." },
      { status: 400 }
    );
  }

  const [stays, clears] = await Promise.all([loadStays(), loadClears()]);
  const accounts = buildAccounts(stays, clears);
  const account = lookup(accounts, phone, lastName);

  // Deliberately identical response whether the guest is unknown or the surname
  // does not match, so this cannot be used to probe which numbers are guests.
  if (!account) {
    return NextResponse.json({ found: false });
  }

  return NextResponse.json({
    found: true,
    name: account.name,
    balance: account.balance,
    stays: account.stays.length,
    expiring: account.expiring,
  });
}

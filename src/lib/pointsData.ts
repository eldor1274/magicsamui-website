import type { ClearEvent, Stay } from "./points";

// Stay history and the record of cleared points both live on the droplet, which
// already syncs Cloudbeds on a cron and has persistent disk. Vercel has neither,
// so it reads through these calls rather than holding any state of its own.
// The data includes guest phone numbers, so the secret is required on every call
// and never reaches the browser — only server code in this app calls these.

const API = process.env.POINTS_API_URL ?? "";
const SECRET = process.env.POINTS_API_SECRET ?? "";

async function call<T>(pathname: string, init?: RequestInit): Promise<T | null> {
  if (!API || !SECRET) return null;
  try {
    const res = await fetch(`${API}${pathname}`, {
      ...init,
      headers: {
        "x-points-secret": SECRET,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function loadStays(): Promise<Stay[]> {
  const data = await call<{ stays: Stay[] }>("/points/stays");
  return data?.stays ?? [];
}

export async function loadClears(): Promise<ClearEvent[]> {
  const data = await call<{ clears: ClearEvent[] }>("/points/clears");
  return data?.clears ?? [];
}

/** Returns false if the clear could not be saved, so callers never report a
 *  redemption that was not actually recorded. */
export async function appendClear(event: ClearEvent): Promise<boolean> {
  const data = await call<{ ok: boolean }>("/points/clears", {
    method: "POST",
    body: JSON.stringify({
      phoneKey: event.phoneKey,
      points: event.points,
      note: event.note,
    }),
  });
  return data?.ok === true;
}

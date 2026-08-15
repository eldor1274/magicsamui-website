"use client";

import { useState } from "react";

interface Stay {
  startDate: string;
  endDate: string;
  total: number;
  net: number;
  points: number;
  source: string;
  roomTypeName: string;
}

interface Account {
  phoneKey: string;
  name: string;
  hasPhone: boolean;
  balance: number;
  earned: number;
  cleared: number;
  spend: number;
  stays: Stay[];
}

export default function PointsAdmin() {
  const [password, setPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Account[]>([]);
  const [liability, setLiability] = useState(0);
  const [accountCount, setAccountCount] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function call(payload: Record<string, unknown>) {
    const res = await fetch("/api/points/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-password": password },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, data: await res.json() };
  }

  async function search(q: string) {
    setBusy(true);
    setMsg("");
    const { ok, data } = await call({ action: "search", query: q });
    setBusy(false);
    if (!ok) {
      setMsg(data.error ?? "Failed");
      return false;
    }
    setMatches(data.matches);
    setLiability(data.totalLiability);
    setAccountCount(data.accounts);
    return true;
  }

  async function unlock() {
    if (await search("")) setUnlocked(true);
  }

  async function clearPoints(account: Account) {
    setBusy(true);
    const { ok, data } = await call({
      action: "clear",
      phoneKey: account.phoneKey,
      points: Number(amount),
      note,
    });
    setBusy(false);
    if (!ok) {
      setMsg(data.error ?? "Failed");
      return;
    }
    setMsg(
      `Cleared ${Number(amount).toLocaleString()} points for ${account.name}. Remaining: ${data.remaining.toLocaleString()}.`
    );
    setOpen(null);
    setNote("");
    setAmount("");
    await search(query);
  }

  if (!unlocked) {
    return (
      <div className="max-w-sm space-y-3">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && unlock()}
          placeholder="Admin password"
          className="w-full rounded-lg border border-sand-light bg-white px-4 py-3"
        />
        {msg && <p className="text-sm text-red-700">{msg}</p>}
        <button
          onClick={unlock}
          className="rounded-lg bg-pool px-5 py-2.5 font-medium text-white hover:bg-pool-dark"
        >
          Unlock
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap gap-6 rounded-xl bg-stone-100 p-5 text-sm">
        <div>
          <p className="text-ink-soft">Guests with points</p>
          <p className="font-serif text-2xl text-ink">{accountCount}</p>
        </div>
        <div>
          <p className="text-ink-soft">Total outstanding</p>
          <p className="font-serif text-2xl text-ink">฿{liability.toLocaleString()}</p>
        </div>
      </div>

      <div className="mt-6 flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search(query)}
          placeholder="Search name or phone number"
          className="flex-1 rounded-lg border border-sand-light bg-white px-4 py-2.5"
        />
        <button
          onClick={() => search(query)}
          disabled={busy}
          className="rounded-lg bg-pool px-5 py-2.5 font-medium text-white hover:bg-pool-dark disabled:opacity-60"
        >
          Search
        </button>
      </div>

      {msg && <p className="mt-4 rounded-lg bg-sand-light/40 p-3 text-sm text-ink">{msg}</p>}

      {matches.length === 0 && (
        <p className="mt-6 rounded-xl bg-stone-100 p-4 text-sm text-ink-soft">
          No guest found for &ldquo;{query}&rdquo;. Try their surname, or the last
          few digits of their phone number.
        </p>
      )}

      <div className="mt-6 space-y-2">
        {matches.map((a) => (
          <div key={a.phoneKey} className="rounded-xl border border-sand-light bg-white">
            <button
              onClick={() => {
                setOpen(open === a.phoneKey ? null : a.phoneKey);
                setAmount(String(a.balance));
              }}
              className="flex w-full items-center justify-between p-4 text-left"
            >
              <div>
                <p className="font-medium text-ink">{a.name}</p>
                <p className="text-xs text-ink-soft">
                  {a.hasPhone ? `…${a.phoneKey.slice(-6)}` : "no phone on file"} ·{" "}
                  {a.stays.length} {a.stays.length === 1 ? "stay" : "stays"} · ฿
                  {a.spend.toLocaleString()} spent
                </p>
                {!a.hasPhone && (
                  <p className="mt-1 text-xs text-sand">
                    Add their number in Cloudbeds so they can check this themselves
                  </p>
                )}
              </div>
              <div className="text-right">
                <p className="font-serif text-xl text-pool">
                  {a.balance.toLocaleString()}
                </p>
                {a.cleared > 0 && (
                  <p className="text-xs text-ink-soft">
                    {a.cleared.toLocaleString()} used
                  </p>
                )}
              </div>
            </button>

            {open === a.phoneKey && (
              <div className="border-t border-sand-light p-4">
                <table className="w-full text-xs text-ink-soft">
                  <tbody>
                    {a.stays.map((s, i) => (
                      <tr key={i} className="border-b border-stone-100 last:border-0">
                        <td className="py-1.5">{s.startDate} → {s.endDate}</td>
                        <td className="py-1.5">{s.roomTypeName}</td>
                        <td className="py-1.5">{s.source}</td>
                        <td className="py-1.5 text-right">฿{s.total.toLocaleString()}</td>
                        <td className="py-1.5 text-right">
                          {s.net < s.total && (
                            <span title="after OTA commission">
                              net ฿{s.net.toLocaleString()}
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 text-right text-pool">
                          +{s.points.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="mt-4 flex flex-wrap items-end gap-2">
                  <div>
                    <label className="block text-xs text-ink-soft">Points to clear</label>
                    <input
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      className="mt-1 w-32 rounded-lg border border-sand-light px-3 py-2"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="block text-xs text-ink-soft">
                      Note (which booking this discounted)
                    </label>
                    <input
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="e.g. Dec 2026 direct booking"
                      className="mt-1 w-full rounded-lg border border-sand-light px-3 py-2"
                    />
                  </div>
                  <button
                    onClick={() => clearPoints(a)}
                    disabled={busy}
                    className="rounded-lg bg-ink px-5 py-2 font-medium text-white hover:opacity-90 disabled:opacity-60"
                  >
                    Clear points
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

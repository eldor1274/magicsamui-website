"use client";

import { useState, type FormEvent } from "react";

interface Result {
  found: boolean;
  name?: string;
  balance?: number;
  stays?: number;
  expiring?: { points: number; on: string } | null;
}

// Styled for the dark points page only: glass panel form, and a successful
// lookup renders the balance as a membership card. Contour lines in the card
// are an abstract original SVG, drawn inline.

export default function PointsLookup() {
  const [phone, setPhone] = useState("");
  const [status, setStatus] = useState<"idle" | "checking" | "done" | "error">("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus("checking");
    setError("");
    try {
      const res = await fetch("/api/points/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong. Please try again.");
        setStatus("error");
        return;
      }
      setResult(data);
      setStatus("done");
    } catch {
      setError("Something went wrong. Please try again.");
      setStatus("error");
    }
  }

  function reset() {
    setStatus("idle");
    setResult(null);
    setPhone("");
  }

  if (status === "done" && result?.found) {
    return (
      <div>
        <div
          className="relative overflow-hidden rounded-3xl border border-sand-light/20 p-7"
          style={{
            background:
              "linear-gradient(135deg, #10312c 0%, #0a1c1a 45%, #05080c 100%)",
            boxShadow: "0 30px 60px -20px rgba(0,0,0,0.8)",
          }}
        >
          <svg
            aria-hidden
            viewBox="0 0 400 240"
            className="pointer-events-none absolute inset-0 h-full w-full opacity-20"
            preserveAspectRatio="none"
          >
            <path d="M-10 150 C 70 120, 130 190, 210 160 S 350 110, 410 150" fill="none" stroke="#e4d2ae" strokeWidth="1" />
            <path d="M-10 180 C 60 150, 150 215, 230 185 S 360 140, 410 180" fill="none" stroke="#e4d2ae" strokeWidth="0.8" />
            <path d="M-10 120 C 80 95, 140 160, 220 135 S 340 85, 410 120" fill="none" stroke="#e4d2ae" strokeWidth="0.6" />
            <path d="M-10 210 C 90 185, 160 240, 250 210 S 370 175, 410 205" fill="none" stroke="#e4d2ae" strokeWidth="0.6" />
          </svg>

          <div className="relative">
            <div className="flex items-center justify-between">
              <p className="text-[11px] uppercase tracking-[0.3em] text-sand-light/80">
                Magic Suites &amp; Villas
              </p>
              <span
                aria-hidden
                className="flex h-8 w-8 items-center justify-center rounded-full border border-sand-light/40 font-serif text-sm text-sand-light"
              >
                M
              </span>
            </div>

            <p className="mt-8 text-xs uppercase tracking-[0.25em] text-white/60">
              {result.name}
            </p>
            <p className="mt-2 font-serif text-6xl text-[#eadfc4]">
              {result.balance?.toLocaleString()}
            </p>
            <p className="mt-1 text-sm text-white/60">
              points · worth ฿{result.balance?.toLocaleString()} off your next stay
            </p>

            <div className="mt-8 flex items-end justify-between text-[11px] uppercase tracking-[0.2em] text-white/50">
              <span>
                {result.stays} {result.stays === 1 ? "stay" : "stays"} with us
              </span>
              <span>1 pt = ฿1</span>
            </div>
            {result.expiring && (
              <p className="mt-3 text-xs text-sand">
                {result.expiring.points.toLocaleString()} points expire on {result.expiring.on}.
              </p>
            )}
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm text-white/60">
          To use these, message us when you book directly and we&apos;ll take the
          amount off your total. Points can&apos;t be used on bookings made
          through Booking.com, Airbnb or other travel sites.
        </div>
        <button onClick={reset} className="mt-5 text-sm text-sand-light underline underline-offset-4">
          Check another number
        </button>
      </div>
    );
  }

  if (status === "done" && !result?.found) {
    return (
      <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-7">
        <p className="font-serif text-xl text-[#eadfc4]">We couldn&apos;t find any points</p>
        <p className="mt-3 text-sm leading-relaxed text-white/60">
          Make sure it&apos;s the number you used when booking, including the
          country code. If you booked through Booking.com or Airbnb, use the
          number you gave them. Still stuck? Message us and we&apos;ll look it up.
        </p>
        <button onClick={reset} className="mt-5 text-sm text-sand-light underline underline-offset-4">
          Try again
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-3xl border border-white/10 bg-white/[0.05] p-7 backdrop-blur"
    >
      <p className="font-serif text-xl text-[#eadfc4]">Check your balance</p>
      <div className="mt-5">
        <label htmlFor="phone" className="block text-xs uppercase tracking-[0.2em] text-white/60">
          Phone number
        </label>
        <input
          id="phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+44 7700 900123"
          className="mt-2 w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-white placeholder-white/30 outline-none focus:border-sand-light/60"
          required
        />
        <p className="mt-2 text-xs text-white/40">
          The number you used when you booked, with country code.
        </p>
      </div>
      {error && (
        <p className="mt-4 rounded-lg border border-red-300/20 bg-red-900/20 p-3 text-sm text-red-200">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={status === "checking"}
        className="mt-6 w-full rounded-xl px-6 py-3 font-medium text-[#241a08] transition hover:brightness-110 disabled:opacity-60"
        style={{ background: "linear-gradient(120deg, #e4d2ae, #b8935a)" }}
      >
        {status === "checking" ? "Checking…" : "Check my points"}
      </button>
    </form>
  );
}

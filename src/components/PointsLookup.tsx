"use client";

import { useState, type FormEvent } from "react";

interface Result {
  found: boolean;
  name?: string;
  balance?: number;
  stays?: number;
  expiring?: { points: number; on: string } | null;
}

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

  if (status === "done" && result?.found) {
    return (
      <div className="rounded-2xl bg-stone-100 p-8 text-center">
        <p className="text-sm uppercase tracking-[0.2em] text-ink-soft">
          {result.name}
        </p>
        <p className="mt-4 font-serif text-6xl text-pool">
          {result.balance?.toLocaleString()}
        </p>
        <p className="mt-1 text-ink-soft">
          points · worth ฿{result.balance?.toLocaleString()} off your next stay
        </p>
        <p className="mt-4 text-sm text-ink-soft">
          From {result.stays} {result.stays === 1 ? "stay" : "stays"} with us.
        </p>
        {result.expiring && (
          <p className="mt-3 text-sm text-sand">
            {result.expiring.points.toLocaleString()} points expire on{" "}
            {result.expiring.on}.
          </p>
        )}
        <div className="mt-6 rounded-xl bg-stone-50 p-4 text-sm text-ink-soft">
          To use these, message us when you book directly and we&apos;ll take the
          amount off your total. Points can&apos;t be used on bookings made
          through Booking.com, Airbnb or other travel sites.
        </div>
        <button
          onClick={() => {
            setStatus("idle");
            setResult(null);
          }}
          className="mt-6 text-sm text-pool underline"
        >
          Check another number
        </button>
      </div>
    );
  }

  if (status === "done" && !result?.found) {
    return (
      <div className="rounded-2xl bg-stone-100 p-8">
        <p className="font-medium text-ink">We couldn&apos;t find any points</p>
        <p className="mt-2 text-sm text-ink-soft">
          Make sure it&apos;s the number you used when booking, including the
          country code. If you booked through Booking.com or Airbnb, use the
          number you gave them. Still stuck? Message us and we&apos;ll look it up.
        </p>
        <button
          onClick={() => {
            setStatus("idle");
            setResult(null);
          }}
          className="mt-5 text-sm text-pool underline"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="phone" className="block text-sm font-medium text-ink">
          Phone number
        </label>
        <input
          id="phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+44 7700 900123"
          className="mt-1 w-full rounded-lg border border-sand-light bg-white px-4 py-3 text-ink outline-none focus:border-pool"
          required
        />
        <p className="mt-1 text-xs text-ink-soft">
          The number you used when you booked, with country code.
        </p>
      </div>
      {error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>
      )}
      <button
        type="submit"
        disabled={status === "checking"}
        className="w-full rounded-lg bg-pool px-6 py-3 font-medium text-white hover:bg-pool-dark disabled:opacity-60"
      >
        {status === "checking" ? "Checking…" : "Check my points"}
      </button>
    </form>
  );
}

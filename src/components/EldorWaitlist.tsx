"use client";

import { useState } from "react";
import { track } from "@/lib/track";

export default function EldorWaitlist() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (status === "sending") return;
    setStatus("sending");
    try {
      const res = await fetch("/api/eldor-waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error();
      track("eldor_waitlist_submit");
      setStatus("done");
    } catch {
      setStatus("error");
    }
  }

  if (status === "done") {
    return (
      <p className="mt-6 rounded-xl border border-sand/40 bg-sand/10 px-4 py-3 text-sm text-sand">
        You&apos;re on the list — we&apos;ll email you the moment EL &amp; DOR open.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="mt-6">
      <p className="text-sm text-stone-50/80">
        Be the first to know when EL &amp; DOR open for booking:
      </p>
      <div className="mt-3 flex max-w-md flex-col gap-2 sm:flex-row">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Your email"
          className="w-full rounded-full border border-stone-50/30 bg-white/10 px-5 py-2.5 text-sm text-stone-50 placeholder:text-stone-50/50 focus:border-sand focus:outline-none"
        />
        {/* Honeypot — humans never see it */}
        <input
          type="text"
          name="company"
          tabIndex={-1}
          autoComplete="off"
          className="hidden"
          aria-hidden="true"
        />
        <button
          type="submit"
          disabled={status === "sending"}
          className="rounded-full bg-sand px-6 py-2.5 text-sm font-semibold text-ink transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {status === "sending" ? "Joining…" : "Notify me"}
        </button>
      </div>
      {status === "error" && (
        <p className="mt-2 text-sm text-red-300">
          Something went wrong — please try again, or message us on WhatsApp.
        </p>
      )}
    </form>
  );
}

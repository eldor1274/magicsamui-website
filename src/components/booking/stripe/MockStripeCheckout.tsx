"use client";

import { useState } from "react";
import { formatThbWithCode } from "@/lib/booking/format";
import type { MockStripeAction, MockStripeResponse } from "@/lib/booking/types";
// Its Tailwind classes are generated in the booking engine's own sheet (see booking.css).
import "../booking.css";

// MOCK of Stripe's hosted Checkout page (stripe-mock mode only). Every button
// drives the in-repo fake; nothing is charged and no real reservation exists.

interface Props {
  sessionId: string;
  status: "open" | "complete" | "expired";
  amountSatang: number;
  lines: { name: string; amountSatang: number }[];
  email: string | null;
  expiresAt: number;
  reservationId: string | null;
  bookingRef: string | null;
}

const BUTTONS: { action: MockStripeAction; label: string; hint: string; primary?: boolean }[] = [
  { action: "pay", label: "Pay (card succeeds)", hint: "checkout.session.completed, paid", primary: true },
  { action: "pay_delayed_success", label: "Delayed payment succeeds", hint: "completed (unpaid) then async_payment_succeeded" },
  { action: "pay_delayed_failure", label: "Delayed payment fails", hint: "completed (unpaid) then async_payment_failed -> hold released" },
  { action: "expire", label: "Let the session expire", hint: "checkout.session.expired -> hold released" },
  { action: "cancel", label: "Back (cancel)", hint: "returns to the payment step; the page calls /api/booking/abandon" },
];

export default function MockStripeCheckout(props: Props) {
  const [busy, setBusy] = useState<MockStripeAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: MockStripeAction) {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("/api/booking/mock-stripe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: props.sessionId, action }),
      });
      const json = (await res.json()) as MockStripeResponse;
      if (json.ok) {
        window.location.assign(json.redirectUrl);
        return;
      }
      setError(json.message);
    } catch {
      setError("The mock request failed.");
    }
    setBusy(null);
  }

  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
      <p className="rounded-xl bg-sand/20 px-4 py-3 text-sm font-semibold text-ink" role="note">
        MOCK STRIPE CHECKOUT - local test only. No card is charged and no real Cloudbeds reservation exists.
      </p>
      <h1 className="mt-5 font-serif text-2xl text-ink">Pay Magic Suites &amp; Villas</h1>
      <p className="mt-1 font-serif text-3xl text-pool">{formatThbWithCode(props.amountSatang)}</p>
      <ul className="mt-4 space-y-1 text-sm text-ink-soft">
        {props.lines.map((l, i) => (
          <li key={i} className="flex justify-between gap-4">
            <span>{l.name}</span>
            <span>{formatThbWithCode(l.amountSatang)}</span>
          </li>
        ))}
      </ul>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-ink-soft">
        <dt>Booking</dt>
        <dd>{props.bookingRef ?? "-"}</dd>
        <dt>Mock hold</dt>
        <dd>{props.reservationId ?? "-"}</dd>
        <dt>Receipt to</dt>
        <dd>{props.email ?? "-"}</dd>
        <dt>Session</dt>
        <dd className="break-all">{props.sessionId}</dd>
        <dt>Expires</dt>
        <dd>{new Date(props.expiresAt * 1000).toLocaleTimeString()}</dd>
      </dl>
      {props.status !== "open" ? (
        <p className="mt-5 rounded-xl bg-stone-100 px-4 py-3 text-sm text-ink">This MOCK session is {props.status}.</p>
      ) : (
        <div className="mt-6 space-y-3">
          {BUTTONS.map((b) => (
            <button
              key={b.action}
              type="button"
              disabled={busy !== null}
              onClick={() => run(b.action)}
              className={
                b.primary
                  ? "w-full rounded-full bg-pool px-6 py-3 text-sm font-medium text-white hover:bg-pool-dark disabled:opacity-60"
                  : "w-full rounded-full border border-pool/40 px-6 py-3 text-sm font-medium text-pool hover:bg-pool/10 disabled:opacity-60"
              }>
              {busy === b.action ? "Working..." : b.label}
              <span className="block text-xs font-normal opacity-80">{b.hint}</span>
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="mt-4 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

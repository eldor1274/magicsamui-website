import type { Metadata } from "next";
import PointsLookup from "@/components/PointsLookup";
import { EARN_RATE, VALID_YEARS } from "@/lib/points";

export const metadata: Metadata = {
  alternates: { canonical: "/points" },
  title: "Guest Points | Magic Suites & Villas",
  description:
    "Check your Magic Suites & Villas guest points. Earn points on every stay and use them as a discount when you book with us directly.",
};

export default function PointsPage() {
  const percent = Math.round(EARN_RATE * 100);
  return (
    <div className="mx-auto max-w-2xl px-5 py-16">
      <p className="text-sm uppercase tracking-[0.3em] text-pool">Guest rewards</p>
      <h1 className="mt-3 font-serif text-4xl text-ink">Your points</h1>
      <p className="mt-4 text-ink-soft">
        Every stay with us earns points worth {percent}% of what you spent — 30
        points for every ฿1,000, and each point is worth ฿1 off a future stay.
        Points last {VALID_YEARS} years. Enter the number you booked with to see
        your balance.
      </p>

      <div className="mt-10">
        <PointsLookup />
      </div>

      <div className="mt-12 border-t border-sand-light pt-8">
        <h2 className="font-serif text-xl text-ink">How it works</h2>
        <ul className="mt-4 space-y-3 text-sm text-ink-soft">
          <li>
            <span className="font-medium text-ink">Earn automatically.</span>{" "}
            Points are added after you check out, on every stay — whether you
            booked with us directly or through a travel site.
          </li>
          <li>
            <span className="font-medium text-ink">Use them with us.</span>{" "}
            Message us when booking directly and we&apos;ll take your points off
            the total as a discount.
          </li>
          <li>
            <span className="font-medium text-ink">1 point = ฿1.</span> No tiers,
            no blackout dates, nothing to sign up for.
          </li>
        </ul>
      </div>
    </div>
  );
}

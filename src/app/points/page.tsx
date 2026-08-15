import type { Metadata } from "next";
import PointsLookup from "@/components/PointsLookup";
import { EARN_RATE, VALID_YEARS } from "@/lib/points";

export const metadata: Metadata = {
  alternates: { canonical: "/points" },
  title: "Guest Points | Magic Suites & Villas",
  description:
    "Check your Magic Suites & Villas guest points. Earn points on every stay and use them as a discount when you book with us directly.",
};

// The dark, card-lounge look is deliberate and self-contained to this page:
// night sky, a sunrise glow on the horizon, gold serif type. All backdrop
// effects are pure CSS gradients — no images, nothing borrowed.

const STARS = [
  [8, 12, 0.9], [17, 34, 0.5], [26, 8, 0.7], [33, 28, 0.4], [41, 15, 0.8],
  [49, 38, 0.5], [57, 8, 0.6], [64, 24, 0.9], [72, 12, 0.5], [79, 32, 0.7],
  [86, 6, 0.6], [93, 22, 0.8], [12, 52, 0.4], [38, 55, 0.6], [60, 48, 0.4],
  [83, 52, 0.5], [23, 44, 0.55], [70, 40, 0.45], [90, 42, 0.4], [4, 30, 0.5],
]
  .map(
    ([x, y, a]) =>
      `radial-gradient(1.2px 1.2px at ${x}% ${y}%, rgba(255,246,224,${a}), transparent 100%)`
  )
  .join(",");

export default function PointsPage() {
  const percent = Math.round(EARN_RATE * 100);
  return (
    <div className="bg-[#070c15] text-white">
      <section className="relative overflow-hidden">
        <div aria-hidden className="absolute inset-0" style={{ backgroundImage: STARS }} />
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-2/3"
          style={{
            background:
              "radial-gradient(70% 90% at 50% 108%, rgba(184,147,90,0.28), rgba(14,107,99,0.10) 55%, transparent 75%)",
          }}
        />
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-px"
          style={{
            background:
              "linear-gradient(90deg, transparent, rgba(228,210,174,0.5), transparent)",
          }}
        />

        <div className="relative mx-auto grid max-w-5xl items-center gap-12 px-5 py-20 lg:grid-cols-[1.05fr_1fr] lg:py-28">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-sand-light/80">
              Magic Suites &amp; Villas
            </p>
            <h1 className="mt-4 font-serif text-4xl leading-tight text-[#eadfc4] sm:text-5xl">
              Guest rewards
            </h1>
            <p className="mt-5 max-w-md text-white/65">
              Every stay with us earns points worth {percent}% of what you spent
              — and each point is worth ฿1 off a future stay, whenever you book
              with us directly.
            </p>
            <ul className="mt-8 flex flex-wrap gap-3 text-xs tracking-wide text-sand-light/90">
              {[`${percent}% back on every stay`, "1 point = ฿1", `Valid ${VALID_YEARS} years`].map(
                (perk) => (
                  <li
                    key={perk}
                    className="rounded-full border border-sand-light/25 px-4 py-1.5"
                  >
                    {perk}
                  </li>
                )
              )}
            </ul>
          </div>

          <PointsLookup />
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-5 pb-20">
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            {
              title: "Earn automatically",
              text: "Points are added after you check out, on every stay — whether you booked with us directly or through a travel site.",
            },
            {
              title: "Use them with us",
              text: "Message us when booking directly and we'll take your points off the total as a discount.",
            },
            {
              title: "1 point = ฿1",
              text: "No tiers, no blackout dates, nothing to sign up for.",
            },
          ].map((item, i) => (
            <div
              key={item.title}
              className="rounded-2xl border border-white/10 bg-white/[0.04] p-6"
            >
              <p className="font-serif text-2xl text-sand-light/70">0{i + 1}</p>
              <p className="mt-3 font-medium text-white/90">{item.title}</p>
              <p className="mt-2 text-sm leading-relaxed text-white/55">{item.text}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

"use client";

// OWNER: ui-search-results
// Landing step: a villa photo hero (fixed height, so nothing shifts while it
// loads) with the frosted hero SearchBar overlapping its lower edge, then a
// short row of reasons to book direct. Keep SearchStepProps stable.

import Image from "next/image";
import { BadgePercent, Car, ShieldCheck } from "lucide-react";
import SearchBar from "./SearchBar";
import type { SearchBarProps } from "./SearchBar";

export type SearchStepProps = Omit<SearchBarProps, "variant">;

const PERKS = [
  { icon: BadgePercent, title: "Best direct rate", text: "Use code DIRECT for our best price on every room." },
  { icon: Car, title: "Free airport pickup", text: "Included on stays of 2 nights or more." },
  { icon: ShieldCheck, title: "Secure payment by Beam", text: "Cards from any country, or Thai PromptPay." },
];

export default function SearchStep(props: SearchStepProps) {
  return (
    <section aria-labelledby="booking-search-title" className="space-y-6">
      <div className="relative">
        <div className="relative h-[260px] overflow-hidden rounded-(--bk-radius-card) bg-(--bk-surface-sunken) sm:h-[400px]">
          <Image
            src="/images/home/Magic-Suites-50-2.jpg"
            alt="Infinity pool and glass-walled living room of a Magic villa at sunset"
            fill
            preload
            fetchPriority="high"
            sizes="(min-width: 1152px) 1104px, 100vw"
            className="object-cover"
          />
          <div className="absolute inset-0 bg-linear-to-b from-(--bk-overlay) via-transparent via-45% to-(--bk-overlay)" aria-hidden="true" />
          <div className="absolute inset-x-0 top-0 p-5 sm:p-8">
            <h2
              id="booking-search-title"
              className="bk-heading max-w-md text-2xl leading-tight text-(--bk-surface) drop-shadow-sm sm:text-3xl"
            >
              Private pool suites &amp; villas in Koh Samui
            </h2>
          </div>
        </div>
        <div className="relative z-10 -mt-24 px-2 sm:-mt-20 sm:px-6 lg:px-10">
          <SearchBar {...props} variant="hero" />
        </div>
      </div>

      <ul className="grid gap-3 sm:grid-cols-3">
        {PERKS.map(({ icon: Icon, title, text }) => (
          <li key={title} className="flex items-start gap-3 rounded-(--bk-radius-card) bg-(--bk-surface) p-4 shadow-(--bk-shadow-card)">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-(--bk-accent-soft) text-(--bk-accent-soft-text)">
              <Icon size={18} aria-hidden="true" />
            </span>
            <span>
              <span className="block text-sm font-semibold text-(--bk-text)">{title}</span>
              <span className="block text-sm text-(--bk-text-muted)">{text}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

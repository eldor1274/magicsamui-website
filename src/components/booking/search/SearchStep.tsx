"use client";

// OWNER: ui-search-results
// Landing step: a villa photo hero (fixed height, so nothing shifts while it
// loads) with the frosted hero SearchBar overlapping its lower edge, then a
// short row of reasons to book direct. Keep SearchStepProps stable.

import { useContext } from "react";
import Image from "next/image";
import { BadgePercent, Car, MessageCircle, ShieldCheck } from "lucide-react";
import { DEMO_COPY_CONFIG, providerCopy } from "@/lib/booking/paymentCopy";
import { BookingContext } from "../state";
import SearchBar from "./SearchBar";
import type { SearchBarProps } from "./SearchBar";

export type SearchStepProps = Omit<SearchBarProps, "variant">;

const PROMO_PERK = { icon: BadgePercent, title: "Best direct rate", text: "Use code DIRECT for our best price on every room." };
/** Shown instead when promo codes are switched off (every Beam/Stripe mode), so the page never suggests a code that fails. */
const OWNER_PERK = { icon: MessageCircle, title: "Talk to the owner", text: "Questions before you book? Eldor answers on WhatsApp." };
const PICKUP_PERK = { icon: Car, title: "Free airport pickup", text: "Included on stays of 2 nights or more." };

export default function SearchStep(props: SearchStepProps) {
  const config = useContext(BookingContext)?.config;
  // The payment perk names the provider the guest will actually pay with (Stripe or Beam).
  const pay = providerCopy(config ?? DEMO_COPY_CONFIG).perk;
  const perks = [PICKUP_PERK, { icon: ShieldCheck, title: pay.title, text: pay.text }];
  return (
    <section aria-labelledby="booking-search-title" className="space-y-6">
      <div className="relative">
        {/* Phones: a taller photo with the stacked search box pulled well up, so the box floats on the photo (Cloudbeds) instead of hanging off it. */}
        <div className="relative h-[360px] overflow-hidden rounded-(--bk-radius-card) bg-(--bk-surface-sunken) sm:h-[400px]">
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
              tabIndex={-1}
              className="bk-heading max-w-md text-2xl leading-tight text-(--bk-surface) drop-shadow-sm focus:outline-none sm:text-3xl"
            >
              Private pool suites &amp; villas in Koh Samui
            </h2>
          </div>
        </div>
        <div className="relative z-10 -mt-48 px-2 sm:-mt-20 sm:px-6 lg:px-10">
          <SearchBar {...props} variant="hero" />
        </div>
      </div>

      <ul className="grid gap-3 sm:grid-cols-3">
        {[props.promoEnabled === false ? OWNER_PERK : PROMO_PERK, ...perks].map(({ icon: Icon, title, text }) => (
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

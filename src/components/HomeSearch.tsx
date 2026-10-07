"use client";

// Homepage quick search for our own booking engine (BOOKING_ENGINE=own): the
// booking page's search capsule (HomeSearchBar), loaded only in the browser.
//
// Why client-only: a server-rendered next/dynamic component puts its CSS in
// the page as a render-blocking stylesheet, and the capsule needs the booking
// engine's sheet (booking.css). With ssr: false that sheet arrives with the
// lazy chunk, after the hero has painted. Until then - and for anyone without
// JavaScript - the server HTML shows a placeholder of the same look and size:
// one link to /booking, where the same search bar is. It is a link rather
// than the earlier date form so nothing a guest types can be wiped when the
// real bar replaces it.
//
// The wrapper reserves the bar's exact height (capsule + the hint line under
// it: 240px on phones, 116px from 768px), so nothing below moves (CLS 0). It
// is positioned with z-10 so the capsule paints over the hero it overlaps;
// the popovers portal to <body>, so the page's sections never clip them.
// .bk-home-search keeps booking.css's page-wide scroll padding off the homepage.

import dynamic from "next/dynamic";
import { Component, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import { ArrowRight, CalendarDays, Search, Tag, User } from "lucide-react";
import { track } from "@/lib/track";
import type { HomeSearchBarProps } from "./HomeSearchBar";

// The booking theme's "magic" values (booking.css, .booking-app) and the
// capsule's fixed paddings, inline: the placeholder needs neither the booking
// sheet nor new rules in globals.css (only the md: layout switch needs classes).
const CAPSULE_STYLE: CSSProperties = {
  padding: 10,
  backgroundColor: "rgb(255 255 255 / 0.55)",
  boxShadow: "0 0 0 1px rgb(255 255 255 / 0.7), 0 12px 32px rgba(32, 28, 22, 0.18)",
  backdropFilter: "blur(12px)",
  WebkitBackdropFilter: "blur(12px)",
};
const PILL_STYLE: CSSProperties = {
  boxShadow: "0 1px 2px rgba(32, 28, 22, 0.06), 0 0 0 1px rgba(32, 28, 22, 0.05)",
};

// Same geometry as SearchBar's hero variant: pills h-14 (h-12 from md), the
// capsule's 10px padding and gaps, the hint line's mt-2 / md:mt-5 and 28px.
const PILL = "h-14 rounded-full bg-white text-ink md:h-12";
const PILL_BUTTON = `inline-flex items-center justify-center gap-2 px-4 text-sm font-medium sm:text-[15px] ${PILL}`;
const DATE_TEXT = "flex h-full flex-1 items-center justify-center px-2 text-sm font-medium text-ink-soft sm:text-[15px]";

function HomeSearchPlaceholder({ promoEnabled }: { promoEnabled: boolean }) {
  return (
    <div>
      {/* One link for screen readers (named like the real search form); the pills inside are only its picture. */}
      <a href="/booking" aria-label="Search availability" className="block rounded-[1.75rem] md:rounded-full" style={CAPSULE_STYLE}>
        <span aria-hidden="true" className="flex flex-col gap-2 md:flex-row">
          <span className={`flex items-center gap-1 md:flex-[1.6] ${PILL}`} style={{ ...PILL_STYLE, padding: "0 6px" }}>
            <CalendarDays size={18} className="ml-2 shrink-0 text-ink-soft" />
            <span className={DATE_TEXT}>Check-in</span>
            <ArrowRight size={16} className="shrink-0 text-ink-soft" />
            <span className={DATE_TEXT}>Check-out</span>
          </span>
          <span className="flex gap-2">
            <span className={`${PILL_BUTTON} flex-1 md:flex-none md:min-w-32`} style={PILL_STYLE}>
              <User size={18} className="shrink-0 text-ink-soft" />
              2 Guests
            </span>
            {promoEnabled && (
              <span className={`${PILL_BUTTON} flex-1 md:flex-none md:min-w-36`} style={PILL_STYLE}>
                <Tag size={18} className="shrink-0 text-ink-soft" />
                Add Code
              </span>
            )}
          </span>
          {/* Drawn disabled (the booking theme's --bk-disabled-opacity), like the real Search button before dates are chosen: no change of look when the bar replaces it. */}
          <span className="inline-flex h-14 shrink-0 items-center justify-center gap-2 rounded-full bg-pool px-7 text-base font-medium text-white md:h-12 md:min-w-32" style={{ opacity: 0.4 }}>
            <Search size={18} className="shrink-0" />
            Search
          </span>
        </span>
      </a>
      <div className="mt-2 flex justify-center md:mt-5 md:justify-start md:pl-3" style={{ minHeight: 28 }}>
        <p className="rounded-xl bg-white/90 px-3 py-1 text-center text-sm font-medium text-ink md:text-left">Choose your dates to see prices.</p>
      </div>
    </div>
  );
}

// One loader per placeholder variant (next/dynamic's loading component gets no props); both load the same chunk.
const BarWithCode = dynamic<HomeSearchBarProps>(() => import("./HomeSearchBar"), {
  ssr: false,
  loading: () => <HomeSearchPlaceholder promoEnabled />,
});
const BarWithoutCode = dynamic<HomeSearchBarProps>(() => import("./HomeSearchBar"), {
  ssr: false,
  loading: () => <HomeSearchPlaceholder promoEnabled={false} />,
});

/**
 * If the bar's chunk can't load (a flaky connection, or a page cached across a
 * deployment), keep the placeholder link to /booking instead of letting the
 * error take down the homepage.
 */
class PlaceholderOnError extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export type HomeSearchProps = HomeSearchBarProps;

export default function HomeSearch(props: HomeSearchProps) {
  const tracked = useRef(false);
  const Bar = props.promoEnabled ? BarWithCode : BarWithoutCode;
  return (
    <div
      className="bk-home-search relative z-10 min-h-[240px] md:min-h-[116px] lg:-mx-16 xl:-mx-28"
      // Same GA4 event as the earlier homepage date form and the Cloudbeds widget: first click anywhere in the search.
      onClickCapture={() => {
        if (!tracked.current) {
          tracked.current = true;
          track("date_picker_interact");
        }
      }}
    >
      <PlaceholderOnError fallback={<HomeSearchPlaceholder promoEnabled={props.promoEnabled} />}>
        <Bar {...props} />
      </PlaceholderOnError>
    </div>
  );
}

"use client";

// OWNER: foundation. Preview copy of the shared BookingHelpStrip (the /booking
// WhatsApp rescue): after 90 s on the page a dismissible "Having trouble
// paying?" bar pins to the bottom. Two differences from the shared strip:
// - its events go through the gated booking analytics, so nothing reaches
//   GA4 from the preview (the shared strip calls track() directly);
// - on phones it stacks ABOVE the mobile cart bar (--bk-cart-bar-h) instead
//   of being hidden underneath it, right where payment trouble happens.

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { MessageCircle, X } from "lucide-react";
import { site } from "@/data/site";
import type { BookingAnalytics } from "@/lib/booking/clientAnalytics";
import { useBottomBar } from "./bottomBars";

const STICKY_AFTER_MS = 90_000;
/** Same key as the shared strip: dismissing either one dismisses both for the session. */
const DISMISS_KEY = "msv_booking_help_dismissed";

const WHATSAPP_HREF = `${site.whatsapp}?text=${encodeURIComponent(
  "Hi, I'm having trouble completing my booking on magicsamui.com - can you help?",
)}`;

export default function BookingHelp({ analytics }: { analytics: BookingAnalytics }) {
  const [sticky, setSticky] = useState(false);
  const barRef = useRef<HTMLElement>(null);
  const analyticsRef = useRef(analytics);
  useBottomBar("help", barRef, sticky);

  useEffect(() => {
    analyticsRef.current = analytics;
  });

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(DISMISS_KEY)) return;
    } catch {
      /* storage blocked - still show the bar */
    }
    const timer = window.setTimeout(() => {
      setSticky(true);
      analyticsRef.current.helpShown();
    }, STICKY_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);

  function dismiss() {
    // The focused Dismiss button is about to unmount: hand focus to the current
    // step's heading (search hero title on the first step) instead of <body>.
    const bar = barRef.current;
    if (bar && bar.contains(document.activeElement)) {
      const heading = document.getElementById("booking-step-heading") ?? document.getElementById("booking-search-title");
      heading?.focus({ preventScroll: true });
    }
    setSticky(false);
    try {
      window.sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  return (
    <>
      {/* Always mounted, so the short message is announced when the bar appears
          (a live region that mounts already filled is often not read). */}
      <p role="status" className="bk-sr-only">
        {sticky ? "Having trouble paying? You can message us on WhatsApp." : ""}
      </p>
      {sticky && <HelpBar barRef={barRef} analytics={analytics} onDismiss={dismiss} />}
    </>
  );
}

function HelpBar({
  barRef,
  analytics,
  onDismiss,
}: {
  barRef: RefObject<HTMLElement | null>;
  analytics: BookingAnalytics;
  onDismiss: () => void;
}) {
  return (
    <aside
      ref={barRef}
      aria-label="Payment help"
      className="fixed inset-x-0 bottom-[var(--bk-cart-bar-h,0px)] z-40 border-t border-(--bk-border) bg-(--bk-surface) px-4 py-3 text-(--bk-text) shadow-(--bk-shadow-bar) lg:bottom-0"
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
        <p className="min-w-0 text-sm">
          {/* Short label on phones so the row (and the pill) stays on one line at 360-390px. */}
          <span className="font-medium sm:hidden">Need help paying?</span>
          <span className="hidden font-medium sm:inline">Having trouble paying?</span>{" "}
          <span className="hidden text-(--bk-text-muted) sm:inline">
            It happens - message us and Eldor will complete the booking for you.
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={WHATSAPP_HREF}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => analytics.helpClick("whatsapp")}
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-(--bk-radius-pill) bg-(--bk-accent) px-4 text-sm font-medium text-(--bk-accent-contrast) transition-colors hover:bg-(--bk-accent-hover)"
          >
            <MessageCircle size={15} className="shrink-0" aria-hidden="true" />
            WhatsApp us
          </a>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss help bar"
            className="inline-flex h-11 w-11 items-center justify-center rounded-full text-(--bk-text-muted) hover:bg-(--bk-surface-sunken)"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </aside>
  );
}

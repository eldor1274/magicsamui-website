"use client";

import { useEffect, useRef, useState } from "react";
import { site } from "@/data/site";
import { track } from "@/lib/track";

export default function CloudbedsImmersive() {
  const [isLocal, setIsLocal] = useState<boolean | null>(null);
  const tracked = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Cloudbeds only serves its widgets to whitelisted public domains,
    // and localhost can't be whitelisted — skip the embed in local dev.
    setIsLocal(["localhost", "127.0.0.1"].includes(window.location.hostname));
    track("booking_engine_view");
  }, []);

  // The engine keeps one search control alive at a time: while its landing
  // search panel is off screen it marks the panel inert + aria-hidden and
  // relies on the compact bar in its header. globals.css hides that bar on the
  // landing view (it made the page jump while scrolling), so without this the
  // date fields were unreachable by keyboard and invisible to screen readers
  // whenever the panel was off screen - including at load on short screens.
  // Attribute-only observer, scoped to the engine: it fires on inert changes,
  // not on the engine's heavy DOM churn.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (isLocal !== false || !wrap) return;
    const release = (el: Element) => {
      if (!el.hasAttribute("inert") || !el.closest("main.cb-landing-page")) return;
      el.removeAttribute("inert");
      el.removeAttribute("aria-hidden");
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.target instanceof Element) release(record.target);
      }
    });
    observer.observe(wrap, { subtree: true, attributes: true, attributeFilter: ["inert"] });
    wrap.querySelectorAll("main.cb-landing-page [inert]").forEach(release);
    return () => observer.disconnect();
  }, [isLocal]);

  // The engine renders at height 0 until its script arrives, then expands and
  // shoves the footer down - Lighthouse measured CLS 0.569 on /booking from
  // exactly that footer jump. Reserving a viewport of height keeps the footer
  // below the fold from first paint, so the pop-in shifts nothing visible.
  if (isLocal === null) return <div className="min-h-dvh" />;

  if (isLocal) {
    return (
      <div className="rounded-2xl bg-stone-100 p-10 text-center text-ink-soft">
        Booking engine — shows on the live site only
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      className="min-h-dvh"
      onClickCapture={() => {
        if (!tracked.current) {
          tracked.current = true;
          track("booking_engine_interact");
        }
      }}
    >
      <cb-immersive-experience
        mode="standard"
        property-code={site.cloudbedsPropertyCode}
        currency="thb"
      />
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { site } from "@/data/site";
import { track } from "@/lib/track";

export default function CloudbedsImmersive() {
  const [isLocal, setIsLocal] = useState<boolean | null>(null);
  const tracked = useRef(false);

  useEffect(() => {
    // Cloudbeds only serves its widgets to whitelisted public domains,
    // and localhost can't be whitelisted — skip the embed in local dev.
    setIsLocal(["localhost", "127.0.0.1"].includes(window.location.hostname));
    track("booking_engine_view");
  }, []);

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

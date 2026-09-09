"use client";

import { useEffect, useRef, useState } from "react";
import { site } from "@/data/site";
import { track } from "@/lib/track";

export default function CloudbedsDatePicker({ className = "" }: { className?: string }) {
  // custom-url must be absolute and the site runs on more than one domain,
  // so it can only be known in the browser.
  const [bookingUrl, setBookingUrl] = useState<string | null>(null);
  const [isLocal, setIsLocal] = useState(false);
  const tracked = useRef(false);

  useEffect(() => {
    setBookingUrl(`${window.location.origin}/booking`);
    // Cloudbeds only serves its widgets to whitelisted public domains,
    // and localhost can't be whitelisted — skip the widget in local dev.
    setIsLocal(["localhost", "127.0.0.1"].includes(window.location.hostname));
  }, []);

  // Measured on the live widget (2026-09-09): it renders 98px tall on phones and
  // 101-106px from tablet width up, never the 56px this used to reserve. That
  // 42-50px pop-in was the homepage's whole field CLS (0.05 per view).
  const reserve = "min-h-[98px] md:min-h-[106px]";

  if (!bookingUrl) return <div className={`${className} ${reserve}`} />;

  if (isLocal) {
    return (
      <div className={className}>
        <div className="rounded-full bg-white px-6 py-4 text-center text-sm text-ink-soft shadow-lg ring-1 ring-black/5">
          Availability calendar — shows on the live site only
        </div>
      </div>
    );
  }

  return (
    // min-height reserves the widget's full space while its script loads on
    // first interaction, so the late upgrade causes no layout shift.
    <div
      className={`${className} ${reserve}`}
      onClickCapture={() => {
        if (!tracked.current) {
          tracked.current = true;
          track("date_picker_interact");
        }
      }}
    >
      <cb-property-date-picker
        property-code={site.cloudbedsPropertyCode}
        button-label="Check Availability"
        layout="horizontal"
        currency="thb"
        custom-url={bookingUrl}
      />
    </div>
  );
}

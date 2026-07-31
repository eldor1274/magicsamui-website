"use client";

import { useEffect, useState } from "react";
import { site } from "@/data/site";

export default function CloudbedsDatePicker({ className = "" }: { className?: string }) {
  // custom-url must be absolute and the site runs on more than one domain,
  // so it can only be known in the browser.
  const [bookingUrl, setBookingUrl] = useState<string | null>(null);

  useEffect(() => {
    setBookingUrl(`${window.location.origin}/booking`);
  }, []);

  if (!bookingUrl) return <div className={className} style={{ minHeight: 56 }} />;

  return (
    <div className={className}>
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

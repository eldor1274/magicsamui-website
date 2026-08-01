"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useInteractionLoad } from "@/lib/useInteractionLoad";
import { site } from "@/data/site";

// Cloudbeds' immersive bundle costs ~430 KiB of JS, so outside /booking
// (where it IS the page content) it waits for the visitor's first
// interaction. useInteractionLoad also keeps it off localhost, which
// Cloudbeds can't whitelist anyway.
export default function CloudbedsScript() {
  const pathname = usePathname();
  const interacted = useInteractionLoad(5000);
  const [bookingEager, setBookingEager] = useState(false);

  useEffect(() => {
    setBookingEager(
      pathname === "/booking" &&
        !["localhost", "127.0.0.1"].includes(window.location.hostname)
    );
  }, [pathname]);

  if (!interacted && !bookingEager) return null;

  return <Script src={site.cloudbedsImmersiveScript} strategy="afterInteractive" />;
}

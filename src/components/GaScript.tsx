"use client";

import Script from "next/script";
import { useInteractionLoad } from "@/lib/useInteractionLoad";

const gaId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

// Google Analytics, deferred to first interaction (or shortly after load).
// The dataLayer stub in layout.tsx queues config and any funnel events
// from page start; gtag.js replays the queue when it loads here.
export default function GaScript() {
  const load = useInteractionLoad(4000);

  if (!gaId || !load) return null;

  return (
    <Script
      src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
      strategy="afterInteractive"
    />
  );
}

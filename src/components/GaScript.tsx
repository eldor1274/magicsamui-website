"use client";

import Script from "next/script";
import { useInteractionLoad } from "@/lib/useInteractionLoad";
import { GOOGLE_ADS_ID } from "@/lib/analytics";
import { isOwnerDevice } from "@/lib/owner";

const gaId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

// Google Analytics + Google Ads, deferred to first interaction (or shortly
// after load). One gtag.js serves both tags — the id in the URL only picks
// which container to fetch; the dataLayer stub in layout.tsx configures both
// and gtag.js replays that queue when it loads here.
export default function GaScript() {
  const load = useInteractionLoad(4000);
  const tagId = gaId || GOOGLE_ADS_ID;

  // Owner devices never load gtag.js, so the queued pageview/events are
  // never sent - Eldor's own visits stay out of GA4 and Ads conversions.
  if (!tagId || !load || isOwnerDevice()) return null;

  return (
    <Script
      src={`https://www.googletagmanager.com/gtag/js?id=${tagId}`}
      strategy="afterInteractive"
    />
  );
}

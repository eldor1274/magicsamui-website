"use client";

import Script from "next/script";
import { useInteractionLoad } from "@/lib/useInteractionLoad";
import { GOOGLE_ADS_ID } from "@/lib/analytics";

const gaId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

// Google Analytics + Google Ads, deferred to first interaction (or shortly
// after load). One gtag.js serves both tags — the id in the URL only picks
// which container to fetch; the dataLayer stub in layout.tsx configures both
// and gtag.js replays that queue when it loads here.
export default function GaScript() {
  const load = useInteractionLoad(4000);
  const tagId = gaId || GOOGLE_ADS_ID;

  if (!tagId || !load) return null;

  return (
    <Script
      src={`https://www.googletagmanager.com/gtag/js?id=${tagId}`}
      strategy="afterInteractive"
    />
  );
}

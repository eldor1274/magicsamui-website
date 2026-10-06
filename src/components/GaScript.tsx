"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useInteractionLoad } from "@/lib/useInteractionLoad";
import { GOOGLE_ADS_ID } from "@/lib/analytics";
import { isOwnerDevice } from "@/lib/owner";

const gaId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

// Google Analytics + Google Ads, deferred to first interaction (or shortly
// after load). One gtag.js serves both tags — the id in the URL only picks
// which container to fetch; the dataLayer stub in layout.tsx configures both
// and gtag.js replays that queue when it loads here.
// previewTracked (from the layout, server side): the booking preview takes REAL
// payments (stripe-live on production - Stage C and the soft launch), so it is
// measured like any other page. Otherwise it runs demo / test-mode / MOCK
// payments (and Stage B tests on production) and must not reach GA4 or Ads.
// previewReturnTracked: the preview's RETURN page while live Stripe payments are
// still being finished (emergency stop or provider drain): purchases of bookings
// already paid are confirmed there and must still be recorded.
export default function GaScript({ previewTracked = false, previewReturnTracked = false }: { previewTracked?: boolean; previewReturnTracked?: boolean }) {
  const load = useInteractionLoad(4000, 1500);
  const pathname = usePathname();
  const tagId = gaId || GOOGLE_ADS_ID;

  // Not even the page_view queued by the layout's stub may leave a non-live
  // preview: gtag.js simply never loads there.
  const tracked = previewTracked || (previewReturnTracked && pathname?.startsWith("/booking-preview/return") === true);
  if (!tracked && pathname?.startsWith("/booking-preview")) return null;

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

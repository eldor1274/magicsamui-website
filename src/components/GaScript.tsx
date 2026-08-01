"use client";

import Script from "next/script";
import { useInteractionLoad } from "@/lib/useInteractionLoad";

const gaId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

// Google Analytics, deferred to first interaction (or shortly after load).
// First scroll fires earlier than the load event on slow connections, so
// this records quick visitors sooner than afterInteractive did.
export default function GaScript() {
  const load = useInteractionLoad(4000);

  if (!gaId || !load) return null;

  return (
    <>
      <Script src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`} strategy="afterInteractive" />
      <Script id="ga-init" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${gaId}');
        `}
      </Script>
    </>
  );
}

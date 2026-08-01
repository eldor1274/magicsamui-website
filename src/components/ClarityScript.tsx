"use client";

import Script from "next/script";
import { useInteractionLoad } from "@/lib/useInteractionLoad";

const CLARITY_PROJECT_ID = "xv2bxar3ao";

// Microsoft Clarity session recording, deferred to first interaction;
// visitors who bounce without ever touching the page weren't producing
// useful recordings anyway.
export default function ClarityScript() {
  const load = useInteractionLoad(10000);

  if (!load) return null;

  return (
    <Script id="ms-clarity" strategy="afterInteractive">
      {`
        (function(c,l,a,r,i,t,y){
            c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
            t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
            y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
        })(window, document, "clarity", "script", "${CLARITY_PROJECT_ID}");
      `}
    </Script>
  );
}

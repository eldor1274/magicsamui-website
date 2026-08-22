"use client";

import Script from "next/script";
import { useInteractionLoad } from "@/lib/useInteractionLoad";
import { isOwnerDevice } from "@/lib/owner";

const CLARITY_PROJECT_ID = "xv2bxar3ao";

// Automation that Clarity's own bot filter can miss because it runs a real
// browser: Lighthouse/PageSpeed audits, headless Chrome, webdriver sessions.
// Clarity already handles declared crawlers server-side; this is the gap.
const BOT_UA =
  /headless|phantom|selenium|puppeteer|playwright|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|bot|crawl|spider/i;

function shouldRecord(): boolean {
  if (typeof navigator === "undefined") return false;
  if (navigator.webdriver) return false;
  if (BOT_UA.test(navigator.userAgent)) return false;
  // Eldor's own devices (points admin unlock, or ?staff=1) - see lib/owner.ts
  if (isOwnerDevice()) return false;
  return true;
}

// Microsoft Clarity session recording, deferred to first interaction;
// visitors who bounce without ever touching the page weren't producing
// useful recordings anyway. Engagement classification (low/medium/high
// intent) is Clarity's own job, so nothing is tagged here.
export default function ClarityScript() {
  const load = useInteractionLoad(10000);

  if (!load || !shouldRecord()) return null;

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

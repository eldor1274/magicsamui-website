"use client";

import Script from "next/script";
import { useInteractionLoad } from "@/lib/useInteractionLoad";

const CLARITY_PROJECT_ID = "xv2bxar3ao";

// Set on the owner's devices when the points admin is unlocked, so Eldor's
// own visits (20 sessions and 6 hours in a month) stop inflating the numbers.
// Clarity has no way to tell it's him; its IP blocking would also cut off
// guests on the villa Wi-Fi, so a per-device flag is the right tool.
export const OWNER_FLAG = "msv_owner";

// Automation that Clarity's own bot filter can miss because it runs a real
// browser: Lighthouse/PageSpeed audits, headless Chrome, webdriver sessions.
// Clarity already handles declared crawlers server-side; this is the gap.
const BOT_UA =
  /headless|phantom|selenium|puppeteer|playwright|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|bot|crawl|spider/i;

function shouldRecord(): boolean {
  if (typeof navigator === "undefined") return false;
  if (navigator.webdriver) return false;
  if (BOT_UA.test(navigator.userAgent)) return false;
  try {
    if (window.localStorage.getItem(OWNER_FLAG)) return false;
  } catch {
    /* storage blocked - record as normal */
  }
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

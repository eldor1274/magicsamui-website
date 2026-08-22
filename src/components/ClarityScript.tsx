"use client";

import Script from "next/script";
import { useEffect } from "react";
import { useInteractionLoad } from "@/lib/useInteractionLoad";

const CLARITY_PROJECT_ID = "xv2bxar3ao";

// Set on the owner's devices when the points admin is unlocked, so Eldor's
// own visits (20 sessions and 6 hours in a month) stop inflating the numbers.
export const OWNER_FLAG = "msv_owner";

// Anything that identifies itself as automation, or is driven by one.
const BOT_UA =
  /bot|crawl|spider|slurp|headless|phantom|selenium|puppeteer|playwright|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|scrapy|python-requests|curl|wget|httpclient|java\/|go-http|node-fetch|axios/i;

function classify(): "bot" | "owner" | "human" {
  if (typeof navigator === "undefined") return "human";
  if (navigator.webdriver) return "bot";
  if (BOT_UA.test(navigator.userAgent)) return "bot";
  // Real browsers always report at least one language; many headless
  // scrapers report none.
  if (!navigator.languages || navigator.languages.length === 0) return "bot";
  try {
    if (window.localStorage.getItem(OWNER_FLAG)) return "owner";
  } catch {
    /* storage blocked - treat as human */
  }
  return "human";
}

type ClarityFn = (...args: unknown[]) => void;

function clarity(...args: unknown[]) {
  const w = window as unknown as { clarity?: ClarityFn };
  if (typeof w.clarity === "function") w.clarity(...args);
}

// Microsoft Clarity session recording, deferred to first interaction.
// Detected bots and the owner's own devices are never recorded at all;
// everyone else is tagged so sessions that never showed a human input can
// be filtered out in Clarity ("traffic" = idle vs human).
export default function ClarityScript() {
  const load = useInteractionLoad(10000);
  const kind = typeof window === "undefined" ? "human" : classify();

  useEffect(() => {
    if (!load || kind !== "human") return;

    clarity("set", "traffic", load === "interaction" ? "human" : "idle");

    // A fallback-loaded visitor who later moves becomes human after all.
    if (load === "fallback") {
      const promote = () => clarity("set", "traffic", "human");
      const events: (keyof WindowEventMap)[] = ["pointermove", "pointerdown", "touchstart", "keydown", "wheel", "scroll"];
      events.forEach((e) => window.addEventListener(e, promote, { once: true, passive: true }));
      return () => events.forEach((e) => window.removeEventListener(e, promote));
    }
  }, [load, kind]);

  if (!load || kind !== "human") return null;

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

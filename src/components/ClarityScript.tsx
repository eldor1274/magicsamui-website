"use client";

import Script from "next/script";
import { useEffect, useState } from "react";

const CLARITY_PROJECT_ID = "xv2bxar3ao";

// Microsoft Clarity session recording — public domains only, so local
// dev sessions never pollute the recordings. Loads on first interaction
// (with an after-load fallback) to stay out of the startup critical path;
// visitors who bounce without ever touching the page weren't producing
// useful recordings anyway.
export default function ClarityScript() {
  const [load, setLoad] = useState(false);

  useEffect(() => {
    if (load) return;
    if (["localhost", "127.0.0.1"].includes(window.location.hostname)) return;

    const start = () => setLoad(true);
    const events: (keyof WindowEventMap)[] = [
      "pointerdown",
      "touchstart",
      "keydown",
      "wheel",
      "scroll",
    ];
    events.forEach((e) =>
      window.addEventListener(e, start, { once: true, passive: true })
    );

    let fallback: ReturnType<typeof setTimeout> | undefined;
    const armFallback = () => {
      fallback = setTimeout(start, 10000);
    };
    if (document.readyState === "complete") armFallback();
    else window.addEventListener("load", armFallback, { once: true });

    return () => {
      events.forEach((e) => window.removeEventListener(e, start));
      window.removeEventListener("load", armFallback);
      if (fallback) clearTimeout(fallback);
    };
  }, [load]);

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

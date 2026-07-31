"use client";

import Script from "next/script";
import { useEffect, useState } from "react";

const CLARITY_PROJECT_ID = "xv2bxar3ao";

// Microsoft Clarity session recording — public domains only, so local
// dev sessions never pollute the recordings.
export default function ClarityScript() {
  const [load, setLoad] = useState(false);

  useEffect(() => {
    setLoad(!["localhost", "127.0.0.1"].includes(window.location.hostname));
  }, []);

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

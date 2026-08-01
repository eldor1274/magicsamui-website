"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { site } from "@/data/site";

// Cloudbeds' immersive bundle costs ~430 KiB of JS, so outside /booking
// (where it IS the page content) it waits for the visitor's first
// interaction, with an after-load fallback for people who just read.
// Localhost is skipped entirely — Cloudbeds can't whitelist it.
export default function CloudbedsScript() {
  const pathname = usePathname();
  const [load, setLoad] = useState(false);

  useEffect(() => {
    if (load) return;
    if (["localhost", "127.0.0.1"].includes(window.location.hostname)) return;
    if (pathname === "/booking") {
      setLoad(true);
      return;
    }

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
      fallback = setTimeout(start, 5000);
    };
    if (document.readyState === "complete") armFallback();
    else window.addEventListener("load", armFallback, { once: true });

    return () => {
      events.forEach((e) => window.removeEventListener(e, start));
      window.removeEventListener("load", armFallback);
      if (fallback) clearTimeout(fallback);
    };
  }, [pathname, load]);

  if (!load) return null;

  return <Script src={site.cloudbedsImmersiveScript} strategy="afterInteractive" />;
}

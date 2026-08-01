"use client";

import { useEffect, useState } from "react";

// Defers heavy third-party scripts out of the startup critical path:
// returns true on the visitor's first interaction, or `fallbackMs` after
// the load event for visitors who never touch the page. Always false on
// localhost so dev sessions stay clean.
export function useInteractionLoad(fallbackMs: number) {
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
      fallback = setTimeout(start, fallbackMs);
    };
    if (document.readyState === "complete") armFallback();
    else window.addEventListener("load", armFallback, { once: true });

    return () => {
      events.forEach((e) => window.removeEventListener(e, start));
      window.removeEventListener("load", armFallback);
      if (fallback) clearTimeout(fallback);
    };
  }, [load, fallbackMs]);

  return load;
}

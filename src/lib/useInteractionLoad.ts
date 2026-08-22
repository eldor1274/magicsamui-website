"use client";

import { useEffect, useState } from "react";

export type LoadTrigger = false | "interaction" | "fallback";

// Defers heavy third-party scripts out of the startup critical path:
// returns "interaction" on the visitor's first interaction, or "fallback"
// `fallbackMs` after the load event for visitors who never touch the page.
// Both are truthy, so callers that only care whether to load keep working;
// the distinction lets analytics tag sessions that never showed a human.
// Always false on localhost so dev sessions stay clean.
export function useInteractionLoad(fallbackMs: number): LoadTrigger {
  const [load, setLoad] = useState<LoadTrigger>(false);

  useEffect(() => {
    if (load) return;
    if (["localhost", "127.0.0.1"].includes(window.location.hostname)) return;

    const start = () => setLoad("interaction");
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
      fallback = setTimeout(() => setLoad("fallback"), fallbackMs);
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

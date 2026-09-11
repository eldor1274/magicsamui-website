"use client";

import { useEffect, useState } from "react";

export type LoadTrigger = false | "interaction" | "fallback";

// Defers heavy third-party scripts out of the startup critical path:
// returns "interaction" on the visitor's first interaction, or "fallback"
// `fallbackMs` after the load event for visitors who never touch the page.
// Both are truthy, so callers that only care whether to load keep working;
// the distinction lets analytics tag sessions that never showed a human.
// Always false on localhost so dev sessions stay clean.
// `interactionDelayMs` staggers the non-essential scripts: without it, GA,
// Clarity and the ~430 KiB Cloudbeds bundle all arrived and evaluated on the
// main thread within the same second after the first tap, which is exactly
// when the visitor taps again (field INP sat at ~300 ms). Cloudbeds keeps 0
// because the date picker needs it; the trackers can wait a moment.
export function useInteractionLoad(
  fallbackMs: number,
  interactionDelayMs = 0
): LoadTrigger {
  const [load, setLoad] = useState<LoadTrigger>(false);

  useEffect(() => {
    if (load) return;
    if (["localhost", "127.0.0.1"].includes(window.location.hostname)) return;

    let delayed: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      if (interactionDelayMs > 0) {
        delayed = setTimeout(() => setLoad("interaction"), interactionDelayMs);
      } else {
        setLoad("interaction");
      }
    };
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
      if (delayed) clearTimeout(delayed);
    };
  }, [load, fallbackMs, interactionDelayMs]);

  return load;
}

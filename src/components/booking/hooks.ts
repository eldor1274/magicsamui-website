"use client";

// OWNER: foundation. Small client hooks shared by booking components.
// They use useSyncExternalStore (no setState inside effects - the repo's
// eslint config rejects that pattern).

import { useSyncExternalStore } from "react";

/** Live media query match; false during SSR and the first client render. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Phone layout (< 768px): full-screen calendar, bottom sheets. */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 767px)");
}

/** Desktop two-column layout with the sticky summary (>= 1024px). */
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 1024px)");
}

const noopSubscribe = () => () => {};

/** False on the server and during hydration, true afterwards. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

"use client";

// Queues GA4 events via the dataLayer stub that layout.tsx seeds at page
// start, so events fire correctly even before the lazily-loaded gtag.js
// arrives (it replays the queue in order on load).
export function track(event: string, params?: Record<string, string | number>) {
  if (typeof window === "undefined") return;
  const w = window as unknown as { dataLayer?: unknown[] };
  w.dataLayer = w.dataLayer || [];
  // gtag.js expects Arguments objects on the dataLayer, not plain arrays.
  (function (..._args: unknown[]) {
    w.dataLayer!.push(arguments);
  })("event", event, params || {});
}

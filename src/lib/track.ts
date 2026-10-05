"use client";

// Queues GA4 events via the dataLayer stub that layout.tsx seeds at page
// start, so events fire correctly even before the lazily-loaded gtag.js
// arrives (it replays the queue in order on load).
// params accept nested values (e.g. GA4 ecommerce `items` arrays).
export function track(event: string, params?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  const w = window as unknown as { dataLayer?: unknown[] };
  w.dataLayer = w.dataLayer || [];
  // gtag.js expects Arguments objects on the dataLayer, not plain arrays.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the rest param only types the call; gtag reads `arguments`
  (function (..._args: unknown[]) {
    // eslint-disable-next-line prefer-rest-params -- gtag needs the Arguments object itself
    w.dataLayer!.push(arguments);
  })("event", event, params || {});
}

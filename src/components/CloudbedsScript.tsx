"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { useInteractionLoad } from "@/lib/useInteractionLoad";
import { site } from "@/data/site";

// Cloudbeds' immersive bundle costs ~430 KiB of JS, so outside /booking
// (where it IS the page content) it waits for the visitor's first
// interaction. useInteractionLoad also keeps it off localhost, which
// Cloudbeds can't whitelist anyway.
// ownEngine (BOOKING_ENGINE=own, from the layout): /booking serves our own
// engine and the homepage uses our own date form, so the bundle is only
// needed on the Cloudbeds fallback page /booking/classic.
const LOCAL_HOSTS = ["localhost", "127.0.0.1"];

/** useSyncExternalStore subscription for a value that never changes while the page is open. */
function subscribeNever(): () => void {
  return () => undefined;
}

export default function CloudbedsScript({ ownEngine = false }: { ownEngine?: boolean }) {
  const pathname = usePathname();
  const interacted = useInteractionLoad(5000);
  // The page hostname is only known in the browser (null on the server and while hydrating), so the
  // eager load on the Cloudbeds booking pages starts right after hydration, as before.
  const hostname = useSyncExternalStore(subscribeNever, () => window.location.hostname, () => null);
  const bookingEager =
    ((pathname === "/booking" && !ownEngine) || pathname === "/booking/classic") &&
    hostname !== null &&
    !LOCAL_HOSTS.includes(hostname);

  // The own booking engine (the preview, its return pages) never uses the Cloudbeds bundle.
  if (pathname?.startsWith("/booking-preview") || pathname?.startsWith("/booking/return")) return null;
  if (ownEngine && pathname !== "/booking/classic") return null;
  if (!interacted && !bookingEager) return null;

  return <Script src={site.cloudbedsImmersiveScript} strategy="afterInteractive" />;
}

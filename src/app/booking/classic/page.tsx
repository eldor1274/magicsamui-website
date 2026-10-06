import type { Metadata } from "next";
import ClassicBookingPage from "@/components/ClassicBookingPage";

// The Cloudbeds booking engine, kept as a fallback once /booking serves our
// own engine (BOOKING_ENGINE=own). Not in the sitemap; noindex and linked
// nofollow. No canonical to /booking: Google advises against noindex plus a
// cross-URL canonical (the target may inherit the noindex).
export const metadata: Metadata = {
  title: "Book Your Stay (classic) | Magic Suites & Villas",
  description: "The classic Cloudbeds booking page for Magic Suites & Villas, Koh Samui.",
  robots: { index: false, follow: true },
};

export default function ClassicBookingFallbackPage() {
  return <ClassicBookingPage />;
}

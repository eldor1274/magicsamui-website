import type { Metadata } from "next";
import ClassicBookingPage from "@/components/ClassicBookingPage";
import OwnBookingPage from "@/components/booking/OwnBookingPage";
import type { BookingSearchParams } from "@/components/booking/OwnBookingPage";
import { resolveBookingEngine } from "@/lib/booking/config";

// One description for both engines: no price promise and no promo code (rate parity, 2026-11-16),
// and nothing that only one engine does. The pickup is the house policy (HOUSE_POLICIES.transfer).
export const metadata: Metadata = {
  alternates: { canonical: "/booking" },
  title: "Book Your Stay | Magic Suites & Villas",
  description:
    "Check live availability and book your private pool suite or villa at Magic Suites & Villas, Koh Samui — free airport or pier pickup on stays of 2+ nights.",
};

// BOOKING_ENGINE = own | cloudbeds (default cloudbeds) picks what /booking
// renders. On the production deployment "own" only takes effect once live
// Stripe payments are fully unlocked (resolveBookingEngine), so a demo, test
// or locked engine can never replace the public page. With "cloudbeds" the
// request's search params are never read, so the page stays prerendered
// exactly as before. Env changes need a redeploy (Vercel applies env vars to
// new deployments only).
export default async function BookingPage({ searchParams }: { searchParams: Promise<BookingSearchParams> }) {
  if (resolveBookingEngine() !== "own") return <ClassicBookingPage />;
  return <OwnBookingPage searchParams={await searchParams} basePath="/booking" classicHref="/booking/classic" />;
}

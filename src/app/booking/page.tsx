import type { Metadata } from "next";
import ClassicBookingPage from "@/components/ClassicBookingPage";
import OwnBookingPage from "@/components/booking/OwnBookingPage";
import type { BookingSearchParams } from "@/components/booking/OwnBookingPage";
import { resolveBookingEngine } from "@/lib/booking/config";

// The own engine adds an openly shown payment processing fee and has no DIRECT
// code, so it must not promise the best rate (the Cloudbeds engine's DIRECT does).
export const metadata: Metadata = {
  alternates: { canonical: "/booking" },
  title: "Book Your Stay | Magic Suites & Villas",
  description:
    resolveBookingEngine() === "own"
      ? "Check live availability and book your private pool suite or villa at Magic Suites & Villas, Koh Samui — secure card or PromptPay payment, confirmed on the spot."
      : "Check live availability and book your private pool suite or villa at Magic Suites & Villas, Koh Samui — best rate, always, when you book direct.",
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

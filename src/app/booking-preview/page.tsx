import type { Metadata } from "next";
import OwnBookingPage from "@/components/booking/OwnBookingPage";
import type { BookingSearchParams } from "@/components/booking/OwnBookingPage";

// PREVIEW of the own booking engine. Not linked from anywhere, not in the
// sitemap, noindex. Demo mode by default: simulated availability and payment,
// nothing is charged or reserved. BOOKING_PAYMENT_PROVIDER (stripe | beam |
// demo) picks the payment provider; the banner says which mode is running.
export const metadata: Metadata = {
  title: "Booking preview | Magic Suites & Villas",
  description: "Preview of the direct booking engine.",
  robots: { index: false, follow: false },
};

export default async function BookingPreviewPage({ searchParams }: { searchParams: Promise<BookingSearchParams> }) {
  return <OwnBookingPage searchParams={await searchParams} basePath="/booking-preview" />;
}

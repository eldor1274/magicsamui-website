import type { Metadata } from "next";
import OwnReturnPage from "@/components/booking/OwnReturnPage";
import type { ReturnSearchParams } from "@/components/booking/OwnReturnPage";

// Where the payment page (Stripe Checkout, Beam, or the simulated / MOCK
// pages) sends the guest after paying on the preview. The status is verified
// on the server from the signed token - never from the query string alone.
export const metadata: Metadata = {
  title: "Booking status | Magic Suites & Villas",
  robots: { index: false, follow: false },
};

// A Stripe return may confirm the booking in Cloudbeds during this render.
export const maxDuration = 30;

export default async function BookingReturnPage({ searchParams }: { searchParams: Promise<ReturnSearchParams> }) {
  return <OwnReturnPage searchParams={await searchParams} basePath="/booking-preview" />;
}

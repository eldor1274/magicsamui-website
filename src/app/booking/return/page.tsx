import type { Metadata } from "next";
import OwnReturnPage from "@/components/booking/OwnReturnPage";
import type { ReturnSearchParams } from "@/components/booking/OwnReturnPage";

// Where Stripe Checkout sends the guest after paying when /booking serves our
// own engine (success_url = /booking/return?...&session_id=cs_...). It keeps
// working after a rollback to BOOKING_ENGINE=cloudbeds, so in-flight payments
// still show (and confirm) their booking. noindex; the status is verified on
// the server from the signed token and the Checkout Session itself.
export const metadata: Metadata = {
  title: "Booking status | Magic Suites & Villas",
  robots: { index: false, follow: false },
};

// A Stripe return may confirm the booking in Cloudbeds during this render.
export const maxDuration = 30;

export default async function BookingReturnPage({ searchParams }: { searchParams: Promise<ReturnSearchParams> }) {
  return <OwnReturnPage searchParams={await searchParams} basePath="/booking" />;
}

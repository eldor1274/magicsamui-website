import type { Metadata } from "next";
import { notFound } from "next/navigation";
import MockStripeCheckout from "@/components/booking/stripe/MockStripeCheckout";
import { getBookingConfig } from "@/lib/booking/config";
import type { BookingConfig } from "@/lib/booking/config";
import { mockWorld } from "@/lib/booking/runtime";

// MOCK Stripe Checkout page - stripe-mock mode only (404 in every other mode,
// and stripe-mock itself is refused on the production deployment). Lets the
// whole Stripe flow be clicked through locally without keys: the buttons
// change the in-repo fake session and deliver signed webhooks to the real
// handler, which writes to the fake Cloudbeds.
export const metadata: Metadata = {
  title: "MOCK Stripe checkout | Magic Suites & Villas",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

export default async function StripeMockPage({ searchParams }: { searchParams: SearchParams }) {
  // Read the request first: this page must render per request (never prerendered at build time).
  const sp = await searchParams;
  let config: BookingConfig;
  try {
    config = getBookingConfig();
  } catch {
    notFound();
  }
  if (config.paymentMode !== "stripe-mock") notFound();

  const sessionId = typeof sp.session_id === "string" ? sp.session_id : "";
  const session = mockWorld(config).stripe.session(sessionId);
  if (!session) notFound();

  return (
    <div className="mx-auto max-w-lg px-5 py-10">
      <MockStripeCheckout
        sessionId={session.id}
        status={session.status}
        amountSatang={session.amount_total}
        lines={session.line_items_input.map((l) => ({ name: l.name, amountSatang: l.unit_amount * l.quantity }))}
        email={session.customer_email}
        expiresAt={session.expires_at}
        reservationId={session.metadata.msv_cb_reservation_id ?? null}
        bookingRef={session.client_reference_id}
      />
    </div>
  );
}

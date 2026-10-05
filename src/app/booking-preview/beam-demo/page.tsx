import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import BookingThemeRoot from "@/components/booking/BookingThemeRoot";
import BeamDemoCheckout from "@/components/booking/beam/BeamDemoCheckout";
import { getCatalogueRoom } from "@/lib/booking/catalogue";
import { MERCHANT_NAME, getBookingConfig } from "@/lib/booking/config";
import type { BookingConfig } from "@/lib/booking/config";
import { formatStayRange } from "@/lib/booking/dates";
import { isPaymentLinkExpired, verifyBookingToken } from "@/lib/booking/token";
import { cancelUrl, resolveOrigin } from "@/lib/booking/urls";

// SIMULATED Beam hosted payment page - demo mode only (404 otherwise).
// Nothing typed here leaves the browser except the chosen outcome.
export const metadata: Metadata = {
  title: "Simulated Beam checkout | Magic Suites & Villas",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

export default async function BeamDemoPage({ searchParams }: { searchParams: SearchParams }) {
  let config: BookingConfig;
  try {
    config = getBookingConfig();
  } catch {
    notFound();
  }
  if (config.paymentMode !== "demo") notFound();

  const sp = await searchParams;
  const t = typeof sp.t === "string" ? sp.t : null;
  const verified = verifyBookingToken(t, config.tokenSecret);
  const expired = verified.ok && isPaymentLinkExpired(verified.payload.booking);

  if (!t || !verified.ok || expired) {
    return (
      <div className="mx-auto max-w-md px-5 py-16 text-center">
        <h1 className="font-serif text-2xl text-ink">This payment link is not valid</h1>
        <p className="mt-3 text-ink-soft">
          {expired ? "It has expired (links last 30 minutes)." : "It may be incomplete or out of date."} Nothing has been charged.
        </p>
        <Link href="/booking-preview?resume=payment" className="mt-6 inline-block rounded-full bg-pool px-6 py-3 text-sm font-medium text-white hover:bg-pool-dark">
          Back to your booking
        </Link>
      </div>
    );
  }

  const booking = verified.payload.booking;
  const rooms = booking.items.map((i) => getCatalogueRoom(i.slug)?.name ?? i.slug).join(" + ");
  const origin = resolveOrigin((await headers()).get("host"), process.env);

  return (
    <div className="mx-auto max-w-xl px-3 py-6 sm:px-5 sm:py-10">
      <BookingThemeRoot theme="magic" className="rounded-(--bk-radius-card) p-3 sm:p-6">
        <BeamDemoCheckout
          token={t}
          bookingRef={booking.ref}
          merchantName={MERCHANT_NAME}
          amountSatang={booking.dueNowSatang}
          description={`${rooms}, ${formatStayRange(booking.checkIn, booking.checkOut, " - ")}`}
          expiresAt={booking.linkExpiresAt}
          cancelUrl={cancelUrl(origin, booking.ref, t)}
        />
      </BookingThemeRoot>
    </div>
  );
}

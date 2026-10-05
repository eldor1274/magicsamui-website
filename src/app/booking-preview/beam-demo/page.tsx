import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import BookingThemeRoot from "@/components/booking/BookingThemeRoot";
import BeamDemoCheckout, { BeamDemoRecover } from "@/components/booking/beam/BeamDemoCheckout";
import { getCatalogueRoom } from "@/lib/booking/catalogue";
import { MERCHANT_NAME, getBookingConfig } from "@/lib/booking/config";
import type { BookingConfig } from "@/lib/booking/config";
import { formatStayRange } from "@/lib/booking/dates";
import { parseTheme } from "@/lib/booking/theme";
import { isPaymentLinkExpired, verifyBookingToken } from "@/lib/booking/token";
import { cancelUrl, resolveOrigin, resumePaymentPath } from "@/lib/booking/urls";

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
    // Keep the guest's preview theme on the way back (signed token first, else ?theme).
    const theme = verified.ok ? verified.payload.booking.theme : parseTheme(typeof sp.theme === "string" ? sp.theme : undefined);
    return (
      <div className="mx-auto max-w-md px-5 py-16 text-center">
        {/* A reload after the token left the address bar: bring it back from this tab's storage. */}
        {!t && <BeamDemoRecover />}
        <h1 className="font-serif text-2xl text-ink">This payment link is not valid</h1>
        <p className="mt-3 text-ink-soft">
          {expired ? "It has expired (links last 30 minutes)." : "It may be incomplete or out of date."} Nothing has been charged.
        </p>
        <Link
          href={resumePaymentPath(expired ? "expired" : "unverified", theme, verified.ok ? verified.payload.booking.ref : null)}
          className="mt-6 inline-block rounded-full bg-pool px-6 py-3 text-sm font-medium text-white hover:bg-pool-dark">
          Back to your booking
        </Link>
      </div>
    );
  }

  const booking = verified.payload.booking;
  const rooms = booking.items.map((i) => getCatalogueRoom(i.slug)?.name ?? i.slug).join(" + ");
  const origin = resolveOrigin((await headers()).get("host"), process.env);

  return (
    <BookingThemeRoot theme="magic" className="bk-hosted-page min-h-dvh px-3 py-6 sm:px-5 sm:py-10">
      <BeamDemoCheckout
        token={t}
        bookingRef={booking.ref}
        merchantName={MERCHANT_NAME}
        amountSatang={booking.dueNowSatang}
        description={`${rooms}, ${formatStayRange(booking.checkIn, booking.checkOut, " - ")}`}
        expiresAt={booking.linkExpiresAt}
        cancelUrl={cancelUrl(origin, booking.ref, t, booking.theme)}
      />
    </BookingThemeRoot>
  );
}

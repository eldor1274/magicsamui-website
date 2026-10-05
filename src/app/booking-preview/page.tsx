import type { Metadata } from "next";
import BookingApp from "@/components/booking/BookingApp";
import { parseTheme } from "@/lib/booking/theme";
import type { SearchDraft } from "@/components/booking/state";
import { BOOKING_WINDOW_MONTHS, MAX_NIGHTS, MAX_SEARCH_ADULTS, getPublicBookingConfig } from "@/lib/booking/config";
import { addMonths, todayInBangkok, validateStayDates } from "@/lib/booking/dates";
import type { ThemeName } from "@/lib/booking/types";

// PREVIEW of the own booking engine with Beam payments. Not linked from
// anywhere, not in the sitemap, noindex. Demo mode by default: simulated
// availability and payment, nothing is charged or reserved.
export const metadata: Metadata = {
  title: "Booking preview | Magic Suites & Villas",
  description: "Preview of the direct booking engine with Beam payments.",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function prefill(sp: { [key: string]: string | string[] | undefined }, today: string): Partial<SearchDraft> | null {
  const out: Partial<SearchDraft> = {};
  const checkIn = one(sp.checkin);
  const checkOut = one(sp.checkout);
  if (checkIn && checkOut && !validateStayDates(checkIn, checkOut, { today, maxNights: MAX_NIGHTS, bookingWindowMonths: BOOKING_WINDOW_MONTHS })) {
    out.checkIn = checkIn;
    out.checkOut = checkOut;
  }
  const adults = Number(one(sp.adults));
  if (Number.isInteger(adults) && adults >= 1 && adults <= MAX_SEARCH_ADULTS) out.adults = adults;
  const promo = one(sp.promo);
  if (promo && /^[A-Za-z0-9_-]{1,32}$/.test(promo)) out.promo = promo.toUpperCase();
  return Object.keys(out).length > 0 ? out : null;
}

function themeLinks(sp: { [key: string]: string | string[] | undefined }): Record<ThemeName, string> {
  const keep = new URLSearchParams();
  for (const key of ["checkin", "checkout", "adults", "promo"]) {
    const v = one(sp[key]);
    if (v) keep.set(key, v);
  }
  const classic = new URLSearchParams(keep);
  classic.set("theme", "classic");
  const magicQs = keep.toString();
  return { magic: `/booking-preview${magicQs ? `?${magicQs}` : ""}`, classic: `/booking-preview?${classic.toString()}` };
}

export default async function BookingPreviewPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const today = todayInBangkok();
  const theme = parseTheme(one(sp.theme));

  return (
    <div className="mx-auto max-w-6xl px-3 py-6 sm:px-5 sm:py-10">
      <BookingApp
        initialSearch={prefill(sp, today)}
        theme={theme}
        resume={one(sp.resume) === "payment" ? "payment" : null}
        config={getPublicBookingConfig()}
        today={today}
        maxDate={addMonths(today, BOOKING_WINDOW_MONTHS)}
        themeHref={themeLinks(sp)}
      />
    </div>
  );
}

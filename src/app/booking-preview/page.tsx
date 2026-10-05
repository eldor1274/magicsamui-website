import { createHash } from "node:crypto";
import type { Metadata } from "next";
import BookingApp from "@/components/booking/BookingApp";
import { parseTheme } from "@/lib/booking/theme";
import type { SearchDraft } from "@/components/booking/state";
import { parseResumeReason } from "@/lib/booking/urls";
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

/** Parameters BookingApp applies once (see ONE_SHOT_PARAMS there). */
const ONE_SHOT_PARAMS = ["checkin", "checkout", "adults", "promo", "resume", "reason", "ref", "t"];

/**
 * Fingerprint of this load's one-shot parameters (null when there are none).
 * BookingApp persists it once applied, so the same URL replayed later - the
 * App Router reuses a cached page on browser Back/Forward even after the
 * address bar was cleaned - never re-applies a stale prefill or Beam-cancel
 * notice. Hashed so the booking token never lands in sessionStorage.
 */
function landingKey(sp: { [key: string]: string | string[] | undefined }): string | null {
  const parts = ONE_SHOT_PARAMS.flatMap((k) => {
    const v = one(sp[k]);
    return v === undefined ? [] : [`${k}=${v}`];
  });
  return parts.length > 0 ? createHash("sha256").update(parts.join("&")).digest("hex").slice(0, 32) : null;
}

/**
 * Theme switch links carry ONLY the theme: the guest's dates, rooms and step
 * come back from sessionStorage, so switching never replays a stale
 * ?checkin/?checkout prefill over what the guest has since chosen.
 */
const THEME_HREF: Record<ThemeName, string> = { magic: "/booking-preview", classic: "/booking-preview?theme=classic" };

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
        resumeReason={parseResumeReason(one(sp.reason))}
        landingKey={landingKey(sp)}
        config={getPublicBookingConfig()}
        today={today}
        maxDate={addMonths(today, BOOKING_WINDOW_MONTHS)}
        themeHref={THEME_HREF}
      />
    </div>
  );
}

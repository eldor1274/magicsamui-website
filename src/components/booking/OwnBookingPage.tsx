import { createHash } from "node:crypto";
import BookingApp from "@/components/booking/BookingAppLazy";
import type { SearchDraft } from "@/components/booking/state";
import { BOOKING_WINDOW_MONTHS, MAX_NIGHTS, MAX_SEARCH_ADULTS, getPublicBookingConfig } from "@/lib/booking/config";
import { addMonths, todayInBangkok, validateStayDates } from "@/lib/booking/dates";
import { promoInputOffered } from "@/lib/booking/quote";
import { isBookingRef } from "@/lib/booking/ref";
import { parseTheme } from "@/lib/booking/theme";
import type { ThemeName } from "@/lib/booking/types";
import { parseResumeReason } from "@/lib/booking/urls";

// Server body of the own booking page, shared by /booking-preview (the
// noindex preview) and /booking (when BOOKING_ENGINE=own is active). Reads
// the one-shot landing parameters (?checkin ?checkout ?adults ?promo, and the
// payment page's ?resume ?reason ?ref ?t) and hands them to BookingApp.

export type BookingSearchParams = { [key: string]: string | string[] | undefined };

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function prefill(sp: BookingSearchParams, today: string, promoEnabled: boolean): Partial<SearchDraft> | null {
  const out: Partial<SearchDraft> = {};
  const checkIn = one(sp.checkin);
  const checkOut = one(sp.checkout);
  if (checkIn && checkOut && !validateStayDates(checkIn, checkOut, { today, maxNights: MAX_NIGHTS, bookingWindowMonths: BOOKING_WINDOW_MONTHS })) {
    out.checkIn = checkIn;
    out.checkOut = checkOut;
  }
  const adults = Number(one(sp.adults));
  if (Number.isInteger(adults) && adults >= 1 && adults <= MAX_SEARCH_ADULTS) out.adults = adults;
  // Where no code input is offered (Beam modes) a ?promo= from an ad link (e.g. ?promo=DIRECT) is dropped
  // quietly. On the own engine any well-formed code is applied (DIRECT: Cloudbeds' Direct rate; any other code:
  // the plan the owner set up for it in Cloudbeds, e.g. ?promo=LONGSTAY) or answered with a note (unknown code,
  // or a page that can't apply codes: the classic booking page).
  const promo = one(sp.promo);
  if (promoEnabled && promo && /^[A-Za-z0-9_-]{1,32}$/.test(promo)) out.promo = promo.toUpperCase();
  return Object.keys(out).length > 0 ? out : null;
}

/** Parameters BookingApp applies once (see ONE_SHOT_PARAMS there). */
// "s": the homepage search id - only part of the landing fingerprint, so a repeated homepage search is applied again.
const ONE_SHOT_PARAMS = ["checkin", "checkout", "adults", "promo", "s", "resume", "reason", "ref", "t"];

/**
 * Fingerprint of this load's one-shot parameters (null when there are none).
 * BookingApp persists it once applied, so the same URL replayed later - the
 * App Router reuses a cached page on browser Back/Forward even after the
 * address bar was cleaned - never re-applies a stale prefill or a
 * payment-cancel notice. Hashed so the booking token never lands in sessionStorage.
 */
function landingKey(sp: BookingSearchParams): string | null {
  const parts = ONE_SHOT_PARAMS.flatMap((k) => {
    const v = one(sp[k]);
    return v === undefined ? [] : [`${k}=${v}`];
  });
  return parts.length > 0 ? createHash("sha256").update(parts.join("&")).digest("hex").slice(0, 32) : null;
}

export default function OwnBookingPage({
  searchParams,
  basePath,
  classicHref = null,
}: {
  searchParams: BookingSearchParams;
  /** "/booking-preview" or "/booking". */
  basePath: "/booking" | "/booking-preview";
  /** Link to the Cloudbeds engine fallback (/booking/classic) on the live /booking. */
  classicHref?: string | null;
}) {
  const sp = searchParams;
  const today = todayInBangkok();
  const theme = parseTheme(one(sp.theme));
  // Theme switch links carry ONLY the theme: the guest's dates, rooms and step come back from
  // sessionStorage, so switching never replays a stale ?checkin/?checkout prefill.
  const themeHref: Record<ThemeName, string> = { magic: basePath, classic: `${basePath}?theme=classic` };
  const config = getPublicBookingConfig();
  const resume = one(sp.resume) === "payment" ? "payment" : null;
  // Stripe back link (cancel_url = ?resume=payment&reason=cancelled&ref&t): BookingApp releases that hold.
  const ref = one(sp.ref);
  const t = one(sp.t);
  const cancelledAttempt =
    resume === "payment" && config.provider === "stripe" && isBookingRef(ref) && t && t.length <= 4096 ? { ref, t } : null;

  return (
    <div className="mx-auto max-w-6xl px-3 py-6 sm:px-5 sm:py-10">
      <BookingApp
        initialSearch={prefill(sp, today, promoInputOffered(config))}
        theme={theme}
        resume={resume}
        resumeReason={parseResumeReason(one(sp.reason))}
        landingKey={landingKey(sp)}
        config={config}
        today={today}
        maxDate={addMonths(today, BOOKING_WINDOW_MONTHS)}
        themeHref={themeHref}
        classicHref={classicHref}
        cancelledAttempt={cancelledAttempt}
      />
    </div>
  );
}

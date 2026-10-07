"use client";

// Homepage quick search for our own booking engine (BOOKING_ENGINE=own): the
// booking page's own search capsule (SearchBar, "hero" variant - calendar,
// guests and promo-code popovers) with the same limits as /booking. It keeps
// its own draft and, on Search, opens the booking page with exactly the
// parameters OwnBookingPage prefills (homeSearchPath), so the guest lands
// straight on the results. It never validates or applies a code itself: the
// booking page does that, as it does for a code typed there.
//
// Loaded only in the browser (HomeSearch.tsx, next/dynamic with ssr: false),
// so the booking engine's stylesheet never becomes render-blocking on the
// homepage; HomeSearch shows a same-size placeholder link until it arrives.

import { useCallback, useEffect, useState } from "react";
import { BookingThemeScope } from "@/components/booking/BookingThemeRoot";
import SearchBar from "@/components/booking/search/SearchBar";
import type { SearchDraft } from "@/components/booking/state";
import { addMonths, todayInBangkok, validateStayDates } from "@/lib/booking/dates";
import { homeSearchPath } from "@/lib/booking/urls";
import { track } from "@/lib/track";

/** The booking page's default party (DEFAULT_ADULTS in components/booking/state.ts). */
const DEFAULT_ADULTS = 2;

export interface HomeSearchBarProps {
  /** Booking limits from the server config, as on /booking (MAX_NIGHTS, BOOKING_WINDOW_MONTHS, MAX_SEARCH_ADULTS). */
  maxNights: number;
  bookingWindowMonths: number;
  maxAdults: number;
  /** promoInputOffered(config): whether the "Add Code" pill is offered (false in Beam modes). */
  promoEnabled: boolean;
  /** promoCodeHint(config): the code the picker suggests, or null where no code lowers the price. */
  promoCodeHint: string | null;
}

export default function HomeSearchBar({ maxNights, bookingWindowMonths, maxAdults, promoEnabled, promoCodeHint }: HomeSearchBarProps) {
  // Today in Samui. This component only renders in the browser, so the prerendered homepage never pins a stale date.
  const [today, setToday] = useState(todayInBangkok);
  const [draft, setDraft] = useState<SearchDraft>({ checkIn: null, checkOut: null, adults: DEFAULT_ADULTS, promo: "" });
  // Search pressed: the booking page is loading (spinner on the button, no second submit).
  const [leaving, setLeaving] = useState(false);

  // Back from the booking page via the back/forward cache: the page comes back as it was left, spinner
  // included - make the bar usable again.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) setLeaving(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  const onChange = useCallback((patch: Partial<SearchDraft>) => setDraft((d) => ({ ...d, ...patch })), []);

  const onSearch = useCallback(() => {
    const { checkIn, checkOut } = draft;
    if (!checkIn || !checkOut || leaving) return;
    const now = todayInBangkok();
    // The calendar only offers valid stays; this catches a page left open past midnight in Samui, whose
    // check-in is now in the past: ask for the dates again instead of sending the guest to the search step.
    if (validateStayDates(checkIn, checkOut, { today: now, maxNights, bookingWindowMonths })) {
      setToday(now);
      setDraft((d) => ({ ...d, checkIn: null, checkOut: null }));
      return;
    }
    // Same GA4 event as the earlier homepage date form, so homepage searches stay comparable.
    track("date_picker_submit");
    setLeaving(true);
    // A full page load, as the earlier GET form did: /booking reads the parameters on the server.
    window.location.assign(homeSearchPath({ checkIn, checkOut, adults: draft.adults, promo: draft.promo }, promoEnabled));
  }, [draft, leaving, maxNights, bookingWindowMonths, promoEnabled]);

  return (
    <BookingThemeScope>
      <SearchBar
        value={draft}
        onChange={onChange}
        onSearch={onSearch}
        busy={leaving}
        variant="hero"
        promoResult={null}
        minDate={today}
        maxDate={addMonths(today, bookingWindowMonths)}
        maxNights={maxNights}
        maxAdults={maxAdults}
        promoEnabled={promoEnabled}
        promoCodeHint={promoCodeHint}
      />
    </BookingThemeScope>
  );
}

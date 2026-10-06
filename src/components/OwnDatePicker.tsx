"use client";

import { useId, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import { CalendarDays, Search, Users } from "lucide-react";
import { STAY_DATE_ERROR_MESSAGES, addDays, addMonths, compareIso, todayInBangkok, validateStayDates } from "@/lib/booking/dates";
import { track } from "@/lib/track";

// Homepage quick search for our own booking engine (BOOKING_ENGINE=own):
// replaces the Cloudbeds date-picker widget. A plain GET form to /booking with
// ?checkin ?checkout ?adults - it works without JavaScript, and the booking
// page validates the values again (anything invalid is simply ignored). It
// renders at its full size from the server HTML, so nothing shifts while the
// page loads. On desktop it is the Cloudbeds widget's height; on phones its
// two rows of labelled 44px fields make it taller than the widget (172px vs
// 98px), which moves the content below it down on the own engine only.

const MAX_GUESTS_OPTION = 10;

/** useSyncExternalStore subscription for a value that never changes while the page is open. */
function subscribeNever(): () => void {
  return () => undefined;
}
// stone-500 on white is ~4.8:1: field outlines need 3:1 to be recognisable (WCAG 1.4.11).
const FIELD =
  "mt-1 block min-h-11 w-full rounded-xl border border-stone-500 bg-white px-2 text-base sm:px-3 text-ink focus:border-pool focus:outline-none focus:ring-2 focus:ring-pool/30";

export interface OwnDatePickerProps {
  className?: string;
  /** Booking limits from the server config (MAX_NIGHTS, BOOKING_WINDOW_MONTHS). */
  maxNights: number;
  bookingWindowMonths: number;
}

export default function OwnDatePicker({ className = "", maxNights, bookingWindowMonths }: OwnDatePickerProps) {
  const id = useId();
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [error, setError] = useState<{ message: string; field: "in" | "out" } | null>(null);
  // Today in Samui, known only in the browser (the homepage is prerendered): null on the server.
  const today = useSyncExternalStore(subscribeNever, todayInBangkok, () => null);
  const tracked = useRef(false);

  const maxDate = today ? addMonths(today, bookingWindowMonths) : undefined;

  function onCheckIn(value: string) {
    setCheckIn(value);
    setError(null);
    // Keep the stay at least one night long.
    if (value && (!checkOut || compareIso(checkOut, value) <= 0)) setCheckOut(addDays(value, 1));
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    const now = today ?? todayInBangkok();
    const problem = validateStayDates(checkIn, checkOut, { today: now, maxNights, bookingWindowMonths });
    if (problem) {
      e.preventDefault();
      // Point at the field that is wrong: a missing/past check-in, else the check-out.
      const field = problem === "checkin_in_past" || (problem === "invalid_date" && !checkIn) ? "in" : "out";
      setError({ message: STAY_DATE_ERROR_MESSAGES[problem], field });
      document.getElementById(`${id}-${field}`)?.focus();
      return;
    }
    track("date_picker_submit");
  }

  // min-h: the Cloudbeds widget's measured height (98px phones, 106px from tablet). Desktop matches it;
  // on phones the form is taller (see the header comment).
  return (
    <form
      action="/booking"
      method="get"
      noValidate
      onSubmit={onSubmit}
      onClickCapture={() => {
        if (!tracked.current) {
          tracked.current = true;
          track("date_picker_interact");
        }
      }}
      aria-label="Check availability"
      className={`${className} relative min-h-[98px] rounded-3xl bg-white p-4 shadow-lg ring-1 ring-black/5 md:min-h-[106px]`}
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-[1fr_1fr_0.8fr_auto] md:items-end">
        <label htmlFor={`${id}-in`} className="block text-xs font-medium uppercase tracking-wider text-ink-soft">
          <span className="flex items-center gap-1.5">
            <CalendarDays size={14} aria-hidden="true" /> Check-in
          </span>
          <input
            id={`${id}-in`}
            name="checkin"
            type="date"
            required
            value={checkIn}
            min={today ?? undefined}
            max={maxDate}
            onChange={(e) => onCheckIn(e.target.value)}
            aria-invalid={error?.field === "in" || undefined}
            aria-describedby={error?.field === "in" ? `${id}-error` : undefined}
            className={FIELD}
          />
        </label>
        <label htmlFor={`${id}-out`} className="block text-xs font-medium uppercase tracking-wider text-ink-soft">
          <span className="flex items-center gap-1.5">
            <CalendarDays size={14} aria-hidden="true" /> Check-out
          </span>
          <input
            id={`${id}-out`}
            name="checkout"
            type="date"
            required
            value={checkOut}
            min={checkIn ? addDays(checkIn, 1) : (today ?? undefined)}
            max={maxDate}
            onChange={(e) => {
              setCheckOut(e.target.value);
              setError(null);
            }}
            aria-invalid={error?.field === "out" || undefined}
            aria-describedby={error?.field === "out" ? `${id}-error` : undefined}
            className={FIELD}
          />
        </label>
        <label htmlFor={`${id}-adults`} className="block text-xs font-medium uppercase tracking-wider text-ink-soft">
          <span className="flex items-center gap-1.5">
            <Users size={14} aria-hidden="true" /> Guests
          </span>
          <select id={`${id}-adults`} name="adults" defaultValue="2" className={`${FIELD} cursor-pointer`}>
            {Array.from({ length: MAX_GUESTS_OPTION }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? "adult" : "adults"}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="inline-flex min-h-11 items-center justify-center gap-2 self-end rounded-full bg-pool px-6 text-sm font-medium tracking-wide text-white transition-colors hover:bg-pool-dark"
        >
          <Search size={16} aria-hidden="true" />
          {/* Short label on phones keeps the button on one line next to the guests field. */}
          <span className="sm:hidden">Search</span>
          <span className="hidden sm:inline">Check Availability</span>
        </button>
      </div>
      <p id={`${id}-error`} role="alert" className="mt-2 text-sm text-red-700 empty:hidden">
        {error?.message ?? ""}
      </p>
    </form>
  );
}

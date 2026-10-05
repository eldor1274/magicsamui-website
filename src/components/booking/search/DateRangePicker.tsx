"use client";

// OWNER: ui-search-results
// Stay date picker.
// - Desktop/tablet (>= 768px): two-month popover under the search bar. Pick
//   check-in, then check-out; every pick calls onChange and the popover closes
//   itself once the range is complete (Cloudbeds behaviour).
// - Phones: full-screen sheet with one month, "Select stay dates", the chosen
//   range as subtitle and a footer "Restrictions may apply" + Apply. Picks are
//   held locally and only applied with Apply (closing discards them).
// "Today" is Asia/Bangkok (minDate, computed on the server). Past days and
// days past the booking window are disabled; while choosing a check-out,
// nights beyond maxNights are disabled. Keep DateRangePickerProps stable.

import { useRef, useState } from "react";
import type { RefObject } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { addDays, diffDays, formatDisplayDate, formatNights, parseIsoDate } from "@/lib/booking/dates";
import type { IsoDate } from "@/lib/booking/types";
import { useIsMobile } from "../hooks";
import Popover from "../ui/Popover";
import Sheet from "../ui/Sheet";
import { BTN_LINK, BTN_PRIMARY } from "../ui/styles";
import RangeCalendar from "./RangeCalendar";
import type { MonthRef } from "./RangeCalendar";

export interface DateRangePickerProps {
  open: boolean;
  onClose: () => void;
  checkIn: IsoDate | null;
  checkOut: IsoDate | null;
  /** Called on every pick; checkOut is null after a new check-in is picked. */
  onChange: (checkIn: IsoDate | null, checkOut: IsoDate | null) => void;
  minDate: IsoDate;
  maxDate: IsoDate;
  maxNights: number;
  anchorRef: RefObject<HTMLElement | null>;
}

export default function DateRangePicker(props: DateRangePickerProps) {
  if (!props.open) return null;
  return <OpenDateRangePicker {...props} />;
}

interface Draft {
  checkIn: IsoDate | null;
  checkOut: IsoDate | null;
}

function toMonth(date: IsoDate): MonthRef {
  const { year, monthIndex } = parseIsoDate(date);
  return { year, monthIndex };
}

function monthIndexOf(m: MonthRef): number {
  return m.year * 12 + m.monthIndex;
}

function shift(m: MonthRef, n: number): MonthRef {
  const d = new Date(Date.UTC(m.year, m.monthIndex + n, 1));
  return { year: d.getUTCFullYear(), monthIndex: d.getUTCMonth() };
}

function firstOfMonth(m: MonthRef): IsoDate {
  return `${m.year}-${String(m.monthIndex + 1).padStart(2, "0")}-01`;
}

function OpenDateRangePicker({ onClose, checkIn, checkOut, onChange, minDate, maxDate, maxNights, anchorRef }: DateRangePickerProps) {
  const isMobile = useIsMobile();
  const months: 1 | 2 = isMobile ? 1 : 2;
  const valid = (d: IsoDate | null) => (d !== null && d >= minDate && d <= maxDate ? d : null);
  const startCheckIn = valid(checkIn);
  const startCheckOut = startCheckIn ? valid(checkOut) : null;

  const [draft, setDraft] = useState<Draft>({ checkIn: startCheckIn, checkOut: startCheckOut });
  const [view, setView] = useState<MonthRef>(() => toMonth(startCheckIn ?? minDate));
  const [activeDate, setActiveDate] = useState<IsoDate>(startCheckIn ?? minDate);
  const [hover, setHover] = useState<IsoDate | null>(null);
  const calendarWrapRef = useRef<HTMLDivElement>(null);

  const minMonth = toMonth(minDate);
  const maxMonth = toMonth(maxDate);
  const lastVisible = shift(view, months - 1);
  const canPrev = monthIndexOf(view) > monthIndexOf(minMonth);
  const canNext = monthIndexOf(lastVisible) < monthIndexOf(maxMonth);

  const choosingCheckOut = draft.checkIn !== null && draft.checkOut === null;

  const isDisabled = (date: IsoDate): boolean => {
    if (date < minDate || date > maxDate) return true;
    if (choosingCheckOut && draft.checkIn !== null && date > draft.checkIn) {
      return diffDays(draft.checkIn, date) > maxNights;
    }
    // A check-in needs at least one night before the end of the booking window.
    return date >= maxDate;
  };

  const previewEnd =
    choosingCheckOut && hover !== null && draft.checkIn !== null && hover > draft.checkIn && !isDisabled(hover) ? hover : null;
  const rangeEnd = draft.checkOut ?? previewEnd;

  const describeDay = (date: IsoDate): string => {
    if (date === draft.checkIn) return "check-in date";
    if (date === draft.checkOut) return "check-out date";
    if (isDisabled(date)) {
      if (choosingCheckOut && date > minDate && date <= maxDate) return `unavailable, stays are limited to ${maxNights} nights`;
      return "unavailable";
    }
    return "";
  };

  const changeView = (next: MonthRef) => {
    setView(next);
    // Keep the roving tab stop inside the visible months.
    const first = firstOfMonth(next);
    const last = addDays(firstOfMonth(shift(next, months)), -1);
    if (activeDate < first || activeDate > last) {
      setActiveDate(first < minDate ? minDate : first > maxDate ? maxDate : first);
    }
  };

  const onActiveDateChange = (date: IsoDate) => {
    setActiveDate(date);
    const m = toMonth(date);
    if (monthIndexOf(m) < monthIndexOf(view)) setView(m);
    else if (monthIndexOf(m) > monthIndexOf(lastVisible)) setView(shift(m, -(months - 1)));
  };

  const pick = (date: IsoDate) => {
    setActiveDate(date);
    if (!choosingCheckOut || draft.checkIn === null || date <= draft.checkIn) {
      setDraft({ checkIn: date, checkOut: null });
      if (!isMobile) onChange(date, null);
      return;
    }
    setDraft({ checkIn: draft.checkIn, checkOut: date });
    setHover(null);
    if (!isMobile) {
      onChange(draft.checkIn, date);
      onClose();
    }
  };

  const clear = () => {
    setDraft({ checkIn: null, checkOut: null });
    setHover(null);
    if (!isMobile) onChange(null, null);
    // "Clear dates" hides itself (nothing left to clear): put focus on the
    // calendar's active day instead of letting it fall to <body>.
    window.setTimeout(() => {
      calendarWrapRef.current?.querySelector<HTMLElement>('button[data-date][tabindex="0"]')?.focus({ preventScroll: true });
    }, 0);
  };

  const nights = draft.checkIn && draft.checkOut ? diffDays(draft.checkIn, draft.checkOut) : null;
  const status = !draft.checkIn
    ? "Select your check-in date"
    : !draft.checkOut
      ? `Check-in ${formatDisplayDate(draft.checkIn)} - now select your check-out date`
      : `${formatDisplayDate(draft.checkIn)} - ${formatDisplayDate(draft.checkOut)}, ${formatNights(nights ?? 0)}`;

  const navButton =
    "inline-flex items-center justify-center rounded-(--bk-radius-control) border border-(--bk-border-strong) bg-(--bk-surface) text-(--bk-text) transition-colors hover:border-(--bk-text) disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:border-(--bk-border-strong)";

  const calendar = (
    <RangeCalendar
      view={view}
      months={months}
      rangeStart={draft.checkIn}
      rangeEnd={rangeEnd}
      today={minDate}
      activeDate={activeDate}
      isDisabled={isDisabled}
      describeDay={describeDay}
      onPick={pick}
      onHover={setHover}
      onActiveDateChange={onActiveDateChange}
      minDate={minDate}
      maxDate={maxDate}
      density={isMobile ? "compact" : "comfortable"}
      struckBefore={draft.checkIn && !draft.checkOut ? draft.checkIn : null}
    />
  );

  const liveStatus = (
    <p className="bk-sr-only" aria-live="polite">
      {status}
    </p>
  );

  if (isMobile) {
    return (
      <Sheet
        open
        variant="fullscreen"
        onClose={onClose}
        title="Select stay dates"
        subtitle={
          draft.checkIn
            ? `${formatDisplayDate(draft.checkIn)} - ${draft.checkOut ? formatDisplayDate(draft.checkOut) : "Check-out"}`
            : "Check-in - Check-out"
        }
        footer={
          <div className="flex items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-sm text-(--bk-text-muted)">
              <span className="h-2 w-2 rounded-full bg-(--bk-accent)" aria-hidden="true" />
              Restrictions may apply
            </p>
            <button
              type="button"
              disabled={!draft.checkIn || !draft.checkOut}
              onClick={() => {
                onChange(draft.checkIn, draft.checkOut);
                onClose();
              }}
              className={`${BTN_PRIMARY} h-11 px-6`}
            >
              Apply
            </button>
          </div>
        }
      >
        <div ref={calendarWrapRef} className="mx-auto max-w-md pt-3">
          <div className="mb-4 flex items-center justify-between">
            <button type="button" onClick={() => changeView(shift(view, -1))} disabled={!canPrev} aria-label="Previous month" className={`${navButton} h-11 w-11`}>
              <ArrowLeft size={18} aria-hidden="true" />
            </button>
            <button type="button" onClick={clear} disabled={!draft.checkIn} className={`${BTN_LINK} text-sm disabled:opacity-0`}>
              Clear dates
            </button>
            <button type="button" onClick={() => changeView(shift(view, 1))} disabled={!canNext} aria-label="Next month" className={`${navButton} h-11 w-11`}>
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          </div>
          {calendar}
          <p className="mt-4 text-center text-sm text-(--bk-text-muted)" aria-hidden="true">
            {nights ? formatNights(nights) : draft.checkIn ? "Select your check-out date" : "Select your check-in date"}
          </p>
          {liveStatus}
        </div>
      </Sheet>
    );
  }

  return (
    <Popover open onClose={onClose} anchorRef={anchorRef} label="Select stay dates" align="start" className="w-max max-w-[calc(100vw-1rem)] p-5">
      <div ref={calendarWrapRef} className="relative">
        <button
          type="button"
          onClick={() => changeView(shift(view, -1))}
          disabled={!canPrev}
          aria-label="Previous month"
          className={`${navButton} absolute left-0 top-[-0.4rem] h-9 w-9 before:absolute before:-inset-1`}
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => changeView(shift(view, 1))}
          disabled={!canNext}
          aria-label="Next month"
          className={`${navButton} absolute right-0 top-[-0.4rem] h-9 w-9 before:absolute before:-inset-1`}
        >
          <ArrowRight size={16} aria-hidden="true" />
        </button>
        {calendar}
      </div>
      <div className="mt-4 flex items-center justify-between gap-4 border-t border-(--bk-border) pt-3 text-sm">
        <p className="text-(--bk-text-muted)" aria-hidden="true">
          {nights ? (
            <>
              <span className="font-medium text-(--bk-text)">{formatNights(nights)}</span> · up to {maxNights} nights online
            </>
          ) : draft.checkIn ? (
            "Select your check-out date"
          ) : (
            "Select your check-in date"
          )}
        </p>
        <button type="button" onClick={clear} disabled={!draft.checkIn} className={`${BTN_LINK} disabled:invisible`}>
          Clear dates
        </button>
      </div>
      {liveStatus}
    </Popover>
  );
}

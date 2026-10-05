"use client";

// OWNER: ui-search-results
// Month grid(s) for picking a stay. Pure view + keyboard handling; the
// selection logic lives in DateRangePicker. Keyboard: arrows move a day/week,
// Home/End go to the start/end of the week, PageUp/PageDown change month,
// Enter/Space pick. Days outside the bookable range stay focusable (with
// aria-disabled) so arrow navigation never gets stuck.

import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent } from "react";
import {
  WEEKDAYS_LONG,
  WEEKDAYS_SHORT,
  addDays,
  addMonths,
  formatMonthLabel,
  monthGrid,
  parseIsoDate,
  weekday,
} from "@/lib/booking/dates";
import type { IsoDate } from "@/lib/booking/types";

export interface MonthRef {
  year: number;
  monthIndex: number;
}

export interface RangeCalendarProps {
  /** Months shown side by side, starting at `view`. */
  view: MonthRef;
  months: 1 | 2;
  /** Range to paint (may be a hover preview). */
  rangeStart: IsoDate | null;
  rangeEnd: IsoDate | null;
  today: IsoDate;
  /** The day that owns tabindex=0 and keyboard focus. */
  activeDate: IsoDate;
  isDisabled: (date: IsoDate) => boolean;
  /** Screen-reader suffix for a day, e.g. "check-in" or "unavailable". */
  describeDay: (date: IsoDate) => string;
  onPick: (date: IsoDate) => void;
  onHover: (date: IsoDate | null) => void;
  /** Keyboard moved the active day (the picker shifts the view if needed). */
  onActiveDateChange: (date: IsoDate) => void;
  minDate: IsoDate;
  maxDate: IsoDate;
  /** "compact" = mobile full-width cells. */
  density: "comfortable" | "compact";
  /**
   * While choosing the check-out: days before the check-in are struck through
   * (as Cloudbeds does) so it is clear the next tap sets the check-out. They
   * stay pickable - picking one starts a new check-in.
   */
  struckBefore?: IsoDate | null;
}

function monthAt(view: MonthRef, offset: number): MonthRef {
  const d = new Date(Date.UTC(view.year, view.monthIndex + offset, 1));
  return { year: d.getUTCFullYear(), monthIndex: d.getUTCMonth() };
}

function clampDate(date: IsoDate, min: IsoDate, max: IsoDate): IsoDate {
  return date < min ? min : date > max ? max : date;
}

const LONG_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function longLabel(date: IsoDate): string {
  const { year, monthIndex, day } = parseIsoDate(date);
  return `${WEEKDAYS_LONG[weekday(date)]}, ${LONG_MONTHS[monthIndex]} ${day}, ${year}`;
}

export default function RangeCalendar({
  view,
  months,
  rangeStart,
  rangeEnd,
  today,
  activeDate,
  isDisabled,
  describeDay,
  onPick,
  onHover,
  onActiveDateChange,
  minDate,
  maxDate,
  density,
  struckBefore = null,
}: RangeCalendarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const keyboardMoved = useRef(false);
  const baseId = useId();

  // On open, land on the selected (or first available) day rather than the
  // nav buttons. Idempotent, so React's dev double-run of effects is fine.
  useEffect(() => {
    rootRef.current?.querySelector<HTMLButtonElement>('button[tabindex="0"][data-date]')?.focus({ preventScroll: true });
  }, []);

  // Focus follows the active day after keyboard moves.
  useEffect(() => {
    if (!keyboardMoved.current) return;
    keyboardMoved.current = false;
    rootRef.current?.querySelector<HTMLButtonElement>(`button[data-date="${activeDate}"]`)?.focus({ preventScroll: true });
  }, [activeDate, view]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target;
    if (!(target instanceof HTMLElement) || !target.dataset.date) return;
    let next: IsoDate | null = null;
    switch (e.key) {
      case "ArrowLeft":
        next = addDays(activeDate, -1);
        break;
      case "ArrowRight":
        next = addDays(activeDate, 1);
        break;
      case "ArrowUp":
        next = addDays(activeDate, -7);
        break;
      case "ArrowDown":
        next = addDays(activeDate, 7);
        break;
      case "Home":
        next = addDays(activeDate, -weekday(activeDate));
        break;
      case "End":
        next = addDays(activeDate, 6 - weekday(activeDate));
        break;
      case "PageUp":
        next = addMonths(activeDate, e.shiftKey ? -12 : -1);
        break;
      case "PageDown":
        next = addMonths(activeDate, e.shiftKey ? 12 : 1);
        break;
      default:
        return;
    }
    e.preventDefault();
    keyboardMoved.current = true;
    onActiveDateChange(clampDate(next, minDate, maxDate));
  };

  const cellSize = density === "compact" ? "h-12 w-full" : "h-11 w-11";

  return (
    <div ref={rootRef} onKeyDown={onKeyDown} onMouseLeave={() => onHover(null)} className={`flex gap-8 ${density === "compact" ? "w-full" : ""}`}>
      {Array.from({ length: months }, (_, i) => {
        const m = monthAt(view, i);
        const labelId = `${baseId}-m${i}`;
        return (
          <div key={`${m.year}-${m.monthIndex}`} className={density === "compact" ? "w-full" : ""}>
            <p id={labelId} className="mb-3 text-center text-base font-medium" aria-live={i === 0 ? "polite" : undefined}>
              {formatMonthLabel(m.year, m.monthIndex)}
            </p>
            {/* table-fixed: the 7 columns share the width equally (no squeezed 36px days at 360px). */}
            <table role="grid" aria-labelledby={labelId} className="w-full table-fixed border-collapse">
              <thead>
                <tr>
                  {WEEKDAYS_SHORT.map((d, wi) => (
                    <th key={d} scope="col" abbr={WEEKDAYS_LONG[wi]} className="pb-2 text-xs font-medium text-(--bk-text-subtle)">
                      {d}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {monthGrid(m.year, m.monthIndex).map((week, wi) => (
                  <tr key={wi}>
                    {week.map((date, di) => {
                      if (!date) return <td key={di} className="p-0" />;
                      const disabled = isDisabled(date);
                      const isStart = date === rangeStart;
                      const isEnd = date === rangeEnd;
                      const inside = rangeStart !== null && rangeEnd !== null && date > rangeStart && date < rangeEnd;
                      const selected = isStart || isEnd;
                      // The light range strip runs edge to edge; the end days get a half strip.
                      const strip = inside
                        ? "bg-(--bk-range)"
                        : isStart && rangeEnd
                          ? "bg-[linear-gradient(to_right,transparent_50%,var(--bk-range)_50%)]"
                          : isEnd && rangeStart
                            ? "bg-[linear-gradient(to_left,transparent_50%,var(--bk-range)_50%)]"
                            : "";
                      const desc = describeDay(date);
                      const struck = !disabled && !selected && struckBefore != null && date < struckBefore;
                      return (
                        <td key={date} role="gridcell" aria-selected={selected || inside} className={`p-0 py-0.5 text-center ${strip}`}>
                          <button
                            type="button"
                            data-date={date}
                            tabIndex={date === activeDate ? 0 : -1}
                            aria-disabled={disabled || undefined}
                            aria-label={`${longLabel(date)}${date === today ? ", today" : ""}${desc ? `, ${desc}` : ""}`}
                            onClick={() => {
                              if (!disabled) onPick(date);
                            }}
                            onMouseEnter={() => onHover(disabled ? null : date)}
                            onFocus={() => onHover(disabled ? null : date)}
                            className={`mx-auto flex ${cellSize} items-center justify-center rounded-(--bk-radius-day) text-[15px] tabular-nums transition-colors ${
                              selected
                                ? "bg-(--bk-accent) font-semibold text-(--bk-accent-contrast) ring-2 ring-inset ring-(--bk-day-selected-ring)"
                                : disabled
                                  ? "cursor-not-allowed text-(--bk-text-subtle) opacity-45"
                                  : struck
                                    ? "text-(--bk-text-subtle) line-through hover:bg-(--bk-surface-sunken)"
                                    : "text-(--bk-text) hover:bg-(--bk-surface-sunken)"
                            } ${date === today && !selected ? "ring-2 ring-inset ring-(--bk-day-today-ring)" : ""}`}
                          >
                            {parseIsoDate(date).day}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

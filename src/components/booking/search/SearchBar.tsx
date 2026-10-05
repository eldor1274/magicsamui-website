"use client";

// OWNER: ui-search-results
// Search capsule, Cloudbeds style: [Check-in -> Check-out] [N Guests]
// [Add Code] [Search]. "hero" is the frosted bar over the landing photo;
// "compact" sits above the results, and there any applied change (dates,
// guests, code) re-runs the search straight away. Search stays disabled
// until both dates are chosen. Keep SearchBarProps stable.

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertCircle, ArrowRight, CalendarDays, CheckCircle2, Loader2, Search, Tag, User } from "lucide-react";
import { formatDisplayDate } from "@/lib/booking/dates";
import type { IsoDate, PromoResult } from "@/lib/booking/types";
import type { SearchDraft } from "../state";
import { BTN_PRIMARY } from "../ui/styles";
import DateRangePicker from "./DateRangePicker";
import GuestsPopover from "./GuestsPopover";
import PromoPopover from "./PromoPopover";

export interface SearchBarProps {
  value: SearchDraft;
  /** Update the draft (no request). */
  onChange: (patch: Partial<SearchDraft>) => void;
  /** Run the search with the current draft. */
  onSearch: () => void;
  /** A search is in flight. */
  busy: boolean;
  /** "hero" on the landing step, "compact" above the results. */
  variant: "hero" | "compact";
  /** Result of the last promo validation from the server (null = none applied). */
  promoResult: PromoResult | null;
  /** First selectable date (today, Asia/Bangkok). */
  minDate: IsoDate;
  /** Last selectable check-out date (today + booking window). */
  maxDate: IsoDate;
  maxNights: number;
  maxAdults: number;
  /** False when no promo code can be valid (Beam modes): the code picker drops its DIRECT hint. */
  promoEnabled?: boolean;
}

type Panel = "dates" | "guests" | "promo" | null;

interface DateSnapshot {
  checkIn: IsoDate | null;
  checkOut: IsoDate | null;
}

export default function SearchBar({
  value,
  onChange,
  onSearch,
  busy,
  variant,
  promoResult,
  minDate,
  maxDate,
  maxNights,
  maxAdults,
  promoEnabled = true,
}: SearchBarProps) {
  const [panel, setPanel] = useState<Panel>(null);
  const datesRef = useRef<HTMLDivElement>(null);
  const guestsRef = useRef<HTMLButtonElement>(null);
  const promoRef = useRef<HTMLButtonElement>(null);
  const searchAfterUpdate = useRef(false);
  const openedWith = useRef<DateSnapshot | null>(null);
  const lastPicked = useRef<DateSnapshot | null>(null);

  const compact = variant === "compact";
  const ready = Boolean(value.checkIn && value.checkOut);

  // The parent reads the draft from its own state, which only catches up
  // after this render commits - so a search requested together with a draft
  // change runs on the next tick, once the new draft is in place.
  useEffect(() => {
    if (!searchAfterUpdate.current) return;
    searchAfterUpdate.current = false;
    window.setTimeout(onSearch, 0);
  }, [value, onSearch]);

  const toggle = (next: Exclude<Panel, null>) => setPanel((p) => (p === next ? null : next));

  const openDates = () => {
    if (panel === "dates") {
      setPanel(null);
      return;
    }
    openedWith.current = { checkIn: value.checkIn, checkOut: value.checkOut };
    lastPicked.current = null;
    setPanel("dates");
  };

  const onDatesChange = (checkIn: IsoDate | null, checkOut: IsoDate | null) => {
    lastPicked.current = { checkIn, checkOut };
    if (checkIn === value.checkIn && checkOut === value.checkOut) return;
    onChange({ checkIn, checkOut });
    const before = openedWith.current;
    if (compact && checkIn && checkOut && (checkIn !== before?.checkIn || checkOut !== before?.checkOut)) {
      searchAfterUpdate.current = true;
    }
  };

  const closeDates = () => {
    setPanel(null);
    // Above the results, closing half-way restores the dates being shown.
    const before = openedWith.current;
    const picked = lastPicked.current;
    if (compact && picked && !picked.checkOut && before?.checkIn && before.checkOut) {
      onChange({ checkIn: before.checkIn, checkOut: before.checkOut });
    }
    openedWith.current = null;
    lastPicked.current = null;
  };

  const applyPatch = (patch: Partial<SearchDraft>) => {
    const changed = (Object.keys(patch) as (keyof SearchDraft)[]).some((k) => patch[k] !== value[k]);
    if (!changed) return;
    onChange(patch);
    if (compact && ready) searchAfterUpdate.current = true;
  };

  const promoCode = value.promo.trim().toUpperCase();
  const promoVerdict = promoResult && promoCode !== "" && promoResult.code.toUpperCase() === promoCode ? promoResult : null;
  const guestsLabel = `${value.adults} ${value.adults === 1 ? "Guest" : "Guests"}`;

  /* --------------------------------- styles -------------------------------- */

  const pill = compact
    ? "h-12 rounded-(--bk-radius-pill) border border-(--bk-border) bg-(--bk-surface-muted) text-(--bk-text) hover:border-(--bk-border-strong)"
    : "h-14 rounded-(--bk-radius-pill) bg-(--bk-surface) text-(--bk-text) shadow-(--bk-shadow-card) md:h-12";
  // Compact on phones: tighter pills and 16px icons so Guests + Code + Search fit one row at 360px (Poppins included).
  const pillButton = `inline-flex items-center justify-center text-sm font-medium transition-colors sm:text-[15px] ${
    compact ? "gap-1.5 px-2.5 sm:gap-2 sm:px-4" : "gap-2 px-4"
  } ${pill}`;
  const pillIcon = compact ? "size-4 shrink-0 sm:size-[18px]" : "shrink-0";
  const dateButton =
    "flex h-full min-w-0 flex-1 items-center justify-center rounded-(--bk-radius-pill) px-2 text-sm font-medium transition-colors hover:bg-(--bk-surface-sunken) sm:text-[15px]";

  const dateText = (d: IsoDate | null, placeholder: string) =>
    d ? <span className="truncate">{formatDisplayDate(d)}</span> : <span className="truncate text-(--bk-text-muted)">{placeholder}</span>;

  // px-0! / sm:px-7!: BTN_PRIMARY carries px-5, which would otherwise win and squeeze the icon in the 48px circle.
  // Compact is an icon circle on phones and again from lg, where the bar is one row and the dates need the room.
  const searchButton = (
    <button
      type="submit"
      disabled={!ready || busy}
      className={`${BTN_PRIMARY} ${compact ? "h-12 w-12 px-0! sm:w-auto sm:px-7! lg:w-12 lg:min-w-0 lg:px-0!" : "h-14 px-7 md:h-12"} shrink-0 text-base md:min-w-32`}
    >
      {busy ? (
        <Loader2 size={18} className="shrink-0 animate-spin" aria-hidden="true" />
      ) : (
        <Search size={18} className="shrink-0" aria-hidden="true" />
      )}
      <span className={compact ? "sr-only sm:not-sr-only lg:sr-only" : undefined}>{busy ? "Searching" : "Search"}</span>
    </button>
  );

  // One quiet line of feedback under the bar (reserved height: no jump). The
  // hero renders it OUTSIDE the frosted capsule so the capsule hugs its controls.
  const feedback = <SearchFeedback compact={compact} ready={ready} hasCheckIn={value.checkIn !== null} promoVerdict={promoVerdict} />;

  return (
    <div>
      <form
        role="search"
        aria-label="Search availability"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready || busy) return;
          setPanel(null);
          onSearch();
        }}
        className={
          compact
            ? "rounded-(--bk-radius-card) bg-(--bk-surface) p-3 shadow-(--bk-shadow-card)"
            : "rounded-[1.75rem] bg-(--bk-surface)/55 p-2.5 shadow-(--bk-shadow-pop) ring-1 ring-(--bk-surface)/70 backdrop-blur-md md:rounded-(--bk-radius-pill)"
        }
      >
        {/* Compact: two rows on phones and tablets, one Cloudbeds-style row from lg. */}
        <div className={compact ? "flex flex-col gap-2 lg:flex-row lg:items-center" : "flex flex-col gap-2 md:flex-row md:items-center"}>
          {/* Dates */}
          <div ref={datesRef} className={`flex min-w-0 items-center gap-1 px-1.5 ${compact ? "lg:flex-1" : "md:flex-[1.6]"} ${pill}`}>
            <CalendarDays size={18} className="ml-2 shrink-0 text-(--bk-text-muted)" aria-hidden="true" />
            <button
              type="button"
              onClick={openDates}
              aria-haspopup="dialog"
              aria-expanded={panel === "dates"}
              aria-label={value.checkIn ? `Check-in, ${formatDisplayDate(value.checkIn)}` : "Check-in"}
              className={dateButton}
            >
              {dateText(value.checkIn, "Check-in")}
            </button>
            <ArrowRight size={16} className="shrink-0 text-(--bk-text-muted)" aria-hidden="true" />
            <button
              type="button"
              onClick={openDates}
              aria-haspopup="dialog"
              aria-expanded={panel === "dates"}
              aria-label={value.checkOut ? `Check-out, ${formatDisplayDate(value.checkOut)}` : "Check-out"}
              className={dateButton}
            >
              {dateText(value.checkOut, "Check-out")}
            </button>
          </div>

          {/* Above the results the Search button joins this row (icon-only on phones) to keep the bar short. */}
          <div className={compact ? "flex min-w-0 gap-2 lg:flex-none" : "flex gap-2"}>
            {/* Guests */}
            <button
              ref={guestsRef}
              type="button"
              onClick={() => toggle("guests")}
              aria-haspopup="dialog"
              aria-expanded={panel === "guests"}
              aria-label={`Guests, ${guestsLabel}`}
              // Compact phones: Guests hugs its label so the code pill gets the rest of the row.
              className={`${pillButton} md:flex-none md:min-w-32 ${compact ? "flex-none sm:flex-1 lg:min-w-0" : "flex-1"}`}
            >
              <User size={18} className={`${pillIcon} text-(--bk-text-muted)`} aria-hidden="true" />
              <span className="whitespace-nowrap">{guestsLabel}</span>
            </button>

            {/* Promo code */}
            <button
              ref={promoRef}
              type="button"
              onClick={() => toggle("promo")}
              aria-haspopup="dialog"
              aria-expanded={panel === "promo"}
              aria-label={
                promoCode
                  ? `Promo code ${promoCode}${promoVerdict ? (promoVerdict.valid ? ", applied" : ", not valid") : ""}`
                  : "Add promo code"
              }
              className={`${pillButton} min-w-0 flex-1 md:flex-none md:min-w-36 ${compact ? "lg:min-w-0" : ""}`}
            >
              {promoVerdict?.valid ? (
                <CheckCircle2 size={18} className={`${pillIcon} text-(--bk-success)`} aria-hidden="true" />
              ) : promoVerdict && !promoVerdict.valid ? (
                <AlertCircle size={18} className={`${pillIcon} text-(--bk-danger)`} aria-hidden="true" />
              ) : (
                <Tag size={18} className={`${pillIcon} text-(--bk-text-muted)`} aria-hidden="true" />
              )}
              <span className="truncate whitespace-nowrap">{promoCode || "Add Code"}</span>
            </button>

            {compact && searchButton}
          </div>

          {!compact && searchButton}
        </div>

        {compact && feedback}

        <DateRangePicker
          open={panel === "dates"}
          onClose={closeDates}
          checkIn={value.checkIn}
          checkOut={value.checkOut}
          onChange={onDatesChange}
          minDate={minDate}
          maxDate={maxDate}
          maxNights={maxNights}
          anchorRef={datesRef}
        />
        <GuestsPopover
          open={panel === "guests"}
          onClose={() => setPanel(null)}
          value={value.adults}
          min={1}
          max={maxAdults}
          onApply={(adults) => applyPatch({ adults })}
          anchorRef={guestsRef}
        />
        <PromoPopover
          open={panel === "promo"}
          onClose={() => setPanel(null)}
          value={value.promo}
          result={promoResult}
          onApply={(promo) => applyPatch({ promo })}
          anchorRef={promoRef}
          promoEnabled={promoEnabled}
        />
      </form>
      {!compact && feedback}
    </div>
  );
}

function SearchFeedback({
  compact,
  ready,
  hasCheckIn,
  promoVerdict,
}: {
  compact: boolean;
  ready: boolean;
  hasCheckIn: boolean;
  promoVerdict: PromoResult | null;
}) {
  let content: ReactNode = null;
  let tone: "muted" | "success" | "danger" = "muted";
  if (promoVerdict && !promoVerdict.valid) {
    content = promoVerdict.message;
    tone = "danger";
  } else if (promoVerdict?.valid) {
    content = `Code ${promoVerdict.code} applied: ${promoVerdict.label}`;
    tone = "success";
  } else if (!ready) {
    content = hasCheckIn ? "Now choose your check-out date." : "Choose your dates to see prices.";
  }
  if (content === null) {
    // Both variants keep the line's height, so the bar (and the results under it) never jump.
    return <div className={compact ? "min-h-7" : "mt-2 h-7 md:mt-5"} aria-hidden="true" />;
  }

  const color =
    tone === "danger"
      ? "text-(--bk-danger)"
      : tone === "success"
        ? "text-(--bk-success)"
        : compact
          ? "text-(--bk-text-muted)"
          : "text-(--bk-text)";
  return (
    <div className={compact ? "min-h-7 px-3 pt-2" : "mt-2 flex min-h-7 justify-center md:mt-5 md:justify-start md:pl-3"}>
      <p
        role={tone === "danger" ? "alert" : "status"}
        className={`text-sm ${color} ${
          compact ? "" : "rounded-(--bk-radius-control) bg-(--bk-surface)/90 px-3 py-1 text-center font-medium md:text-left"
        }`}
      >
        {content}
      </p>
    </div>
  );
}

"use client";

// OWNER: ui-search-results
// Phones and tablets (< lg): fixed bottom bar with the dates, "THB x" and the
// step CTA, shown once a room is in the cart. Tapping the total opens the
// full Reservation Summary in a bottom sheet ("View details"). BookingApp
// reserves bottom padding for the bar (pb-28) so nothing is hidden under it.
// Keep MobileSummaryBarProps stable.

import { useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { ChevronUp } from "lucide-react";
import { formatStayRange } from "@/lib/booking/dates";
import { formatThbWithCode } from "@/lib/booking/format";
import type { IsoDate, Quote } from "@/lib/booking/types";
import Sheet from "../ui/Sheet";
import type { SummaryCta } from "./ReservationSummary";
import SummaryCtaButton from "./SummaryCtaButton";

export interface MobileSummaryBarProps {
  quote: Quote | null;
  checkIn: IsoDate | null;
  checkOut: IsoDate | null;
  cta: SummaryCta | null;
  /** The full ReservationSummary (variant "sheet") shown when expanded. */
  summary: ReactNode;
}

export default function MobileSummaryBar({ quote, checkIn, checkOut, cta, summary }: MobileSummaryBarProps) {
  const [expanded, setExpanded] = useState(false);

  if (!quote) return null;

  // The CTA inside the sheet acts on the page (next step, submit the guest
  // form, pay): close the sheet right after so the guest sees where they went.
  const onSheetClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target instanceof Element && e.target.closest("[data-summary-cta]")) {
      window.setTimeout(() => setExpanded(false), 0);
    }
  };

  return (
    <>
      {/* z-41: above the shared BookingHelpStrip (fixed bottom, z-40) so the CTA is never covered; the WhatsApp FAB stays reachable above the bar. */}
      <div className="fixed inset-x-0 bottom-0 z-41 border-t border-(--bk-border) bg-(--bk-surface) text-(--bk-text) shadow-(--bk-shadow-bar) lg:hidden">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-haspopup="dialog"
            aria-expanded={expanded}
            aria-label={`Reservation total ${formatThbWithCode(quote.totalSatang)}. View details`}
            className="min-w-0 flex-1 rounded-(--bk-radius-control) text-left"
          >
            {checkIn && checkOut && (
              <span className="block truncate text-xs text-(--bk-text-muted)">{formatStayRange(checkIn, checkOut, " - ")}</span>
            )}
            <span className="bk-price block text-lg font-semibold leading-tight">{formatThbWithCode(quote.totalSatang)}</span>
            <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-(--bk-text) underline decoration-1 underline-offset-2">
              View details
              <ChevronUp size={14} aria-hidden="true" />
            </span>
          </button>
          {cta && <SummaryCtaButton cta={cta} className="h-12 shrink-0 px-6 text-base" />}
        </div>
      </div>

      <Sheet open={expanded} onClose={() => setExpanded(false)} title="Reservation Summary">
        <div onClickCapture={onSheetClick}>{summary}</div>
      </Sheet>
    </>
  );
}

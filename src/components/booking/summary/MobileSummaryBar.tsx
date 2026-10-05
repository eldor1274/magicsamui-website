"use client";

// OWNER: ui-search-results
// Phones and tablets (< lg): fixed bottom bar with the dates, "THB x" and the
// step CTA, shown once a room is in the cart. Tapping the total opens the
// full Reservation Summary in a bottom sheet ("View details"). BookingApp
// reserves bottom padding for the bar (pb-28) so nothing is hidden under it,
// and keys the bar on "cart empty / not empty" so the sheet's open state is
// reset when the last room is removed from inside it.
// Keep MobileSummaryBarProps stable.

import { useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { ChevronUp } from "lucide-react";
import { formatStayRange } from "@/lib/booking/dates";
import { formatThbWithCode } from "@/lib/booking/format";
import type { IsoDate, Quote } from "@/lib/booking/types";
import { useBottomBar } from "../bottomBars";
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
  /** Prices are (re)loading for a non-empty cart: keep the bar with a shimmer total. */
  loading?: boolean;
}

export default function MobileSummaryBar({ quote, checkIn, checkOut, cta, summary, loading = false }: MobileSummaryBarProps) {
  const [expanded, setExpanded] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const visible = Boolean(quote) || loading;
  // Publishes the bar height so the help strip stacks above it and the WhatsApp button clears it.
  useBottomBar("cart", barRef, visible);

  if (!visible) return null;
  const total = quote ? formatThbWithCode(quote.totalSatang) : null;
  // Next to a pay button the bar shows what Beam will actually charge: with a
  // deposit below 100% that is the amount due now, not the total.
  const dueNow = quote && cta?.barLabel && quote.dueNowSatang < quote.totalSatang ? formatThbWithCode(quote.dueNowSatang) : null;
  const amountLabel = dueNow ? `Due now ${dueNow}, total ${total}` : total ? `Reservation total ${total}` : null;

  // The CTA inside the sheet acts on the page (next step, submit the guest
  // form, pay): close the sheet right after so the guest sees where they went.
  const onSheetClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target instanceof Element && e.target.closest("[data-summary-cta]")) {
      window.setTimeout(() => setExpanded(false), 0);
    }
  };

  return (
    <>
      {/* z-41: above the help strip, which stacks on top of this bar (--bk-cart-bar-h) rather than under it. */}
      <div ref={barRef} className="fixed inset-x-0 bottom-0 z-41 border-t border-(--bk-border) bg-(--bk-surface) text-(--bk-text) shadow-(--bk-shadow-bar) lg:hidden">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-haspopup="dialog"
            aria-expanded={expanded}
            aria-label={amountLabel ? `${amountLabel}. View details` : "Updating prices. View reservation details"}
            className="min-w-0 flex-1 rounded-(--bk-radius-control) text-left"
          >
            {dueNow ? (
              <span className="block truncate text-xs text-(--bk-text-muted)">
                Due now · <span className="bk-price">Total {total}</span>
              </span>
            ) : (
              checkIn &&
              checkOut && <span className="block truncate text-xs text-(--bk-text-muted)">{formatStayRange(checkIn, checkOut, " - ")}</span>
            )}
            {total ? (
              <span className="bk-price block text-lg font-semibold leading-tight">{dueNow ?? total}</span>
            ) : (
              <span className="block h-[1.375rem] w-32 animate-pulse rounded bg-(--bk-surface-sunken)" aria-hidden="true" />
            )}
            <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-(--bk-text) underline decoration-1 underline-offset-2">
              View details
              <ChevronUp size={14} aria-hidden="true" />
            </span>
          </button>
          {cta && (
            <SummaryCtaButton
              cta={cta.barLabel ? { ...cta, label: cta.barLabel } : cta}
              // The short visible label ("Pay now") gets the amount actually charged in its accessible name.
              ariaLabel={cta.barLabel && quote ? `${cta.barLabel}: ${formatThbWithCode(quote.dueNowSatang)}` : undefined}
              className="h-12 shrink-0 px-6 text-base"
            />
          )}
        </div>
      </div>

      {/* BookingApp remounts this bar when the cart empties, so `expanded` never outlives the cart. */}
      <Sheet open={expanded && visible} onClose={() => setExpanded(false)} title="Reservation Summary">
        <div onClickCapture={onSheetClick}>{summary}</div>
      </Sheet>
    </>
  );
}

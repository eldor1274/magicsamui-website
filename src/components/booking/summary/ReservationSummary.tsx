"use client";

// OWNER: ui-search-results
// Reservation Summary (Cloudbeds card): dates and a "N Nights" chip; empty
// state; one line per cart item (room, plan, guests, add-ons, price, remove);
// Subtotal, add-ons, promo discount, the payment processing fee with a visible
// explanation (Cloudbeds hides this fee in a tooltip the site suppresses - we
// show it), Total "THB x", Due now; the step CTA; "Secure payment by Beam".
// quote.lines[i] corresponds to cart[i]. "sidebar" is the sticky desktop
// card; "sheet" is the same content inside the mobile summary sheet.
// Keep ReservationSummaryProps / SummaryCta stable.

import { useId, useState } from "react";
import { ArrowRight, BedDouble, Car, Info, Moon, ShieldCheck, Trash2, User } from "lucide-react";
import { FREE_PICKUP_MIN_NIGHTS, getCatalogueRoom } from "@/lib/booking/catalogue";
import { formatDisplayDate, formatNights, nightsBetween } from "@/lib/booking/dates";
import { formatThb, formatThbWithCode } from "@/lib/booking/format";
import type { CartItem, IsoDate, Quote } from "@/lib/booking/types";
import { CHIP, TOUCH_TARGET } from "../ui/styles";
import SummaryCtaButton from "./SummaryCtaButton";

export interface SummaryCta {
  label: string;
  /** Shorter label for the narrow mobile bar (e.g. "Pay now"; the bar then shows the amount due now next to it). */
  barLabel?: string;
  /** Click handler (ignored when submitForm is set). */
  onClick?: () => void;
  /** Render as <button type="submit" form={submitForm}> (guest step). */
  submitForm?: string;
  disabled?: boolean;
  /** Show a spinner and block repeat clicks. */
  busy?: boolean;
}

export interface ReservationSummaryProps {
  quote: Quote | null;
  cart: CartItem[];
  checkIn: IsoDate | null;
  checkOut: IsoDate | null;
  /** null hides the CTA (e.g. on the payment step the PaymentStep owns it). */
  cta: SummaryCta | null;
  /** Remove a cart item; undefined makes lines read-only. */
  onRemove?: (itemId: string) => void;
  onLearnMore: () => void;
  /** Availability is reloading: show skeleton shimmer on totals. */
  loading?: boolean;
  /** "sidebar" = sticky desktop card, "sheet" = inside the mobile bar's expanded panel. */
  variant: "sidebar" | "sheet";
}

export default function ReservationSummary({
  quote,
  cart,
  checkIn,
  checkOut,
  cta,
  onRemove,
  onLearnMore,
  loading = false,
  variant,
}: ReservationSummaryProps) {
  const [feeInfoOpen, setFeeInfoOpen] = useState(false);
  const feeInfoId = useId();
  const headingId = useId();
  const sidebar = variant === "sidebar";
  const nights = quote?.nights ?? (checkIn && checkOut ? nightsBetween(checkIn, checkOut) : null);
  const hasItems = cart.length > 0;

  /** Amount text, or a same-size shimmer while prices reload. */
  const amount = (text: string, className = "") => (
    <span
      className={`bk-price tabular-nums ${className} ${loading ? "animate-pulse rounded bg-(--bk-surface-sunken) text-transparent" : ""}`}
      aria-hidden={loading || undefined}
    >
      {text}
    </span>
  );

  /** Total / Due now / balance. In the sidebar these sit in the pinned footer with the CTA,
      so the total stays visible however many rooms scroll above it. */
  const totalRows = quote && (
    <>
      <div className="flex items-baseline justify-between gap-3 border-t border-(--bk-border) pt-3">
        <dt className="text-base font-semibold">Total</dt>
        <dd>{amount(formatThbWithCode(quote.totalSatang), "text-lg font-semibold sm:text-xl")}</dd>
      </div>
      <div className="flex justify-between gap-3 border-t border-(--bk-border) pt-3 font-semibold">
        <dt>Due now{quote.depositPct < 100 ? ` (${quote.depositPct}% deposit)` : ""}</dt>
        <dd>{amount(formatThb(quote.dueNowSatang))}</dd>
      </div>
      {quote.balanceSatang > 0 && (
        <div className="flex justify-between gap-3 text-(--bk-text-muted)">
          <dt>Balance due later</dt>
          <dd>{amount(formatThb(quote.balanceSatang))}</dd>
        </div>
      )}
    </>
  );

  return (
    <section
      aria-labelledby={sidebar ? headingId : undefined}
      aria-label={sidebar ? undefined : "Reservation Summary"}
      aria-busy={loading || undefined}
      className={sidebar ? "rounded-(--bk-radius-card) bg-(--bk-surface) p-5 text-(--bk-text) shadow-(--bk-shadow-card)" : "text-(--bk-text)"}
    >
      {sidebar && (
        <h2 id={headingId} className="bk-heading text-center text-lg">
          Reservation Summary
        </h2>
      )}

      {/* Dates */}
      {checkIn && checkOut ? (
        <div className={`flex flex-col items-center gap-2 ${sidebar ? "mt-2" : ""}`}>
          <p className="flex items-center gap-3 text-sm">
            <span className="bk-sr-only">
              Check-in {formatDisplayDate(checkIn)} to check-out {formatDisplayDate(checkOut)}
            </span>
            <span aria-hidden="true">{formatDisplayDate(checkIn)}</span>
            <ArrowRight size={16} className="text-(--bk-text-muted)" aria-hidden="true" />
            <span aria-hidden="true">{formatDisplayDate(checkOut)}</span>
          </p>
          {nights !== null && (
            <span className={CHIP}>
              <Moon size={14} aria-hidden="true" />
              {formatNights(nights)}
            </span>
          )}
        </div>
      ) : (
        sidebar && <p className="mt-2 text-center text-sm text-(--bk-text-muted)">Choose your dates to see prices</p>
      )}

      {!hasItems ? (
        <div className="mt-4 flex flex-col items-center gap-2 rounded-(--bk-radius-control) bg-(--bk-surface-sunken) px-4 py-8 text-center">
          <BedDouble size={40} strokeWidth={1.5} className="text-(--bk-text-subtle)" aria-hidden="true" />
          <p className="text-sm text-(--bk-text-muted)">No Accommodations Added</p>
        </div>
      ) : (
        <>
          {/* Line items */}
          <ul className="mt-4 divide-y divide-(--bk-border) border-y border-(--bk-border)" aria-label="Rooms in your reservation">
            {cart.map((item, i) => {
              const line = quote?.lines[i];
              const name = line?.roomName ?? getCatalogueRoom(item.slug)?.name ?? item.slug;
              const planName = line?.ratePlanName ?? (item.ratePlanId === "breakfast" ? "Breakfast" : "Standard Rate");
              return (
                <li key={item.id} className="py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium leading-snug">{name}</p>
                      <p className="mt-0.5 text-xs text-(--bk-text-muted)">{planName}</p>
                    </div>
                    {line ? (
                      amount(formatThb(line.roomSatang), "shrink-0 text-sm")
                    ) : (
                      <span className="mt-0.5 h-4 w-16 shrink-0 animate-pulse rounded bg-(--bk-surface-sunken)" aria-hidden="true" />
                    )}
                  </div>
                  {line && line.addons.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {line.addons.map((a) => (
                        <li key={a.addonId} className="flex items-start justify-between gap-3 text-xs text-(--bk-text-muted)">
                          <span>
                            + {a.name} · {a.guests} × {a.eligibleNights.length} {a.eligibleNights.length === 1 ? "night" : "nights"}
                          </span>
                          {amount(formatThb(a.amountSatang), "shrink-0")}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className={CHIP} aria-label={`${item.adults} ${item.adults === 1 ? "adult" : "adults"}`}>
                      <User size={14} aria-hidden="true" />
                      {item.adults}
                    </span>
                    {onRemove && (
                      <button
                        type="button"
                        onClick={() => onRemove(item.id)}
                        aria-label={`Remove ${name}`}
                        className="inline-flex h-11 w-11 items-center justify-center rounded-(--bk-radius-control) border border-(--bk-danger) text-(--bk-danger) transition-colors hover:bg-(--bk-danger-soft) lg:h-9 lg:w-9"
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {/* Totals */}
          {quote ? (
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt>Subtotal</dt>
                <dd>{amount(formatThb(quote.roomsSubtotalSatang))}</dd>
              </div>
              {quote.addonsSubtotalSatang > 0 && (
                <div className="flex justify-between gap-3">
                  <dt>Add-ons</dt>
                  <dd>{amount(formatThb(quote.addonsSubtotalSatang))}</dd>
                </div>
              )}
              {quote.promo && (
                <div className="flex justify-between gap-3 text-(--bk-success)">
                  <dt>
                    {quote.promo.label}
                  </dt>
                  <dd>{amount(formatThb(-quote.promo.discountSatang))}</dd>
                </div>
              )}
              <div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="flex items-center gap-1">
                    Payment processing fee ({quote.cardFeePct}%)
                    <button
                      type="button"
                      onClick={() => setFeeInfoOpen((v) => !v)}
                      aria-expanded={feeInfoOpen}
                      aria-controls={feeInfoId}
                      aria-label="What is the payment processing fee?"
                      className={`${TOUCH_TARGET} inline-flex h-6 w-6 items-center justify-center rounded-full text-(--bk-text-muted) hover:bg-(--bk-surface-sunken) hover:text-(--bk-text)`}
                    >
                      <Info size={15} aria-hidden="true" />
                    </button>
                  </dt>
                  <dd>{amount(formatThb(quote.cardFeeSatang))}</dd>
                </div>
                <p
                  id={feeInfoId}
                  hidden={!feeInfoOpen}
                  className="mt-1.5 rounded-(--bk-radius-control) bg-(--bk-surface-sunken) px-3 py-2 text-xs leading-relaxed text-(--bk-text-muted)"
                >
                  A {quote.cardFeePct}% fee covers the cost of taking your payment securely through Beam, whether you pay by card or
                  PromptPay. It is already included in the total below - there are no other charges at checkout.
                </p>
              </div>
              {!sidebar && totalRows}
            </dl>
          ) : (
            <p className="mt-3 text-center text-sm text-(--bk-text-muted)">{loading ? "Updating prices…" : "Prices will appear in a moment."}</p>
          )}

          {quote && quote.nights >= FREE_PICKUP_MIN_NIGHTS && (
            <p className="mt-3 flex items-center gap-2 rounded-(--bk-radius-control) bg-(--bk-success-soft) px-3 py-2 text-xs text-(--bk-text)">
              <Car size={15} className="shrink-0 text-(--bk-success)" aria-hidden="true" />
              Free airport pickup included with your stay
            </p>
          )}

          {/* In the sidebar the totals and CTA stick to the bottom of the (height-capped, scrollable)
              sticky column, so Total, Due now and the button stay visible on short screens and with
              several rooms in the cart; only the line items and breakdown scroll above them. */}
          <div
            className={
              sidebar
                ? "sticky bottom-0 -mx-5 -mb-5 mt-1 rounded-b-(--bk-radius-card) bg-(--bk-surface) px-5 pb-5 pt-1 shadow-[0_-8px_12px_-12px_rgb(0_0_0/0.25)]"
                : "mt-1 pt-3"
            }
          >
            {sidebar && totalRows && <dl className="mb-4 space-y-2 text-sm">{totalRows}</dl>}
            {cta && <SummaryCtaButton cta={cta} className="h-12 w-full text-base" />}

            <p className="mt-3 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-xs text-(--bk-text-muted)">
              <ShieldCheck size={15} className="text-(--bk-success)" aria-hidden="true" />
              <span>Secure payment by Beam</span>
              <button
                type="button"
                onClick={onLearnMore}
                aria-haspopup="dialog"
                className={`${TOUCH_TARGET} font-medium text-(--bk-text) underline decoration-1 underline-offset-4 hover:text-(--bk-accent)`}
              >
                Learn more
              </button>
            </p>
          </div>
        </>
      )}
    </section>
  );
}
